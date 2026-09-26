// Diffusions @LeCercle_Lebot — file d'envoi, reprise, garde-fous, programmation.
//
// Copie adaptée de lib/funnels/dzpk/broadcast.ts (qui n'est pas modifié). Ce qui
// change : l'audience (audience.ts), un bouton tracké par destinataire, la
// programmation, et la relecture des exclusions juste avant chaque envoi.
//
// ┌─ CE QUE CE MODULE GARANTIT, ET CE QU'IL NE GARANTIT PAS ───────────────────┐
// │ GARANTI                                                                    │
// │  • Jamais deux envois au même compte pour une diffusion : verrou de drain  │
// │    en base, réservation exclusive 'pending' → 'sending', UNIQUE en base,   │
// │    et aucun renvoi automatique d'un envoi dont l'issue est inconnue.       │
// │  • Reprise : une coupure laisse le reste en 'pending', le tick suivant     │
// │    reprend là. Un 429 ou un refus de Telegram ne consomme personne.        │
// │  • Une panne (réseau, 5xx, token) met la diffusion en PAUSE au lieu de     │
// │    marquer toute la liste en échec.                                        │
// │  • « Test à moi » n'écrit rien : il n'apparaît dans aucun compteur.        │
// │                                                                            │
// │ NON GARANTI (assumé)                                                       │
// │  • Exactement-une-fois. Si le process meurt pendant un envoi, ou si        │
// │    Telegram ne répond pas, on ne sait pas si le message est arrivé. Ce     │
// │    destinataire passe en 'unknown' et n'est PAS renvoyé : au plus un       │
// │    destinataire possiblement privé par incident, jamais un doublon.        │
// └────────────────────────────────────────────────────────────────────────────┘

import { randomBytes } from "crypto";
import { getDb } from "@/lib/db";
import { tgRetrying, isBlockedError, isPermanentRecipientError, sleep, type TgResult } from "./tg";
import { checkTelegramHtml } from "./html";
import {
  resolveAudience, summarize, segmentError, currentExclusion,
  type DbLike, type LecercleSegment, type ExclusionMotive,
} from "./audience";

// ── Réglages ──────────────────────────────────────────────

/**
 * Espacement entre deux envois (ms). 200 ms = 5 msg/s, la cadence DZPK.
 * Plancher à 40 ms = 25 msg/s : le plafond fixé pour ce bot, sous la limite
 * Telegram (~30/s). La vraie limite est le signalement, pas le débit.
 */
export function spacingMs(): number {
  const raw = parseInt(process.env.LECERCLE_BROADCAST_RATE_MS ?? "", 10);
  if (!Number.isFinite(raw)) return 200;
  return Math.min(5_000, Math.max(40, raw));
}

/** Destinataires par tick de cron : 200 × 200 ms ≈ 40 s, tient dans la minute. */
export function drainBatch(): number {
  const raw = parseInt(process.env.LECERCLE_BROADCAST_BATCH ?? "", 10);
  if (!Number.isFinite(raw)) return 200;
  return Math.min(1_000, Math.max(1, raw));
}

export const MAX_ATTEMPTS = 3;

/**
 * Seul compte autorisé pour « Test à moi » (Hugo, 1486389037). Codé en dur,
 * exprès : aucune variable d'environnement ne peut élargir la liste. L'écran ne
 * peut pas, même par erreur, envoyer un « test » à un lead.
 */
const TEST_CHAT_IDS: readonly number[] = [1486389037];
export function allowedTestChatIds(): number[] {
  return [...TEST_CHAT_IDS];
}

/** Durée du bail de drain. > durée max d'une itération (fetch 15 s + attente 429 15 s). */
export const LEASE_SECONDS = 120;

/** Base publique des liens trackés. */
export function publicBaseUrl(): string {
  return (process.env.LECERCLE_PUBLIC_BASE_URL?.trim()
    || process.env.NEXT_PUBLIC_BASE_URL?.trim()
    || "https://lecerclepoker-production.up.railway.app").replace(/\/+$/, "");
}

export function trackedUrl(token: string): string {
  return `${publicBaseUrl()}/b/${token}`;
}

/** 128 bits aléatoires, base64url (22 caractères). */
export function newClickToken(): string {
  return randomBytes(16).toString("base64url");
}

// ── Types ─────────────────────────────────────────────────

export type BroadcastStatus = "draft" | "scheduled" | "running" | "paused" | "done" | "cancelled";
export type TargetStatus = "pending" | "sending" | "sent" | "failed" | "blocked" | "skipped" | "unknown";

