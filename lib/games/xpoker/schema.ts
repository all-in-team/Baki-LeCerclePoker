// XPoker Twd — SCHÉMA et migration `add_xpoker_twd_v1`. Module pur : aucun import
// de valeur (le type Database ne coûte rien à l'exécution). Importé par lib/db.ts
// ET par scripts/xpoker-schema.test.ts, pour que le test exerce LA MÊME SQL que la
// prod — même mécanisme que lib/pool/schema.ts et lib/funnels/dzpk/schema.
//
// ─────────────────────────────────────────────────────────────────────────────
// LE MODÈLE EN QUATRE PHRASES.
//   1. Le club règle l'agence EN CHIPS, chaque semaine, d'après un sheet :
//      total = 反水% × Σrake + TAX% × (−Σwinlose − Σrake). Importé tel quel,
//      vérifié au centime (xpoker_imports), jamais converti en USDT.
//   2. Un joueur a N Player ID (player_game_ids, game XPOKER_TWD) ; ses résultats
//      s'additionnent au niveau joueur, le détail par compte reste lisible
//      (xpoker_week_rows).
//   3. Le deal (action %, RB %) est porté par le JOUEUR, versionné par semaine
//      (xpoker_player_deals) — et VOLONTAIREMENT hors player_game_deals : la
//      commande bot /deal (lib/telegram-commands/player-self-service.ts) liste
//      player_game_deals AVEC le rakeback au joueur, et le RB XPoker ne doit
//      JAMAIS lui être notifié. Ici la règle est structurelle, pas un filtre.
//   4. L'agence est dépositaire des jetons : ce que le club envoie et ce qui est
//      redistribué (buy-ins, cash-outs, parts d'action, RB) passe par UN grand
//      livre chips (xpoker_chip_ledger). Le stock agence et la position d'un
//      joueur sont deux lectures de ce livre, jamais un même compteur.
//
// DEVISE : tout est en chips (TWD). Le taux chips/USD (xpoker_chip_rates) est
// historisé par date d'effet, FIGÉ sur chaque import et chaque règlement, et ne
// sert qu'à l'AFFICHAGE — un changement de taux ne recalcule jamais une semaine
// déjà importée ou réglée. (Décisions Baki Q1/Q1bis/Q10, 2026-09-13.)
//
// MIGRATION : marqueur posé APRÈS le travail, ROLLBACK dans le catch, corps
// rejouable (IF NOT EXISTS / OR IGNORE / ALTER gardé par pragma_table_info),
// et REFUS de tourner dans la transaction ouverte par une migration antérieure
// (leçon add_a5poker_game_v1 / add_nexa_bankroll_weeks_fk_v2 : un ROLLBACK de
// secours dans un BEGIN étranger annulerait des milliers de lignes de schéma).
// ─────────────────────────────────────────────────────────────────────────────

import type Database from "better-sqlite3";

export const XPOKER_MIGRATION_V1 = "add_xpoker_twd_v1";

/** Tolérance du checksum d'import : au centime (le sheet garde 4 décimales, l'écart réel est ~1e-10). */
export const XPOKER_CHECK_TOLERANCE = 0.005;

/** Une date ISO 'YYYY-MM-DD' — un '13/09/2026' ou un 'hier' ne trierait jamais avec les autres. */
const ISO = "GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";
/** Un lundi ISO : toute semaine du modèle est ancrée sur son lundi, sans exception. */
const MONDAY = (col: string) => `(${col} ${ISO} AND strftime('%w', ${col}) = '1')`;

