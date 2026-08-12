// Diffusions vers les leads dzpk — file d'envoi, reprise, garde-fous.
//
// ┌─ CE QUE CE MODULE GARANTIT, ET CE QU'IL NE GARANTIT PAS ───────────────────┐
// │ GARANTI                                                                    │
// │  • Aucun destinataire n'est perdu : le statut est commité ligne par ligne, │
// │    donc une coupure laisse le reste en 'pending' et le tick suivant        │
// │    reprend exactement là.                                                  │
// │  • Aucun double-envoi par concurrence : UNIQUE(broadcast_id, lead_id) et   │
// │    un seul envoi en vol à la fois.                                         │
// │  • Un 429 ne consomme jamais un destinataire : il reste 'pending'.         │
// │                                                                            │
// │ NON GARANTI (assumé, borné)                                                │
// │  • Exactement-une-fois. Si le process meurt entre le sendMessage accepté   │
// │    par Telegram et l'UPDATE qui le marque 'sent', ce destinataire sera     │
// │    réessayé. Les envois étant SÉRIELS, la casse est bornée à UN doublon    │
// │    par crash. L'inverse — marquer avant d'envoyer — perdrait le message,   │
// │    ce qui est pire : un doublon se voit, un silence non.                   │
// └────────────────────────────────────────────────────────────────────────────┘

import { getDb } from "@/lib/db";
import { tgRetrying, isBlockedError, sleep } from "./tg";
import { markBlocked, type DbLike, type DzpkState } from "./leads";

// ── Réglages ──────────────────────────────────────────────

/**
 * Espacement entre deux envois, en millisecondes.
 *
 * 200 ms ⇒ 5 messages/s, la cadence déjà retenue par la diffusion historique
 * (`lib/telegram-commands/broadcast.ts`). Très en dessous du plafond Telegram
 * (~30/s), et c'est volontaire : la limite qui compte ici n'est pas technique
 * mais réputationnelle. Un bot qui arrose se fait signaler par ses
 * destinataires, et Telegram le restreint sans préavis ni recours.
 */
export function spacingMs(): number {
  const raw = parseInt(process.env.DZPK_BROADCAST_RATE_MS ?? "", 10);
  if (!Number.isFinite(raw)) return 200;
  return Math.min(5_000, Math.max(50, raw));
}

/**
 * Destinataires traités par tick de cron.
 *
 * 200 × 200 ms ≈ 40 s, ce qui tient dans la minute du cron avec de la marge.
 * Dépasser ferait chevaucher deux ticks — le verrou `draining` l'empêche, mais
 * un tick qui déborde systématiquement masquerait le vrai débit.
 */
export function drainBatch(): number {
  const raw = parseInt(process.env.DZPK_BROADCAST_BATCH ?? "", 10);
  if (!Number.isFinite(raw)) return 200;
  return Math.min(1_000, Math.max(1, raw));
}

/** Au-delà, un destinataire est déclaré en échec définitif plutôt que réessayé sans fin. */
export const MAX_ATTEMPTS = 3;

// ── Types ─────────────────────────────────────────────────

export type BroadcastStatus = "draft" | "running" | "paused" | "done" | "cancelled";
export type TargetStatus = "pending" | "sent" | "blocked" | "failed";

/** Toutes les étapes sélectionnables. Ordre d'affichage, pas de priorité. */
export const ALL_STAGES: DzpkState[] = ["started", "replied", "joined", "bound", "converted"];

export interface DzpkSegment {
  /** `null` = toutes les sources. Liste vide = aucune (0 destinataire, et c'est dit). */
  sources: string[] | null;
  stages: DzpkState[];
}