export interface LecercleBroadcast {
  id: number;
  title: string;
  body: string;
  button_label: string | null;
  button_url: string | null;
  segment: string;
  excluded: string;
  status: BroadcastStatus;
  total: number;
  scheduled_at: string | null;
  resume_after: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface BroadcastStats {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  blocked: number;
  skipped: number;
  /** Envoi en vol (réservé par le drain). */
  sending: number;
  /** Issue inconnue : possiblement reçu, jamais renvoyé automatiquement. */
  unknown: number;
  clicked: number;
  replied: number;
}

// ── Validation du contenu ─────────────────────────────────

export interface DraftContent {
  body: string;
  buttonLabel?: string | null;
  buttonUrl?: string | null;
}

/**
 * Le bouton n'accepte que http(s) : il passe par la redirection /b/<token>,
 * et un 302 vers tg:// tombe en erreur dans un navigateur sans Telegram.
 */
export function contentError(c: DraftContent): string | null {
  const body = (c.body ?? "").trim();
  if (!body) return "Message vide";
  const html = checkTelegramHtml(body);
  if (!html.ok) return `HTML Telegram invalide : ${html.errors[0]}`;

  const label = (c.buttonLabel ?? "").trim();
  const url = (c.buttonUrl ?? "").trim();
  if (label && !url) return "Bouton : libellé sans URL";
  if (url && !label) return "Bouton : URL sans libellé";
  if ([...label].length > 64) return "Bouton : libellé trop long (64 caractères max)";
  if (url) {
    if (!/^https?:\/\//i.test(url)) return "Bouton : l'URL doit commencer par http:// ou https://";
    try { new URL(url); } catch { return "Bouton : URL illisible"; }
    if (url.length > 2000) return "Bouton : URL trop longue";
  }
  return null;
}

// ── Création ──────────────────────────────────────────────

export interface CreateInput extends DraftContent {
  title: string;
  segment: LecercleSegment;
  createdBy?: string | null;
}

export interface CreateResult {
  ok: boolean;
  error?: string;
  id?: number;
  total?: number;
  excluded?: Partial<Record<ExclusionMotive, number>>;
}

/**
 * Crée un BROUILLON et fige ses destinataires, dans une seule transaction.
 * Rien ne part avant `startBroadcast` / `scheduleBroadcast`, qui exigent le
 * nombre figé ici : l'écran ne peut confirmer qu'un chiffre venu du serveur.
 */
export function createBroadcast(
  input: CreateInput,
  opts: { owners?: number[] } = {},
  dbOverride?: DbLike,
): CreateResult {
  const db = dbOverride ?? getDb();

  const title = (input.title ?? "").trim();
  if (!title) return { ok: false, error: "Titre requis" };
  const cErr = contentError(input);
  if (cErr) return { ok: false, error: cErr };
  const segErr = segmentError(input.segment);
  if (segErr) return { ok: false, error: segErr };

  const rows = resolveAudience(input.segment, opts, dbOverride);
  const summary = summarize(rows);
  const recipients = rows.filter(r => r.motive === null);
  if (recipients.length === 0) return { ok: false, error: "Aucun destinataire pour ce segment" };

  let id = 0;
  db.transaction(() => {
    const ins = db.prepare(
      `INSERT INTO lecercle_broadcasts (title, body, button_label, button_url, segment, excluded, status, total, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
    ).run(
      title, input.body.trim(),
      (input.buttonLabel ?? "").trim() || null, (input.buttonUrl ?? "").trim() || null,
      JSON.stringify(input.segment), JSON.stringify(summary.excluded),
      recipients.length, input.createdBy ?? null,
    );
    id = Number(ins.lastInsertRowid);

    // Pas d'INSERT OR IGNORE : l'audience rend une ligne par telegram_id. Un
    // doublon ici serait un bug d'audience, et il doit faire échouer toute la
    // création plutôt que de passer en silence.
    const insTarget = db.prepare(
      `INSERT INTO lecercle_broadcast_targets (broadcast_id, telegram_id, username, first_name, click_token)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const r of recipients) insTarget.run(id, r.telegram_id, r.username, r.first_name, newClickToken());
  })();

  return { ok: true, id, total: recipients.length, excluded: summary.excluded };
}

// ── Cycle de vie ──────────────────────────────────────────

export function getBroadcast(id: number, dbOverride?: DbLike): LecercleBroadcast | undefined {
  const db = dbOverride ?? getDb();
  return db.prepare(`SELECT * FROM lecercle_broadcasts WHERE id = ?`).get(id) as LecercleBroadcast | undefined;
}

export function getStats(id: number, dbOverride?: DbLike): BroadcastStats {
  const db = dbOverride ?? getDb();
  const r = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(status = 'pending') AS pending,
           SUM(status = 'sent')    AS sent,
           SUM(status = 'failed')  AS failed,
           SUM(status = 'blocked') AS blocked,
           SUM(status = 'skipped') AS skipped,
           SUM(status = 'sending') AS sending,
           SUM(status = 'unknown') AS unknown,
           SUM(first_click_at IS NOT NULL) AS clicked,
           SUM(replied_at IS NOT NULL)     AS replied
      FROM lecercle_broadcast_targets WHERE broadcast_id = ?`).get(id) as Record<string, number | null>;
  const v = (k: string) => Number(r[k] ?? 0);
  return {
    total: v("total"), pending: v("pending"), sent: v("sent"), failed: v("failed"),
    blocked: v("blocked"), skipped: v("skipped"), sending: v("sending"), unknown: v("unknown"),
    clicked: v("clicked"), replied: v("replied"),
  };
}

export interface ActionResult { ok: boolean; error?: string }

function otherRunning(id: number, db: DbLike): { id: number; title: string } | undefined {
  return db.prepare(
    `SELECT id, title FROM lecercle_broadcasts WHERE status = 'running' AND id != ?`
  ).get(id) as { id: number; title: string } | undefined;
}

function pendingCount(id: number, db: DbLike): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM lecercle_broadcast_targets WHERE broadcast_id = ? AND status = 'pending'`
  ).get(id) as { n: number }).n;
}

