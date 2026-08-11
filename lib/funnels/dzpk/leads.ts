// Enregistrement et lecture des leads dzpk.
//
// Toutes les fonctions acceptent un `dbOverride` : c'est ce qui rend la logique
// testable sur une base temporaire, sans dépendre de `data/lecercle.db` (qui ne
// s'initialise pas hors Railway). Même parti pris que `logRichAdsClick`, pour la
// même raison — un test qui recopie le SQL au lieu d'exécuter le vrai code ne
// prouve rien.

import { getDb } from "@/lib/db";
import { DEFAULT_SOURCE, SOURCE_MAX_LEN } from "./config";
import { nameKey } from "./name-key";

/**
 * Nom d'affichage Telegram : `first_name` + `last_name`.
 *
 * C'EST la clé d'appariement du funnel. Le club reprend automatiquement le nom
 * du compte Telegram quand le joueur rejoint — le joueur ne choisit aucun pseudo
 * séparé. Ce que le club affichera dans « 已绑定为代理 [nom] » est donc, à un
 * renommage près, exactement cette chaîne.
 *
 * Reconstruit ici plutôt que lu d'un champ Telegram : l'API ne fournit pas de
 * `display_name`, seulement les deux morceaux.
 */
export function displayName(identity: Pick<TgIdentity, "first_name" | "last_name">): string {
  return [identity.first_name, identity.last_name].filter(Boolean).join(" ").trim();
}

export interface DbLike {
  prepare(sql: string): {
    run(...args: any[]): { changes: number; lastInsertRowid: number | bigint };
    get(...args: any[]): any;
    all(...args: any[]): any[];
  };
}

export interface DzpkLead {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  source: string;
  source_raw: string | null;
  started_at: string;
  last_start_at: string;
  start_count: number;
  last_message_at: string | null;
  first_reply_at: string | null;
  club_joined_at: string | null;
  bound_at: string | null;
  banned_at: string | null;
  converted_at: string | null;
  last_followup_at: string | null;
  blocked: number;
  notes: string | null;
}

