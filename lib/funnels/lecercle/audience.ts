// Audience des diffusions @LeCercle_Lebot : qui peut-on cibler, et qui est écarté.
//
// ┌─ D'OÙ VIENNENT LES DESTINATAIRES ──────────────────────────────────────────┐
// │ `lecercle_bot_users` = tout compte vu en conversation privée avec le bot. │
// │ Alimentée par le webhook (tracking.ts) et initialisée une fois depuis les  │
// │ cinq tables qui gardaient une trace de /start (backfillBotUsers).          │
// │                                                                            │
// │ En option, décochée par défaut : les joueurs qui ont un telegram_id mais   │
// │ aucune preuve d'avoir démarré le bot. La plupart ne peuvent pas recevoir   │
// │ de message (403 « can't initiate conversation »).                          │
// └────────────────────────────────────────────────────────────────────────────┘
//
// Les exclusions d'office sont calculées dans le MÊME SQL que les destinataires :
// le chiffre montré dans l'écran, celui du récap et la liste figée à la création
// sortent de la même requête.

import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import { OWNER_IDS } from "@/lib/telegram-commands/helpers";
import {
  SOURCE_KEYS, DEFAULT_SEGMENT, segmentError,
  type SourceKey, type ExclusionMotive, type LecercleSegment,
} from "./segment";

export type DbLike = Database.Database;

export {
  SOURCE_KEYS, SOURCE_LABELS, ONBOARDING_STAGES, NEXA_STAGES, QQPK_STAGES, MOTIVE_LABELS,
  DEFAULT_SEGMENT, segmentError,
} from "./segment";
export type { SourceKey, ExclusionMotive, LecercleSegment } from "./segment";