export const XPOKER_SCHEMA_SQL = `
  -- ── Taux chips/USD, historisé par date d'effet ────────────────────────────
  -- Le taux applicable à une date = la ligne d'effective_from la plus récente
  -- ≤ cette date. Jamais mis à jour en place : on AJOUTE une date d'effet.
  CREATE TABLE IF NOT EXISTS xpoker_chip_rates (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    effective_from TEXT NOT NULL UNIQUE CHECK(effective_from ${ISO}),
    chips_per_usd  REAL NOT NULL CHECK(chips_per_usd > 0),
    note           TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Comptes AGENCE présents dans la grille du club ────────────────────────
  -- Leur win/lose entre dans le total du club (donc dans le checksum) mais
  -- jamais dans une position joueur. Données, pas code : la liste vit ici.
  CREATE TABLE IF NOT EXISTS xpoker_agency_accounts (
    member_id  TEXT PRIMARY KEY,
    label      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Deal du JOUEUR, versionné par semaine ─────────────────────────────────
  -- Bornes en lundis ISO, incluses, end_week NULL = en cours. Versionné et non
  -- écrasé : changer un % ne réécrit jamais une semaine déjà réglée. HORS
  -- player_game_deals, voir l'en-tête de ce fichier (RB jamais notifié).
  CREATE TABLE IF NOT EXISTS xpoker_player_deals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    -- UNITÉ DANS LE NOM (R2 money-auditor, décision Baki 2026-09-13) : *_pct est un
    -- POURCENT (10 = 10 %). Les taux du sheet, eux, sont des FRACTIONS et s'appellent
    -- *_fraction (xpoker_imports.rb_fraction = 0.8). Le CHECK refuse l'entre-deux
    -- ]0, 1[ : « 0.8 » saisi ici serait une fraction déguisée, pas 0,8 %.
    action_pct REAL NOT NULL CHECK(action_pct = 0 OR (action_pct >= 1 AND action_pct <= 100)),
    rb_pct     REAL NOT NULL DEFAULT 0 CHECK(rb_pct = 0 OR (rb_pct >= 1 AND rb_pct <= 100)),
    start_week TEXT NOT NULL CHECK(${MONDAY("start_week")}),
    end_week   TEXT CHECK(end_week IS NULL OR ${MONDAY("end_week")}),
    note       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (end_week IS NULL OR end_week >= start_week),
    UNIQUE(player_id, start_week)
  );
  CREATE INDEX IF NOT EXISTS idx_xpoker_deals_player
    ON xpoker_player_deals(player_id, start_week);
  -- UNE seule période en cours par joueur : deux end_week NULL, c'est deux taux
  -- pour la même semaine et un dealForWeekOn qui choisirait en silence.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_xpoker_deals_one_open
    ON xpoker_player_deals(player_id) WHERE end_week IS NULL;

  -- ── UN import = UNE semaine du sheet, avec sa PROVENANCE FIGÉE ────────────
  -- La semaine est une PLAGE DE DATES CONFIRMÉE À LA MAIN (Baki) ; tab_label est
  -- le nom d'onglet brut, opaque, jamais interprété seul (pas d'année dedans,
  -- '111' = 1/11 ou 11/1).
  -- Les paramètres et le pied de bloc sont RECOPIÉS tels que lus : si le club
  -- change sa formule, le checksum le dit, et la ligne garde ce qu'elle a vu.
  -- sheet_total (U22, « Total ») et sheet_cleared (B20, « 總交收 ») sont STOCKÉS
  -- TOUS LES DEUX : on n'en choisit pas un, cleared_matches dit s'ils divergent
  -- (constaté sur 4 semaines de mars-avril 2026 où B11 = U21). Le montant
  -- effectivement reçu est celui que Baki confirme, jamais celui que la feuille
  -- calcule.
  CREATE TABLE IF NOT EXISTS xpoker_imports (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start          TEXT NOT NULL UNIQUE CHECK(${MONDAY("week_start")}),   -- lundi, confirmé
    week_end            TEXT NOT NULL CHECK(week_end = date(week_start, '+6 days')), -- son dimanche
    tab_label           TEXT,                            -- '8/3', '83', 'Sheet1'… opaque
    source              TEXT NOT NULL CHECK(source IN ('xlsx','csv')),
    filename            TEXT,
    file_hash           TEXT,
    -- Identité du club telle que l'import l'a vue : le nom lu dans la feuille ET
    -- l'ID club de la config. Si un second club arrive un jour, l'historique dit
    -- déjà à qui appartient chaque semaine.
    club_name           TEXT NOT NULL,
    club_id             TEXT,
    -- Paramètres lus dans le bloc — FRACTIONS (0.8 pour 80 %), l'unité est dans le
    -- nom et le CHECK la tient : jamais un pourcent ici (cf. xpoker_player_deals).
    chip_value          REAL NOT NULL,
    rb_fraction         REAL NOT NULL CHECK(rb_fraction >= 0 AND rb_fraction <= 1),
    tax_fraction        REAL NOT NULL CHECK(tax_fraction >= 0 AND tax_fraction <= 1),
    -- Pied de bloc, tel que lu.
    sheet_total_winloss REAL NOT NULL,
    sheet_total_rake    REAL NOT NULL,
    sheet_tax           REAL NOT NULL,
    sheet_rb_amount     REAL NOT NULL,
    sheet_total         REAL NOT NULL,                   -- U22 « Total »
    sheet_cleared       REAL,                            -- B20 « 總交收 » (bloc de règlement, tous clubs), NULL si absent
    sheet_cleared_club_line REAL,                        -- B11, la ligne « <club> » du même bloc — diverge de B20 si d'autres clubs y sont sommés
    -- Recalcul ligne à ligne sur TOUTES les lignes du bloc (agence et
    -- sous-agent comprises : le club les compte, donc le checksum aussi).
    recomputed_rb       REAL NOT NULL,
    recomputed_tax      REAL NOT NULL,
    recomputed_total    REAL NOT NULL,
    check_delta         REAL NOT NULL,                   -- recomputed_total − sheet_total
    -- Générées : les verdicts ne peuvent pas mentir sur leurs propres écarts.
    check_ok INTEGER GENERATED ALWAYS AS
      (CASE WHEN ABS(check_delta) <= ${XPOKER_CHECK_TOLERANCE} THEN 1 ELSE 0 END) STORED,
    cleared_matches INTEGER GENERATED ALWAYS AS
      (CASE WHEN sheet_cleared IS NULL THEN NULL
            WHEN ABS(sheet_cleared - sheet_total) <= ${XPOKER_CHECK_TOLERANCE} THEN 1 ELSE 0 END) STORED,
    -- Sortie explicite « importer quand même, écart acté » (doctrine
    -- rakeback_ack NEXA) : motif obligatoire, la semaine reste marquée en écart,
    -- jamais réglable en un clic. Cas connu : onglet 3/23, TAX = 0 en D2 mais
    -- formule à 5 % dans le pied.
    override_reason     TEXT,
    -- Un sous-agent (Agent ID ≠ agent, Super Agent ID = agent) était présent
    -- dans la grille. Semaine importée avec ce drapeau ; l'ajustement manuel
    -- (chips, signé) reste vide tant que le club n'a pas confirmé un partage.
    sub_agent_present   INTEGER NOT NULL DEFAULT 0,
    sub_agent_adjustment_chips REAL,
    sub_agent_adjustment_note  TEXT,
    -- Taux FIGÉ au commit de l'import (xpoker_chip_rates à week_end).
    rate_chips_per_usd  REAL NOT NULL CHECK(rate_chips_per_usd > 0),
    rows_total          INTEGER NOT NULL,
    note                TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    -- Le filet au niveau du schéma : hors tolérance sans motif = refusé par la base.
    CHECK (ABS(check_delta) <= ${XPOKER_CHECK_TOLERANCE} OR override_reason IS NOT NULL)
  );

  -- ── Détail compte × semaine — SOURCE DE VÉRITÉ des résultats ──────────────
  -- Une ligne par Player ID lu dans le bloc, agence et sous-agent compris.
  -- id_label (R) et nickname (T) sont des LIBELLÉS d'affichage/historique :
  -- on ne rattache JAMAIS dessus, uniquement sur member_id (S).
  -- player_id est RÉSOLU à l'écriture via player_game_ids (game XPOKER_TWD) ;
  -- NULL = à traiter dans l'écran de réconciliation. Le lien validé ne vit
  -- jamais ici : il vit dans player_game_ids, donc un ré-import ne perd rien.
  CREATE TABLE IF NOT EXISTS xpoker_week_rows (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id      INTEGER NOT NULL REFERENCES xpoker_imports(id) ON DELETE CASCADE,
    week_start     TEXT NOT NULL CHECK(${MONDAY("week_start")}),
    member_id      TEXT NOT NULL,
    id_label       TEXT,
    nickname       TEXT,
    agent_id       TEXT,
    super_agent_id TEXT,
    winloss_chips  REAL NOT NULL,
    rake_chips     REAL NOT NULL CHECK(rake_chips >= 0),   -- un rake est toujours ≥ 0 (F2)
    -- 1 = compte agence (xpoker_agency_accounts au moment de l'import) : jamais
    -- de position joueur. 1 = sous-agent présent sur cette ligne.
    is_agency      INTEGER NOT NULL DEFAULT 0 CHECK(is_agency IN (0, 1)),
    is_sub_agent   INTEGER NOT NULL DEFAULT 0 CHECK(is_sub_agent IN (0, 1)),
    player_id      INTEGER REFERENCES players(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(week_start, member_id),
    -- Un compte agence n'a jamais de joueur : le CHECK le tient, pas seulement l'import.
    CHECK (is_agency = 0 OR player_id IS NULL)
  );
  CREATE INDEX IF NOT EXISTS idx_xpoker_rows_player
    ON xpoker_week_rows(player_id, week_start);
  CREATE INDEX IF NOT EXISTS idx_xpoker_rows_import
    ON xpoker_week_rows(import_id);
  CREATE INDEX IF NOT EXISTS idx_xpoker_rows_member
    ON xpoker_week_rows(member_id, week_start);
  -- Alimente l'écran de réconciliation.
  CREATE INDEX IF NOT EXISTS idx_xpoker_rows_unlinked
    ON xpoker_week_rows(week_start) WHERE player_id IS NULL AND is_agency = 0;

  -- ── GRAND LIVRE CHIPS de l'agence ─────────────────────────────────────────
  -- direction vue AGENCE : 'in' = des chips entrent dans mon stock, 'out' = en
  -- sortent. kind dit pourquoi :
  --   club_settlement : le club me règle (in) ou je lui dois (out)
  --   buyin           : je crédite le compte XPoker d'un joueur (out)
  --   cashout         : un joueur me rend des chips (in)
  --   action_paid     : règlement de part d'action — il me règle (in, il a gagné)
  --                     ou je lui verse (out, il a perdu) ; écrit au markPaid du
  --                     règlement, daté paid_date (la date RÉELLE du transfert)
  --   rb_paid         : rakeback versé au joueur (out), jamais notifié ; même
  --                     markPaid, même date
  --   adjustment      : correction manuelle motivée (in/out)
  -- Stock agence = Σ in − Σ out, toutes lignes. Position joueur = ses lignes
  -- (player_id) + ses résultats × son deal. Deux lectures, une table de faits.
  -- settlement_id en NO ACTION : le « délock » de /payments fait DELETE FROM
  -- manual_settlements ; un règlement PAYÉ porte un mouvement, et ce DELETE
  -- doit échouer au niveau du schéma plutôt que laisser un mouvement orphelin.
  CREATE TABLE IF NOT EXISTS xpoker_chip_ledger (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at        TEXT NOT NULL CHECK(occurred_at ${ISO}),
    kind               TEXT NOT NULL CHECK(kind IN ('club_settlement','buyin','cashout','action_paid','rb_paid','adjustment')),
    direction          TEXT NOT NULL CHECK(direction IN ('in','out')),
    chips              REAL NOT NULL CHECK(chips > 0),
    rate_chips_per_usd REAL NOT NULL CHECK(rate_chips_per_usd > 0),  -- figé, affichage seulement
    player_id          INTEGER REFERENCES players(id),
    member_id          TEXT,
    import_id          INTEGER REFERENCES xpoker_imports(id),
    settlement_id      INTEGER REFERENCES manual_settlements(id),
    -- Grand livre APPEND-ONLY : une ligne fausse ne s'efface pas, elle se contre-passe
    -- (kind 'adjustment', sens inverse, même montant, motif). reverses_id pointe la
    -- ligne annulée ; une ligne ne s'annule qu'une fois (index unique ci-dessous).
    reverses_id        INTEGER REFERENCES xpoker_chip_ledger(id),
    note               TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    -- Un buy-in / cash-out est rattaché à un COMPTE (member_id) et remonte au joueur.
    CHECK (kind NOT IN ('buyin','cashout') OR (player_id IS NOT NULL AND member_id IS NOT NULL)),
    CHECK (kind != 'club_settlement' OR (player_id IS NULL AND member_id IS NULL)),
    -- Un versement de règlement porte toujours son règlement ET son joueur.
    CHECK (kind NOT IN ('action_paid','rb_paid') OR (settlement_id IS NOT NULL AND player_id IS NOT NULL)),
    -- Un ajustement manuel sans motif est une ligne qu'on ne saura pas relire dans 3 mois.
    CHECK (kind != 'adjustment' OR (note IS NOT NULL AND length(trim(note)) > 0)),
    -- Une contre-passation est un ajustement.
    CHECK (reverses_id IS NULL OR kind = 'adjustment'),
    -- Un règlement club est TOUJOURS adossé à un import : sans ça il se ressaisit à
    -- l'infini et le stock agence ment (faille F1, money-auditor 2026-09-13). Avec
    -- l'index unique ci-dessous, un import = un règlement, au niveau du schéma.
    CHECK (kind != 'club_settlement' OR import_id IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS idx_xpoker_ledger_player
    ON xpoker_chip_ledger(player_id, occurred_at) WHERE player_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_xpoker_ledger_date
    ON xpoker_chip_ledger(occurred_at);
  -- Un règlement produit AU PLUS un mouvement par nature (action_paid, rb_paid) —
  -- garanti au niveau du schéma : le markPaid ne réussit qu'une fois, et si ce
  -- code repassait, la base refuserait le doublon.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_xpoker_ledger_settlement
    ON xpoker_chip_ledger(settlement_id, kind) WHERE settlement_id IS NOT NULL;
  -- Un règlement club par import.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_xpoker_ledger_import
    ON xpoker_chip_ledger(import_id) WHERE kind = 'club_settlement';
  -- Une ligne ne se contre-passe qu'une fois.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_xpoker_ledger_reverses
    ON xpoker_chip_ledger(reverses_id) WHERE reverses_id IS NOT NULL;

  -- ── TRACE des déplacements de Player ID (R1, fonction de premier rang) ────
  -- Un ID rattaché au mauvais joueur est un cas NORMAL (pseudos qui ressemblent
  -- à des ID : XP40049772 ≠ 4025681). relinkMemberIdOn le déplace explicitement,
  -- recalcule des deux côtés (les résultats sont dérivés à la lecture), refuse
  -- si une semaine concernée est déjà réglée, et laisse CETTE ligne. Jamais de
  -- déplacement silencieux.
  CREATE TABLE IF NOT EXISTS xpoker_relink_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id      TEXT NOT NULL,
    from_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
    to_player_id   INTEGER REFERENCES players(id) ON DELETE SET NULL,
    from_name      TEXT,                                 -- figé : le nom peut changer ensuite
    to_name        TEXT,
    weeks          TEXT NOT NULL,                        -- JSON des week_start déplacées
    movements      INTEGER NOT NULL DEFAULT 0,           -- lignes du grand livre déplacées
    reason         TEXT,
    actor          TEXT NOT NULL DEFAULT 'baki',         -- pas d'auth (v1)
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_xpoker_relink_member ON xpoker_relink_log(member_id, created_at);

  -- ── Semaines couvertes par un règlement joueur (étape 4) ──────────────────
  -- Pattern nexa_action_settlement_weeks : UNIQUE(player_id, week_start) rend
  -- le double règlement impossible au niveau du schéma ; ON DELETE CASCADE
  -- depuis manual_settlements libère les semaines au déverrouillage (un
  -- règlement payé ne se déverrouille pas — garde du moteur, et le NO ACTION du
  -- grand livre ci-dessus). Tout est figé EN CHIPS ; le taux est recopié pour
  -- l'équivalent d'affichage, rien d'autre.
  -- due_chips > 0 : le joueur doit à l'agence · < 0 : l'agence lui verse.
  CREATE TABLE IF NOT EXISTS xpoker_settlement_weeks (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    settlement_id      INTEGER NOT NULL REFERENCES manual_settlements(id) ON DELETE CASCADE,
    player_id          INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    week_start         TEXT NOT NULL CHECK(${MONDAY("week_start")}),
    -- L'import d'où viennent les chiffres figés — pour l'audit, et deleteImportOn le protège.
    import_id          INTEGER REFERENCES xpoker_imports(id),
    winloss_chips      REAL NOT NULL,
    rake_chips         REAL NOT NULL,
    action_pct         REAL NOT NULL CHECK(action_pct = 0 OR (action_pct >= 1 AND action_pct <= 100)),  -- POURCENT
    rb_pct             REAL NOT NULL CHECK(rb_pct = 0 OR (rb_pct >= 1 AND rb_pct <= 100)),              -- POURCENT
    action_chips       REAL NOT NULL,                    -- action_pct/100 × winloss
    rb_chips           REAL NOT NULL CHECK(rb_chips >= 0), -- rb_pct/100 × rake, rake ≥ 0
    due_chips          REAL NOT NULL,                    -- action_chips − rb_chips
    rate_chips_per_usd REAL NOT NULL CHECK(rate_chips_per_usd > 0),
    UNIQUE(player_id, week_start)
  );
  CREATE INDEX IF NOT EXISTS idx_xpoker_settle_weeks_settlement
    ON xpoker_settlement_weeks(settlement_id);
`;