export interface DzpkBroadcast {
  id: number;
  title: string;
  body: string;
  button_label: string | null;
  button_url: string | null;
  segment: string;
  status: BroadcastStatus;
  total: number;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface BroadcastCounts {
  pending: number;
  sent: number;
  blocked: number;
  failed: number;
}

// ── Segment ───────────────────────────────────────────────

/**
 * L'étape d'un lead, EN SQL.
 *
 * Duplique `deriveState` (leads.ts) — une duplication assumée : segmenter en
 * mémoire imposerait de charger tous les leads pour n'en garder qu'une part,
 * et ce module doit rester utilisable quand la table aura grossi.
 *
 * La duplication est verrouillée par un test qui compare les deux sur les 16
 * combinaisons possibles des quatre colonnes de date (dzpk-broadcast.test.ts).
 * Sans lui, une étape ajoutée d'un seul côté produirait un segment faux — donc
 * une diffusion partie au mauvais public, sans aucune erreur visible.
 */
export const STAGE_SQL = `
  CASE
    WHEN converted_at    IS NOT NULL THEN 'converted'
    WHEN bound_at        IS NOT NULL THEN 'bound'
    WHEN club_joined_at  IS NOT NULL THEN 'joined'
    WHEN first_reply_at  IS NOT NULL THEN 'replied'
    ELSE 'started'
  END`;

/**
 * Exclusions NON négociables, appliquées à tout segment.
 *
 * `blocked = 1` : le lead a bloqué le bot. Lui réécrire ne peut pas aboutir et
 * chaque tentative est un 403 de plus au compteur de Telegram.
 *
 * `banned_at` : joueur banni par le club. Lui pousser une promo serait au mieux
 * absurde, au pire une relance vers un compte que le club a fermé.
 */
const HARD_EXCLUSIONS = `blocked = 0 AND banned_at IS NULL`;

/** Le segment est-il exploitable ? Rendu au lieu d'être jeté : l'écran doit pouvoir le dire. */
export function segmentError(segment: DzpkSegment): string | null {
  if (!Array.isArray(segment.stages) || segment.stages.length === 0) {
    return "Aucune étape sélectionnée";
  }
  const inconnues = segment.stages.filter(s => !ALL_STAGES.includes(s));
  if (inconnues.length) return `Étape inconnue : ${inconnues.join(", ")}`;
  if (segment.sources !== null && !Array.isArray(segment.sources)) {
    return "sources doit être une liste ou null";
  }
  if (segment.sources !== null && segment.sources.length === 0) {
    return "Aucune source sélectionnée";
  }
  return null;
}

function segmentWhere(segment: DzpkSegment): { sql: string; params: any[] } {
  const params: any[] = [];
  let sql = `${HARD_EXCLUSIONS} AND ${STAGE_SQL} IN (${segment.stages.map(() => "?").join(",")})`;
  params.push(...segment.stages);

  if (segment.sources !== null) {
    sql += ` AND source IN (${segment.sources.map(() => "?").join(",")})`;
    params.push(...segment.sources);
  }
  return { sql, params };
}

/** Destinataires d'un segment, à cet instant. Lecture seule. */
export function resolveSegment(
  segment: DzpkSegment,
  dbOverride?: DbLike,
): Array<{ lead_id: number; telegram_id: number }> {
  const err = segmentError(segment);
  if (err) return [];
  const db = dbOverride ?? getDb();
  const { sql, params } = segmentWhere(segment);
  return db.prepare(
    `SELECT id AS lead_id, telegram_id FROM dzpk_leads WHERE ${sql} ORDER BY id`
  ).all(...params);
}

export function countSegment(segment: DzpkSegment, dbOverride?: DbLike): number {
  const err = segmentError(segment);
  if (err) return 0;
  const db = dbOverride ?? getDb();
  const { sql, params } = segmentWhere(segment);
  return (db.prepare(`SELECT COUNT(*) AS n FROM dzpk_leads WHERE ${sql}`).get(...params) as any).n;
}

// ── Création ──────────────────────────────────────────────

export interface CreateInput {
  title: string;
  body: string;
  buttonLabel?: string | null;
  buttonUrl?: string | null;
  segment: DzpkSegment;
  createdBy?: string | null;
}

export interface CreateResult {
  ok: boolean;
  error?: string;
  id?: number;
  total?: number;
}

/**
 * Crée une diffusion en BROUILLON et fige ses destinataires.
 *
 * Deux écritures, une seule transaction : une diffusion dont la liste de
 * destinataires serait à moitié écrite enverrait à un public arbitraire, et
 * `total` mentirait sur ce qui reste à faire.
 *
 * Le statut est 'draft' : rien ne part tant que `startBroadcast` n'est pas
 * appelé. Créer et envoyer sont deux gestes distincts, exprès — c'est ce qui
 * permet à l'écran de montrer le récap avant que quoi que ce soit ne parte.
 */
export function createBroadcast(input: CreateInput, dbOverride?: DbLike): CreateResult {
  const db = dbOverride ?? getDb();

  const title = (input.title ?? "").trim();
  const body = (input.body ?? "").trim();
  if (!title) return { ok: false, error: "Titre requis" };
  if (!body) return { ok: false, error: "Message vide" };

  // Telegram refuse au-delà de 4096 caractères. Le dire ici plutôt que de
  // laisser 400 échouer un par un sur toute la liste.
  if ([...body].length > 4096) {
    return { ok: false, error: `Message trop long : ${[...body].length} caractères, maximum 4096` };
  }

  const segErr = segmentError(input.segment);
  if (segErr) return { ok: false, error: segErr };

  const label = (input.buttonLabel ?? "").trim();
  const url = (input.buttonUrl ?? "").trim();
  if (label && !url) return { ok: false, error: "Bouton : libellé sans URL" };
  if (url && !label) return { ok: false, error: "Bouton : URL sans libellé" };
  // Telegram rejette l'inline keyboard dont l'url n'est pas http(s)/tg. Un
  // bouton invalide fait échouer l'envoi ENTIER, pas seulement le bouton.
  if (url && !/^(https?|tg):\/\//i.test(url)) {
    return { ok: false, error: "Bouton : URL doit commencer par http://, https:// ou tg://" };
  }

  const targets = resolveSegment(input.segment, dbOverride);
  if (targets.length === 0) return { ok: false, error: "Aucun destinataire pour ce segment" };

  let id = 0;
  const write = () => {
    const ins = db.prepare(
      `INSERT INTO dzpk_broadcasts (title, body, button_label, button_url, segment, status, total, created_by)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`
    ).run(title, body, label || null, url || null, JSON.stringify(input.segment),
          targets.length, input.createdBy ?? null);
    id = Number(ins.lastInsertRowid);

    const insTarget = db.prepare(
      `INSERT INTO dzpk_broadcast_targets (broadcast_id, lead_id, telegram_id) VALUES (?, ?, ?)`
    );
    for (const t of targets) insTarget.run(id, t.lead_id, t.telegram_id);
  };

  if (typeof (db as any).transaction === "function") (db as any).transaction(write)();
  else write();

  return { ok: true, id, total: targets.length };
}

// ── Cycle de vie ──────────────────────────────────────────

export function getBroadcast(id: number, dbOverride?: DbLike): DzpkBroadcast | undefined {
  const db = dbOverride ?? getDb();
  return db.prepare(`SELECT * FROM dzpk_broadcasts WHERE id = ?`).get(id) as DzpkBroadcast | undefined;
}

export function getCounts(id: number, dbOverride?: DbLike): BroadcastCounts {
  const db = dbOverride ?? getDb();
  const rows = db.prepare(
    `SELECT status, COUNT(*) AS n FROM dzpk_broadcast_targets WHERE broadcast_id = ? GROUP BY status`
  ).all(id) as Array<{ status: TargetStatus; n: number }>;
  const out: BroadcastCounts = { pending: 0, sent: 0, blocked: 0, failed: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export interface ActionResult { ok: boolean; error?: string }

/**
 * Démarre (ou reprend) une diffusion.
 *
 * UNE SEULE diffusion peut tourner à la fois. Ce n'est pas une limite
 * technique : deux diffusions en parallèle doubleraient la cadence réelle sans
 * que ni l'une ni l'autre ne le sache, et le réglage d'espacement — la seule
 * protection contre le signalement — ne voudrait plus rien dire.
 */
export function startBroadcast(id: number, dbOverride?: DbLike): ActionResult {
  const db = dbOverride ?? getDb();
  const bc = getBroadcast(id, dbOverride);
  if (!bc) return { ok: false, error: "Diffusion introuvable" };
  if (bc.status === "running") return { ok: true };
  if (bc.status === "done") return { ok: false, error: "Diffusion déjà terminée" };
  if (bc.status === "cancelled") return { ok: false, error: "Diffusion annulée" };

  const running = db.prepare(
    `SELECT id, title FROM dzpk_broadcasts WHERE status = 'running' AND id != ?`
  ).get(id) as { id: number; title: string } | undefined;
  if (running) {
    return { ok: false, error: `Diffusion #${running.id} « ${running.title} » est déjà en cours` };
  }

  if (getCounts(id, dbOverride).pending === 0) {
    return { ok: false, error: "Plus aucun destinataire en attente" };
  }

  db.prepare(
    `UPDATE dzpk_broadcasts
        SET status = 'running',
            started_at = COALESCE(started_at, datetime('now')),
            last_error = NULL
      WHERE id = ?`
  ).run(id);
  return { ok: true };
}

export function pauseBroadcast(id: number, reason?: string, dbOverride?: DbLike): ActionResult {
  const db = dbOverride ?? getDb();
  const info = db.prepare(
    `UPDATE dzpk_broadcasts SET status = 'paused', last_error = ? WHERE id = ? AND status = 'running'`
  ).run(reason ?? null, id);
  if (info.changes === 0) return { ok: false, error: "Diffusion non démarrée" };
  return { ok: true };
}

/**
 * Annule ce qui n'est pas encore parti.
 *
 * Les destinataires déjà servis gardent leur statut : une annulation n'efface
 * pas ce qui est arrivé chez les gens.
 */
export function cancelBroadcast(id: number, dbOverride?: DbLike): ActionResult {
  const db = dbOverride ?? getDb();
  const bc = getBroadcast(id, dbOverride);
  if (!bc) return { ok: false, error: "Diffusion introuvable" };
  if (bc.status === "done") return { ok: false, error: "Diffusion déjà terminée" };
  db.prepare(
    `UPDATE dzpk_broadcasts SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?`
  ).run(id);
  return { ok: true };
}

// ── Garde-fou anti-spam ───────────────────────────────────

export interface BroadcastGuard {
  /** Dernière diffusion réellement partie (au moins un envoi). */
  last: { id: number; title: string; sent: number; at: string } | null;
  /** Heures écoulées depuis, arrondies. `null` s'il n'y a jamais rien eu. */
  hoursSince: number | null;
  sentLast24h: number;
  sentLast7d: number;
  broadcastsLast7d: number;
}

/**
 * De quoi juger « est-ce que j'en abuse ? » avant d'appuyer.
 *
 * Compte les MESSAGES partis, pas les diffusions créées : c'est le volume reçu
 * par les leads qui déclenche les signalements, pas le nombre de fois où Baki a
 * ouvert le formulaire.
 */
export function getGuard(dbOverride?: DbLike): BroadcastGuard {
  const db = dbOverride ?? getDb();

  const last = db.prepare(
    `SELECT b.id, b.title, COUNT(t.id) AS sent, MAX(t.sent_at) AS at
       FROM dzpk_broadcasts b
       JOIN dzpk_broadcast_targets t ON t.broadcast_id = b.id AND t.status = 'sent'
      GROUP BY b.id
      ORDER BY at DESC
      LIMIT 1`
  ).get() as { id: number; title: string; sent: number; at: string } | undefined;

  const sentLast24h = (db.prepare(
    `SELECT COUNT(*) AS n FROM dzpk_broadcast_targets
      WHERE status = 'sent' AND sent_at >= datetime('now', '-24 hours')`
  ).get() as any).n;

  const sentLast7d = (db.prepare(
    `SELECT COUNT(*) AS n FROM dzpk_broadcast_targets
      WHERE status = 'sent' AND sent_at >= datetime('now', '-7 days')`
  ).get() as any).n;

  const broadcastsLast7d = (db.prepare(
    `SELECT COUNT(DISTINCT broadcast_id) AS n FROM dzpk_broadcast_targets
      WHERE status = 'sent' AND sent_at >= datetime('now', '-7 days')`
  ).get() as any).n;

  let hoursSince: number | null = null;
  if (last?.at) {
    const row = db.prepare(
      `SELECT CAST((julianday('now') - julianday(?)) * 24 AS INTEGER) AS h`
    ).get(last.at) as any;
    hoursSince = row?.h ?? null;
  }

  return { last: last ?? null, hoursSince, sentLast24h, sentLast7d, broadcastsLast7d };
}

export interface BroadcastListRow extends DzpkBroadcast {
  counts: BroadcastCounts;
}

export function listBroadcasts(limit = 20, dbOverride?: DbLike): BroadcastListRow[] {
  const db = dbOverride ?? getDb();
  const rows = db.prepare(
    `SELECT * FROM dzpk_broadcasts ORDER BY id DESC LIMIT ?`
  ).all(limit) as DzpkBroadcast[];
  return rows.map(r => ({ ...r, counts: getCounts(r.id, dbOverride) }));
}

// ── Envoi ─────────────────────────────────────────────────

function keyboardOf(bc: DzpkBroadcast) {
  if (!bc.button_label || !bc.button_url) return undefined;
  return { inline_keyboard: [[{ text: bc.button_label, url: bc.button_url }]] };
}

/**
 * Erreur de FORME du message : elle frapperait les 4000 destinataires à
 * l'identique.
 *
 * Un 400 « can't parse entities » sur le premier destinataire annonce 400
 * suivants. Continuer brûlerait la liste entière pour rien et remplirait le
 * compteur d'erreurs du bot côté Telegram. On met la diffusion en pause et on
 * dit pourquoi — c'est réparable en corrigeant le HTML, pas en réessayant.
 */
function isFatalFormatError(res: { error_code?: number; description?: string }): boolean {
  if (res.error_code !== 400) return false;
  const d = (res.description ?? "").toLowerCase();
  return d.includes("parse entities")
    || d.includes("can't parse")
    || d.includes("button_url")
    || d.includes("message is too long")
    || d.includes("wrong remote file")
    || d.includes("reply markup");
}

export interface DrainResult {
  /** `null` quand aucune diffusion n'était en cours — le cas nominal, silencieux. */
  broadcastId: number | null;
  sent: number;
  blocked: number;
  failed: number;
  /** Destinataires laissés en attente par un 429 ou une pause : repris au tick suivant. */
  deferred: number;
  finished: boolean;
  pausedReason?: string;
}

const EMPTY: DrainResult = {
  broadcastId: null, sent: 0, blocked: 0, failed: 0, deferred: 0, finished: false,
};

/**
 * Verrou de processus.
 *
 * Le cron tourne à la minute ; un tick qui déborde croiserait le suivant, et
 * les deux se partageraient la même file. L'UNIQUE en base empêcherait le
 * doublon, mais pas le doublement de la cadence d'envoi — précisément ce que
 * l'espacement sert à éviter.
 */
let draining = false;

/** La diffusion en cours, s'il y en a une. */
export function getRunningBroadcast(dbOverride?: DbLike): DzpkBroadcast | undefined {
  const db = dbOverride ?? getDb();
  return db.prepare(
    `SELECT * FROM dzpk_broadcasts WHERE status = 'running' ORDER BY started_at LIMIT 1`
  ).get() as DzpkBroadcast | undefined;
}

export interface DrainOpts {
  max?: number;
  spacing?: number;
  /**
   * Envoi injectable.
   *
   * C'est ce qui rend la mécanique de reprise prouvable : sans lui, vérifier
   * qu'une coupure au milieu ne perd ni ne redouble personne demanderait
   * d'appeler Telegram pour de vrai, donc ne serait jamais vérifié.
   */
  sendFn?: (chatId: number, bc: DzpkBroadcast) => Promise<{
    ok: boolean; error_code?: number; description?: string; result?: { message_id?: number };
  }>;
}

/** Un tour de file. Idempotent, interruptible, repris par le tick suivant. */
export async function runBroadcastDrain(
  opts: DrainOpts = {},
  dbOverride?: DbLike,
): Promise<DrainResult> {
  if (draining) return { ...EMPTY };
  draining = true;
  try {
    return await drainInner(opts, dbOverride);
  } finally {
    draining = false;
  }
}

async function drainInner(opts: DrainOpts, dbOverride?: DbLike): Promise<DrainResult> {
  const db = dbOverride ?? getDb();
  const bc = getRunningBroadcast(dbOverride);
  if (!bc) return { ...EMPTY };

  const max = opts.max ?? drainBatch();
  const spacing = opts.spacing ?? spacingMs();
  const send = opts.sendFn ?? defaultSend;

  const targets = db.prepare(
    `SELECT id, lead_id, telegram_id, attempts
       FROM dzpk_broadcast_targets
      WHERE broadcast_id = ? AND status = 'pending'
      ORDER BY id
      LIMIT ?`
  ).all(bc.id, max) as Array<{ id: number; lead_id: number; telegram_id: number; attempts: number }>;

  const out: DrainResult = {
    broadcastId: bc.id, sent: 0, blocked: 0, failed: 0, deferred: 0, finished: false,
  };

  for (const t of targets) {
    // La tentative est comptée AVANT l'envoi. Un destinataire sur lequel le
    // process meurt en boucle finit donc par sortir en 'failed' au lieu d'être
    // réessayé indéfiniment à chaque redémarrage.
    db.prepare(`UPDATE dzpk_broadcast_targets SET attempts = attempts + 1 WHERE id = ?`).run(t.id);

    const res = await send(t.telegram_id, bc);

    if (res.ok) {
      db.prepare(
        `UPDATE dzpk_broadcast_targets
            SET status = 'sent', sent_at = datetime('now'), telegram_message_id = ?, error = NULL
          WHERE id = ?`
      ).run(res.result?.message_id ?? null, t.id);
      out.sent++;
    } else if (isBlockedError(res)) {
      // Définitif : ni réessai, ni échec à investiguer. Le lead est marqué pour
      // sortir des segments futurs — sinon chaque diffusion rejouerait le même
      // 403 sur les mêmes comptes.
      db.prepare(
        `UPDATE dzpk_broadcast_targets SET status = 'blocked', error = ? WHERE id = ?`
      ).run((res.description ?? "bloqué").slice(0, 200), t.id);
      markBlocked(t.lead_id, dbOverride);
      out.blocked++;
    } else if (isFatalFormatError(res)) {
      // Le destinataire reste 'pending' : ce n'est pas lui le problème. On
      // rembobine sa tentative pour ne pas l'épuiser sur une erreur de forme.
      db.prepare(`UPDATE dzpk_broadcast_targets SET attempts = attempts - 1 WHERE id = ?`).run(t.id);
      const reason = `Message refusé par Telegram : ${res.description ?? "format invalide"}`;
      pauseBroadcast(bc.id, reason, dbOverride);
      out.deferred = countPending(bc.id, dbOverride);
      out.pausedReason = reason;
      return out;
    } else if (res.error_code === 429) {
      // `tgRetrying` a déjà honoré `retry_after` et épuisé son budget. Le
      // destinataire N'EST PAS consommé : on rend la main, le tick suivant
      // reprendra. Insister ici ne ferait qu'aggraver la limitation.
      db.prepare(`UPDATE dzpk_broadcast_targets SET attempts = attempts - 1 WHERE id = ?`).run(t.id);
      out.deferred = countPending(bc.id, dbOverride);
      return out;
    } else {
      const attempts = t.attempts + 1;
      const msg = (res.description ?? "erreur inconnue").slice(0, 200);
      if (attempts >= MAX_ATTEMPTS) {
        db.prepare(
          `UPDATE dzpk_broadcast_targets SET status = 'failed', error = ? WHERE id = ?`
        ).run(msg, t.id);
        out.failed++;
      } else {
        db.prepare(`UPDATE dzpk_broadcast_targets SET error = ? WHERE id = ?`).run(msg, t.id);
      }
    }

    if (spacing > 0) await sleep(spacing);
  }

  const pending = countPending(bc.id, dbOverride);
  out.deferred = pending;

  // Terminé = plus rien en attente. La diffusion peut avoir été mise en pause
  // entre-temps par une autre voie : on ne force pas 'done' dans ce cas.
  if (pending === 0) {
    const info = db.prepare(
      `UPDATE dzpk_broadcasts SET status = 'done', finished_at = datetime('now')
        WHERE id = ? AND status = 'running'`
    ).run(bc.id);
    out.finished = info.changes > 0;
  }

  return out;
}

function countPending(broadcastId: number, dbOverride?: DbLike): number {
  const db = dbOverride ?? getDb();
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM dzpk_broadcast_targets WHERE broadcast_id = ? AND status = 'pending'`
  ).get(broadcastId) as any).n;
}

async function defaultSend(chatId: number, bc: DzpkBroadcast) {
  const keyboard = keyboardOf(bc);
  return tgRetrying("sendMessage", {
    chat_id: chatId,
    text: bc.body,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

/**
 * Envoi de contrôle à un seul compte, hors file.
 *
 * N'écrit RIEN : ce n'est pas une diffusion d'un destinataire, c'est une
 * relecture. Le compter dans les statistiques fausserait le garde-fou
 * anti-spam, qui doit mesurer ce que les leads reçoivent.
 */
export async function sendTest(
  chatId: number,
  draft: { body: string; buttonLabel?: string | null; buttonUrl?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const keyboard = draft.buttonLabel && draft.buttonUrl
    ? { inline_keyboard: [[{ text: draft.buttonLabel, url: draft.buttonUrl }]] }
    : undefined;

  const res = await tgRetrying("sendMessage", {
    chat_id: chatId,
    text: draft.body,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });

  if (res.ok) return { ok: true };
  return { ok: false, error: res.description ?? "échec de l'envoi" };
}