function inFlightCount(id: number, db: DbLike): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM lecercle_broadcast_targets WHERE broadcast_id = ? AND status = 'sending'`
  ).get(id) as { n: number }).n;
}

/**
 * Démarre un brouillon, ou reprend une diffusion en pause.
 *
 * Depuis un brouillon, `expectedTotal` est OBLIGATOIRE et doit égaler le total
 * figé : c'est la confirmation « j'envoie à N personnes » rendue vérifiable.
 * Une seule diffusion à la fois : deux en parallèle doubleraient la cadence.
 */
export function startBroadcast(id: number, expectedTotal?: number, dbOverride?: DbLike): ActionResult {
  const db = dbOverride ?? getDb();
  const bc = getBroadcast(id, dbOverride);
  if (!bc) return { ok: false, error: "Diffusion introuvable" };
  if (bc.status === "running") return { ok: true };
  if (bc.status === "done") return { ok: false, error: "Diffusion déjà terminée" };
  if (bc.status === "cancelled") return { ok: false, error: "Diffusion annulée" };
  if (bc.status === "scheduled") return { ok: false, error: "Diffusion programmée : annule-la ou attends son heure" };
  if (bc.status === "draft" && expectedTotal !== bc.total) {
    return { ok: false, error: `Confirmation invalide : ${bc.total} destinataires figés, ${expectedTotal ?? "aucun"} confirmé(s)` };
  }

  const running = otherRunning(id, db);
  if (running) return { ok: false, error: `Diffusion #${running.id} « ${running.title} » est déjà en cours` };
  if (pendingCount(id, db) === 0) {
    // Une pause tombée entre le dernier envoi et la clôture laisserait sinon une
    // diffusion « en pause » à jamais, sans rien à reprendre.
    if (bc.status === "paused" && inFlightCount(id, db) === 0) {
      db.prepare(`UPDATE lecercle_broadcasts SET status = 'done', finished_at = datetime('now') WHERE id = ? AND status = 'paused'`).run(id);
      return { ok: false, error: "Plus rien en attente : diffusion close" };
    }
    return { ok: false, error: "Plus aucun destinataire en attente" };
  }

  const info = db.prepare(
    `UPDATE lecercle_broadcasts
        SET status = 'running', started_at = COALESCE(started_at, datetime('now')), last_error = NULL
      WHERE id = ? AND status IN ('draft','paused')
        AND NOT EXISTS (SELECT 1 FROM lecercle_broadcasts WHERE status = 'running' AND id != ?)`
  ).run(id, id);
  if (info.changes === 0) return { ok: false, error: "Diffusion non démarrable (état changé entre-temps)" };
  return { ok: true };
}

/**
 * Programme un brouillon. `scheduledAtUtc8` = « YYYY-MM-DDTHH:MM » en UTC+8,
 * stocké en UTC. Même confirmation du total que startBroadcast.
 */
export function scheduleBroadcast(
  id: number, scheduledAtUtc8: string, expectedTotal: number | undefined, dbOverride?: DbLike,
): ActionResult & { scheduledAt?: string } {
  const db = dbOverride ?? getDb();
  const bc = getBroadcast(id, dbOverride);
  if (!bc) return { ok: false, error: "Diffusion introuvable" };
  if (bc.status !== "draft") return { ok: false, error: "Seul un brouillon peut être programmé" };
  if (expectedTotal !== bc.total) {
    return { ok: false, error: `Confirmation invalide : ${bc.total} destinataires figés, ${expectedTotal ?? "aucun"} confirmé(s)` };
  }
  const at = utc8ToSqlUtc(scheduledAtUtc8);
  if (!at) return { ok: false, error: "Date/heure illisible (attendu AAAA-MM-JJTHH:MM, UTC+8)" };
  const now = Date.now();
  const t = Date.parse(at.replace(" ", "T") + "Z");
  if (t < now + 60_000) return { ok: false, error: "L'heure programmée doit être dans le futur (au moins 1 minute)" };
  if (t > now + 30 * 86_400_000) return { ok: false, error: "Programmation limitée à 30 jours" };

  const info = db.prepare(
    `UPDATE lecercle_broadcasts SET status = 'scheduled', scheduled_at = ? WHERE id = ? AND status = 'draft'`
  ).run(at, id);
  if (info.changes === 0) return { ok: false, error: "Diffusion non programmable (état changé entre-temps)" };
  return { ok: true, scheduledAt: at };
}

/** « 2026-09-26T21:30 » (UTC+8) → « 2026-09-26 13:30:00 » (UTC, format SQLite). */
export function utc8ToSqlUtc(s: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s ?? "")) return null;
  const t = Date.parse(`${s}:00+08:00`);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 19).replace("T", " ");
}

export function pauseBroadcast(id: number, reason?: string, dbOverride?: DbLike): ActionResult {
  const db = dbOverride ?? getDb();
  const info = db.prepare(
    `UPDATE lecercle_broadcasts SET status = 'paused', last_error = ? WHERE id = ? AND status = 'running'`
  ).run(reason ?? null, id);
  if (info.changes === 0) return { ok: false, error: "Diffusion non démarrée" };
  return { ok: true };
}

