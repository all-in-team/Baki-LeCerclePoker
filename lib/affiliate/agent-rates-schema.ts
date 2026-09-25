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
//   5. Une relation créée APRÈS la migration reçoit 50 % sur chaque game actif
//      (kind 'default', « par défaut — à confirmer » dans le CRM), et Baki est
//      notifié. Le blocage ne reste que pour un game sans AUCUNE ligne de taux.
//   6. Relations existantes, games où le filleul n'a pas encore de deal : la
//      migration reproduit ce que l'ancienne règle aurait donné à un deal créé
//      demain — 50 % 'default' si la fenêtre de 30 jours est encore ouverte,
//      0 % 'hors_fenetre' sinon. Rien ne change donc pour un filleul qui ouvre
//      un nouveau game juste après le déploiement.
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
    kind            TEXT NOT NULL CHECK(kind IN ('migration', 'hors_fenetre', 'manual', 'default')),
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

/**
 * Le corps de la migration : fige la règle legacy en lignes de taux « depuis l'origine »
 * pour chaque relation × game. Idempotent (INSERT OR IGNORE sur « une seule origine »).
 * Sorti de la migration pour qu'une base de DÉMO chargée après coup puisse être amorcée
 * par le même code, sans rien supprimer.
 */
export function seedRatesFromLegacyOn(db: Database.Database): void {
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
  // Games où le filleul n'a pas (encore) de deal : ce que l'ancienne règle donnerait à
  // un deal créé maintenant — fenêtre ouverte ⇒ 50 % par défaut, fermée ⇒ 0 % hors fenêtre.
  const now = new Date();
  const noDeal = db.prepare(`
    SELECT ar.id AS relationship_id, ar.start_date, g.id AS game_id
    FROM affiliate_relationships ar CROSS JOIN games g
    WHERE g.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM player_game_deals d WHERE d.player_id = ar.referred_player_id AND d.game_id = g.id)
    ORDER BY ar.id, g.id
  `).all() as { relationship_id: number; start_date: string; game_id: number }[];
  for (const p of noDeal) {
    if (legacyWindowOpenAt(p.start_date, now)) ins.run(p.relationship_id, p.game_id, DEFAULT_AGENT_PCT, "default", DEFAULT_RATE_NOTE + ` (fenêtre 30 j ouverte à la migration, relation du ${p.start_date})`);
    else ins.run(p.relationship_id, p.game_id, 0, "hors_fenetre", `hors fenêtre 30 j figé à la migration (aucun deal, relation du ${p.start_date})`);
  }
  for (const p of pairs) {
    if (legacyIsEligible(p.start_date, p.created_at)) {
      ins.run(p.relationship_id, p.game_id, LEGACY_AGENT_PCT, "migration",
        `taux unique d'avant le ${new Date().toISOString().slice(0, 10)} (deal créé le ${p.created_at}, relation du ${p.start_date})`);
    } else {
      ins.run(p.relationship_id, p.game_id, 0, "hors_fenetre",
        `hors fenêtre 30 j figé à la migration (deal créé le ${p.created_at}, relation du ${p.start_date})`);
    }
  }
}

export type AgentRatesMigrationResult = "applied" | "already_applied" | "deferred";

/** Fenêtre de 30 jours d'une relation encore ouverte à cette date — même arithmétique que legacyIsEligible. */
export function legacyWindowOpenAt(relStartDate: string, at: Date): boolean {
  return (at.getTime() - new Date(relStartDate + "T00:00:00Z").getTime()) / (1000 * 86400) <= 30;
}

export const DEFAULT_AGENT_PCT = 50;
export const DEFAULT_RATE_NOTE = "par défaut — à confirmer";

/**
 * 50 % 'default' depuis l'origine sur chaque game ACTIF qui n'a encore aucune ligne
 * pour cette relation. Appelé à la création d'une relation (décision Baki 2026-09-26).
 * Idempotent (INSERT OR IGNORE sur l'unicité « une seule origine »). Rend les games posés.
 */