/** Identité Telegram telle qu'observée sur un contact donné. */
export interface TgIdentity {
  telegram_id: number;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

// ── Source ────────────────────────────────────────────────

/**
 * Nettoyage du payload de deep link.
 *
 * Le contrat de Baki est « texte libre loggé tel quel, organic si vide ». On le
 * respecte : AUCUNE liste blanche de sources, une source jamais vue est une
 * source valide — c'est tout l'intérêt du système (ajouter un canal = créer un
 * lien, zéro code).
 *
 * Le contrôle de FORME reste indispensable : cette valeur vient d'une URL
 * publique et finit affichée dans le back-office. On borne, on retire les
 * caractères de contrôle, et on plie la casse pour que `TgAds` et `tgads` ne
 * comptent pas comme deux canaux.
 *
 * Le payload BRUT est conservé à part (`source_raw`) : si un jour une source
 * arrive tronquée ou déformée, la valeur d'origine reste consultable.
 */
export function normalizeSource(payload: string | null | undefined): string {
  if (payload == null) return DEFAULT_SOURCE;
  const cleaned = stripControl(String(payload)).replace(/\s+/g, " ").trim().toLowerCase();
  if (cleaned === "") return DEFAULT_SOURCE;
  return cleaned.slice(0, SOURCE_MAX_LEN);
}

/**
 * Retire les caractères de contrôle (C0, DEL, C1).
 *
 * Écrit par code de caractère plutôt que par classe d'expression régulière : une
 * classe du type [\\x00-\\x1f] est illisible, se corrompt au copier-coller, et une
 * plage mal bornée y avalerait des caractères imprimables sans que personne ne
 * le voie. Ici l'intention se vérifie à l'œil.
 *
 * Les caractères non-ASCII imprimables sont CONSERVÉS : une source peut
 * légitimement être nommée en chinois.
 */
function stripControl(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    // Tabulation, saut de ligne, retour chariot : ce sont des SÉPARATEURS, pas
    // du bruit. Les supprimer collerait deux mots ("tg⇥ads" → "tgads") alors
    // qu'un espace au même endroit serait conservé — deux traitements pour le
    // même rôle. On les laisse passer, le collapse d'espaces qui suit s'en
    // charge de façon uniforme.
    if (c === 0x09 || c === 0x0a || c === 0x0d) { out += ch; continue; }
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

// ── Idempotence des updates ───────────────────────────────

/**
 * true = update déjà traité, l'appelant doit s'arrêter là.
 *
 * Table PROPRE au bot dzpk. Partager `telegram_updates` avec le bot principal
 * serait un bug : les deux bots numérotent leurs updates indépendamment, donc
 * un /start dzpk portant un update_id déjà vu côté NEXA serait jeté en silence.
 *
 * Fail-open : en cas d'erreur base, on préfère un doublon possible à un /start
 * perdu — un lead qui reçoit deux messages d'accueil est un incident mineur,
 * un lead qui n'en reçoit aucun est un clic payé pour rien.
 */
export function isDuplicateDzpkUpdate(updateId: unknown, dbOverride?: DbLike): boolean {
  if (typeof updateId !== "number" || !Number.isFinite(updateId)) return false;
  try {
    const db = dbOverride ?? getDb();
    const info = db.prepare(`INSERT OR IGNORE INTO dzpk_updates (update_id) VALUES (?)`).run(updateId);
    if (info.changes === 0) return true;
    // Purge opportuniste — table jetable, pas de cron dédié.
    if (updateId % 50 === 0) {
      db.prepare(`DELETE FROM dzpk_updates WHERE created_at < datetime('now', '-24 hours')`).run();
    }
    return false;
  } catch (e: any) {
    console.error("[DZPK] dedup update failed:", e?.message ?? e);
    return false;
  }
}

// ── Journal ───────────────────────────────────────────────

/**
 * Journalise un événement.
 *
 * L'identité observée est copiée sur CHAQUE événement, pas seulement sur le
 * lead. C'est redondant et c'est voulu : le club ne renvoie qu'un nom libre, et
 * un lead qui a renommé son compte Telegram entre son /start et sa première
 * partie ne serait plus appariable si seule la dernière identité subsistait.
 * Cette redondance est la matière première du rattrapage manuel en phase 2.
 */
export function logLeadEvent(
  leadId: number,
  kind: string,
  opts: { source?: string | null; identity?: TgIdentity; payload?: unknown } = {},
  dbOverride?: DbLike,
): void {
  try {
    const db = dbOverride ?? getDb();
    db.prepare(
      `INSERT INTO dzpk_lead_events (lead_id, kind, source, username, first_name, last_name, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      leadId,
      kind,
      opts.source ?? null,
      opts.identity?.username ?? null,
      opts.identity?.first_name ?? null,
      opts.identity?.last_name ?? null,
      opts.payload === undefined ? null : JSON.stringify(opts.payload),
    );
  } catch (e: any) {
    // Un journal qui casse ne doit pas faire tomber l'accueil du lead.
    console.error("[DZPK] logLeadEvent failed:", e?.message ?? e);
  }
}

// ── Enregistrement du /start ──────────────────────────────

export interface RecordStartResult {
  lead: DzpkLead;
  /** false = re-/start d'un lead déjà connu. */
  created: boolean;
  /** Source portée par CE /start, même quand elle est ignorée au profit du first-touch. */
  observedSource: string;
}

/**
 * Point d'entrée unique du /start. Idempotent par construction.
 *
 * FIRST-TOUCH : `source` n'est écrite qu'à la création. Un re-/start portant
 * une autre source incrémente `start_count`, loggue un événement `restart` avec
 * la source observée, et laisse la colonne intacte. L'attribution revient à la
 * pub qui a payé le premier contact — arbitrage explicite de Baki.
 *
 * L'identité, elle, EST rafraîchie : c'est la plus récente qui sert à joindre
 * le lead. L'ancienne n'est pas perdue pour autant, elle reste dans le journal.
 */
export function recordStart(
  identity: TgIdentity,
  payload: string | null | undefined,
  dbOverride?: DbLike,
): RecordStartResult {
  const db = dbOverride ?? getDb();
  const observedSource = normalizeSource(payload);
  const rawPayload = payload == null || payload === "" ? null : String(payload).slice(0, 256);

  const existing = db.prepare(`SELECT * FROM dzpk_leads WHERE telegram_id = ?`)
    .get(identity.telegram_id) as DzpkLead | undefined;

  const display = displayName(identity);

  if (!existing) {
    const info = db.prepare(
      `INSERT INTO dzpk_leads (telegram_id, username, first_name, last_name, source, source_raw,
                               display_name, display_name_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      identity.telegram_id,
      identity.username ?? null,
      identity.first_name ?? null,
      identity.last_name ?? null,
      observedSource,
      rawPayload,
      display,
      nameKey(display),
    );
    const lead = db.prepare(`SELECT * FROM dzpk_leads WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as DzpkLead;
    logLeadEvent(lead.id, "start", { source: observedSource, identity, payload: { raw: rawPayload } }, dbOverride);
    return { lead, created: true, observedSource };
  }

  // Re-/start : identité rafraîchie, source NON touchée.
  db.prepare(
    `UPDATE dzpk_leads
        SET username = ?, first_name = ?, last_name = ?,
            display_name = ?, display_name_key = ?,
            last_start_at = datetime('now'),
            start_count = start_count + 1,
            updated_at = datetime('now')
      WHERE id = ?`
  ).run(
    identity.username ?? null,
    identity.first_name ?? null,
    identity.last_name ?? null,
    display,
    nameKey(display),
    existing.id,
  );
  logLeadEvent(
    existing.id,
    "restart",
    { source: observedSource, identity, payload: { raw: rawPayload, kept_source: existing.source } },
    dbOverride,
  );
  const lead = db.prepare(`SELECT * FROM dzpk_leads WHERE id = ?`).get(existing.id) as DzpkLead;
  return { lead, created: false, observedSource };
}

// ── Messages entrants ─────────────────────────────────────

/**
 * Trace un message écrit par le lead.
 *
 * En phase 1 le bot ne répond pas encore (le relais humain arrive en phase 3) —
 * mais le message est CONSERVÉ dès maintenant, texte inclus, dans le journal.
 * Sans ça, tout ce que les leads écriront avant la phase 3 serait perdu, et
 * c'est précisément le bug que le live takeover corrige côté NEXA.
 */
export function recordLeadMessage(
  identity: TgIdentity,
  text: string | null,
  kind = "message",
  dbOverride?: DbLike,
): DzpkLead | null {
  const db = dbOverride ?? getDb();
  const lead = db.prepare(`SELECT * FROM dzpk_leads WHERE telegram_id = ?`)
    .get(identity.telegram_id) as DzpkLead | undefined;
  if (!lead) return null;

  db.prepare(
    `UPDATE dzpk_leads
        SET last_message_at = datetime('now'),
            first_reply_at  = COALESCE(first_reply_at, datetime('now')),
            username = ?, first_name = ?, last_name = ?,
            updated_at = datetime('now')
      WHERE id = ?`
  ).run(
    identity.username ?? null,
    identity.first_name ?? null,
    identity.last_name ?? null,
    lead.id,
  );
  logLeadEvent(lead.id, kind, { identity, payload: { text: text ?? null } }, dbOverride);
  return db.prepare(`SELECT * FROM dzpk_leads WHERE id = ?`).get(lead.id) as DzpkLead;
}

/** Marque un lead comme ayant bloqué le bot. Idempotent. */
export function markBlocked(leadId: number, dbOverride?: DbLike): void {
  const db = dbOverride ?? getDb();
  const info = db.prepare(
    `UPDATE dzpk_leads SET blocked = 1, updated_at = datetime('now') WHERE id = ? AND blocked = 0`
  ).run(leadId);
  if (info.changes > 0) logLeadEvent(leadId, "blocked", {}, dbOverride);
}

// ── Lecture ───────────────────────────────────────────────

export function getLeadByTelegramId(telegramId: number, dbOverride?: DbLike): DzpkLead | undefined {
  const db = dbOverride ?? getDb();
  return db.prepare(`SELECT * FROM dzpk_leads WHERE telegram_id = ?`).get(telegramId) as DzpkLead | undefined;
}

export type DzpkState = "converted" | "bound" | "joined" | "replied" | "started";

/**
 * État affiché, DÉRIVÉ des faits — jamais stocké.
 *
 * L'ordre de priorité descend du plus engageant au moins engageant. Il ne
 * suppose aucune séquence : un lead peut avoir écrit sans avoir rejoint, ou
 * avoir été rattaché sans avoir jamais écrit. C'est exactement pour ça qu'une
 * colonne `state` unique serait fausse.
 *
 * `banned` n'est pas un état ici : un joueur banni a bel et bien été rattaché,
 * et l'effacer de l'étape « bound » fausserait le taux de conversion de sa
 * source. Le bannissement se lit sur `banned_at`, en attribut.
 */
export function deriveState(lead: Pick<DzpkLead,
  "converted_at" | "bound_at" | "club_joined_at" | "first_reply_at">): DzpkState {
  if (lead.converted_at) return "converted";
  if (lead.bound_at) return "bound";
  if (lead.club_joined_at) return "joined";
  if (lead.first_reply_at) return "replied";
  return "started";
}

export interface SourceStatsRow {
  source: string;
  starts: number;
  joined: number;
  bound: number;
  replied: number;
  blocked: number;
  banned: number;
}

/**
 * Funnel par source.
 *
 * Les compteurs sont CUMULATIFS et non exclusifs : un lead rattaché compte
 * aussi dans `joined` s'il a une date de join. Un taux start→bound se lit donc
 * directement, sans recomposer des tranches. C'est le contraire de ce que
 * donnerait un GROUP BY sur un état unique, où chaque lead ne serait compté
 * qu'une fois, dans sa case la plus avancée.
 *
 * Conséquence à garder en tête à l'affichage : `joined >= bound` n'est PAS
 * garanti — le club peut rattacher un joueur dont on n'a jamais vu la notif de
 * join (notif ratée, ou lead entré avant la mise en service de l'ingestion).
 */
export function getStatsBySource(dbOverride?: DbLike): SourceStatsRow[] {
  const db = dbOverride ?? getDb();
  return db.prepare(
    `SELECT source,
            COUNT(*)                                          AS starts,
            SUM(CASE WHEN club_joined_at IS NOT NULL THEN 1 ELSE 0 END) AS joined,
            SUM(CASE WHEN bound_at       IS NOT NULL THEN 1 ELSE 0 END) AS bound,
            SUM(CASE WHEN first_reply_at IS NOT NULL THEN 1 ELSE 0 END) AS replied,
            SUM(CASE WHEN blocked = 1                THEN 1 ELSE 0 END) AS blocked,
            SUM(CASE WHEN banned_at      IS NOT NULL THEN 1 ELSE 0 END) AS banned
       FROM dzpk_leads
      GROUP BY source
      ORDER BY starts DESC, source`
  ).all() as SourceStatsRow[];
}