/** Annule ce qui n'est pas parti. Les envois faits gardent leur statut. */
export function cancelBroadcast(id: number, dbOverride?: DbLike): ActionResult {
  const db = dbOverride ?? getDb();
  let changed = 0;
  db.transaction(() => {
    changed = db.prepare(
      `UPDATE lecercle_broadcasts SET status = 'cancelled', finished_at = datetime('now')
        WHERE id = ? AND status NOT IN ('done','cancelled')`
    ).run(id).changes;
    // Les restants sont soldés, pas laissés « en attente » d'une diffusion morte.
    // Une ligne 'sending' (envoi en vol) n'est pas touchée : son issue sera écrite.
    if (changed) {
      db.prepare(
        `UPDATE lecercle_broadcast_targets SET status = 'skipped', error = 'diffusion annulée'
          WHERE broadcast_id = ? AND status = 'pending'`
      ).run(id);
    }
  })();
  if (changed === 0) return { ok: false, error: "Diffusion introuvable, terminée ou déjà annulée" };
  return { ok: true };
}

/**
 * Démarre la plus ancienne diffusion programmée dont l'heure est passée, si
 * rien ne tourne. Une diffusion programmée pendant qu'une autre tourne attend
 * la minute suivante — elle ne se perd pas.
 */
export function promoteDueScheduled(dbOverride?: DbLike): number | null {
  const db = dbOverride ?? getDb();
  const due = db.prepare(
    `SELECT id FROM lecercle_broadcasts
      WHERE status = 'scheduled' AND scheduled_at <= datetime('now')
      ORDER BY scheduled_at, id LIMIT 1`
  ).get() as { id: number } | undefined;
  if (!due) return null;
  const info = db.prepare(
    `UPDATE lecercle_broadcasts
        SET status = 'running', started_at = COALESCE(started_at, datetime('now')), last_error = NULL
      WHERE id = ? AND status = 'scheduled'
        AND NOT EXISTS (SELECT 1 FROM lecercle_broadcasts WHERE status = 'running')`
  ).run(due.id);
  return info.changes > 0 ? due.id : null;
}

// ── Garde-fou anti-spam ───────────────────────────────────

export interface BroadcastGuard {
  last: { id: number; title: string; sent: number; at: string } | null;
  hoursSince: number | null;
  sentLast24h: number;
  sentLast7d: number;
  broadcastsLast7d: number;
}

export function getGuard(dbOverride?: DbLike): BroadcastGuard {
  const db = dbOverride ?? getDb();
  const last = db.prepare(
    `SELECT b.id, b.title, COUNT(t.id) AS sent, MAX(t.sent_at) AS at
       FROM lecercle_broadcasts b
       JOIN lecercle_broadcast_targets t ON t.broadcast_id = b.id AND t.status = 'sent'
      GROUP BY b.id ORDER BY at DESC LIMIT 1`
  ).get() as { id: number; title: string; sent: number; at: string } | undefined;
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const sentLast24h = count(`SELECT COUNT(*) AS n FROM lecercle_broadcast_targets
    WHERE status = 'sent' AND sent_at >= datetime('now', '-24 hours')`);
  const sentLast7d = count(`SELECT COUNT(*) AS n FROM lecercle_broadcast_targets
    WHERE status = 'sent' AND sent_at >= datetime('now', '-7 days')`);
  const broadcastsLast7d = count(`SELECT COUNT(DISTINCT broadcast_id) AS n FROM lecercle_broadcast_targets
    WHERE status = 'sent' AND sent_at >= datetime('now', '-7 days')`);
  let hoursSince: number | null = null;
  if (last?.at) {
    const row = db.prepare(`SELECT CAST((julianday('now') - julianday(?)) * 24 AS INTEGER) AS h`).get(last.at) as { h: number };
    hoursSince = row?.h ?? null;
  }
  return { last: last ?? null, hoursSince, sentLast24h, sentLast7d, broadcastsLast7d };
}

export interface BroadcastListRow extends LecercleBroadcast { stats: BroadcastStats }

export function listBroadcasts(limit = 30, dbOverride?: DbLike): BroadcastListRow[] {
  const rows = (dbOverride ?? getDb()).prepare(
    `SELECT * FROM lecercle_broadcasts ORDER BY id DESC LIMIT ?`
  ).all(limit) as LecercleBroadcast[];
  return rows.map(r => ({ ...r, stats: getStats(r.id, dbOverride) }));
}

// ── Liste nominative ──────────────────────────────────────

export type TargetFilter =
  | "all" | "sent" | "failed" | "blocked" | "skipped" | "pending" | "unknown"
  | "clicked" | "not_clicked" | "replied" | "not_replied";

export const TARGET_FILTERS: TargetFilter[] = [
  "all", "sent", "failed", "blocked", "skipped", "pending", "unknown", "clicked", "not_clicked", "replied", "not_replied",
];

export interface TargetRow {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  status: TargetStatus;
  error_code: number | null;
  error: string | null;
  sent_at: string | null;
  first_click_at: string | null;
  click_count: number;
  replied_at: string | null;
  /** Lien vers son sujet au groupe Support (Nexa ou relais des diffusions), s'il existe. */
  topic_link?: string | null;
}