/**
 * Colonnes ADDITIVES sur des tables partagées — toutes nullables ou à défaut
 * constant, posées une par une sous garde pragma_table_info (rejouable).
 *
 * player_game_ids : nickname (T du sheet, libellé), status ('active'|'archived'),
 *   added_at, archived_at. Preuve étape 2a : 12 lecteurs nomment leurs colonnes, 7 écrivains
 *   listent les leurs, aucun `SELECT *`, `status` jamais lu sur cette table.
 * manual_settlements : amount_due_native (le montant RÉGLÉ, en chips),
 *   native_currency ('TWD'), fx_rate_applied (chips/USD figé au lock). Sur ces
 *   lignes amount_due_usdt est un ÉQUIVALENT D'AFFICHAGE, jamais un montant à
 *   payer, et XPoker est EXCLU de la compensation inter-rooms du hub (Baki Q1).
 *   Preuve étape 2b : 0 occurrence des 3 noms, 5 INSERT à colonnes explicites,
 *   2 précédents ALTER additifs, aucun rebuild.
 */
export const XPOKER_ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: "player_game_ids", column: "nickname", ddl: "TEXT" },
  { table: "player_game_ids", column: "status", ddl: "TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived'))" },
  { table: "player_game_ids", column: "added_at", ddl: "TEXT" },
  // Revue « dernière fenêtre » 2026-09-13 : sans date d'archivage, un compte archivé ne
  // dit pas depuis quand — et un import ultérieur sous cet ID ne peut pas être situé.
  { table: "player_game_ids", column: "archived_at", ddl: "TEXT" },
  { table: "manual_settlements", column: "amount_due_native", ddl: "REAL" },
  { table: "manual_settlements", column: "native_currency", ddl: "TEXT" },
  { table: "manual_settlements", column: "fx_rate_applied", ddl: "REAL" },
];

