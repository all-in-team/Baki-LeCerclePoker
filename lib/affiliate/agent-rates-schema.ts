// Taux AGENT par (filleul, game), versionné par semaine — SCHÉMA et migration
// `add_affiliate_agent_rates_v1`. Module pur (le type Database ne coûte rien à
// l'exécution) : importé par lib/db.ts ET par scripts/affiliate-agent-rates.test.ts,
// pour que le test exerce LA MÊME SQL que la prod (même mécanisme que xpoker/schema).
//
// ─────────────────────────────────────────────────────────────────────────────
// LE MODÈLE (décisions Baki 2026-09-26).
//   1. La part de l'agent n'est plus un 0.50 codé en dur : c'est un POURCENT de la
//      PART AGENCE (base perçue, inchangée : résultat cash × action perçue), porté
//      par le couple (relation d'affiliation, game) et versionné par semaine
//      (lundis UTC, bornes incluses, end_week NULL = en cours).
//   2. start_week NULL = « depuis l'origine » : c'est la forme que prend le taux
//      migré, pour que la migration couvre TOUT l'historique sans date inventée.
//   3. L'éligibilité (règle des 30 jours sur player_game_deals.created_at) est FIGÉE
//      ici une fois pour toutes : éligible → 50 % depuis l'origine (kind
//      'migration'), hors fenêtre → 0 % depuis l'origine (kind 'hors_fenetre').
//      Après la migration, le calcul ne relit plus created_at : recréer un deal
//      joueur ne fait plus basculer un filleul « hors fenêtre ».
//   4. Un 0 % saisi à la main (kind 'manual') est un taux normal, mais il porte
//      OBLIGATOIREMENT une note (CHECK) : il se distingue du 0 % hors fenêtre.
// ─────────────────────────────────────────────────────────────────────────────

import type Database from "better-sqlite3";

export const AFFILIATE_AGENT_RATES_MIGRATION_V1 = "add_affiliate_agent_rates_v1";

/** Le taux unique d'avant ce chantier, en POURCENT. Ne sert qu'à la migration (et au contrôle legacy). */
export const LEGACY_AGENT_PCT = 50;

const ISO = "GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";
const MONDAY = (col: string) => `(${col} ${ISO} AND strftime('%w', ${col}) = '1')`;

export const AFFILIATE_AGENT_RATES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS affiliate_agent_rates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    relationship_id INTEGER NOT NULL REFERENCES affiliate_relationships(id) ON DELETE CASCADE,
    game_id         INTEGER NOT NULL REFERENCES games(id),
    -- POURCENT de la part agence (25 = 25 %). ]0, 1[ refusé : « 0.25 » serait une
    -- fraction déguisée (même règle R2 que xpoker_player_deals).
    agent_pct       REAL NOT NULL CHECK(agent_pct = 0 OR (agent_pct >= 1 AND agent_pct <= 100)),
    start_week      TEXT CHECK(start_week IS NULL OR ${MONDAY("start_week")}),  -- NULL = depuis l'origine
    end_week        TEXT CHECK(end_week IS NULL OR ${MONDAY("end_week")}),      -- NULL = en cours
    kind            TEXT NOT NULL CHECK(kind IN ('migration', 'hors_fenetre', 'manual')),
    note            TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (end_week IS NULL OR start_week IS NULL OR end_week >= start_week),
    -- Le 0 % saisi à la main n'est jamais anonyme : il dit pourquoi.
    CHECK (kind != 'manual' OR agent_pct != 0 OR (note IS NOT NULL AND length(trim(note)) > 0)),
    CHECK (kind != 'hors_fenetre' OR agent_pct = 0)
  );
  CREATE INDEX IF NOT EXISTS idx_aff_agent_rates_rel_game
    ON affiliate_agent_rates(relationship_id, game_id, start_week);
  -- Unicités : une seule période « depuis l'origine », un seul début par semaine,
  -- une seule période en cours — deux taux pour la même semaine, c'est un calcul
  -- qui choisirait en silence.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_aff_agent_rates_one_origin
    ON affiliate_agent_rates(relationship_id, game_id) WHERE start_week IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_aff_agent_rates_start
    ON affiliate_agent_rates(relationship_id, game_id, start_week) WHERE start_week IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_aff_agent_rates_one_open
    ON affiliate_agent_rates(relationship_id, game_id) WHERE end_week IS NULL;
`;

/**
 * Éligibilité LEGACY d'un game pour une relation — COPIE EXACTE de l'ancien
 * getCommissionRate (lib/queries/affiliate.ts avant ce chantier), même arithmétique
 * de dates JS : le deal compte s'il a été créé au plus 30 jours après le début de
 * la relation (un deal créé AVANT compte aussi). Ne sert plus qu'à figer l'état à
 * la migration et au contrôle legacy.
 */
export function legacyIsEligible(relStartDate: string, dealCreatedAt: string | null): boolean {
  if (!dealCreatedAt) return false;
  const relStart = new Date(relStartDate + "T00:00:00Z");
  const dealCreated = new Date(dealCreatedAt);
  const diffDays = (dealCreated.getTime() - relStart.getTime()) / (1000 * 86400);
  return diffDays <= 30;
}

export type AgentRatesMigrationResult = "applied" | "already_applied" | "deferred";

/**
 * Crée la table et fige l'état actuel : pour CHAQUE relation (tout statut) × CHAQUE
 * game où le filleul a un deal, une période « depuis l'origine » à 50 % (éligible)
 * ou 0 % (hors fenêtre). Rien d'autre n'est touché. Marqueur APRÈS le travail,
 * ROLLBACK dans le catch, report si une transaction étrangère est ouverte.
 */
export function runAffiliateAgentRatesMigrationV1(db: Database.Database): AgentRatesMigrationResult {
  if (db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`).get(AFFILIATE_AGENT_RATES_MIGRATION_V1)) return "already_applied";
  if (db.inTransaction) return "deferred";

  db.exec("BEGIN");
  try {
    db.exec(AFFILIATE_AGENT_RATES_SCHEMA_SQL);
    const pairs = db.prepare(`
      SELECT ar.id AS relationship_id, ar.start_date, pgd.game_id, pgd.created_at
      FROM affiliate_relationships ar
      JOIN player_game_deals pgd ON pgd.player_id = ar.referred_player_id
      ORDER BY ar.id, pgd.game_id
    `).all() as { relationship_id: number; start_date: string; game_id: number; created_at: string | null }[];
    const ins = db.prepare(`
      INSERT OR IGNORE INTO affiliate_agent_rates (relationship_id, game_id, agent_pct, start_week, end_week, kind, note)
      VALUES (?, ?, ?, NULL, NULL, ?, ?)
    `);
    for (const p of pairs) {
      if (legacyIsEligible(p.start_date, p.created_at)) {
        ins.run(p.relationship_id, p.game_id, LEGACY_AGENT_PCT, "migration",
          `taux unique d'avant le ${new Date().toISOString().slice(0, 10)} (deal créé le ${p.created_at}, relation du ${p.start_date})`);
      } else {
        ins.run(p.relationship_id, p.game_id, 0, "hors_fenetre",
          `hors fenêtre 30 j figé à la migration (deal créé le ${p.created_at}, relation du ${p.start_date})`);
      }
    }
    db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run(AFFILIATE_AGENT_RATES_MIGRATION_V1);
    db.exec("COMMIT");
    return "applied";
  } catch (err) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw err;
  }
}