/** t.me/c/<id sans -100>/<sujet> — seulement pour un supergroupe (-100…). */
function topicUrl(chatId: string | null | undefined, threadId: number | null | undefined): string | null {
  const s = String(chatId ?? "");
  if (!threadId || !s.startsWith("-100")) return null;
  return `https://t.me/c/${s.slice(4)}/${threadId}`;
}

/**
 * Sujet d'un compte : celui du relais des diffusions, sinon son sujet Nexa.
 * Lecture tolérante : une table absente (migration en échec) donne « pas de lien »,
 * jamais une page cassée.
 */
function topicLinksFor(telegramIds: number[], db: DbLike): Map<number, string> {
  const out = new Map<number, string>();
  const tryAll = (sql: string) => {
    try {
      const st = db.prepare(sql);
      for (const id of telegramIds) {
        if (out.has(id)) continue;
        const r = st.get(id) as { c: string | null; t: number | null } | undefined;
        const url = topicUrl(r?.c, r?.t);
        if (url) out.set(id, url);
      }
    } catch { /* table ou colonne absente : pas de lien */ }
  };
  tryAll(`SELECT admin_chat_id AS c, thread_id AS t FROM lecercle_dm_threads WHERE telegram_id = ?`);
  tryAll(`SELECT admin_topic_chat_id AS c, admin_thread_id AS t FROM nexa_leads WHERE tg_user_id = ?`);
  return out;
}

export function listTargets(
  id: number, filter: TargetFilter = "all", q = "", limit = 2000, dbOverride?: DbLike,
): TargetRow[] {
  const db = dbOverride ?? getDb();
  const where: string[] = ["broadcast_id = ?"];
  const params: any[] = [id];
  const byStatus: Partial<Record<TargetFilter, string>> = {
    sent: "status = 'sent'", failed: "status = 'failed'", blocked: "status = 'blocked'",
    skipped: "status = 'skipped'", pending: "status IN ('pending','sending')", unknown: "status = 'unknown'",
    clicked: "first_click_at IS NOT NULL", not_clicked: "status = 'sent' AND first_click_at IS NULL",
    replied: "replied_at IS NOT NULL", not_replied: "status = 'sent' AND replied_at IS NULL",
  };
  if (byStatus[filter]) where.push(byStatus[filter]!);
  const needle = q.trim().replace(/^@/, "").toLowerCase();
  if (needle) {
    where.push(`(LOWER(COALESCE(username,'')) LIKE ? OR LOWER(COALESCE(first_name,'')) LIKE ? OR CAST(telegram_id AS TEXT) LIKE ?)`);
    const like = `%${needle.replace(/[%_]/g, "")}%`;
    params.push(like, like, like);
  }
  params.push(limit);
  const rows = db.prepare(
    `SELECT id, telegram_id, username, first_name, status, error_code, error, sent_at,
            first_click_at, click_count, replied_at
       FROM lecercle_broadcast_targets WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`
  ).all(...params) as TargetRow[];
  // Lien pour tout destinataire qui a un sujet, réponse comptée ou non : une
  // conversation relayée ne doit jamais être invisible depuis la diffusion.
  const links = topicLinksFor(rows.map(r => r.telegram_id), db);
  for (const r of rows) r.topic_link = links.get(r.telegram_id) ?? null;
  return rows;
}

// ── Envoi ─────────────────────────────────────────────────
//
// ┌─ POURQUOI UN MÊME COMPTE NE PEUT PAS RECEVOIR DEUX FOIS ───────────────────┐
// │ 1. Verrou en BASE (lecercle_broadcast_lock) : un seul drain actif, quel    │
// │    que soit le nombre de copies du module chargées par Next. Le bail est   │
// │    renouvelé avant chaque envoi ; perdu → le drain s'arrête.              │
// │ 2. Réservation exclusive : 'pending' → 'sending' par un UPDATE conditionnel│
// │    qui exige aussi « diffusion en cours » et « verrou à moi ». Une ligne   │
// │    'sending' n'est plus sélectionnable par personne.                       │
// │ 3. Issue inconnue ⇒ jamais de renvoi : une ligne restée 'sending' (process │
// │    mort) ou un envoi sans réponse de Telegram passe en 'unknown'.          │
// │ 4. UNIQUE(broadcast_id, telegram_id) en dernier rempart.                   │
// │ Seuls sont remis en 'pending' les échecs où Telegram a RÉPONDU par un refus│
// │ (429, 4xx) ou où la requête n'est jamais partie : rien n'a été livré.      │
// └────────────────────────────────────────────────────────────────────────────┘

/** Erreur de FORME : elle frapperait tous les destinataires à l'identique. */
function isFatalFormatError(res: TgResult): boolean {
  if (res.error_code !== 400) return false;
  const d = (res.description ?? "").toLowerCase();
  return d.includes("parse entities") || d.includes("can't parse") || d.includes("button_url")
    || d.includes("message is too long") || d.includes("reply markup") || d.includes("text must be non-empty")
    || d.includes("message text is empty")
    || d.includes("wrong http url") || d.includes("wrong url");
}