export type XpokerSeed = {
  gameName: string;
  defaultActionPct: number;
  seedChipsPerUsd: number;
  seedRateEffectiveFrom: string;
  agencyAccounts: { member_id: string; label: string }[];
};

export type XpokerMigrationResult = "applied" | "already_applied" | "deferred";

/**
 * Joue `add_xpoker_twd_v1`. Retourne 'deferred' — SANS poser le marqueur — si une
 * migration antérieure a laissé une transaction ouverte (on repassera au boot
 * suivant). Jette après ROLLBACK sur toute autre erreur : l'appelant (lib/db.ts)
 * journalise, et la migration se rejoue au prochain boot, corps rejouable.
 */
export function runXpokerMigrationV1(db: Database.Database, seed: XpokerSeed): XpokerMigrationResult {
  const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`).get(XPOKER_MIGRATION_V1);
  if (already) return "already_applied";
  if (db.inTransaction) return "deferred";

  db.exec("BEGIN");
  try {
    db.exec(XPOKER_SCHEMA_SQL);

    for (const c of XPOKER_ADDED_COLUMNS) {
      const has = (db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(c.table, c.column));
      if (!has) db.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.ddl}`);
    }

    // Nouvelle ligne games — DISTINCTE du legacy 'Xpoker' (id=3, archivé, 0 référence
    // en prod, lecture 2026-09-13). currency 'TWD' : seul lecteur = grindhouse
    // (toUsdt → taux manquant signalé, jamais sommé en brut).
    db.prepare(`INSERT OR IGNORE INTO games (name, status, default_action_pct, currency) VALUES (?, 'active', ?, 'TWD')`)
      .run(seed.gameName, seed.defaultActionPct);
    db.prepare(`INSERT OR IGNORE INTO xpoker_chip_rates (effective_from, chips_per_usd, note) VALUES (?, ?, 'graine — brief 2026-09-13')`)
      .run(seed.seedRateEffectiveFrom, seed.seedChipsPerUsd);
    const insAgency = db.prepare(`INSERT OR IGNORE INTO xpoker_agency_accounts (member_id, label) VALUES (?, ?)`);
    for (const a of seed.agencyAccounts) insAgency.run(a.member_id, a.label);

    // Marqueur APRÈS le travail, dans la même transaction : il n'existe que si tout existe.
    db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run(XPOKER_MIGRATION_V1);
    db.exec("COMMIT");
    return "applied";
  } catch (err) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw err;
  }
}