/** « 2026-09-25 » en UTC+8 → borne SQL UTC du début de ce jour-là. */
function dayStartUtc(day: string, addDays = 0): string {
  const d = new Date(`${day}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + addDays);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

const inList = (n: number) => Array.from({ length: n }, () => "?").join(",");

/**
 * Le SQL de l'audience : une ligne par telegram_id, avec son motif d'exclusion
 * (`motive` NULL = destinataire).
 *
 * Le motif est le PREMIER qui s'applique, dans cet ordre : opérateur, bloqué,
 * relances coupées, takeover. Chaque compte n'est donc compté qu'une fois dans
 * les exclus, et « destinataires + exclus = comptes du segment » tient toujours.
 */
function audienceSql(seg: LecercleSegment, owners: number[]): { sql: string; params: any[] } {
  const params: any[] = [];

  // ── Appartenance aux sources, avec les filtres d'étape de chaque funnel ──
  const srcClauses: string[] = [];
  const has = (k: SourceKey) => seg.sources.includes(k);

  if (has("onboarding")) {
    let c = `EXISTS (SELECT 1 FROM onboarding_leads o WHERE o.telegram_id = a.telegram_id`;
    if (seg.onboardingStages) { c += ` AND o.stage IN (${inList(seg.onboardingStages.length)})`; params.push(...seg.onboardingStages); }
    srcClauses.push(c + ")");
  }
  if (has("nexa")) {
    let c = `EXISTS (SELECT 1 FROM nexa_leads n WHERE n.tg_user_id = a.telegram_id`;
    if (seg.nexaStages) { c += ` AND n.stage IN (${inList(seg.nexaStages.length)})`; params.push(...seg.nexaStages); }
    if (seg.nexaSources) { c += ` AND n.source IN (${inList(seg.nexaSources.length)})`; params.push(...seg.nexaSources); }
    srcClauses.push(c + ")");
  }
  if (has("qqpk")) {
    let c = `EXISTS (SELECT 1 FROM qqpk_funnel_leads q WHERE q.telegram_id = a.telegram_id`;
    if (seg.qqpkStages) { c += ` AND q.stage IN (${inList(seg.qqpkStages.length)})`; params.push(...seg.qqpkStages); }
    srcClauses.push(c + ")");
  }
  if (has("affiliate")) {
    srcClauses.push(`EXISTS (SELECT 1 FROM affiliate_leads f WHERE f.referred_telegram_id = a.telegram_id)`);
  }
  if (has("player")) {
    srcClauses.push(`EXISTS (SELECT 1 FROM players p WHERE p.telegram_id = a.telegram_id
                     AND CAST(p.telegram_chat_id AS INTEGER) = p.telegram_id)`);
  }
  if (has("other")) {
    srcClauses.push(`NOT EXISTS (SELECT 1 FROM onboarding_leads o WHERE o.telegram_id = a.telegram_id)
      AND NOT EXISTS (SELECT 1 FROM nexa_leads n WHERE n.tg_user_id = a.telegram_id)
      AND NOT EXISTS (SELECT 1 FROM qqpk_funnel_leads q WHERE q.telegram_id = a.telegram_id)
      AND NOT EXISTS (SELECT 1 FROM affiliate_leads f WHERE f.referred_telegram_id = a.telegram_id)
      AND NOT EXISTS (SELECT 1 FROM players p WHERE p.telegram_id = a.telegram_id
                      AND CAST(p.telegram_chat_id AS INTEGER) = p.telegram_id)`);
  }

  // Un joueur « sans preuve » n'est dans aucune source par construction : il
  // entre par sa case à lui, pas par les sources.
  const provenMatch = srcClauses.length ? `(a.unproven = 0 AND ((${srcClauses.join(") OR (")})))` : "0";
  let where = seg.includeUnproven ? `(${provenMatch} OR a.unproven = 1)` : provenMatch;

  if (seg.linked === "yes") where += ` AND EXISTS (SELECT 1 FROM players p WHERE p.telegram_id = a.telegram_id)`;
  if (seg.linked === "no") where += ` AND NOT EXISTS (SELECT 1 FROM players p WHERE p.telegram_id = a.telegram_id)`;
  if (seg.startedFrom) { where += ` AND a.first_seen_at >= ?`; params.push(dayStartUtc(seg.startedFrom)); }
  if (seg.startedTo) { where += ` AND a.first_seen_at < ?`; params.push(dayStartUtc(seg.startedTo, 1)); }
  if (seg.activeWithinDays) { where += ` AND a.last_seen_at >= datetime('now', ?)`; params.push(`-${seg.activeWithinDays} days`); }
  if (seg.inactiveForDays) {
    where += ` AND (a.last_seen_at IS NULL OR a.last_seen_at < datetime('now', ?))`;
    params.push(`-${seg.inactiveForDays} days`);
  }

  // Les propriétaires sont passés en paramètres, jamais interpolés. Liste vide :
  // un IN () est invalide en SQLite, d'où la valeur impossible.
  const ownerList = owners.length ? owners : [-1];
  const motive = `CASE
      WHEN a.telegram_id IN (${inList(ownerList.length)}) THEN 'owner'
      WHEN a.blocked_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM nexa_leads n WHERE n.tg_user_id = a.telegram_id AND n.blocked = 1)
        OR EXISTS (SELECT 1 FROM qqpk_funnel_leads q WHERE q.telegram_id = a.telegram_id AND q.blocked = 1)
        THEN 'blocked'
      WHEN EXISTS (SELECT 1 FROM nexa_leads n WHERE n.tg_user_id = a.telegram_id AND n.relances_off = 1)
        THEN 'relances_off'
      WHEN EXISTS (SELECT 1 FROM nexa_leads n WHERE n.tg_user_id = a.telegram_id
                   AND ((n.takeover_until IS NOT NULL AND n.takeover_until > datetime('now'))
                        OR n.awaiting_human_since IS NOT NULL))
        THEN 'takeover'
      ELSE NULL END`;

  const unprovenBranch = seg.includeUnproven
    ? `UNION ALL
       SELECT p.telegram_id, MAX(p.telegram_handle), MAX(p.name), NULL, NULL, NULL, 1
         FROM players p
        WHERE p.telegram_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM lecercle_bot_users u WHERE u.telegram_id = p.telegram_id)
        GROUP BY p.telegram_id`
    : "";

  const sql = `
    WITH a AS (
      SELECT telegram_id, username, first_name, first_seen_at, last_seen_at, blocked_at, 0 AS unproven
        FROM lecercle_bot_users
      ${unprovenBranch}
    )
    SELECT a.telegram_id, a.username, a.first_name, a.unproven, ${motive} AS motive
      FROM a
     WHERE ${where}
     ORDER BY a.telegram_id`;

  // Ordre des paramètres = ordre d'apparition : le CASE (SELECT) précède le WHERE.
  return { sql, params: [...ownerList, ...params] };
}

export interface AudienceRow {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  unproven: number;
  motive: ExclusionMotive | null;
}

export interface AudienceSummary {
  recipients: number;
  excluded: Partial<Record<ExclusionMotive, number>>;
  /** Parmi les destinataires, combien sont des joueurs sans preuve de /start. */
  unproven: number;
}

function ownerIds(opts?: { owners?: number[] }): number[] {
  return opts?.owners ?? [...OWNER_IDS];
}

export function resolveAudience(seg: LecercleSegment, opts?: { owners?: number[] }, dbOverride?: DbLike): AudienceRow[] {
  if (segmentError(seg)) return [];
  const db = dbOverride ?? getDb();
  const { sql, params } = audienceSql(seg, ownerIds(opts));
  return db.prepare(sql).all(...params) as AudienceRow[];
}

export function summarize(rows: AudienceRow[]): AudienceSummary {
  const out: AudienceSummary = { recipients: 0, excluded: {}, unproven: 0 };
  for (const r of rows) {
    if (r.motive) out.excluded[r.motive] = (out.excluded[r.motive] ?? 0) + 1;
    else {
      out.recipients++;
      if (r.unproven) out.unproven++;
    }
  }
  return out;
}

export function countAudience(seg: LecercleSegment, opts?: { owners?: number[] }, dbOverride?: DbLike): AudienceSummary {
  return summarize(resolveAudience(seg, opts, dbOverride));
}

/**
 * Motif d'exclusion d'UN compte à cet instant.
 *
 * Relu par le moteur juste avant chaque envoi : une diffusion figée hier (ou
 * programmée) ne doit pas partir chez quelqu'un qui a bloqué le bot ou qu'un
 * opérateur a pris en main entre-temps. Même CASE que l'audience.
 */
export function currentExclusion(telegramId: number, opts?: { owners?: number[] }, dbOverride?: DbLike): ExclusionMotive | null {
  const db = dbOverride ?? getDb();
  const owners = ownerIds(opts);
  if (owners.includes(telegramId)) return "owner";
  const row = db.prepare(`
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM lecercle_bot_users u WHERE u.telegram_id = @id AND u.blocked_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM nexa_leads n WHERE n.tg_user_id = @id AND n.blocked = 1)
        OR EXISTS (SELECT 1 FROM qqpk_funnel_leads q WHERE q.telegram_id = @id AND q.blocked = 1)
        THEN 'blocked'
      WHEN EXISTS (SELECT 1 FROM nexa_leads n WHERE n.tg_user_id = @id AND n.relances_off = 1)
        THEN 'relances_off'
      WHEN EXISTS (SELECT 1 FROM nexa_leads n WHERE n.tg_user_id = @id
                   AND ((n.takeover_until IS NOT NULL AND n.takeover_until > datetime('now'))
                        OR n.awaiting_human_since IS NOT NULL))
        THEN 'takeover'
      ELSE NULL END AS motive`).get({ id: telegramId }) as { motive: ExclusionMotive | null };
  return row.motive;
}

// ── Facettes pour l'écran ─────────────────────────────────

export interface AudienceFacets {
  botUsers: number;
  bySource: Record<SourceKey, number>;
  onboardingStages: Record<string, number>;
  nexaStages: Record<string, number>;
  nexaSources: Record<string, number>;
  qqpkStages: Record<string, number>;
  unprovenPlayers: number;
}

/** Volumes par case à cocher, comptés sur l'audience connue (bot_users). */
export function getAudienceFacets(dbOverride?: DbLike): AudienceFacets {
  const db = dbOverride ?? getDb();
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const group = (sql: string) => Object.fromEntries(
    (db.prepare(sql).all() as Array<{ k: string; n: number }>).map(r => [String(r.k), r.n]),
  );

  const bySource = {} as Record<SourceKey, number>;
  for (const k of SOURCE_KEYS) {
    const seg: LecercleSegment = { ...DEFAULT_SEGMENT, sources: [k] };
    const { sql, params } = audienceSql(seg, [-1]);
    bySource[k] = (db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...params) as { n: number }).n;
  }

  return {
    botUsers: n(`SELECT COUNT(*) AS n FROM lecercle_bot_users`),
    bySource,
    onboardingStages: group(`SELECT o.stage AS k, COUNT(*) AS n FROM onboarding_leads o
      JOIN lecercle_bot_users u ON u.telegram_id = o.telegram_id GROUP BY o.stage`),
    nexaStages: group(`SELECT x.stage AS k, COUNT(*) AS n FROM nexa_leads x
      JOIN lecercle_bot_users u ON u.telegram_id = x.tg_user_id GROUP BY x.stage`),
    nexaSources: group(`SELECT x.source AS k, COUNT(*) AS n FROM nexa_leads x
      JOIN lecercle_bot_users u ON u.telegram_id = x.tg_user_id GROUP BY x.source ORDER BY n DESC`),
    qqpkStages: group(`SELECT q.stage AS k, COUNT(*) AS n FROM qqpk_funnel_leads q
      JOIN lecercle_bot_users u ON u.telegram_id = q.telegram_id GROUP BY q.stage`),
    unprovenPlayers: n(`SELECT COUNT(DISTINCT p.telegram_id) AS n FROM players p
      WHERE p.telegram_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM lecercle_bot_users u WHERE u.telegram_id = p.telegram_id)`),
  };
}

// L'initialisation depuis les cinq sources vit dans schema.ts (module pur), pour
// que la migration de lib/db.ts puisse l'appeler sans cycle d'import.
export { backfillBotUsers } from "./schema";