/** Erreur du BOT, pas du destinataire : token refusé, méthode introuvable. */
function isBotConfigError(res: TgResult): boolean {
  return res.error_code === 401 || res.error_code === 404;
}

export interface DrainResult {
  broadcastId: number | null;
  promoted: number | null;
  /** false = un autre drain tient le verrou ; ce tour n'a rien fait. */
  locked: boolean;
  /** Lignes 'sending' orphelines (process mort) passées en 'unknown' à la prise du verrou. */
  recovered: number;
  sent: number;
  blocked: number;
  failed: number;
  skipped: number;
  unknown: number;
  deferred: number;
  finished: boolean;
  pausedReason?: string;
}

export type SendFn = (chatId: number, bc: LecercleBroadcast, target: { click_token: string }) => Promise<TgResult<{ message_id?: number }>>;

export interface DrainOpts {
  max?: number;
  spacing?: number;
  /** Envoi injectable : c'est ce qui rend reprise et dédoublonnage testables sans Telegram. */
  sendFn?: SendFn;
  owners?: number[];
  /** Identité du détenteur du verrou (tests : simuler deux process). */
  lockOwner?: string;
}

const emptyResult = (): DrainResult => ({
  broadcastId: null, promoted: null, locked: true, recovered: 0,
  sent: 0, blocked: 0, failed: 0, skipped: 0, unknown: 0, deferred: 0, finished: false,
});

export function getRunningBroadcast(dbOverride?: DbLike): LecercleBroadcast | undefined {
  return (dbOverride ?? getDb()).prepare(
    `SELECT * FROM lecercle_broadcasts WHERE status = 'running' ORDER BY started_at LIMIT 1`
  ).get() as LecercleBroadcast | undefined;
}

function acquireLock(owner: string, db: DbLike): boolean {
  db.prepare(`INSERT OR IGNORE INTO lecercle_broadcast_lock (id) VALUES (1)`).run();
  return db.prepare(
    `UPDATE lecercle_broadcast_lock SET owner = ?, until = datetime('now', ?)
      WHERE id = 1 AND (until IS NULL OR until < datetime('now') OR owner = ?)`
  ).run(owner, `+${LEASE_SECONDS} seconds`, owner).changes === 1;
}

function renewLock(owner: string, db: DbLike): boolean {
  return db.prepare(
    `UPDATE lecercle_broadcast_lock SET until = datetime('now', ?) WHERE id = 1 AND owner = ? AND until >= datetime('now')`
  ).run(`+${LEASE_SECONDS} seconds`, owner).changes === 1;
}

function releaseLock(owner: string, db: DbLike): void {
  db.prepare(`UPDATE lecercle_broadcast_lock SET owner = NULL, until = NULL WHERE id = 1 AND owner = ?`).run(owner);
}

/**
 * Un tour de file. Idempotent, interruptible, repris par le tick suivant.
 * Sans le verrou, rend la main immédiatement (`locked: false`).
 */
export async function runBroadcastDrain(opts: DrainOpts = {}, dbOverride?: DbLike): Promise<DrainResult> {
  const db = dbOverride ?? getDb();
  const owner = opts.lockOwner ?? randomBytes(8).toString("hex");
  if (!acquireLock(owner, db)) return { ...emptyResult(), locked: false };
  try {
    // Le verrou est à nous : aucune ligne 'sending' ne peut appartenir à un
    // drain vivant. Celles qui restent viennent d'un process mort en plein
    // envoi — issue inconnue, jamais renvoyées.
    const recovered = db.prepare(
      `UPDATE lecercle_broadcast_targets
          SET status = 'unknown', error = 'envoi interrompu (redémarrage) : issue inconnue, non renvoyé'
        WHERE status = 'sending'`
    ).run().changes;
    const promoted = getRunningBroadcast(dbOverride) ? null : promoteDueScheduled(dbOverride);
    const res = await drainInner(owner, opts, db, dbOverride);
    return { ...res, promoted, recovered };
  } finally {
    releaseLock(owner, db);
  }
}