export function seedDefaultRatesOn(db: Database.Database, relationshipId: number): { game_id: number; game_name: string }[] {
  const games = db.prepare(`
    SELECT g.id AS game_id, g.name AS game_name FROM games g
    WHERE g.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM affiliate_agent_rates r WHERE r.relationship_id = ? AND r.game_id = g.id)
    ORDER BY g.id
  `).all(relationshipId) as { game_id: number; game_name: string }[];
  const ins = db.prepare(`
    INSERT OR IGNORE INTO affiliate_agent_rates (relationship_id, game_id, agent_pct, start_week, end_week, kind, note)
    VALUES (?, ?, ?, NULL, NULL, 'default', ?)
  `);
  const out: { game_id: number; game_name: string }[] = [];
  for (const g of games) if (ins.run(relationshipId, g.game_id, DEFAULT_AGENT_PCT, DEFAULT_RATE_NOTE).changes > 0) out.push(g);
  return out;
}

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
    seedRatesFromLegacyOn(db);
    db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run(AFFILIATE_AGENT_RATES_MIGRATION_V1);
    db.exec("COMMIT");
    return "applied";
  } catch (err) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEAL PERÇU par game, versionné par semaine — migration `add_game_perceived_deals_v1`.
//
// Le « perçu » (games.perceived_*) est la BASE de la commission de tous les agents
// sur un game (part agence = résultat × action perçue). Il n'était pas versionné :
// le modifier réécrivait tout l'historique, semaines déjà payées comprises (erreur
// A5 20 → 50 % du 25/09). Il vit désormais ici, par périodes de lundis, avec aperçu
// et gel comme les taux agents. Les colonnes games.perceived_* restent comme
// PHOTO de la valeur à la migration (lue par le seul contrôle legacy) : plus rien
// ne les écrit, plus aucun calcul ne les lit.
// ─────────────────────────────────────────────────────────────────────────────

export const GAME_PERCEIVED_MIGRATION_V1 = "add_game_perceived_deals_v1";

const PCT_COL = (c: string) => `CHECK(${c} IS NULL OR ${c} = 0 OR (${c} >= 1 AND ${c} <= 100))`;

export const GAME_PERCEIVED_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS game_perceived_deals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id        INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    -- POURCENTS. NULL = non défini à ce niveau : la cascade descend (relation, puis deal réel).
    action_pct     REAL ${PCT_COL("action_pct")},
    rakeback_pct   REAL ${PCT_COL("rakeback_pct")},
    insurance_pct  REAL ${PCT_COL("insurance_pct")},
    start_week     TEXT CHECK(start_week IS NULL OR ${MONDAY("start_week")}),  -- NULL = depuis l'origine
    end_week       TEXT CHECK(end_week IS NULL OR ${MONDAY("end_week")}),      -- NULL = en cours
    note           TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (end_week IS NULL OR start_week IS NULL OR end_week >= start_week)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_game_perceived_one_origin ON game_perceived_deals(game_id) WHERE start_week IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_game_perceived_start ON game_perceived_deals(game_id, start_week) WHERE start_week IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_game_perceived_one_open ON game_perceived_deals(game_id) WHERE end_week IS NULL;
`;

/** Reprend games.perceived_* « depuis l'origine » pour chaque game où l'un des trois est défini. */
export function runGamePerceivedMigrationV1(db: Database.Database): AgentRatesMigrationResult {
  if (db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`).get(GAME_PERCEIVED_MIGRATION_V1)) return "already_applied";
  if (db.inTransaction) return "deferred";
  db.exec("BEGIN");
  try {
    db.exec(GAME_PERCEIVED_SCHEMA_SQL);
    db.prepare(`
      INSERT OR IGNORE INTO game_perceived_deals (game_id, action_pct, rakeback_pct, insurance_pct, start_week, end_week, note)
      SELECT id, perceived_action_pct, perceived_rakeback_pct, perceived_insurance_pct, NULL, NULL,
             'repris de games.perceived_* à la migration du ' || date('now')
      FROM games
      WHERE perceived_action_pct IS NOT NULL OR perceived_rakeback_pct IS NOT NULL OR perceived_insurance_pct IS NOT NULL
    `).run();
    db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run(GAME_PERCEIVED_MIGRATION_V1);
    db.exec("COMMIT");
    return "applied";
  } catch (err) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw err;
  }
}