async function drainInner(owner: string, opts: DrainOpts, db: DbLike, dbOverride?: DbLike): Promise<DrainResult> {
  const out = emptyResult();
  const bc = getRunningBroadcast(dbOverride);
  if (!bc) return out;
  out.broadcastId = bc.id;

  // 429 long : on n'envoie rien avant l'heure fixée par Telegram, même si le
  // tick de la minute suivante arrive avant.
  const wait = db.prepare(
    `SELECT 1 AS w FROM lecercle_broadcasts WHERE id = ? AND resume_after IS NOT NULL AND resume_after > datetime('now')`
  ).get(bc.id);
  if (wait) {
    out.deferred = pendingCount(bc.id, db);
    return out;
  }

  const max = opts.max ?? drainBatch();
  const spacing = opts.spacing ?? spacingMs();
  const send = opts.sendFn ?? defaultSend;

  const targets = db.prepare(
    `SELECT id, telegram_id, click_token FROM lecercle_broadcast_targets
      WHERE broadcast_id = ? AND status = 'pending' ORDER BY id LIMIT ?`
  ).all(bc.id, max) as Array<{ id: number; telegram_id: number; click_token: string }>;

  // claimed_at vient de la migration du relais (add_lecercle_dm_relay_v1). Si elle
  // a échoué, on réserve sans l'horodatage plutôt que de bloquer toutes les
  // diffusions sur une colonne manquante (audit relais, finding 7).
  const hasClaimedAt = (db.prepare(
    `SELECT COUNT(*) AS n FROM pragma_table_info('lecercle_broadcast_targets') WHERE name = 'claimed_at'`
  ).get() as { n: number }).n > 0;
  const claim = db.prepare(
    `UPDATE lecercle_broadcast_targets SET status = 'sending', attempts = attempts + 1${hasClaimedAt ? ", claimed_at = datetime('now')" : ""}
      WHERE id = ? AND status = 'pending'
        AND EXISTS (SELECT 1 FROM lecercle_broadcasts WHERE id = ? AND status = 'running')
        AND EXISTS (SELECT 1 FROM lecercle_broadcast_lock WHERE id = 1 AND owner = ? AND until >= datetime('now'))`
  );
  const release = db.prepare(
    `UPDATE lecercle_broadcast_targets SET status = 'pending', attempts = attempts - 1, error_code = ?, error = ?
      WHERE id = ? AND status = 'sending'`
  );
  const settle = (id: number, status: TargetStatus, code: number | null, error: string | null) =>
    db.prepare(`UPDATE lecercle_broadcast_targets SET status = ?, error_code = ?, error = ? WHERE id = ? AND status = 'sending'`)
      .run(status, code, error, id);
  // Refus 4xx NON reconnu : s'il frappe plusieurs destinataires d'affilée à
  // l'identique, c'est le message ou le bot, pas eux — on s'arrête avant d'user
  // la liste (une liste noire de libellés ne peut pas tout prévoir).
  let lastRefusal: string | null = null;
  let sameRefusals = 0;
  const stop = (reason: string) => {
    pauseBroadcast(bc.id, reason, dbOverride);
    out.pausedReason = reason;
    out.deferred = pendingCount(bc.id, db);
    return out;
  };

  for (const t of targets) {
    if (!renewLock(owner, db)) {
      out.deferred = pendingCount(bc.id, db);
      return out;
    }

    // Exclusion relue au moment de l'envoi (bloqué, relances coupées, takeover
    // survenus depuis la création) : écarté avec son motif, pas perdu.
    const motive = currentExclusion(t.telegram_id, { owners: opts.owners }, dbOverride);
    if (motive) {
      const info = db.prepare(
        `UPDATE lecercle_broadcast_targets SET status = 'skipped', error = ? WHERE id = ? AND status = 'pending'`
      ).run(`exclu à l'envoi : ${motive}`, t.id);
      if (info.changes) out.skipped++;
      continue;
    }

    // Réservation exclusive. Échoue si la ligne n'est plus 'pending', si la
    // diffusion a été mise en pause/annulée, ou si le verrou n'est plus à nous :
    // dans les trois cas, on n'envoie pas.
    if (claim.run(t.id, bc.id, owner).changes === 0) {
      const st = (db.prepare(`SELECT status FROM lecercle_broadcasts WHERE id = ?`).get(bc.id) as { status: string }).status;
      if (st !== "running") {
        out.deferred = pendingCount(bc.id, db);
        return out;
      }
      continue;
    }

    const res = await send(t.telegram_id, bc, { click_token: t.click_token });
    const desc = (res.description ?? "").slice(0, 200) || null;

    if (res.ok) {
      const done = db.prepare(
        `UPDATE lecercle_broadcast_targets
            SET status = 'sent', sent_at = datetime('now'), telegram_message_id = ?, error = NULL, error_code = NULL
          WHERE id = ? AND status = 'sending'`
      ).run(res.result?.message_id ?? null, t.id).changes;
      // 0 ligne : un autre drain a entre-temps classé cette ligne (bail perdu).
      // Pas compté ici, pour que le compte rendu ne dise pas plus que la base.
      if (done === 1) out.sent++;
      lastRefusal = null; sameRefusals = 0;
    } else if (isBlockedError(res)) {
      settle(t.id, "blocked", res.error_code ?? null, desc ?? "bloqué");
      markBlocked(t.telegram_id, res.description ?? "403", db);
      out.blocked++;
    } else if (res.notSent) {
      // Requête jamais partie : rien livré, on rend le destinataire et on s'arrête.
      release.run(null, desc, t.id);
      return stop(`Envoi impossible : ${res.description ?? "configuration"}`);
    } else if (res.error_code === undefined || res.error_code >= 500) {
      // Pas de réponse exploitable (réseau, timeout, 5xx) : Telegram a PU livrer.
      // Ce destinataire ne sera pas renvoyé ; la diffusion s'arrête pour qu'un
      // humain regarde avant de continuer — une panne ne vide pas la liste.
      settle(t.id, "unknown", res.error_code ?? null, `issue inconnue, non renvoyé : ${desc ?? "pas de réponse"}`);
      out.unknown++;
      return stop(`Telegram injoignable ou en erreur (${res.error_code ?? "pas de réponse"} ${res.description ?? ""}). ` +
        `1 destinataire en issue inconnue, non renvoyé.`.trim());
    } else if (isFatalFormatError(res)) {
      release.run(res.error_code, desc, t.id);
      return stop(`Message refusé par Telegram : ${res.description ?? "format invalide"}`);
    } else if (isBotConfigError(res)) {
      release.run(res.error_code, desc, t.id);
      return stop(`Bot refusé par Telegram (${res.error_code}) : ${res.description ?? "token invalide"}`);
    } else if (res.error_code === 429) {
      // Refus explicite : rien livré. Le destinataire est rendu, et plus aucun
      // envoi avant l'heure indiquée par Telegram.
      release.run(429, desc, t.id);
      const after = Math.max(1, Math.min(3600, res.parameters?.retry_after ?? 5));
      db.prepare(`UPDATE lecercle_broadcasts SET resume_after = datetime('now', ?) WHERE id = ?`).run(`+${after} seconds`, bc.id);
      out.deferred = pendingCount(bc.id, db);
      return out;
    } else if (isPermanentRecipientError(res)) {
      settle(t.id, "failed", res.error_code, desc);
      out.failed++;
    } else {
      // Autre refus explicite (4xx) : rien livré, réessayable dans la limite.
      sameRefusals = desc === lastRefusal ? sameRefusals + 1 : 1;
      lastRefusal = desc;
      if (sameRefusals >= 3) {
        release.run(res.error_code, desc, t.id);
        db.prepare(
          `UPDATE lecercle_broadcast_targets SET attempts = MAX(0, attempts - 1)
            WHERE broadcast_id = ? AND status = 'pending' AND error = ? AND error_code = ?`
        ).run(bc.id, desc, res.error_code);
        return stop(`Même refus de Telegram sur 3 destinataires d'affilée (${res.error_code} ${res.description ?? ""}) : pause par précaution`);
      }
      const attempts = (db.prepare(`SELECT attempts FROM lecercle_broadcast_targets WHERE id = ?`).get(t.id) as { attempts: number }).attempts;
      if (attempts >= MAX_ATTEMPTS) {
        settle(t.id, "failed", res.error_code, desc);
        out.failed++;
      } else {
        db.prepare(`UPDATE lecercle_broadcast_targets SET status = 'pending', error_code = ?, error = ? WHERE id = ? AND status = 'sending'`)
          .run(res.error_code, desc, t.id);
      }
    }

    if (spacing > 0) await sleep(spacing);
  }

  out.deferred = pendingCount(bc.id, db);
  if (out.deferred === 0 && inFlightCount(bc.id, db) === 0) {
    const info = db.prepare(
      `UPDATE lecercle_broadcasts SET status = 'done', finished_at = datetime('now') WHERE id = ? AND status = 'running'`
    ).run(bc.id);
    out.finished = info.changes > 0;
  }
  return out;
}

/**
 * Un 403 « blocked » exclut le compte de TOUTES les diffusions suivantes.
 * Upsert : un joueur « sans preuve » qui répond 403 blocked a forcément
 * démarré le bot un jour — il entre dans l'audience, marqué bloqué.
 */
export function markBlocked(telegramId: number, reason: string, db: DbLike): void {
  db.prepare(
    `INSERT INTO lecercle_bot_users (telegram_id, blocked_at, block_reason, origin)
     VALUES (?, datetime('now'), ?, 'send')
     ON CONFLICT(telegram_id) DO UPDATE SET
       blocked_at = COALESCE(lecercle_bot_users.blocked_at, excluded.blocked_at),
       block_reason = COALESCE(lecercle_bot_users.block_reason, excluded.block_reason)`
  ).run(telegramId, reason.slice(0, 200));
}

function keyboard(label: string | null, url: string | null) {
  if (!label || !url) return undefined;
  return { inline_keyboard: [[{ text: label, url }]] };
}

async function defaultSend(chatId: number, bc: LecercleBroadcast, target: { click_token: string }) {
  // Le lien tracké vit UNIQUEMENT dans le bouton. Telegram ne génère pas
  // d'aperçu pour un bouton, donc aucun robot ne le « clique » à l'envoi.
  const kb = keyboard(bc.button_label, bc.button_url ? trackedUrl(target.click_token) : null);
  return tgRetrying<{ message_id?: number }>("sendMessage", {
    chat_id: chatId,
    text: bc.body,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(kb ? { reply_markup: kb } : {}),
  });
}

/**
 * « Test à moi » : hors file, n'écrit RIEN, refusé hors allowedTestChatIds().
 * Le bouton pointe directement vers l'URL finale (aucun jeton créé).
 */
export async function sendTest(
  chatId: number,
  draft: DraftContent,
  sendImpl: (method: string, body: Record<string, any>) => Promise<TgResult> = tgRetrying,
): Promise<ActionResult> {
  if (!allowedTestChatIds().includes(chatId)) {
    return { ok: false, error: `Test refusé : ${chatId} n'est pas un compte de test autorisé` };
  }
  const err = contentError(draft);
  if (err) return { ok: false, error: err };
  const kb = keyboard((draft.buttonLabel ?? "").trim() || null, (draft.buttonUrl ?? "").trim() || null);
  const res = await sendImpl("sendMessage", {
    chat_id: chatId,
    text: draft.body.trim(),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(kb ? { reply_markup: kb } : {}),
  });
  return res.ok ? { ok: true } : { ok: false, error: res.description ?? "échec de l'envoi" };
}
