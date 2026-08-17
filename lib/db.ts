import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
// DDL du funnel dzpk. Vit dans son propre module pour que la migration et les
// tests exécutent LA MÊME chaîne SQL — un test qui recopie le schéma valide sa
// copie, pas la base. Ce module n'importe rien, aucun cycle possible.
import {
  DZPK_SCHEMA_SQL, DZPK_MIGRATION_V1,
  DZPK_INGEST_SCHEMA_SQL, DZPK_MIGRATION_INGEST_V1,
  DZPK_MATCH_SCHEMA_SQL, DZPK_MATCH_SCHEMA_SQL_2, DZPK_MATCH_SCHEMA_SQL_3, DZPK_MIGRATION_MATCH_V1,
  DZPK_BROADCAST_SCHEMA_SQL, DZPK_MIGRATION_BROADCAST_V1,
  DZPK_TAKEOVER_SCHEMA_SQL, DZPK_TAKEOVER_ALTER_READ, DZPK_TAKEOVER_ALTER_RELAY,
  DZPK_MIGRATION_TAKEOVER_V1,
  DZPK_POSTBACK_ALTER_CLICK, DZPK_POSTBACK_ALTER_SENT, DZPK_POSTBACK_ALTER_RESULT,
  DZPK_MIGRATION_POSTBACK_V1,
  DZPK_POSTBACK_ALTER_JOIN_SENT, DZPK_POSTBACK_ALTER_JOIN_RESULT,
  DZPK_MIGRATION_POSTBACK_V2,
  DZPK_WELCOME_AB_ALTER, DZPK_MIGRATION_WELCOME_AB_V1,
} from "./funnels/dzpk/schema";
// Module pur (aucun import) : utilisable depuis une migration sans cycle.
import { nameKey as dzpkNameKey } from "./funnels/dzpk/name-key";

// Quarantaine des mouvements wallet — cf. la migration en bas de ce fichier.
export const WALLET_TX_QUARANTINE_V1 = "add_wallet_tx_quarantine_v1";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "lecercle.db");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  initSchema(_db);
  return _db;
}

// Read-only connection for the agent's query_db tool — the engine itself
// rejects any write, regardless of what SQL slips past upstream validation.
let _roDb: Database.Database | null = null;

export function getReadonlyDb(): Database.Database {
  if (_roDb) return _roDb;
  getDb(); // ensure the file exists and migrations ran first
  _roDb = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return _roDb;
}

function initSchema(db: Database.Database) {
  console.log(`[BOOT] migrations starting, db=${DB_PATH}`);
  try {
    const applied = db.prepare(`SELECT name FROM _applied_fixes ORDER BY name`).all() as { name: string }[];
    console.log(`[BOOT] already applied:`, applied.map(r => r.name));
  } catch { console.log(`[BOOT] _applied_fixes table not yet created`); }
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE CHECK(name IN ('TELE','Wepoker','Xpoker','ClubGG','KKPOKER')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived'))
    );
    INSERT OR IGNORE INTO games (name) VALUES ('TELE'),('Wepoker'),('Xpoker'),('ClubGG'),('KKPOKER');

    CREATE TABLE IF NOT EXISTS player_game_deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      action_pct REAL NOT NULL DEFAULT 50,
      rakeback_pct REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(player_id, game_id)
    );

    CREATE TABLE IF NOT EXISTS poker_apps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      deal_type TEXT NOT NULL CHECK(deal_type IN ('rakeback','revenue_share','flat')),
      deal_value REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      payout_schedule TEXT NOT NULL DEFAULT 'monthly',
      club_id TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      telegram_handle TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','churned')),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS player_app_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      app_id INTEGER NOT NULL REFERENCES poker_apps(id) ON DELETE CASCADE,
      deal_type TEXT NOT NULL CHECK(deal_type IN ('rakeback','revenue_share','flat')),
      deal_value REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
      joined_at TEXT NOT NULL DEFAULT (date('now')),
      UNIQUE(player_id, app_id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id INTEGER NOT NULL REFERENCES poker_apps(id) ON DELETE CASCADE,
      period_label TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      raw_content TEXT,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounting_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER REFERENCES reports(id) ON DELETE SET NULL,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      app_id INTEGER NOT NULL REFERENCES poker_apps(id) ON DELETE CASCADE,
      period_label TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      gross_amount REAL NOT NULL,
      player_cut REAL NOT NULL DEFAULT 0,
      my_net REAL NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS telegram_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      note TEXT,
      tx_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      app_id    INTEGER NOT NULL REFERENCES poker_apps(id) ON DELETE CASCADE,
      type      TEXT NOT NULL CHECK(type IN ('deposit','withdrawal')),
      amount    REAL NOT NULL,
      currency  TEXT NOT NULL DEFAULT 'USDT',
      note      TEXT,
      tx_date   TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS crm_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'note' CHECK(type IN ('note','call','payment','alert','message')),
      tg_msg_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tg_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      tg_chat_id TEXT NOT NULL,
      tg_msg_id INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      content TEXT NOT NULL,
      msg_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tg_chat_id, tg_msg_id)
    );
  `);

  // migrate existing DBs
  try { db.exec(`ALTER TABLE poker_apps ADD COLUMN club_id TEXT`); } catch {}
  try { db.exec(`ALTER TABLE poker_apps ADD COLUMN club_name TEXT`); } catch {}

  // Remove UNIQUE constraint on poker_apps.name (there can be many clubs per app)
  const hasUniqueOnName = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='poker_apps' AND name LIKE 'sqlite_autoindex%'`
  ).get();
  if (hasUniqueOnName) {
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE poker_apps_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        deal_type TEXT NOT NULL CHECK(deal_type IN ('rakeback','revenue_share','flat')),
        deal_value REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'EUR',
        payout_schedule TEXT NOT NULL DEFAULT 'monthly',
        club_id TEXT,
        club_name TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO poker_apps_new SELECT id, name, deal_type, deal_value, currency, payout_schedule, club_id, club_name, notes, created_at FROM poker_apps;
      DROP TABLE poker_apps;
      ALTER TABLE poker_apps_new RENAME TO poker_apps;
    `);
    db.pragma("foreign_keys = ON");
  }
  try { db.exec(`ALTER TABLE players ADD COLUMN action_pct REAL NOT NULL DEFAULT 40`); } catch {}
  try { db.exec(`ALTER TABLE games ADD COLUMN default_action_pct REAL`); } catch {}
  try { db.exec(`ALTER TABLE players ADD COLUMN tier TEXT DEFAULT 'A' CHECK(tier IN ('S','A','B'))`); } catch {}
  try { db.exec(`ALTER TABLE players ADD COLUMN telegram_phone TEXT`); } catch {}
  try { db.exec(`ALTER TABLE players ADD COLUMN tron_address TEXT`); } catch {}
  try { db.exec(`ALTER TABLE players ADD COLUMN tron_app_id INTEGER REFERENCES poker_apps(id) ON DELETE SET NULL`); } catch {}
  try { db.exec(`ALTER TABLE wallet_transactions ADD COLUMN tron_tx_hash TEXT`); } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tron_hash ON wallet_transactions(tron_tx_hash) WHERE tron_tx_hash IS NOT NULL`); } catch {}
  // Counterparty wallet: for deposits = sender (tx.from), for withdrawals = recipient cashout (tx.to)
  try { db.exec(`ALTER TABLE wallet_transactions ADD COLUMN counterparty_address TEXT`); } catch {}

  try { db.exec(`ALTER TABLE players ADD COLUMN tele_wallet_perso TEXT`); } catch {}
  // WALLET CASHOUT : adresse fixe du joueur pour recevoir ses cashouts (Binance TRC20, wallet perso, etc.)
  try { db.exec(`ALTER TABLE players ADD COLUMN tele_wallet_cashout TEXT`); } catch {}

  // telegram_id for deduplication when auto-importing from groups
  try { db.exec(`ALTER TABLE players ADD COLUMN telegram_id INTEGER`); } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_players_telegram_id ON players(telegram_id) WHERE telegram_id IS NOT NULL`); } catch {}

  // Add game_id to wallet_transactions
  try { db.exec(`ALTER TABLE wallet_transactions ADD COLUMN game_id INTEGER REFERENCES games(id) ON DELETE SET NULL`); } catch {}

  // Multi-cashout support — a player can have N cashout addresses
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS player_wallet_cashouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        address TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(player_id, address)
      );
      CREATE INDEX IF NOT EXISTS idx_pwc_player ON player_wallet_cashouts(player_id);
      CREATE INDEX IF NOT EXISTS idx_pwc_address ON player_wallet_cashouts(address);
    `);
  } catch {}

  // Multi-game-wallet support — a player can have N deposit/game addresses
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS player_wallet_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        address TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(player_id, address)
      );
      CREATE INDEX IF NOT EXISTS idx_pwg_player ON player_wallet_games(player_id);
      CREATE INDEX IF NOT EXISTS idx_pwg_address ON player_wallet_games(address);
    `);
  } catch {}

  // One-time fix: flip deposit/withdrawal directions (to=player means deposit, from=player means withdrawal)
  db.exec(`CREATE TABLE IF NOT EXISTS _applied_fixes (name TEXT PRIMARY KEY)`);

  // Backfill from legacy single-column tele_wallet_cashout (one-time, runs after _applied_fixes exists)
  const fixBackfillCashouts = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("backfill_player_wallet_cashouts_v1");
  if (fixBackfillCashouts.changes > 0) {
    try {
      db.exec(`
        INSERT OR IGNORE INTO player_wallet_cashouts (player_id, address)
        SELECT id, tele_wallet_cashout FROM players
        WHERE tele_wallet_cashout IS NOT NULL AND tele_wallet_cashout != ''
      `);
    } catch {}
  }
  // Backfill from legacy single-column tron_address into multi-game-wallet table
  const fixBackfillGameWallets = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("backfill_player_wallet_games_v1");
  if (fixBackfillGameWallets.changes > 0) {
    try {
      db.exec(`
        INSERT OR IGNORE INTO player_wallet_games (player_id, address)
        SELECT id, tron_address FROM players
        WHERE tron_address IS NOT NULL AND tron_address != ''
      `);
    } catch {}
  }
  const fixFlip = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("flip_wallet_directions_v2");
  if (fixFlip.changes > 0) {
    db.exec(`UPDATE wallet_transactions SET type = CASE WHEN type='deposit' THEN 'withdrawal' ELSE 'deposit' END`);
  }

  // One-time: migrate existing wallet_transactions to game_id
  const fixGameId = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("wallet_transactions_game_id_v1");
  if (fixGameId.changes > 0) {
    db.exec(`UPDATE wallet_transactions SET game_id = (SELECT id FROM games WHERE name='TELE') WHERE app_id = 1 AND game_id IS NULL`);
    db.exec(`UPDATE wallet_transactions SET game_id = (SELECT id FROM games WHERE name='Wepoker') WHERE app_id IN (2,3,4) AND game_id IS NULL`);
  }

  // One-time: delete orphan auto-sync rows. These are leftover from an older sync
  // that didn't store tron_tx_hash, now duplicated by the new sync (which does).
  // Manual entries (note != 'auto-sync') are untouched.
  const fixOrphanSync = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("delete_orphan_auto_sync_rows_v1");
  if (fixOrphanSync.changes > 0) {
    db.exec(`DELETE FROM wallet_transactions WHERE note = 'auto-sync' AND tron_tx_hash IS NULL`);
  }

  // One-time: create TELE game deals for players who already have a tron_address
  const fixTeleDeals = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("create_tele_game_deals_v1");
  if (fixTeleDeals.changes > 0) {
    db.exec(`
      INSERT OR IGNORE INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct)
      SELECT p.id, (SELECT id FROM games WHERE name='TELE'), COALESCE(p.action_pct, 40), 0
      FROM players p WHERE p.tron_address IS NOT NULL AND p.tron_address != ''
    `);
  }

  // Settings key-value store
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Rakeback reports system
  db.exec(`
    CREATE TABLE IF NOT EXISTS rakeback_reports (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      period_label TEXT NOT NULL,
      raw_extraction TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rakeback_entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id  INTEGER NOT NULL REFERENCES rakeback_reports(id) ON DELETE CASCADE,
      player_id  INTEGER REFERENCES players(id) ON DELETE SET NULL,
      external_id TEXT NOT NULL,
      amount     REAL NOT NULL,
      currency   TEXT NOT NULL DEFAULT 'USDT',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS player_game_ids (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      UNIQUE(game_id, external_id)
    );

    CREATE TABLE IF NOT EXISTS game_ignored_ids (
      game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      PRIMARY KEY (game_id, external_id)
    );
  `);

  // Telegram onboarding sessions (guided multi-step flow)
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_sessions (
      chat_id         TEXT NOT NULL,
      step            TEXT NOT NULL,
      player_id       INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      expected_tg_id  INTEGER,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (chat_id)
    );
  `);
  try { db.exec(`ALTER TABLE telegram_sessions ADD COLUMN expected_tg_id INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE telegram_sessions ADD COLUMN pending_cmd TEXT`); } catch {}
  // Migration: make player_id nullable (needed for waiting_game step which has no player context)
  const fixSessionsNullablePlayer = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("telegram_sessions_nullable_player_id_v1");
  if (fixSessionsNullablePlayer.changes > 0) {
    db.pragma("foreign_keys = OFF");
    db.exec(`
      ALTER TABLE telegram_sessions RENAME TO telegram_sessions_old;
      CREATE TABLE telegram_sessions (
        chat_id        TEXT NOT NULL PRIMARY KEY,
        step           TEXT NOT NULL,
        player_id      INTEGER REFERENCES players(id) ON DELETE CASCADE,
        expected_tg_id INTEGER,
        pending_cmd    TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO telegram_sessions
        SELECT chat_id, step, player_id, expected_tg_id, NULL, created_at
        FROM telegram_sessions_old;
      DROP TABLE telegram_sessions_old;
    `);
    db.pragma("foreign_keys = ON");
  }

  // One-time: make wallet_transactions.app_id nullable (recreate table)
  const fixAppIdNullable = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("wallet_transactions_app_id_nullable_v1");
  if (fixAppIdNullable.changes > 0) {
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE wallet_transactions_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        app_id     INTEGER REFERENCES poker_apps(id) ON DELETE SET NULL,
        game_id    INTEGER REFERENCES games(id) ON DELETE SET NULL,
        type       TEXT NOT NULL CHECK(type IN ('deposit','withdrawal')),
        amount     REAL NOT NULL,
        currency   TEXT NOT NULL DEFAULT 'USDT',
        note       TEXT,
        tron_tx_hash TEXT,
        tx_date    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO wallet_transactions_new
        SELECT id, player_id, app_id, game_id, type, amount, currency, note, tron_tx_hash, tx_date, created_at
        FROM wallet_transactions;
      DROP TABLE wallet_transactions;
      ALTER TABLE wallet_transactions_new RENAME TO wallet_transactions;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tron_hash ON wallet_transactions(tron_tx_hash) WHERE tron_tx_hash IS NOT NULL;
    `);
    db.pragma("foreign_keys = ON");
  }

  // Multi-amount rakeback entries
  try { db.exec(`ALTER TABLE rakeback_entries ADD COLUMN insurance_amount REAL NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE rakeback_entries ADD COLUMN winnings_amount REAL NOT NULL DEFAULT 0`); } catch {}
  // Per-report action percentages per type
  try { db.exec(`ALTER TABLE rakeback_reports ADD COLUMN rakeback_pct REAL`); } catch {}
  try { db.exec(`ALTER TABLE rakeback_reports ADD COLUMN insurance_pct REAL`); } catch {}
  try { db.exec(`ALTER TABLE rakeback_reports ADD COLUMN winnings_pct REAL`); } catch {}
  // Per-player insurance rakeback %
  try { db.exec(`ALTER TABLE player_game_deals ADD COLUMN insurance_pct REAL`); } catch {}
  try { db.exec(`ALTER TABLE player_game_deals ADD COLUMN start_date TEXT`); } catch {}
  // Club tracking on reports
  try { db.exec(`ALTER TABLE rakeback_reports ADD COLUMN club_id TEXT`); } catch {}
  try { db.exec(`ALTER TABLE rakeback_reports ADD COLUMN club_name TEXT`); } catch {}
  // Actual game date (separate from upload timestamp)
  try { db.exec(`ALTER TABLE rakeback_reports ADD COLUMN report_date TEXT`); } catch {}

  // Clubs table — identifies a game by club ID, stores its deal rates
  db.exec(`
    CREATE TABLE IF NOT EXISTS clubs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id          INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      external_club_id TEXT NOT NULL,
      club_name        TEXT,
      rb_pct           REAL,
      ins_pct          REAL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(game_id, external_club_id)
    );
  `);

  // Agent chat: conversation memory + inbox for scheduled-agent pickup
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_conversations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    TEXT NOT NULL,
      role       TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_conv_chat ON agent_conversations(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_inbox (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id      TEXT NOT NULL,
      message      TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_inbox_unprocessed ON agent_inbox(processed_at) WHERE processed_at IS NULL;

    CREATE TABLE IF NOT EXISTS agent_usage (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id               TEXT NOT NULL,
      model                 TEXT NOT NULL,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cost_usd              REAL NOT NULL DEFAULT 0,
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_usage_created ON agent_usage(created_at);

    CREATE TABLE IF NOT EXISTS agent_doer_sessions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id        TEXT NOT NULL,
      chat_id           TEXT NOT NULL,
      description       TEXT NOT NULL,
      money_ok          INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'starting' CHECK(status IN ('starting','running','idle','completed','failed','cancelled')),
      pr_url            TEXT,
      branch_name       TEXT,
      cost_usd_estimate REAL DEFAULT 0,
      error_message     TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at      TEXT,
      UNIQUE(session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_doer_status ON agent_doer_sessions(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_doer_created ON agent_doer_sessions(created_at);
  `);

  // Default settings (idempotent inserts)
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run("agent_doer_budget_cap_usd_daily", "10");
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run("agent_doer_env_id", "");
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run("agent_doer_agent_id", "");

  // telegram_chat_id: for direct bot messages to players (weekly summaries, cashout notifications)
  try { db.exec(`ALTER TABLE players ADD COLUMN telegram_chat_id TEXT`); } catch {}

  // Cashout requests queue
  db.exec(`
    CREATE TABLE IF NOT EXISTS cashout_requests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      amount      REAL NOT NULL,
      currency    TEXT NOT NULL DEFAULT 'USDT',
      status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','paid','cancelled')),
      note        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      approved_at TEXT,
      paid_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cashout_status ON cashout_requests(status);
    CREATE INDEX IF NOT EXISTS idx_cashout_player ON cashout_requests(player_id);
  `);

  // Report schedule tracking — detect missing reports per club
  db.exec(`
    CREATE TABLE IF NOT EXISTS club_report_schedules (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      club_id    TEXT NOT NULL,
      game_id    INTEGER NOT NULL REFERENCES games(id),
      cadence    TEXT NOT NULL DEFAULT 'daily' CHECK(cadence IN ('daily','weekdays','weekly','biweekly','monthly')),
      start_date TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      UNIQUE(game_id, club_id)
    );
    CREATE TABLE IF NOT EXISTS report_skip_days (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      club_id    TEXT NOT NULL,
      game_id    INTEGER NOT NULL REFERENCES games(id),
      skip_date  TEXT NOT NULL,
      reason     TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(game_id, club_id, skip_date)
    );
  `);

  // Migrate club_report_schedules to support more cadence values
  const fixCadence = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("schedules_cadence_expand_v1");
  if (fixCadence.changes > 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS club_report_schedules_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        club_id    TEXT NOT NULL,
        game_id    INTEGER NOT NULL REFERENCES games(id),
        cadence    TEXT NOT NULL DEFAULT 'daily' CHECK(cadence IN ('daily','weekdays','weekly','biweekly','monthly')),
        start_date TEXT NOT NULL,
        active     INTEGER NOT NULL DEFAULT 1,
        UNIQUE(game_id, club_id)
      );
      INSERT OR IGNORE INTO club_report_schedules_new SELECT * FROM club_report_schedules;
      DROP TABLE club_report_schedules;
      ALTER TABLE club_report_schedules_new RENAME TO club_report_schedules;
    `);
  }

  // Onboarding leads — track funnel from Instagram → bot → group
  db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_leads (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id       INTEGER NOT NULL UNIQUE,
      telegram_username TEXT,
      first_name        TEXT,
      stage             TEXT NOT NULL DEFAULT 'welcome' CHECK(stage IN ('welcome','discovered','joined')),
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen         TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Exchange rates for multi-currency P&L normalization
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run("exchange_rate_cny_usdt", "0.138");
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run("exchange_rate_eur_usdt", "1.08");

  // Smart alert: loss threshold (negative USDT — alert when player P&L drops below this)
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run("alert_loss_threshold_usdt", "-2000");

  // One-time fix: purge ALL withdrawal records. Pass 3 (removed) imported bogus cashouts
  // from unrelated senders. Next sync reimports only legitimate wallet mère cashouts via Pass 2.
  const fixPass3 = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("purge_all_withdrawals_v2");
  if (fixPass3.changes > 0) {
    db.exec(`DELETE FROM wallet_transactions WHERE type = 'withdrawal'`);
  }

  // One-time fix: previous migration may have removed shared wallet from Baki — re-add it.
  // Baki and Hugo intentionally share cashout wallet TNBf7UHvahKbodkH8PEtwFoQk6xMLSAvNd.
  const fixHugoCashouts = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("reassign_hugo_cashout_wallet_v1");
  if (fixHugoCashouts.changes > 0) {
    // noop — superseded by v2 below
  }

  // Allow the same blockchain tx to be attributed to multiple players (shared cashout wallets).
  // Change UNIQUE index from (tron_tx_hash) to (tron_tx_hash, player_id).
  // Re-add Baki's shared wallet if removed, then purge withdrawals for clean re-import.
  const fixSharedCashouts = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("shared_cashout_wallets_v1");
  if (fixSharedCashouts.changes > 0) {
    db.exec(`INSERT OR IGNORE INTO player_wallet_cashouts (player_id, address) VALUES (2, 'TNBf7UHvahKbodkH8PEtwFoQk6xMLSAvNd')`);
    db.exec(`DROP INDEX IF EXISTS idx_wallet_tron_hash`);
    db.exec(`CREATE UNIQUE INDEX idx_wallet_tron_hash ON wallet_transactions(tron_tx_hash, player_id) WHERE tron_tx_hash IS NOT NULL`);
    db.exec(`DELETE FROM wallet_transactions WHERE type = 'withdrawal' AND note = 'auto-sync'`);
  }

  // Multi wallet mère support — replaces single settings.tele_wallet_mere
  const fixWalletMeres = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_wallet_meres_v1");
  if (fixWalletMeres.changes > 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wallet_meres (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        address    TEXT NOT NULL UNIQUE,
        label      TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`
      INSERT OR IGNORE INTO wallet_meres (address, label)
      SELECT value, 'Principal' FROM settings
      WHERE key = 'tele_wallet_mere' AND value != ''
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_meres (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      address    TEXT NOT NULL UNIQUE,
      label      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Source tracking for wallet_transactions — every row must be 'sync', 'manual', or 'unknown' (legacy)
  const fixWalletTxSource = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_wallet_tx_source_v1");
  if (fixWalletTxSource.changes > 0) {
    db.exec(`ALTER TABLE wallet_transactions ADD COLUMN source TEXT DEFAULT 'unknown'`);
    db.exec(`UPDATE wallet_transactions SET source = 'sync' WHERE tron_tx_hash IS NOT NULL AND tron_tx_hash != ''`);
    db.exec(`UPDATE wallet_transactions SET source = 'manual' WHERE (tron_tx_hash IS NULL OR tron_tx_hash = '') AND note IS NOT NULL`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS wallet_tx_source_check BEFORE INSERT ON wallet_transactions
      BEGIN
        SELECT RAISE(ABORT, 'wallet_transactions: source must be sync (with tron_tx_hash) or manual')
        WHERE (NEW.source = 'sync' AND (NEW.tron_tx_hash IS NULL OR NEW.tron_tx_hash = ''))
           OR NEW.source NOT IN ('sync', 'manual', 'unknown');
      END
    `);
  }
  try { db.exec(`ALTER TABLE wallet_transactions ADD COLUMN source TEXT DEFAULT 'unknown'`); } catch {}
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS wallet_tx_source_check BEFORE INSERT ON wallet_transactions
    BEGIN
      SELECT RAISE(ABORT, 'wallet_transactions: source must be sync (with tron_tx_hash) or manual')
      WHERE (NEW.source = 'sync' AND (NEW.tron_tx_hash IS NULL OR NEW.tron_tx_hash = ''))
         OR NEW.source NOT IN ('sync', 'manual', 'unknown');
    END
  `);

  // Precise China-time datetime for week-boundary filtering.
  // Backfill assumptions:
  //   sync rows: tx_date is UTC date from block_timestamp. Midnight UTC = 08:00 China.
  //     Intra-day precision is lost for existing rows; future syncs write exact block_timestamp.
  //   manual rows: tx_date was entered as a China-local date. Treat as midnight China time.
  //   A future re-sync can backfill exact times for existing rows if needed.
  const fixTxDatetime = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_tx_datetime_v1");
  if (fixTxDatetime.changes > 0) {
    db.exec(`ALTER TABLE wallet_transactions ADD COLUMN tx_datetime TEXT`);
    db.exec(`UPDATE wallet_transactions SET tx_datetime = SUBSTR(tx_date, 1, 10) || 'T08:00:00+08:00' WHERE source = 'sync' AND tx_datetime IS NULL`);
    db.exec(`UPDATE wallet_transactions SET tx_datetime = SUBSTR(tx_date, 1, 10) || 'T00:00:00+08:00' WHERE source = 'manual' AND tx_datetime IS NULL`);
    db.exec(`UPDATE wallet_transactions SET tx_datetime = SUBSTR(tx_date, 1, 10) || 'T08:00:00+08:00' WHERE tx_datetime IS NULL`);
  }
  try { db.exec(`ALTER TABLE wallet_transactions ADD COLUMN tx_datetime TEXT`); } catch {}

  // Normalize tx_datetime from +08:00 (China) to UTC Z for France-time filtering
  const fixNormalize = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("normalize_tx_datetime_utc_v1");
  if (fixNormalize.changes > 0) {
    // Convert +08:00 → Z: subtract 8 hours from the local timestamp
    db.exec(`
      UPDATE wallet_transactions
      SET tx_datetime = STRFTIME('%Y-%m-%dT%H:%M:%SZ',
        SUBSTR(tx_datetime, 1, 19), '-8 hours')
      WHERE tx_datetime LIKE '%+08:00'
    `);
    // Convert +00:00 → Z (if any exist)
    db.exec(`
      UPDATE wallet_transactions
      SET tx_datetime = SUBSTR(tx_datetime, 1, 19) || 'Z'
      WHERE tx_datetime LIKE '%+00:00'
    `);
    // Rollback SQL (documentation only — never auto-run):
    // UPDATE wallet_transactions
    // SET tx_datetime = STRFTIME('%Y-%m-%dT%H:%M:%S+08:00', SUBSTR(tx_datetime, 1, 19), '+8 hours')
    // WHERE tx_datetime LIKE '%Z';
  }

  // Settlement engine tables
  const fixSettlement = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("settlement_engine_v1");
  if (fixSettlement.changes > 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS weekly_settlement_periods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week_start TEXT NOT NULL UNIQUE,
        week_end TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','computed','locked')),
        computed_at TEXT,
        locked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS weekly_settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week_start TEXT NOT NULL,
        player_id INTEGER NOT NULL REFERENCES players(id),
        status TEXT NOT NULL CHECK(status IN ('auto_settled','pending_manual','carry_over','settled','conflict')),
        pnl_player REAL,
        pnl_operator REAL,
        action_pct_snapshot REAL,
        lock_anchor_tx_id INTEGER REFERENCES wallet_transactions(id),
        lock_anchor_datetime TEXT,
        locked_at TEXT,
        locked_by TEXT,
        manual_close_amount REAL,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(week_start, player_id)
      );
    `);
  }

  // Migration: auto_settled → settled (settlement auto-lock)
  const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("settlement_auto_lock_v1");
  if (fix.changes > 0) {
    db.exec(`
      UPDATE weekly_settlements
      SET status = 'settled', locked_at = COALESCE(locked_at, datetime('now')), locked_by = COALESCE(locked_by, 'auto')
      WHERE status = 'auto_settled';
    `);
  }

  // Migration: tx overrides table for per-player transaction include/exclude
  const fix2 = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("settlement_tx_overrides_v1");
  if (fix2.changes > 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS weekly_settlement_tx_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        settlement_id INTEGER NOT NULL REFERENCES weekly_settlements(id),
        wallet_transaction_id INTEGER NOT NULL REFERENCES wallet_transactions(id),
        action TEXT NOT NULL CHECK(action IN ('exclude', 'include')),
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_by TEXT NOT NULL DEFAULT 'baki',
        UNIQUE(settlement_id, wallet_transaction_id)
      );
    `);
  }

  // Migration: revert auto-lock on non-locked periods (back to editable)
  const fix3 = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("settlement_revert_auto_lock_v1");
  if (fix3.changes > 0) {
    db.exec(`
      UPDATE weekly_settlements
      SET status = 'auto_settled', locked_at = NULL, locked_by = NULL
      WHERE status = 'settled' AND locked_by = 'auto'
        AND week_start IN (
          SELECT week_start FROM weekly_settlement_periods WHERE status != 'locked'
        );
    `);
  }

  // Migration: add note column to weekly_settlement_periods for unlock audit trail
  const fix4 = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("settlement_period_note_v1");
  if (fix4.changes > 0) {
    db.exec(`ALTER TABLE weekly_settlement_periods ADD COLUMN note TEXT;`);
  }

  // Broadcast: store player group chat ID + topic IDs
  try { db.exec(`ALTER TABLE players ADD COLUMN telegram_group_id TEXT`); } catch {}
  try { db.exec(`ALTER TABLE players ADD COLUMN alertes_topic_id INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE players ADD COLUMN liveplay_topic_id INTEGER`); } catch {}

  // All 7 standard topic columns for player groups
  try { db.exec(`ALTER TABLE players ADD COLUMN accounting_topic_id INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE players ADD COLUMN deals_topic_id INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE players ADD COLUMN clubs_topic_id INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE players ADD COLUMN depot_topic_id INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE players ADD COLUMN onboarding_topic_id INTEGER`); } catch {}

  // Weekly cashout state tracking
  const fixCashoutState = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("weekly_cashout_state_v1");
  if (fixCashoutState.changes > 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS weekly_cashout_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        week_start TEXT NOT NULL,
        reminder_sent_at TEXT,
        cashout_confirmed INTEGER DEFAULT 0,
        confirmed_at TEXT,
        escalation_count INTEGER DEFAULT 0,
        ops_alerted INTEGER DEFAULT 0,
        UNIQUE(player_id, week_start)
      );
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_cashout_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      week_start TEXT NOT NULL,
      reminder_sent_at TEXT,
      cashout_confirmed INTEGER DEFAULT 0,
      confirmed_at TEXT,
      escalation_count INTEGER DEFAULT 0,
      ops_alerted INTEGER DEFAULT 0,
      not_played INTEGER DEFAULT 0,
      UNIQUE(player_id, week_start)
    );
  `);

  // Add not_played column to existing weekly_cashout_state tables
  const fixNotPlayed = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("weekly_cashout_not_played_v1");
  if (fixNotPlayed.changes > 0) {
    try { db.exec(`ALTER TABLE weekly_cashout_state ADD COLUMN not_played INTEGER DEFAULT 0`); } catch {}
  }

  // DB-backed dedup: track last message timestamp to prevent double sends
  const fixLastMsg = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("weekly_cashout_last_message_v1");
  if (fixLastMsg.changes > 0) {
    try { db.exec(`ALTER TABLE weekly_cashout_state ADD COLUMN last_message_at TEXT`); } catch {}
  }
  try { db.exec(`ALTER TABLE weekly_cashout_state ADD COLUMN last_message_at TEXT`); } catch {}

  const fixBackfillLastMsg = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("backfill_last_message_at_v1");
  if (fixBackfillLastMsg.changes > 0) {
    db.exec(`UPDATE weekly_cashout_state SET last_message_at = reminder_sent_at WHERE last_message_at IS NULL AND reminder_sent_at IS NOT NULL`);
  }

  // Settlement payment tracking
  const fixPayment = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("weekly_settlement_payment_v1");
  if (fixPayment.changes > 0) {
    try { db.exec(`ALTER TABLE weekly_settlements ADD COLUMN payment_received INTEGER DEFAULT 0`); } catch {}
    try { db.exec(`ALTER TABLE weekly_settlements ADD COLUMN received_at TEXT`); } catch {}
    try { db.exec(`ALTER TABLE weekly_settlements ADD COLUMN received_by TEXT`); } catch {}
  }
  try { db.exec(`ALTER TABLE weekly_settlements ADD COLUMN payment_received INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE weekly_settlements ADD COLUMN received_at TEXT`); } catch {}
  try { db.exec(`ALTER TABLE weekly_settlements ADD COLUMN received_by TEXT`); } catch {}

  // Drop unused legacy tables (0 rows in production — never populated)
  const fixDropLegacy = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("drop_unused_legacy_tables_v1");
  if (fixDropLegacy.changes > 0) {
    db.exec(`DROP TABLE IF EXISTS accounting_entries`);
    db.exec(`DROP TABLE IF EXISTS reports`);
  }

  // Onboarding reminder tracking columns
  const fixOnboardReminders = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("onboarding_reminders_v1");
  if (fixOnboardReminders.changes > 0) {
    try { db.exec(`ALTER TABLE onboarding_leads ADD COLUMN step_entered_at TEXT`); } catch {}
    try { db.exec(`ALTER TABLE onboarding_leads ADD COLUMN reminders_sent INTEGER DEFAULT 0`); } catch {}
    try { db.exec(`ALTER TABLE onboarding_leads ADD COLUMN last_reminder_at TEXT`); } catch {}
    try { db.exec(`ALTER TABLE onboarding_leads ADD COLUMN ops_alerted INTEGER DEFAULT 0`); } catch {}
    try { db.exec(`ALTER TABLE onboarding_leads ADD COLUMN ops_alerted_at TEXT`); } catch {}
  }
  try { db.exec(`ALTER TABLE onboarding_leads ADD COLUMN step_entered_at TEXT`); } catch {}
  try { db.exec(`ALTER TABLE onboarding_leads ADD COLUMN reminders_sent INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE onboarding_leads ADD COLUMN last_reminder_at TEXT`); } catch {}
  try { db.exec(`ALTER TABLE onboarding_leads ADD COLUMN ops_alerted INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE onboarding_leads ADD COLUMN ops_alerted_at TEXT`); } catch {}

  // Agency extras — one-off wins/fees per game (global, not player-level)
  const fixAgencyExtras = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("agency_extras_v1");
  if (fixAgencyExtras.changes > 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agency_extras (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_key TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('win', 'fee')),
        amount REAL NOT NULL,
        currency TEXT NOT NULL,
        description TEXT,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
        recorded_by TEXT,
        notes TEXT,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agency_extras_game ON agency_extras(game_key, recorded_at);
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS agency_extras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_key TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('win', 'fee')),
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      description TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      recorded_by TEXT,
      notes TEXT,
      deleted_at TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agency_extras_game ON agency_extras(game_key, recorded_at)`);

  // KKPOKER launch: recreate games table with expanded CHECK + status column
  const fixKkpoker = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("kkpoker_launch_v1");
  if (fixKkpoker.changes > 0) {
    const existing = db.prepare(`SELECT id, name FROM games ORDER BY id`).all() as { id: number; name: string }[];
    db.exec(`ALTER TABLE games RENAME TO games_old`);
    db.exec(`
      CREATE TABLE games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE CHECK(name IN ('TELE','Wepoker','Xpoker','ClubGG','KKPOKER')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived'))
      )
    `);
    const ins = db.prepare(`INSERT INTO games (id, name, status) VALUES (?, ?, ?)`);
    for (const g of existing) {
      ins.run(g.id, g.name, g.name === "TELE" ? "archived" : "active");
    }
    if (!existing.find(g => g.name === "KKPOKER")) {
      db.prepare(`INSERT INTO games (name, status) VALUES ('KKPOKER', 'active')`).run();
    }
    db.exec(`DROP TABLE games_old`);
  }
  // Ensure KKPOKER exists even if migration already ran
  try { db.prepare(`INSERT OR IGNORE INTO games (name, status) VALUES ('KKPOKER', 'active')`).run(); } catch {}
  // Ensure status column exists (idempotent for fresh DBs)
  try { db.exec(`ALTER TABLE games ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`); } catch {}

  // Extend wallet_meres with game_id + status columns, seed KKPOKER wallet_mère
  const fixWmGameId = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("wallet_meres_game_id_v1");
  if (fixWmGameId.changes > 0) {
    try { db.exec(`ALTER TABLE wallet_meres ADD COLUMN game_id INTEGER REFERENCES games(id)`); } catch {}
    try { db.exec(`ALTER TABLE wallet_meres ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`); } catch {}
    try { db.exec(`ALTER TABLE wallet_meres ADD COLUMN retired_at TEXT`); } catch {}
    // Tag existing rows as TELE (game id=1)
    const teleGame = db.prepare(`SELECT id FROM games WHERE name = 'TELE'`).get() as { id: number } | undefined;
    if (teleGame) {
      db.prepare(`UPDATE wallet_meres SET game_id = ? WHERE game_id IS NULL`).run(teleGame.id);
    }
    // Seed KKPOKER wallet_mère
    const kkGame = db.prepare(`SELECT id FROM games WHERE name = 'KKPOKER'`).get() as { id: number } | undefined;
    if (kkGame) {
      db.prepare(`INSERT OR IGNORE INTO wallet_meres (address, label, game_id, status) VALUES (?, ?, ?, 'active')`)
        .run("TRWyGmpLeJAH8TSUr8WzA2KRuNUUaTMAdA", "main", kkGame.id);
    }
  }
  try { db.exec(`ALTER TABLE wallet_meres ADD COLUMN game_id INTEGER REFERENCES games(id)`); } catch {}
  try { db.exec(`ALTER TABLE wallet_meres ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`); } catch {}
  try { db.exec(`ALTER TABLE wallet_meres ADD COLUMN retired_at TEXT`); } catch {}

  // Per-game wallet support: add game_id to player_wallet_games and player_wallet_cashouts
  try { db.exec(`ALTER TABLE player_wallet_games ADD COLUMN game_id INTEGER REFERENCES games(id)`); } catch {}
  try { db.exec(`ALTER TABLE player_wallet_cashouts ADD COLUMN game_id INTEGER REFERENCES games(id)`); } catch {}

  const fixPerGameWallets = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("per_game_wallets_v1");
  if (fixPerGameWallets.changes > 0) {
    const teleGame = db.prepare(`SELECT id FROM games WHERE name = 'TELE'`).get() as { id: number } | undefined;
    if (teleGame) {
      db.prepare(`UPDATE player_wallet_games SET game_id = ? WHERE game_id IS NULL`).run(teleGame.id);
      db.prepare(`UPDATE player_wallet_cashouts SET game_id = ? WHERE game_id IS NULL`).run(teleGame.id);
    }

    // Rebuild player_wallet_games with UNIQUE(player_id, address, game_id)
    db.exec(`
      CREATE TABLE player_wallet_games_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        address TEXT NOT NULL,
        label TEXT,
        game_id INTEGER REFERENCES games(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(player_id, address, game_id)
      );
      INSERT INTO player_wallet_games_new (id, player_id, address, label, game_id, created_at)
        SELECT id, player_id, address, label, game_id, created_at FROM player_wallet_games;
      DROP TABLE player_wallet_games;
      ALTER TABLE player_wallet_games_new RENAME TO player_wallet_games;
      CREATE INDEX IF NOT EXISTS idx_pwg_player ON player_wallet_games(player_id);
      CREATE INDEX IF NOT EXISTS idx_pwg_address ON player_wallet_games(address);
      CREATE INDEX IF NOT EXISTS idx_pwg_game ON player_wallet_games(game_id);
    `);

    // Rebuild player_wallet_cashouts with UNIQUE(player_id, address, game_id)
    db.exec(`
      CREATE TABLE player_wallet_cashouts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        address TEXT NOT NULL,
        label TEXT,
        game_id INTEGER REFERENCES games(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(player_id, address, game_id)
      );
      INSERT INTO player_wallet_cashouts_new (id, player_id, address, label, game_id, created_at)
        SELECT id, player_id, address, label, game_id, created_at FROM player_wallet_cashouts;
      DROP TABLE player_wallet_cashouts;
      ALTER TABLE player_wallet_cashouts_new RENAME TO player_wallet_cashouts;
      CREATE INDEX IF NOT EXISTS idx_pwc_player ON player_wallet_cashouts(player_id);
      CREATE INDEX IF NOT EXISTS idx_pwc_address ON player_wallet_cashouts(address);
      CREATE INDEX IF NOT EXISTS idx_pwc_game ON player_wallet_cashouts(game_id);
    `);
  }

  // Option A: register TVGMzHejH9... as KKPOKER wallet mère (was only registered for TELE)
  try {
    console.log(`[MIGRATION:wallet_mere_tvgm_kkpoker_v1] starting`);
    const fixMereKK = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("wallet_mere_tvgm_kkpoker_v1");
    if (fixMereKK.changes > 0) {
      const kkGame = db.prepare(`SELECT id FROM games WHERE name = 'KKPOKER'`).get() as { id: number } | undefined;
      if (kkGame) {
        const ins = db.prepare(
          `INSERT OR IGNORE INTO wallet_meres (address, label, game_id, status) VALUES (?, ?, ?, 'active')`
        ).run("TVGMzHejH9pbgREEQxCCDK7EzexDCvAKpB", "mere 2 (KK)", kkGame.id);
        console.log(`[MIGRATION:wallet_mere_tvgm_kkpoker_v1] OK, changes=${ins.changes}`);
      } else {
        console.log(`[MIGRATION:wallet_mere_tvgm_kkpoker_v1] OK, skipped (KKPOKER game not found)`);
      }
    } else {
      console.log(`[MIGRATION:wallet_mere_tvgm_kkpoker_v1] OK, already applied`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:wallet_mere_tvgm_kkpoker_v1] FAILED:`, err.message);
    console.error(err.stack);
  }

  // Backfill: reclassify deposits that were actually sent by a wallet mère
  try {
    console.log(`[MIGRATION:reclassify_wallet_mere_deposits_v1] starting`);
    const fixReclass = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("reclassify_wallet_mere_deposits_v1");
    if (fixReclass.changes > 0) {
      const result = db.prepare(`
        UPDATE wallet_transactions
        SET type = 'withdrawal'
        WHERE type = 'deposit'
          AND source = 'sync'
          AND LOWER(counterparty_address) IN (
            SELECT LOWER(address) FROM wallet_meres WHERE status = 'active'
          )
      `).run();
      console.log(`[MIGRATION:reclassify_wallet_mere_deposits_v1] OK, changes=${result.changes}`);
    } else {
      console.log(`[MIGRATION:reclassify_wallet_mere_deposits_v1] OK, already applied`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:reclassify_wallet_mere_deposits_v1] FAILED:`, err.message);
    console.error(err.stack);
  }

  // Add A5POKER to games table (requires recreating table to update CHECK constraint)
  try {
    const fixA5 = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_a5poker_game_v1");
    if (fixA5.changes > 0) {
      db.pragma("foreign_keys = OFF");
      try {
        db.exec(`
          BEGIN;
          CREATE TABLE games_backup_20260524_phase1 AS SELECT * FROM games;
          CREATE TABLE games_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE CHECK(name IN ('TELE','Wepoker','Xpoker','ClubGG','KKPOKER','A5POKER')),
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
            default_action_pct REAL
          );
          INSERT INTO games_new (id, name, status, default_action_pct)
            SELECT id, name, status, default_action_pct FROM games;
          DROP TABLE games;
          ALTER TABLE games_new RENAME TO games;
          INSERT INTO games (name, status, default_action_pct)
            VALUES ('A5POKER', 'active', 20);
          COMMIT;
        `);
      } finally {
        db.pragma("foreign_keys = ON");
      }
      console.log("[MIGRATION] add_a5poker_game_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_a5poker_game_v1] FAILED:`, err.message);
    console.error(err.stack);
  }

  // Add end_date to player_game_deals for soft-delete (archiving deals preserves historical P&L)
  try {
    const fixEndDate = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_deal_end_date_v1");
    if (fixEndDate.changes > 0) {
      db.exec(`ALTER TABLE player_game_deals ADD COLUMN end_date TEXT`);
      console.log("[MIGRATION] add_deal_end_date_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_deal_end_date_v1] FAILED:`, err.message);
    console.error(err.stack);
  }

  try {
    const fixJoinTracking = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_player_joined_via_v1");
    if (fixJoinTracking.changes > 0) {
      db.exec(`ALTER TABLE players ADD COLUMN joined_via TEXT`);
      console.log("[MIGRATION] add_player_joined_via_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_player_joined_via_v1] FAILED:`, err.message);
    console.error(err.stack);
  }

  try {
    const fixAff = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_affiliate_tables_v1");
    if (fixAff.changes > 0) {
      db.exec(`
        CREATE TABLE affiliate_relationships (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          affiliate_player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          referred_player_id      INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          origin_game_id          INTEGER NOT NULL REFERENCES games(id),
          start_date              TEXT NOT NULL DEFAULT (date('now')),
          status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'terminated')),
          disclosed_action_pct    REAL,
          disclosed_rakeback_pct  REAL,
          disclosed_insurance_pct REAL,
          exclude_agency_extras   INTEGER NOT NULL DEFAULT 1,
          notes                   TEXT,
          created_at              TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(referred_player_id)
        );
        CREATE INDEX idx_aff_rel_affiliate ON affiliate_relationships(affiliate_player_id);
        CREATE INDEX idx_aff_rel_referred ON affiliate_relationships(referred_player_id);
        CREATE TABLE affiliate_payments (
          id                          INTEGER PRIMARY KEY AUTOINCREMENT,
          relationship_id             INTEGER NOT NULL REFERENCES affiliate_relationships(id) ON DELETE CASCADE,
          game_id                     INTEGER NOT NULL REFERENCES games(id),
          week_start_date             TEXT NOT NULL,
          week_end_date               TEXT NOT NULL,
          amount_usdt                 REAL NOT NULL,
          tx_hash                     TEXT,
          paid_at                     TEXT NOT NULL DEFAULT (datetime('now')),
          paid_by                     TEXT,
          snapshot_agency_pnl_lifetime REAL,
          snapshot_commission_rate    REAL,
          snapshot_total_earned       REAL,
          snapshot_total_paid_before  REAL,
          notes                       TEXT
        );
        CREATE INDEX idx_aff_pay_rel ON affiliate_payments(relationship_id);
        CREATE INDEX idx_aff_pay_week ON affiliate_payments(week_start_date);
      `);
      console.log("[MIGRATION] add_affiliate_tables_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_affiliate_tables_v1] FAILED:`, err.message);
    console.error(err.stack);
  }

  try {
    const fixLeads = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_affiliate_leads_v1");
    if (fixLeads.changes > 0) {
      db.exec(`
        CREATE TABLE affiliate_leads (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          affiliate_player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          referred_handle       TEXT NOT NULL,
          kickoff_group_id      TEXT,
          kickoff_invite_link   TEXT,
          status                TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'converted', 'expired', 'cancelled')),
          created_at            TEXT NOT NULL DEFAULT (datetime('now')),
          converted_at          TEXT,
          converted_player_id   INTEGER REFERENCES players(id),
          origin_game_id        INTEGER REFERENCES games(id),
          UNIQUE(referred_handle, status)
        );
        CREATE INDEX idx_aff_leads_handle ON affiliate_leads(referred_handle);
        CREATE INDEX idx_aff_leads_affiliate ON affiliate_leads(affiliate_player_id);
      `);
      console.log("[MIGRATION] add_affiliate_leads_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_affiliate_leads_v1] FAILED:`, err.message);
    console.error(err.stack);
  }

  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("aff_rel_nullable_origin_v1");
    if (fix.changes > 0) {
      db.exec(`
        DROP TABLE IF EXISTS affiliate_relationships;
        CREATE TABLE affiliate_relationships (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          affiliate_player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          referred_player_id      INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          origin_game_id          INTEGER REFERENCES games(id),
          start_date              TEXT NOT NULL DEFAULT (date('now')),
          status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'terminated')),
          disclosed_action_pct    REAL,
          disclosed_rakeback_pct  REAL,
          disclosed_insurance_pct REAL,
          exclude_agency_extras   INTEGER NOT NULL DEFAULT 1,
          notes                   TEXT,
          created_at              TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(referred_player_id)
        );
        CREATE INDEX idx_aff_rel_affiliate ON affiliate_relationships(affiliate_player_id);
        CREATE INDEX idx_aff_rel_referred ON affiliate_relationships(referred_player_id);
      `);
      console.log("[MIGRATION] aff_rel_nullable_origin_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:aff_rel_nullable_origin_v1] FAILED:`, err.message);
  }

  // Replace the table-level UNIQUE(referred_player_id) — which let a *terminated* relation occupy
  // the slot and block re-affiliation — with a PARTIAL unique index scoped to active rows only.
  // Business rule: "at most 1 ACTIVE agent per filleul"; terminated history coexists freely.
  // Append-only rebuild (no DELETE), atomic transaction, ids preserved → FK refs from
  // affiliate_payments / affiliate_relationship_games stay intact.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("aff_rel_unique_active_only_v1");
    if (fix.changes > 0) {
      const before = (db.prepare(`SELECT COUNT(*) AS n FROM affiliate_relationships`).get() as { n: number }).n;
      db.pragma("foreign_keys = OFF");
      const tx = db.transaction(() => {
        db.exec(`
          CREATE TABLE affiliate_relationships_new (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            affiliate_player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
            referred_player_id      INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
            origin_game_id          INTEGER REFERENCES games(id),
            start_date              TEXT NOT NULL DEFAULT (date('now')),
            status                  TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'terminated')),
            disclosed_action_pct    REAL,
            disclosed_rakeback_pct  REAL,
            disclosed_insurance_pct REAL,
            exclude_agency_extras   INTEGER NOT NULL DEFAULT 1,
            notes                   TEXT,
            created_at              TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO affiliate_relationships_new SELECT * FROM affiliate_relationships;
          DROP TABLE affiliate_relationships;
          ALTER TABLE affiliate_relationships_new RENAME TO affiliate_relationships;
          CREATE INDEX idx_aff_rel_affiliate ON affiliate_relationships(affiliate_player_id);
          CREATE INDEX idx_aff_rel_referred ON affiliate_relationships(referred_player_id);
          CREATE UNIQUE INDEX idx_aff_rel_referred_active ON affiliate_relationships(referred_player_id) WHERE status = 'active';
        `);
      });
      tx();
      db.pragma("foreign_keys = ON");
      const after = (db.prepare(`SELECT COUNT(*) AS n FROM affiliate_relationships`).get() as { n: number }).n;
      console.log(`[MIGRATION] aff_rel_unique_active_only_v1 applied (rows before=${before} after=${after})`);
    }
  } catch (err: any) {
    db.pragma("foreign_keys = ON");
    console.error(`[MIGRATION:aff_rel_unique_active_only_v1] FAILED:`, err.message);
    console.error(err.stack);
  }

  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_affiliate_profiles_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS affiliate_profiles (
          affiliate_player_id INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
          joined_at TEXT NOT NULL DEFAULT (datetime('now')),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused'))
        );
        INSERT OR IGNORE INTO affiliate_profiles (affiliate_player_id, joined_at, status)
        SELECT DISTINCT ar.affiliate_player_id, MIN(ar.start_date), 'active'
        FROM affiliate_relationships ar
        WHERE ar.status = 'active'
        GROUP BY ar.affiliate_player_id;
      `);
      console.log("[MIGRATION] add_affiliate_profiles_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_affiliate_profiles_v1] FAILED:`, err.message);
  }

  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_grindhouse_sessions_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS grindhouse_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          player_id INTEGER NOT NULL REFERENCES players(id),
          game_id INTEGER NOT NULL REFERENCES games(id),
          session_date TEXT NOT NULL DEFAULT (date('now')),
          duration_hours REAL NOT NULL,
          net_result_usdt REAL NOT NULL,
          notes TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_grindhouse_date ON grindhouse_sessions(session_date);
        CREATE INDEX IF NOT EXISTS idx_grindhouse_player ON grindhouse_sessions(player_id);
      `);
      console.log("[MIGRATION] add_grindhouse_sessions_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_grindhouse_sessions_v1] FAILED:`, err.message);
  }

  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_grindhouse_grinders_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS grindhouse_grinders (
          player_id INTEGER PRIMARY KEY REFERENCES players(id),
          joined_at TEXT NOT NULL DEFAULT (date('now')),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
          deal_percentage REAL DEFAULT 50,
          notes TEXT
        );
      `);
      console.log("[MIGRATION] add_grindhouse_grinders_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_grindhouse_grinders_v1] FAILED:`, err.message);
  }

  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_grindhouse_expenses_settlements_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS grindhouse_expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL DEFAULT (date('now')),
          amount_usdt REAL NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('grind', 'resto', 'autre')),
          player_id INTEGER REFERENCES players(id),
          description TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_grindhouse_expenses_date ON grindhouse_expenses(date);
        CREATE INDEX IF NOT EXISTS idx_grindhouse_expenses_type ON grindhouse_expenses(type);
        CREATE INDEX IF NOT EXISTS idx_grindhouse_expenses_player ON grindhouse_expenses(player_id);

        CREATE TABLE IF NOT EXISTS grindhouse_settlements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          player_id INTEGER NOT NULL REFERENCES players(id),
          period_start TEXT NOT NULL,
          period_end TEXT NOT NULL,
          sessions_pnl REAL NOT NULL,
          attributed_grind_fees REAL NOT NULL,
          pool_net REAL NOT NULL,
          grinder_share REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid')),
          paid_at TEXT,
          notes TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_grindhouse_settlements_player ON grindhouse_settlements(player_id);
        CREATE INDEX IF NOT EXISTS idx_grindhouse_settlements_period ON grindhouse_settlements(period_start, period_end);
      `);
      console.log("[MIGRATION] add_grindhouse_expenses_settlements_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_grindhouse_expenses_settlements_v1] FAILED:`, err.message);
  }

  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_affiliate_relationship_games_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS affiliate_relationship_games (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          relationship_id INTEGER NOT NULL REFERENCES affiliate_relationships(id) ON DELETE CASCADE,
          game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          disclosed_action_pct REAL,
          disclosed_rakeback_pct REAL,
          disclosed_insurance_pct REAL,
          exclude_agency_extras INTEGER NOT NULL DEFAULT 1,
          UNIQUE(relationship_id, game_id)
        );
      `);
      console.log("[MIGRATION] add_affiliate_relationship_games_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_affiliate_relationship_games_v1] FAILED:`, err.message);
  }

  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_games_deal_columns_v1");
    if (fix.changes > 0) {
      for (const col of [
        "exact_action_pct", "exact_rakeback_pct", "exact_insurance_pct",
        "perceived_action_pct", "perceived_rakeback_pct", "perceived_insurance_pct",
      ]) {
        try { db.exec(`ALTER TABLE games ADD COLUMN ${col} REAL`); } catch {}
      }
      console.log("[MIGRATION] add_games_deal_columns_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_games_deal_columns_v1] FAILED:`, err.message);
  }

  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_aff_rel_games_excluded_v1");
    if (fix.changes > 0) {
      try { db.exec(`ALTER TABLE affiliate_relationship_games ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0`); } catch {}
      console.log("[MIGRATION] add_aff_rel_games_excluded_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_aff_rel_games_excluded_v1] FAILED:`, err.message);
  }

  // Add AAPKMY to games table (requires recreating table to update CHECK constraint)
  try {
    const fixAapk = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_aapkmy_game_v1");
    if (fixAapk.changes > 0) {
      db.pragma("foreign_keys = OFF");
      try {
        db.exec(`
          BEGIN;
          CREATE TABLE games_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE CHECK(name IN ('TELE','Wepoker','Xpoker','ClubGG','KKPOKER','A5POKER','AAPKMY')),
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
            default_action_pct REAL,
            exact_action_pct REAL,
            exact_rakeback_pct REAL,
            exact_insurance_pct REAL,
            perceived_action_pct REAL,
            perceived_rakeback_pct REAL,
            perceived_insurance_pct REAL
          );
          INSERT INTO games_new (id, name, status, default_action_pct, exact_action_pct, exact_rakeback_pct, exact_insurance_pct, perceived_action_pct, perceived_rakeback_pct, perceived_insurance_pct)
            SELECT id, name, status, default_action_pct, exact_action_pct, exact_rakeback_pct, exact_insurance_pct, perceived_action_pct, perceived_rakeback_pct, perceived_insurance_pct FROM games;
          DROP TABLE games;
          ALTER TABLE games_new RENAME TO games;
          INSERT INTO games (name, status) VALUES ('AAPKMY', 'active');
          COMMIT;
        `);
      } finally {
        db.pragma("foreign_keys = ON");
      }
      console.log("[MIGRATION] add_aapkmy_game_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_aapkmy_game_v1] FAILED:`, err.message);
    console.error(err.stack);
  }

  // Fix player_game_ids FK pointing to defunct "games_old" instead of "games"
  try {
    const fixPgiFK = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("fix_player_game_ids_fk_v1");
    if (fixPgiFK.changes > 0) {
      db.pragma("foreign_keys = OFF");
      try {
        db.exec(`
          BEGIN;
          CREATE TABLE player_game_ids_new (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
            game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
            external_id TEXT NOT NULL,
            UNIQUE(game_id, external_id)
          );
          INSERT INTO player_game_ids_new (id, player_id, game_id, external_id)
            SELECT id, player_id, game_id, external_id FROM player_game_ids;
          DROP TABLE player_game_ids;
          ALTER TABLE player_game_ids_new RENAME TO player_game_ids;
          COMMIT;
        `);
      } finally {
        db.pragma("foreign_keys = ON");
      }
      console.log("[MIGRATION] fix_player_game_ids_fk_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:fix_player_game_ids_fk_v1] FAILED:`, err.message);
    console.error(err.stack);
  }

  // Free-text variant per grindhouse session (Squid, Holdem, PLO…) — filters come later
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_session_variant_v1");
    if (fix.changes > 0) {
      db.exec(`ALTER TABLE grindhouse_sessions ADD COLUMN variant TEXT`);
      console.log("[MIGRATION] add_session_variant_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_session_variant_v1] FAILED:`, err.message);
  }

  // Drop the closed name CHECK on games so games can be created from the UI
  // (POST /api/games). Same rebuild pattern as add_aapkmy_game_v1; UNIQUE stays.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("drop_games_name_check_v1");
    if (fix.changes > 0) {
      db.pragma("foreign_keys = OFF");
      try {
        db.exec(`
          BEGIN;
          CREATE TABLE games_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
            default_action_pct REAL,
            exact_action_pct REAL,
            exact_rakeback_pct REAL,
            exact_insurance_pct REAL,
            perceived_action_pct REAL,
            perceived_rakeback_pct REAL,
            perceived_insurance_pct REAL
          );
          INSERT INTO games_new (id, name, status, default_action_pct, exact_action_pct, exact_rakeback_pct, exact_insurance_pct, perceived_action_pct, perceived_rakeback_pct, perceived_insurance_pct)
            SELECT id, name, status, default_action_pct, exact_action_pct, exact_rakeback_pct, exact_insurance_pct, perceived_action_pct, perceived_rakeback_pct, perceived_insurance_pct FROM games;
          DROP TABLE games;
          ALTER TABLE games_new RENAME TO games;
          COMMIT;
        `);
      } finally {
        db.pragma("foreign_keys = ON");
      }
      console.log("[MIGRATION] drop_games_name_check_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:drop_games_name_check_v1] FAILED:`, err.message);
    console.error(err.stack);
  }

  // Per-game currency — grindhouse session amounts inherit it. NOTE: despite its name,
  // grindhouse_sessions.net_result_usdt stores the RAW amount in the game's currency;
  // aggregates convert via toUsdt() (manual rate per currency in settings, invariant #3).
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_games_currency_v1");
    if (fix.changes > 0) {
      db.exec(`ALTER TABLE games ADD COLUMN currency TEXT NOT NULL DEFAULT 'USDT'`);
      console.log("[MIGRATION] add_games_currency_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_games_currency_v1] FAILED:`, err.message);
  }

  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_agent_activity_notifs_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_activity_notifs (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          filleul_player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          action_type       TEXT NOT NULL,   -- 'deposit' | 'big_session'
          action_ref        TEXT NOT NULL,   -- unique id of the source action (e.g. 'deposit:<wallet_tx_id>') for dedup
          amount_usdt       REAL,
          notified_at       TEXT NOT NULL DEFAULT (datetime('now')),
          dry_run           INTEGER NOT NULL DEFAULT 1,
          UNIQUE(agent_player_id, action_ref)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_notifs_agent_day ON agent_activity_notifs(agent_player_id, dry_run, notified_at);
      `);
      console.log("[MIGRATION] add_agent_activity_notifs_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_agent_activity_notifs_v1] FAILED:`, err.message);
  }

  // Seed AKS game (wallet-based, mirror of A5POKER). The games.name CHECK was
  // dropped in drop_games_name_check_v1, so a plain INSERT OR IGNORE suffices.
  // Wallet mère is configured later via Config Wallets — not seeded here.
  try {
    const fixAks = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_aks_game_v1");
    if (fixAks.changes > 0) {
      db.prepare(`INSERT OR IGNORE INTO games (name, status, default_action_pct, currency) VALUES ('AKS', 'active', 30, 'USDT')`).run();
      console.log("[MIGRATION] add_aks_game_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_aks_game_v1] FAILED:`, err.message);
  }

  // Seed QQPK game (wallet-based plumbing, mirror of AKS). STAKING model — the C/T
  // settlement engine lands in Phase 3; Phase 1 only registers the game so wallets,
  // TronGrid sync and net-brut P&L work. The games.name CHECK was dropped earlier
  // (drop_games_name_check_v1), so a plain INSERT OR IGNORE suffices. default_action_pct=0
  // because staking carries no action %. Wallet mère is configured later via Settings.
  try {
    const fixQqpk = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_qqpk_game_v1");
    if (fixQqpk.changes > 0) {
      db.prepare(`INSERT OR IGNORE INTO games (name, status, default_action_pct, currency) VALUES ('QQPK', 'active', 0, 'USDT')`).run();
      console.log("[MIGRATION] add_qqpk_game_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_qqpk_game_v1] FAILED:`, err.message);
  }

  // Seed NUTSPK game (wallet-based action game, mirror of AKS). The games.name CHECK was
  // dropped in drop_games_name_check_v1, so a plain INSERT OR IGNORE suffices. default_action_pct=30
  // is only a prompt hint — the real % is chosen per-player at onboarding (free text). Wallet mère
  // is configured later via Settings → Config Wallets — not seeded here.
  try {
    const fixNutspk = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_nutspk_game_v1");
    if (fixNutspk.changes > 0) {
      db.prepare(`INSERT OR IGNORE INTO games (name, status, default_action_pct, currency) VALUES ('NUTSPK', 'active', 30, 'USDT')`).run();
      console.log("[MIGRATION] add_nutspk_game_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_nutspk_game_v1] FAILED:`, err.message);
  }

  // QQPK staking blocks — persistent C/T state per player per calendar-month block.
  // Phase 3: table only. The pure calc engine lives in lib/qqpk-staking-engine.ts; the
  // saisie-mains UI / "Régler le mois" button (Phase 4) and dashboard rollup (Phase 5)
  // come later. Money math NEVER lives here — this is storage only.
  //   c_prec/t_prec : state carried from the previous period (0 at block open after reset)
  //   c/t           : recomputed state (C = c_prec + resultat_periode; T per 70/30 rule)
  //   reglement     : T − t_prec (>0 Cercle pays player, <0 player pays Cercle)
  //   condition_30k_applied : 1 iff the <30k-hands no-coverage rule suppressed a loss coverage
  try {
    const fixStaking = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_qqpk_staking_v1");
    if (fixStaking.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS qqpk_staking_blocks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          player_id INTEGER NOT NULL REFERENCES players(id),
          block_month TEXT NOT NULL,                 -- cycle id: per-player rolling cycle START date 'YYYY-MM-DD' (Phase 4.5; was 'YYYY-MM' calendar month in Phase 3/4)
          block_start TEXT NOT NULL,                 -- UTC ISO of month start (Paris-anchored)
          block_end TEXT NOT NULL,                   -- UTC ISO of month end (Paris-anchored)
          resultat_periode REAL NOT NULL DEFAULT 0,  -- on-chain net for the period (withdrawals − deposits, USDT)
          mains INTEGER NOT NULL DEFAULT 0,          -- hands played (manual entry)
          c_prec REAL NOT NULL DEFAULT 0,
          c REAL NOT NULL DEFAULT 0,
          t_prec REAL NOT NULL DEFAULT 0,
          t REAL NOT NULL DEFAULT 0,
          reglement REAL NOT NULL DEFAULT 0,
          condition_30k_applied INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','computed','settled')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT,
          UNIQUE(player_id, block_month)
        )
      `);
      console.log("[MIGRATION] add_qqpk_staking_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_qqpk_staking_v1] FAILED:`, err.message);
  }

  // Deal acceptance trace — append-only audit log of explicit deal acceptances.
  // Written when a player clicks "✅ J'accepte" in any onboarding flow, BEFORE the
  // game link is revealed (anti-bypass). Proof of which deal/% was accepted, when.
  // Not used in any P&L computation — audit only.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_deal_acceptances_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS deal_acceptances (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          action_pct  REAL,
          accepted_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_deal_acceptances_player ON deal_acceptances(player_id, game_id);
      `);
      console.log("[MIGRATION] add_deal_acceptances_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_deal_acceptances_v1] FAILED:`, err.message);
  }

  // Robust affiliate attribution: capture the referred user's telegram_id on the lead so
  // the ref_<agent> deep link works even when the filleul has no @username (referred_handle
  // is NOT NULL, so a synthetic "tg:<id>" handle is stored alongside). Conversion then
  // matches by telegram_id, not @handle. (Bug: Maxico/Maxime lost attribution to agent Theo.)
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_affiliate_lead_telegram_id_v1");
    if (fix.changes > 0) {
      try { db.exec(`ALTER TABLE affiliate_leads ADD COLUMN referred_telegram_id INTEGER`); } catch {}
      console.log("[MIGRATION] add_affiliate_lead_telegram_id_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_affiliate_lead_telegram_id_v1] FAILED:`, err.message);
  }

  // ── Manual settlement (action games: A5POKER / KKPOKER / AKS) — Phase 1 schema only ──
  // Replaces the weekly auto-settlement (kept read-only) with a per-game, per-player manual
  // tx-selection model. Phase 1 is structure only — no selection/lock/compute logic yet.
  // Does NOT touch weekly_settlements (legacy history) or QQPK (qqpk_staking_blocks).
  //
  // 1) Light per-transaction settled flag + nullable back-link to the settlement that consumed it.
  //    `settled` (0=available, 1=consumed by a manual settlement). `settlement_id` is a light link
  //    (no settlement_lines child table for now) so a settlement's txs can be regrouped / un-locked.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_settlement_flag_v1");
    if (fix.changes > 0) {
      try { db.exec(`ALTER TABLE wallet_transactions ADD COLUMN settled INTEGER NOT NULL DEFAULT 0`); } catch {}
      try { db.exec(`ALTER TABLE wallet_transactions ADD COLUMN settlement_id INTEGER`); } catch {}
      // Fast lookup of unsettled tx scoped per game+player (the selection list).
      db.exec(`CREATE INDEX IF NOT EXISTS idx_wallet_tx_unsettled ON wallet_transactions(game_id, player_id, settled);`);
      // Fast "which txs belong to settlement N" (regroup / unlock).
      db.exec(`CREATE INDEX IF NOT EXISTS idx_wallet_tx_settlement ON wallet_transactions(settlement_id) WHERE settlement_id IS NOT NULL;`);
      console.log("[MIGRATION] add_settlement_flag_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_settlement_flag_v1] FAILED:`, err.message);
  }

  // 2) Manual settlements ledger — one row per locked/paid manual settlement (per game, per player).
  //    On lock: insert a 'locked' row + flag the selected wallet_transactions (settled=1, settlement_id=id).
  //    On payment: status='paid' + paid_at + tx_hash. Light back-link only (no settlement_lines table).
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_manual_settlements_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS manual_settlements (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id             INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          player_id           INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          net_selected_usdt   REAL NOT NULL DEFAULT 0,   -- Σ withdrawals − Σ deposits of the selected txs (USDT)
          action_pct_applied  REAL NOT NULL DEFAULT 0,   -- deal action_pct snapshot at lock time
          amount_due_usdt     REAL NOT NULL DEFAULT 0,   -- net_selected_usdt × action_pct_applied / 100
          status              TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','paid')),
          tx_hash             TEXT,                       -- on-chain ref of the payment, set when paid
          notes               TEXT,
          locked_at           TEXT NOT NULL DEFAULT (datetime('now')),
          paid_at             TEXT,
          created_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_manual_settlements_scope ON manual_settlements(game_id, player_id, status);
      `);
      console.log("[MIGRATION] add_manual_settlements_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_manual_settlements_v1] FAILED:`, err.message);
  }

  // 2-bis) Explicit payment DATE (YYYY-MM-DD) — distinct from paid_at.
  //   paid_at   = audit timestamp of the click (datetime('now'), never backdated)
  //   paid_date = the day the money actually moved, as declared by Baki on the
  //               /payments hub. Nullable; readers fall back to date(paid_at).
  //   Additive only (invariant #6) — no backfill, no rewrite of existing rows.
  //   markPaid() references paid_date UNCONDITIONALLY, so a one-shot ALTER failure would
  //   break payment marking on every room page, not just the hub. The _applied_fixes flag is
  //   therefore only a log marker: the ALTER runs on EVERY boot and is idempotent (it throws
  //   "duplicate column name" once applied, which we swallow). Self-healing by construction.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("manual_settlements_paid_date_v1");
    let added = false;
    try { db.exec(`ALTER TABLE manual_settlements ADD COLUMN paid_date TEXT`); added = true; } catch {}
    if (fix.changes > 0 || added) console.log(`[MIGRATION] manual_settlements_paid_date_v1 (column added: ${added})`);
    const hasCol = (db.prepare(`PRAGMA table_info(manual_settlements)`).all() as { name: string }[])
      .some(c => c.name === "paid_date");
    if (!hasCol) console.error(`[MIGRATION:manual_settlements_paid_date_v1] paid_date MISSING after ALTER — markPaid will fail`);
  } catch (err: any) {
    console.error(`[MIGRATION:manual_settlements_paid_date_v1] FAILED:`, err.message);
  }

  // 3) QQPK manual rakeback — owner-only revenue the Cercle earns from the room per player,
  //    per rolling cycle. INVISIBLE to the player: NOT in the 70/30 deal, NOT in the staking
  //    engine, NOT in settlements/lock, NOT in any Telegram message. Display-only additive
  //    line so Baki sees his true total (Part Cercle prévisionnelle + RB manuel).
  //    Key: cycle_start = same per-player rolling-cycle start date as qqpk_staking_blocks.block_month.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_qqpk_cycle_rakeback_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS qqpk_cycle_rakeback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          player_id INTEGER NOT NULL REFERENCES players(id),
          cycle_start TEXT NOT NULL,                -- 'YYYY-MM-DD', = qqpk_staking_blocks.block_month of that cycle
          amount REAL NOT NULL DEFAULT 0,           -- USDT, manual entry, ≥ 0
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT,
          UNIQUE(player_id, cycle_start)
        )
      `);
      console.log("[MIGRATION] add_qqpk_cycle_rakeback_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_qqpk_cycle_rakeback_v1] FAILED:`, err.message);
  }

  // 4) QQPK entry journal — append-only log of dated saisies for the evolution graph.
  //    DISPLAY-ONLY: never read by the engine, settlements, or lock — the graph consumes it.
  //    kind 'mains'/'rb' logged by their write-paths (setQqpkMains/setQqpkCycleRakeback);
  //    'result' events are NOT logged: the résultat is derived from wallet_transactions,
  //    which are already fully dated (tx_datetime) — reserved in the CHECK for the future.
  //    Seed: one dated point per existing rb/mains row (their real updated_at) so current
  //    cycles don't start from an empty graph. History BEFORE the journal doesn't exist —
  //    no retroactive fake curve for mains/rb.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_qqpk_entry_log_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS qqpk_entry_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          player_id INTEGER NOT NULL REFERENCES players(id),
          cycle_start TEXT NOT NULL,                -- 'YYYY-MM-DD', = qqpk_staking_blocks.block_month
          kind TEXT NOT NULL CHECK(kind IN ('result','mains','rb')),
          value REAL NOT NULL,                      -- the SAVED value (absolute, not a delta)
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_qqpk_entry_log_scope ON qqpk_entry_log(player_id, cycle_start, kind, created_at);
        INSERT INTO qqpk_entry_log (player_id, cycle_start, kind, value, created_at)
          SELECT player_id, cycle_start, 'rb', amount, COALESCE(updated_at, created_at) FROM qqpk_cycle_rakeback;
        INSERT INTO qqpk_entry_log (player_id, cycle_start, kind, value, created_at)
          SELECT player_id, block_month, 'mains', mains, COALESCE(updated_at, created_at) FROM qqpk_staking_blocks WHERE mains > 0;
      `);
      console.log("[MIGRATION] add_qqpk_entry_log_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_qqpk_entry_log_v1] FAILED:`, err.message);
  }

  // Seed OKPOKER game (wallet-based action game, mirror of AKS). The games.name CHECK was
  // dropped in drop_games_name_check_v1, so a plain INSERT OR IGNORE suffices. default_action_pct=30
  // is only a prompt hint — the real % is chosen per-player at onboarding (free text).
  // Unlike AKS/NUTSPK the wallet mère IS seeded here (Baki provided it with the launch):
  // address validated on-chain before shipping (TronGrid: existing account, real USDT history).
  try {
    const fixOkpoker = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_okpoker_game_v1");
    if (fixOkpoker.changes > 0) {
      db.prepare(`INSERT OR IGNORE INTO games (name, status, default_action_pct, currency) VALUES ('OKPOKER', 'active', 30, 'USDT')`).run();
      const okGame = db.prepare(`SELECT id FROM games WHERE name = 'OKPOKER'`).get() as { id: number } | undefined;
      if (okGame) {
        db.prepare(`INSERT OR IGNORE INTO wallet_meres (address, label, game_id, status) VALUES (?, ?, ?, 'active')`)
          .run("TYCBsKvJSrLoj6pudJCLFNFYdBcntNP1gU", "main", okGame.id);
      }
      console.log("[MIGRATION] add_okpoker_game_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_okpoker_game_v1] FAILED:`, err.message);
  }

  // Reclassify Iacopo's A5 cashout mis-stamped QQPK (821.75 USDT, 2026-07-05).
  // Verified on-chain: sent BY the A5POKER mère TVGMz… TO his A5POKER cashout
  // wallet TMrfADRo… (also registered as his QQPK game wallet) — the QQPK sync's
  // old cross-game Pass 1 rule claimed it first, and the tron_tx_hash dedup then
  // blocked the correct A5 import. The sync rule is fixed (#7/#8); this repairs
  // the one existing row. Keyed by hash, guarded on settled=0 + current game.
  try {
    const fixIacopo = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("reclass_iacopo_a5_cashout_v1");
    if (fixIacopo.changes > 0) {
      const r = db.prepare(`
        UPDATE wallet_transactions
        SET game_id = (SELECT id FROM games WHERE name = 'A5POKER')
        WHERE tron_tx_hash = 'b8ee0f3655c57d86e880c9b2b52c258b735fdd4b60353f7e8bf8d3e2b91af281'
          AND type = 'withdrawal' AND settled = 0
          AND game_id = (SELECT id FROM games WHERE name = 'QQPK')
      `).run();
      console.log(`[MIGRATION] reclass_iacopo_a5_cashout_v1 applied (${r.changes} row)`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:reclass_iacopo_a5_cashout_v1] FAILED:`, err.message);
  }

  // Seed JVIP game (wallet-based action game, config-only clone of OKPOKER).
  // default_action_pct=30 is only a prompt hint — the real % is chosen per-player at
  // onboarding (free text). Wallet mère provided by Baki at launch, validated on-chain
  // before shipping (TronGrid: existing account, recent activity).
  try {
    const fixJvip = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_jvip_game_v1");
    if (fixJvip.changes > 0) {
      db.prepare(`INSERT OR IGNORE INTO games (name, status, default_action_pct, currency) VALUES ('JVIP', 'active', 30, 'USDT')`).run();
      const jvipGame = db.prepare(`SELECT id FROM games WHERE name = 'JVIP'`).get() as { id: number } | undefined;
      if (jvipGame) {
        db.prepare(`INSERT OR IGNORE INTO wallet_meres (address, label, game_id, status) VALUES (?, ?, ?, 'active')`)
          .run("TKtLFAJ6wWSHZmQNgZfUGbxFRK5wf8jEzJ", "main", jvipGame.id);
      }
      console.log("[MIGRATION] add_jvip_game_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_jvip_game_v1] FAILED:`, err.message);
  }

  // Align Hugo Roine (player 1) and Hakim AMIRUL (player 53) to 100% action on
  // BOTH AKS and OKPOKER (decision Baki, with the AKS/OK POKER merge): their
  // OKPOKER deals were 30/50 while AKS was 100, and the settlement engine's
  // divergent-deal guard blocks any settlement for them on the merged view
  // until the deals agree. AKS rows are already 100 — idempotent there.
  try {
    const fixAlign = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("align_aksok_action_pct_100_v1");
    if (fixAlign.changes > 0) {
      const r = db.prepare(`
        UPDATE player_game_deals
        SET action_pct = 100
        WHERE player_id IN (1, 53)
          AND game_id IN (SELECT id FROM games WHERE name IN ('AKS', 'OKPOKER'))
      `).run();
      console.log(`[MIGRATION] align_aksok_action_pct_100_v1 applied (${r.changes} rows)`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:align_aksok_action_pct_100_v1] FAILED:`, err.message);
  }

  // Seed TTPOKER game (wallet-based action game, config-only clone of OKPOKER/JVIP).
  // default_action_pct=30 is only a prompt hint — the real % is chosen per-player at
  // onboarding (free text). Wallet mère provided by Baki at launch, validated on-chain
  // before shipping (TronGrid: existing account since 2025-02, recent activity).
  try {
    const fixTtpoker = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_ttpoker_game_v1");
    if (fixTtpoker.changes > 0) {
      db.prepare(`INSERT OR IGNORE INTO games (name, status, default_action_pct, currency) VALUES ('TTPOKER', 'active', 30, 'USDT')`).run();
      const ttGame = db.prepare(`SELECT id FROM games WHERE name = 'TTPOKER'`).get() as { id: number } | undefined;
      if (ttGame) {
        db.prepare(`INSERT OR IGNORE INTO wallet_meres (address, label, game_id, status) VALUES (?, ?, ?, 'active')`)
          .run("TDMm86DeHb4wqvoghxMS2oipt8MDu418Ma", "main", ttGame.id);
      }
      console.log("[MIGRATION] add_ttpoker_game_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_ttpoker_game_v1] FAILED:`, err.message);
  }

  // Duplicate CRM player "Paul" (id 10, no telegram) shares his cashout/game wallet
  // addresses with the real "Paul ☀️" (id 45): the shared-wallet sync then imported
  // each on-chain transfer under BOTH players (31 double-counted txs), and the
  // one-owner-per-cashout guard blocks every wallet save on id 45. Baki: solve the
  // address conflict. This removes id 10's WALLET REGISTRATIONS ONLY — his
  // wallet_transactions / deals / settlement history is deliberately untouched
  // (separate, explicitly-scoped cleanup if Baki wants the historical dedup).
  try {
    const fixPaul = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("cleanup_paul_duplicate_wallets_v1");
    if (fixPaul.changes > 0) {
      const co = db.prepare(`DELETE FROM player_wallet_cashouts WHERE player_id = 10`).run();
      const gw = db.prepare(`DELETE FROM player_wallet_games WHERE player_id = 10`).run();
      // Legacy TELE columns too — verified set in prod (tele_wallet_cashout holds the
      // shared TTHWAph… address). TELE is archived so they are dormant, but nulling
      // them removes the last registration of the shared addresses under id 10.
      db.prepare(`UPDATE players SET tron_address = NULL, tele_wallet_cashout = NULL WHERE id = 10`).run();
      console.log(`[MIGRATION] cleanup_paul_duplicate_wallets_v1 applied (${co.changes} cashouts, ${gw.changes} game wallets, legacy cols nulled)`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:cleanup_paul_duplicate_wallets_v1] FAILED:`, err.message);
  }

  // Persistent pitch-intent ledger for self-service deep-link games (OKPOKER/JVIP/TTPOKER).
  // Makes ?start=<game> incassable: the auto-pitch fires on player join even after a redeploy
  // or a delayed join (the in-memory pendingGroupData Map does not survive a restart).
  // UNIQUE(player_telegram_id, game_name) = one live intent per player+game; consumed_at is
  // the dedup marker (claimed atomically on join → never two pitches). See pending-game-pitch.ts.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_pending_game_pitches_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pending_game_pitches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          player_telegram_id INTEGER NOT NULL,
          game_name TEXT NOT NULL,
          group_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          consumed_at TEXT,
          UNIQUE(player_telegram_id, game_name)
        );
        CREATE INDEX IF NOT EXISTS idx_pending_game_pitches_lookup
          ON pending_game_pitches(player_telegram_id, consumed_at);
      `);
      console.log("[MIGRATION] add_pending_game_pitches_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_pending_game_pitches_v1] FAILED:`, err.message);
  }

  // Player aliases (display-only MVP): two players sharing a cashout wallet address = same
  // entity/team → grouped under an alias so the P&L views can mix their results. This is
  // PRESENTATION ONLY — settlements stay per-player, the money engine is untouched. A player
  // belongs to at most ONE alias (UNIQUE player_id), and once a member it is never moved
  // automatically (stability). Detection = shared cashout address, union-find (lib/aliases.ts).
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_player_aliases_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS player_aliases (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          label TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS player_alias_members (
          alias_id INTEGER NOT NULL REFERENCES player_aliases(id) ON DELETE CASCADE,
          player_id INTEGER NOT NULL UNIQUE REFERENCES players(id),
          added_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_player_alias_members_alias ON player_alias_members(alias_id);
      `);
      console.log("[MIGRATION] add_player_aliases_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_player_aliases_v1] FAILED:`, err.message);
  }

  // 3 AKS game wallets moved Paul ☀️ (45) → Maxime Legreen (29) on 2026-07-14: the next
  // sync re-imported the addresses' full history under Max — his 4 rows below duplicate
  // Paul's 4 buy-ins of 2026-07-13 (3×500 + 300 USDT), already settled under Paul.
  // Delete Max's unsettled copies only, keyed by hash + player, guarded settled=0 and
  // settlement_id IS NULL so a settlement done in the meantime is never touched. The
  // reassignment guard in insertWalletTransactionByHash keeps the next sync from
  // recreating them (hashes stay attributed to Paul).
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("dedup_aks_paul_max_reassigned_deposits_v1");
    if (fix.changes > 0) {
      const dupFilter = `
        SELECT id FROM wallet_transactions
        WHERE player_id = 29 AND type = 'deposit' AND source = 'sync'
          AND settled = 0 AND settlement_id IS NULL
          AND tron_tx_hash IN (
            'dc6da59ddab1d786bbf393168c6d1000935174c3b745d8b3433c58a25e129bc4',
            'd8ede9a44923cf5785ea228cca53d5a661eb472712fd65909bd3128452ed5fca',
            '7225dd6876a649635509bea6529b015eac49acde132db3bcad0df776745ea8dd',
            '214fd6754b186d3180d28f0f2a85fca96c95bdb371dad6b77d44a9e562b959bf'
          )`;
      const tx = db.transaction(() => {
        // weekly_settlement_tx_overrides has a FK on wallet_transactions with no ON
        // DELETE: an override on a dupe row would abort the DELETE while the
        // _applied_fixes marker is already consumed. Purge overrides first.
        const ov = db.prepare(`DELETE FROM weekly_settlement_tx_overrides WHERE wallet_transaction_id IN (${dupFilter})`).run();
        const r = db.prepare(`DELETE FROM wallet_transactions WHERE id IN (${dupFilter})`).run();
        console.log(`[MIGRATION] dedup_aks_paul_max_reassigned_deposits_v1 applied (${r.changes} rows deleted, expected 4; ${ov.changes} overrides purged)`);
      });
      tx();
    }
  } catch (err: any) {
    console.error(`[MIGRATION:dedup_aks_paul_max_reassigned_deposits_v1] FAILED:`, err.message);
  }

  // Same reassignment dedup, Hugo Roine (1) → Sacha Bouaziz (31) on AKS: 3 deposits of
  // 2026-07-10 (3×500 USDT, funded from Hugo's cashout wallet TUMXxSL6…) were re-imported
  // under Sacha when the game wallets moved to him — they are Hugo's stakes, not Sacha's
  // buy-ins (Baki 2026-07-16: "ce n'était pas de lui, j'ai utilisé ma wallet cashout").
  // Delete Sacha's copies only; Hugo's originals stay (consistent with his 27 other
  // TUMXxSL6-funded deposits). The reassignment guard blocks any re-import under Sacha.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("dedup_aks_hugo_sacha_reassigned_deposits_v1");
    if (fix.changes > 0) {
      const dupFilter = `
        SELECT id FROM wallet_transactions
        WHERE player_id = 31 AND type = 'deposit' AND source = 'sync'
          AND settled = 0 AND settlement_id IS NULL
          AND tron_tx_hash IN (
            'ea5ce1222512e2c8f3675622fe9b186cdd46d5e164dfeff91de5cf24fe573ffb',
            '576733e9fffcbb9ad15b930505d0aff3ac7f9cad793331cc30da6e44d0681ab6',
            'fa9ca28adf77b3ffdc3a2a4f89a6212cee7d43ebbf73e97a65bc2d355f684a40'
          )`;
      const tx = db.transaction(() => {
        // Same FK precaution as the Paul→Max dedup above: purge overrides first.
        const ov = db.prepare(`DELETE FROM weekly_settlement_tx_overrides WHERE wallet_transaction_id IN (${dupFilter})`).run();
        const r = db.prepare(`DELETE FROM wallet_transactions WHERE id IN (${dupFilter})`).run();
        console.log(`[MIGRATION] dedup_aks_hugo_sacha_reassigned_deposits_v1 applied (${r.changes} rows deleted, expected 3; ${ov.changes} overrides purged)`);
      });
      tx();
    }
  } catch (err: any) {
    console.error(`[MIGRATION:dedup_aks_hugo_sacha_reassigned_deposits_v1] FAILED:`, err.message);
  }

  // TVGMzH… mère cleanup (Hugo/GO 2026-07-16). The address is registered as an active
  // mère on TELE + KKPOKER + A5POKER but is now A5's mère in practice: July audit shows
  // all its 34 withdrawals attributed to A5 except one — a 1 072,73 A5 cashout to Hugo
  // claimed by the KK sync because his cashout TUMXxSL6… was registered on KK but not A5.
  // Four ops, each individually guarded/idempotent:
  //   1. retire the KKPOKER row of TVGMzH… (KK Pass 2 stops claiming its transfers;
  //      TELE and A5POKER rows untouched)
  //   2. register TUMXxSL6… as Hugo's A5POKER cashout (future TVGMzH→TUMX cashouts
  //      import under A5 instead of vanishing)
  //   3. reclass the one mis-stamped withdrawal KK→A5 (same pattern as
  //      reclass_iacopo_a5_cashout_v1; guarded settled=0 + no settlement link)
  //   4. reopen Hugo's KKPOKER deal (end_date=NULL) — it was soft-closed 2026-05-25,
  //      which blanked his Net P&L while July txs kept importing.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("reclass_hugo_a5_kk_cleanup_v1");
    if (fix.changes > 0) {
      const retire = db.prepare(`
        UPDATE wallet_meres SET status = 'retired', retired_at = datetime('now')
        WHERE address = 'TVGMzHejH9pbgREEQxCCDK7EzexDCvAKpB'
          AND game_id = (SELECT id FROM games WHERE name = 'KKPOKER')
          AND status = 'active'
      `).run();
      const cashout = db.prepare(`
        INSERT OR IGNORE INTO player_wallet_cashouts (player_id, address, game_id)
        SELECT 1, 'TUMXxSL6ZPrHFtYYepYYY5BjwqT3TQDkGd', id FROM games WHERE name = 'A5POKER'
      `).run();
      const reclass = db.prepare(`
        UPDATE wallet_transactions
        SET game_id = (SELECT id FROM games WHERE name = 'A5POKER')
        WHERE tron_tx_hash = 'bda937ba373aff8f121182bbec92cad86691a2d2887cfd8e278c411dee8f781f'
          AND player_id = 1 AND type = 'withdrawal'
          AND settled = 0 AND settlement_id IS NULL
          AND game_id = (SELECT id FROM games WHERE name = 'KKPOKER')
      `).run();
      const deal = db.prepare(`
        UPDATE player_game_deals SET end_date = NULL
        WHERE player_id = 1 AND game_id = (SELECT id FROM games WHERE name = 'KKPOKER')
      `).run();
      console.log(`[MIGRATION] reclass_hugo_a5_kk_cleanup_v1 applied (mere retired: ${retire.changes}, cashout added: ${cashout.changes}, tx reclassed: ${reclass.changes}, deal reopened: ${deal.changes} — expected 1/1/1/1)`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:reclass_hugo_a5_kk_cleanup_v1] FAILED:`, err.message);
  }

  // Snapshots quotidiens de trésorerie (graph "Trésorerie · évolution" du dashboard).
  // Table neuve, display-only — aucun lien avec wallet_transactions ni le money engine.
  // Peuplée par le backfill on-chain (route admin) puis le cron 23h50 Paris.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_treasury_snapshots_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS treasury_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL,
          address TEXT NOT NULL,
          usdt REAL NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(date, address)
        );
        CREATE INDEX IF NOT EXISTS idx_treasury_snapshots_date ON treasury_snapshots(date);
      `);
      console.log("[MIGRATION] add_treasury_snapshots_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_treasury_snapshots_v1] FAILED:`, err.message);
  }

  // Seed WN game (room sur la même app que A5POKER/NUTSPK — vue fusionnée A5NUTS,
  // même wallet mère TVGMzH…). default_action_pct=40 = suggestion du pitch (GO Hugo
  // 2026-07-20), le % réel est choisi par l'owner et aligné sur le deal A5NUTS
  // existant du joueur (le settlement fusionné refuse les % divergents).
  try {
    const fixWn = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_wn_game_v1");
    if (fixWn.changes > 0) {
      db.prepare(`INSERT OR IGNORE INTO games (name, status, default_action_pct, currency) VALUES ('WN', 'active', 40, 'USDT')`).run();
      const wnGame = db.prepare(`SELECT id FROM games WHERE name = 'WN'`).get() as { id: number } | undefined;
      if (wnGame) {
        db.prepare(`INSERT OR IGNORE INTO wallet_meres (address, label, game_id, status) VALUES (?, ?, ?, 'active')`)
          .run("TVGMzHejH9pbgREEQxCCDK7EzexDCvAKpB", "1st A5poker (WN)", wnGame.id);
      }
      console.log("[MIGRATION] add_wn_game_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_wn_game_v1] FAILED:`, err.message);
  }

  // Deal WN de Hakim AMIRUL : l'ancienne règle d'alignement a écrasé le 40 tapé par
  // Hugo avec son 25 A5 (test du 2026-07-20). Les % sont désormais indépendants →
  // remise à 40 (guard action_pct=25 : si Hugo l'a déjà corrigé à la main, no-op).
  try {
    const fixHakim = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("fix_hakim_wn_pct_40_v1");
    if (fixHakim.changes > 0) {
      const r = db.prepare(`
        UPDATE player_game_deals SET action_pct = 40
        WHERE player_id = (SELECT id FROM players WHERE name = 'Hakim AMIRUL')
          AND game_id = (SELECT id FROM games WHERE name = 'WN')
          AND action_pct = 25
      `).run();
      console.log(`[MIGRATION] fix_hakim_wn_pct_40_v1 applied (${r.changes} row)`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:fix_hakim_wn_pct_40_v1] FAILED:`, err.message);
  }

  // QQPK Funnel (GO Hugo 2026-07-22) — funnel de masse Instagram → bot DM, ZÉRO lien
  // avec le système QQPK staking existant (cycles/settlements intouchés). Tables neuves,
  // isolées : leads (pas des players) + reports hebdo importés du back-office de la room.
  // Seules les lignes dont Member ID = ID enregistré par un lead sont importées.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_qqpk_funnel_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS qqpk_funnel_leads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          telegram_id INTEGER NOT NULL UNIQUE,
          username TEXT,
          first_name TEXT,
          stage INTEGER NOT NULL DEFAULT 0,
          qqpk_member_id TEXT,
          blocked INTEGER NOT NULL DEFAULT 0,
          reminders_sent INTEGER NOT NULL DEFAULT 0,
          last_reminder_at TEXT,
          stage1_at TEXT,
          stage2_at TEXT,
          stage3_at TEXT,
          stage4_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_qqpk_funnel_leads_stage ON qqpk_funnel_leads(stage);
        CREATE INDEX IF NOT EXISTS idx_qqpk_funnel_leads_member ON qqpk_funnel_leads(qqpk_member_id);
        CREATE TABLE IF NOT EXISTS qqpk_funnel_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id TEXT NOT NULL,
          week_start TEXT NOT NULL,
          nickname TEXT,
          rake REAL NOT NULL DEFAULT 0,
          deposits REAL NOT NULL DEFAULT 0,
          withdrawals REAL NOT NULL DEFAULT 0,
          winloss REAL NOT NULL DEFAULT 0,
          insurance REAL NOT NULL DEFAULT 0,
          rewards REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(member_id, week_start)
        );
        CREATE INDEX IF NOT EXISTS idx_qqpk_funnel_reports_member ON qqpk_funnel_reports(member_id);
      `);
      console.log("[MIGRATION] add_qqpk_funnel_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_qqpk_funnel_v1] FAILED:`, err.message);
  }

  // Nexa Funnel (GO Hugo 2026-07-24) — funnel de masse NEXAPOKER, même modèle que
  // QQPK mais parcours différent : pas de rakeback (pitch = code bonus), room en
  // système d'agent → groupe Telegram privé créé au premier dépôt.
  // Tables neuves ISOLÉES : aucun lien avec players, QQPK, ni le money engine.
  //   • stage = palier MAX atteint (n'avance jamais à reculons) ; les timestamps
  //     par palier restent indépendants → « Marquer dépôt fait » fonctionne même
  //     si un import a déjà promu le lead à room_verified.
  //   • member_id UNIQUE nullable : SQLite tolère plusieurs NULL ; un ID déjà pris
  //     par un autre lead lève duplicate_id au lieu d'écraser.
  //   • nexa_lead_events : journal unique (transitions, relances, clics « question »,
  //     création de groupe, actions admin) — alimente la fiche lead et les logs.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_nexa_funnel_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS nexa_leads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tg_user_id INTEGER NOT NULL UNIQUE,
          tg_username TEXT,
          first_name TEXT,
          source TEXT NOT NULL DEFAULT 'direct',
          os TEXT,
          member_id TEXT UNIQUE,
          stage TEXT NOT NULL DEFAULT 'started'
            CHECK(stage IN ('started','app_installed','account_created','deposit_done','room_verified','played')),
          started_at TEXT,
          installed_at TEXT,
          account_at TEXT,
          deposit_at TEXT,
          verified_at TEXT,
          played_at TEXT,
          group_chat_id TEXT,
          group_invite_link TEXT,
          relances_count INTEGER NOT NULL DEFAULT 0,
          last_reminder_at TEXT,
          last_interaction_at TEXT,
          duplicate_id INTEGER NOT NULL DEFAULT 0,
          cold INTEGER NOT NULL DEFAULT 0,
          blocked INTEGER NOT NULL DEFAULT 0,
          notes TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_nexa_leads_stage ON nexa_leads(stage);
        CREATE INDEX IF NOT EXISTS idx_nexa_leads_member ON nexa_leads(member_id);

        CREATE TABLE IF NOT EXISTS nexa_lead_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          lead_id INTEGER NOT NULL REFERENCES nexa_leads(id),
          kind TEXT NOT NULL
            CHECK(kind IN ('stage_change','question','reminder','group_created','admin')),
          stage TEXT,
          payload TEXT,
          actor TEXT NOT NULL DEFAULT 'bot'
            CHECK(actor IN ('bot','import','admin')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_nexa_events_lead ON nexa_lead_events(lead_id, created_at);

        CREATE TABLE IF NOT EXISTS nexa_weekly_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          week_start TEXT NOT NULL,
          filename TEXT,
          rows_read INTEGER NOT NULL DEFAULT 0,
          matched_count INTEGER NOT NULL DEFAULT 0,
          uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_nexa_reports_week ON nexa_weekly_reports(week_start);

        CREATE TABLE IF NOT EXISTS nexa_weekly_stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          report_id INTEGER REFERENCES nexa_weekly_reports(id),
          member_id TEXT NOT NULL,
          week_start TEXT NOT NULL,
          nickname TEXT,
          rake REAL NOT NULL DEFAULT 0,
          deposits REAL NOT NULL DEFAULT 0,
          withdrawals REAL NOT NULL DEFAULT 0,
          winloss REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(week_start, member_id)
        );
        CREATE INDEX IF NOT EXISTS idx_nexa_stats_member ON nexa_weekly_stats(member_id);
      `);
      console.log("[MIGRATION] add_nexa_funnel_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_nexa_funnel_v1] FAILED:`, err.message);
  }

  // Anti-doublon de création/annonce du groupe Nexa (bug constaté en test : le
  // message « Bienvenue en direct avec nous » partait deux fois).
  // Cause : la création de groupe (CreateChat + MigrateChat + 5 topics + invite)
  // dépassait le délai d'attente du webhook Telegram, qui rejouait alors le même
  // callback → double traitement.
  //   • group_claimed_at  : verrou atomique — un seul traitement crée le groupe.
  //   • group_announced_at: le message de bienvenue + lien ne part qu'une fois.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_nexa_group_claim_v1");
    if (fix.changes > 0) {
      try { db.exec(`ALTER TABLE nexa_leads ADD COLUMN group_claimed_at TEXT`); } catch {}
      try { db.exec(`ALTER TABLE nexa_leads ADD COLUMN group_announced_at TEXT`); } catch {}
      console.log("[MIGRATION] add_nexa_group_claim_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_nexa_group_claim_v1] FAILED:`, err.message);
  }

  // Cycle de vie des groupes d'onboarding (audit Hugo 2026-07-25).
  //
  // Problème 1 — DOUBLONS : la création de groupe (userbot) n'était tracée NULLE PART
  // avant que le joueur rejoigne (la ligne `players` naît au join). Deux /start, ou un
  // webhook rejoué par Telegram parce que createPlayerGroup dépasse son délai, créaient
  // donc deux groupes (constaté : M K tg 7041662947 → 2 groupes la même minute).
  // Problème 2 — FANTÔMES : un groupe jamais rejoint restait à vie (15 des 16 groupes
  // morts trouvés à l'audit étaient même protégés du purge hebdo par le keep-guard,
  // puisque `players.telegram_group_id` était renseigné).
  //
  //   • group_creations : LE registre — une ligne dès la création, bien avant le join.
  //     C'est lui qui rend la création idempotente (clé = owner_key = tg_user_id) et qui
  //     alimente le job de nettoyage 24h (joined_at IS NULL AND cleaned_at IS NULL).
  //   • *_joined_at   : horodatage du join, posé depuis l'event Telegram `chat_member`.
  //   • *_not_joined  : flag « groupe non rejoint » → le lead est relançable au lieu
  //     d'être perdu, et le lien mort disparaît de la vue CRM.
  //   • onboarding_leads.group_* : le verrou de création du funnel joueur vit ici, car
  //     c'est la seule table qui a une ligne AVANT le join (upsert au /start).
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_group_lifecycle_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS group_creations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL UNIQUE,
          owner_kind TEXT NOT NULL CHECK(owner_kind IN ('player','nexa_lead')),
          owner_key INTEGER NOT NULL,
          owner_label TEXT,
          title TEXT,
          invite_link TEXT,
          topic_ids TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          joined_at TEXT,
          joined_by INTEGER,
          cleaned_at TEXT,
          cleanup_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_group_creations_owner ON group_creations(owner_kind, owner_key);
        CREATE INDEX IF NOT EXISTS idx_group_creations_pending ON group_creations(joined_at, cleaned_at, created_at);
      `);
      for (const sql of [
        `ALTER TABLE players ADD COLUMN group_joined_at TEXT`,
        `ALTER TABLE players ADD COLUMN group_not_joined INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE nexa_leads ADD COLUMN group_joined_at TEXT`,
        `ALTER TABLE nexa_leads ADD COLUMN group_not_joined INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE onboarding_leads ADD COLUMN group_chat_id TEXT`,
        `ALTER TABLE onboarding_leads ADD COLUMN group_invite_link TEXT`,
        `ALTER TABLE onboarding_leads ADD COLUMN group_claimed_at TEXT`,
        `ALTER TABLE onboarding_leads ADD COLUMN group_joined_at TEXT`,
        `ALTER TABLE onboarding_leads ADD COLUMN group_not_joined INTEGER NOT NULL DEFAULT 0`,
      ]) {
        try { db.exec(sql); } catch { /* colonne déjà là */ }
      }
      console.log("[MIGRATION] add_group_lifecycle_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_group_lifecycle_v1] FAILED:`, err.message);
  }

  // Porte unique de création de groupe (incident Alexis, 2026-08-04).
  //
  // Alexis avait déjà son groupe (`players.telegram_group_id = -1003723869680`, mai) ;
  // son rattachement à NEXA lui en a créé un SECOND (-1004319796631). Le garde-fou
  // existait pourtant : `ensureNexaGroup` appelle `findExistingGroupForTgUser`. Mais la
  // réutilisation était CONDITIONNÉE à l'obtention d'un lien d'invitation — pas de lien
  // (userbot HS, plus admin du vieux groupe), et le code retombait dans la création.
  // Un groupe trouvé doit être réutilisé même sans lien : le lien est un confort, pas
  // une condition. Et deux chemins (parrainage affilié, API admin) ne cherchaient rien
  // du tout et n'écrivaient jamais dans le registre.
  //
  //   • group_claims        : LE verrou, clé = tg_user_id (pas le lead, pas la room).
  //     Remplace les verrous par table (`nexa_leads.group_claimed_at`,
  //     `onboarding_leads.group_claimed_at`), qui ne se voyaient pas entre eux — deux
  //     funnels pouvaient créer en parallèle pour le MÊME utilisateur Telegram.
  //   • group_review_cases  : les cas AMBIGUS. Correspondance par handle ou par nom
  //     seulement ⇒ on ne crée rien, on ne fusionne rien, Hugo tranche à la main.
  //   • group_room_notices  : dédoublonne le message « room ajoutée à ton suivi » posté
  //     dans un groupe réutilisé — une room rattachée deux fois ne le poste qu'une fois.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_group_single_door_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS group_claims (
          tg_user_id INTEGER PRIMARY KEY,
          claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
          context    TEXT
        );

        CREATE TABLE IF NOT EXISTS group_review_cases (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          kind         TEXT NOT NULL CHECK(kind IN ('ambiguous_match','no_tg_user_id')),
          context      TEXT NOT NULL,
          tg_user_id   INTEGER,
          handle       TEXT,
          display_name TEXT,
          candidates   TEXT,
          detail       TEXT,
          status       TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at  TEXT,
          resolution   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_group_cases_status ON group_review_cases(status, created_at);
        -- Un même contexte non résolu ne s'empile pas : re-cliquer sur « Créer le groupe »
        -- rouvre le même cas au lieu d'en créer un dixième.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_group_cases_open
          ON group_review_cases(context) WHERE status = 'open';

        CREATE TABLE IF NOT EXISTS group_room_notices (
          chat_id    TEXT NOT NULL,
          room       TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (chat_id, room)
        );
      `);
      console.log("[MIGRATION] add_group_single_door_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_group_single_door_v1] FAILED:`, err.message);
  }

  // Archivage (soft-delete) de la liste Joueurs — audit Hugo 2026-07-25.
  // 142 des 237 lignes `players` n'ont JAMAIS été des joueurs : le bot est membre d'un
  // groupe communautaire sans rapport avec le poker (`𓂃🌿 نَفَحَاتٌ إِيمَانِيَّةٌ 🌿𓂃`,
  // chat -1004358906632) et `handleNewMembers` créait une ligne à chaque personne qui
  // rejoignait, sans vérifier que le chat était un groupe d'onboarding LeCercle.
  //
  // Colonne dédiée plutôt qu'une 4ᵉ valeur de `status` : `status` pilote déjà le bouton
  // Archiver (active↔inactive), des filtres et des KPIs — y injecter 'archived' aurait
  // changé silencieusement ces comportements. Ici l'archivage est orthogonal et
  // réversible : `archived_at = NULL` restaure.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_player_archive_v1");
    if (fix.changes > 0) {
      try { db.exec(`ALTER TABLE players ADD COLUMN archived_at TEXT`); } catch {}
      try { db.exec(`ALTER TABLE players ADD COLUMN archive_reason TEXT`); } catch {}
      console.log("[MIGRATION] add_player_archive_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_player_archive_v1] FAILED:`, err.message);
  }

  // Confirmation à deux étapes pour les actions de l'agent Telegram (Baki 2026-07-27).
  //
  // agent_pending_actions = l'INTENTION. L'outil appelé par Claude écrit une ligne ici
  // et s'arrête : il n'exécute rien. Seul un clic sur [Confirmer] déclenche l'exécution.
  // C'est ce qui garantit qu'aucun chemin ne va du texte du modèle à une écriture.
  //   • status : pending → confirmed | cancelled | expired | failed (jamais réouvert)
  //   • expires_at : une intention non confirmée meurt (TTL court) — pas de bouton
  //     oublié qui déclenche une action une semaine plus tard
  //   • requested_by : le confirmeur DOIT être le demandeur (vérifié à l'exécution),
  //     en plus du contrôle OWNER_IDS côté webhook
  //
  // agent_action_log = le JOURNAL. Une ligne par exécution tentée, avec l'état
  // avant/après sérialisé, pour que tout soit réversible à la main et auditable
  // depuis le back-office. Append-only : on n'édite jamais une ligne de log.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_agent_actions_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_pending_actions (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id      TEXT NOT NULL,
          requested_by INTEGER NOT NULL,
          tool         TEXT NOT NULL,
          level        TEXT NOT NULL CHECK(level IN ('simple','sensitive')),
          params_json  TEXT NOT NULL,
          preview      TEXT NOT NULL,
          status       TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','confirmed','cancelled','expired','failed')),
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at   TEXT NOT NULL,
          notified_at  TEXT,
          resolved_at  TEXT,
          resolved_by  INTEGER,
          result_text  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agent_pending_open
          ON agent_pending_actions(chat_id, status) WHERE status = 'pending';

        CREATE TABLE IF NOT EXISTS agent_action_log (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          pending_id  INTEGER REFERENCES agent_pending_actions(id) ON DELETE SET NULL,
          tool        TEXT NOT NULL,
          level       TEXT NOT NULL,
          params_json TEXT NOT NULL,
          actor       INTEGER NOT NULL,
          chat_id     TEXT NOT NULL,
          ok          INTEGER NOT NULL,
          error       TEXT,
          before_json TEXT,
          after_json  TEXT,
          summary     TEXT,
          executed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_agent_action_log_time ON agent_action_log(executed_at DESC);
      `);
      console.log("[MIGRATION] add_agent_actions_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_agent_actions_v1] FAILED:`, err.message);
  }

  // Langue du funnel Nexa (Hugo 2026-07-28) — le lead choisit FR ou EN au /start,
  // tout le funnel suit. Copy dans lib/funnels/nexa/copy.ts, socle lib/i18n/.
  //
  // DEUX colonnes, parce qu'elles répondent à deux questions différentes :
  //   • `lang`           → dans quelle langue on parle. Jamais NULL, défaut 'fr'.
  //   • `lang_chosen_at` → faut-il afficher le sélecteur ? NULL = jamais demandé.
  // Sans la seconde, impossible de distinguer « a choisi FR » de « lead créé avant
  // la feature » : tous les leads existants reverraient le sélecteur en pleine
  // séquence. Ici ils restent en français et ne le voient jamais.
  //
  // Pas de CHECK sur `lang` : ajouter une langue (ES…) ne doit toucher que
  // lib/i18n/index.ts. La validation est faite par `coerceLang()` à la lecture,
  // qui retombe sur DEFAULT_LANG pour toute valeur inconnue.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_nexa_lead_lang_v1");
    if (fix.changes > 0) {
      for (const sql of [
        `ALTER TABLE nexa_leads ADD COLUMN lang TEXT NOT NULL DEFAULT 'fr'`,
        `ALTER TABLE nexa_leads ADD COLUMN lang_chosen_at TEXT`,
      ]) {
        try { db.exec(sql); } catch { /* colonne déjà là */ }
      }
      console.log("[MIGRATION] add_nexa_lead_lang_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_nexa_lead_lang_v1] FAILED:`, err.message);
  }

  // Journal des relances d'onboarding (Hugo 2026-07-31) — append-only.
  //
  // Pourquoi : avant ça, la seule trace d'une relance vivait dans 4 colonnes mutables de
  // `onboarding_leads` (reminders_sent, last_reminder_at, ops_alerted, ops_alerted_at), écrasées
  // sur place. Pire, `trackOnboardingStep()` les remettait à zéro dès que le joueur interagissait :
  // une relance envoyée à un joueur actif effaçait sa propre trace. Incident du 30/07 (YuS) :
  // impossible d'auditer autrement qu'en croyant la capture d'écran du joueur.
  //
  // `sent_at_utc` est nommée explicitement : le conteneur tourne en UTC, `datetime('now')` écrit
  // de l'UTC, et le nom de colonne doit interdire toute relecture ambiguë à ±2 h.
  //
  // `conditions_json` fige les preuves d'activité TELLES QU'ÉVALUÉES au moment de l'envoi
  // (dernier rake, dernière tx, dernière interaction bot, nb wallets…). Sans ce snapshot,
  // rejouer un incident a posteriori est impossible : les données sous-jacentes ont bougé.
  //
  // Append-only imposé par triggers : un journal d'audit qu'on peut réécrire ne vaut rien.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_onboarding_reminder_log_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS onboarding_reminder_log (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          lead_id               INTEGER NOT NULL,
          telegram_id           INTEGER,
          player_id             INTEGER,
          phase                 TEXT NOT NULL CHECK(phase IN ('8h','24h','7d')),
          sent                  INTEGER NOT NULL DEFAULT 0,
          chat_id               TEXT,
          session_step          TEXT,
          step_entered_at       TEXT,
          hours_since           REAL,
          reminders_sent_before INTEGER,
          ops_alerted_before    INTEGER,
          conditions_json       TEXT NOT NULL DEFAULT '{}',
          sent_at_utc           TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_onboarding_reminder_log_lead
          ON onboarding_reminder_log(lead_id, sent_at_utc);
        CREATE INDEX IF NOT EXISTS idx_onboarding_reminder_log_sent_at
          ON onboarding_reminder_log(sent_at_utc);

        CREATE TRIGGER IF NOT EXISTS onboarding_reminder_log_no_update
        BEFORE UPDATE ON onboarding_reminder_log
        BEGIN SELECT RAISE(ABORT, 'onboarding_reminder_log est append-only'); END;

        CREATE TRIGGER IF NOT EXISTS onboarding_reminder_log_no_delete
        BEFORE DELETE ON onboarding_reminder_log
        BEGIN SELECT RAISE(ABORT, 'onboarding_reminder_log est append-only'); END;
      `);
      console.log("[MIGRATION] add_onboarding_reminder_log_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_onboarding_reminder_log_v1] FAILED:`, err.message);
  }

  // Dernière activité joueur (Hugo 2026-08-04) — colonne SÉPARÉE de `step_entered_at`.
  //
  // Pourquoi une colonne à part : `step_entered_at` répond à « depuis quand ce lead est à cette
  // étape », info métier utilisée ailleurs. La réutiliser pour l'activité détruirait ce sens, et
  // une écriture erronée corromprait une donnée réelle. `last_player_activity_at` est au contraire
  // jetable : recalculable, et une erreur y reste confinée.
  //
  // Écrite depuis le webhook Telegram, où `from.id` EST le telegram_id fourni par Telegram —
  // aucune résolution `chat_id -> telegram_id`, donc aucune attribution silencieusement fausse.
  // `onboarding_leads.telegram_id` étant UNIQUE, l'UPDATE touche 0 ou 1 ligne, jamais plus.
  //
  // Démarre NULL et non backfillable (tg_messages vide, settings._webhook_last n'garde qu'une
  // ligne écrasée). Pendant la transition, la relance teste AUSSI `telegram_sessions.created_at` :
  // NULL ici ne doit pas rendre tout le monde éligible. Ne retirer l'ancienne condition qu'une
  // fois cette colonne peuplée (~30 j).
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_last_player_activity_v1");
    if (fix.changes > 0) {
      try { db.exec(`ALTER TABLE onboarding_leads ADD COLUMN last_player_activity_at TEXT`); } catch { /* colonne déjà là */ }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_onboarding_leads_activity
                 ON onboarding_leads(last_player_activity_at)`);
      console.log("[MIGRATION] add_last_player_activity_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_last_player_activity_v1] FAILED:`, err.message);
  }

  // Reprise en main humaine du bot funnel — « live takeover » (Hugo 2026-08-04).
  //
  // Problème : le bot Nexa est 100 % scripté. Un lead qui pose une question hors
  // scénario reçoit une réponse générique et personne ne voit passer la question.
  // Le funnel n'a AUCUN historique de conversation : `nexa_lead_events` journalise
  // des transitions, pas des messages.
  //
  //   • bot_messages : l'historique complet, entrant ET sortant, takeover ou pas.
  //     C'est la source de vérité du panneau conversation du back-office.
  //     `created_at` est en millisecondes (strftime %f) et non `datetime('now')` :
  //     un message scripté et une réponse d'opérateur peuvent partir dans la même
  //     seconde, et le panneau doit afficher l'ordre RÉEL. Le format reste
  //     lexicographiquement triable et compatible avec fmtDateTime (slice 0-16).
  //     L'index UNIQUE partiel sur les entrants est le garde-fou d'idempotence :
  //     même si Telegram rejoue un update, un message lead n'est relayé qu'une fois.
  //
  //   • relay_map : admin_message_id -> lead_id. C'est ce qui permet de résoudre le
  //     lead quand l'opérateur utilise « Répondre » sur un post du chat admin.
  //     Clé composite (chat, message) : les message_id ne sont uniques QUE par chat,
  //     un UNIQUE sur admin_message_id seul casserait à tout changement de chat admin.
  //     Purgée à 30 j par le cron (au-delà, plus personne ne répond à un vieux post).
  //
  //   • telegram_updates : dédoublonnage au niveau update. Telegram rejoue un update
  //     quand le webhook dépasse son délai — c'est déjà arrivé sur ce repo (double
  //     création de groupe, double message de bienvenue, cf. add_nexa_group_claim_v1).
  //     Une ligne par update_id traité, purgée à 24 h.
  //
  //   • nexa_leads.takeover_until : tant que ce timestamp est dans le futur, aucun
  //     message AUTOMATIQUE ne part vers ce lead (relances, promotions d'import,
  //     confirmation de dépôt). Les réponses aux clics de bouton, elles, continuent —
  //     un lead qui pilote lui-même ne doit pas rester sans réponse (choix Hugo).
  //   • relances_off : /stop dans le chat admin — désactivation DÉFINITIVE des
  //     relances pour ce lead, indépendante du flag `cold` (qui, lui, se remet à 0
  //     dès que le lead avance d'une étape).
  //   • last_lead_msg_at : horodatage AFFICHÉ à côté de la pastille. Purement cosmétique.
  //   • last_read_msg_id : curseur de lecture, comparé directement au plus grand id
  //     entrant de bot_messages (« non lu ⇔ il existe un entrant d'id supérieur »).
  //     Ni horloge ni colonne miroir, volontairement : avec des timestamps,
  //     `strftime('%f')` plafonne à la milliseconde et un message reçu pendant
  //     l'ouverture du panneau passait pour lu ; avec une colonne `last_lead_msg_id`
  //     mise à jour juste après l'INSERT, une lecture intercalée entre les deux le
  //     ratait aussi. Comparer au contenu réel de la table ferme les deux fenêtres.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_live_takeover_v1");
    if (fix.changes > 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bot_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          lead_id INTEGER NOT NULL REFERENCES nexa_leads(id),
          direction TEXT NOT NULL CHECK(direction IN ('in','out')),
          sender TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'text',
          text TEXT,
          telegram_message_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_bot_messages_lead ON bot_messages(lead_id, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_messages_in_unique
          ON bot_messages(lead_id, telegram_message_id)
          WHERE direction = 'in' AND telegram_message_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS relay_map (
          admin_chat_id TEXT NOT NULL,
          admin_message_id INTEGER NOT NULL,
          lead_id INTEGER NOT NULL REFERENCES nexa_leads(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (admin_chat_id, admin_message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_relay_map_lead ON relay_map(lead_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_relay_map_age ON relay_map(created_at);

        CREATE TABLE IF NOT EXISTS telegram_updates (
          update_id INTEGER PRIMARY KEY,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_telegram_updates_age ON telegram_updates(created_at);
      `);
      for (const sql of [
        `ALTER TABLE nexa_leads ADD COLUMN takeover_until TEXT`,
        `ALTER TABLE nexa_leads ADD COLUMN takeover_by TEXT`,
        `ALTER TABLE nexa_leads ADD COLUMN relances_off INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE nexa_leads ADD COLUMN last_lead_msg_at TEXT`,
        `ALTER TABLE nexa_leads ADD COLUMN last_read_msg_id INTEGER NOT NULL DEFAULT 0`,
      ]) {
        try { db.exec(sql); } catch { /* colonne déjà là */ }
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bot_messages_in
                 ON bot_messages(lead_id, direction, id)`);
      console.log("[MIGRATION] add_live_takeover_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_live_takeover_v1] FAILED:`, err.message);
  }

  // Live takeover — passage du flux plat aux Sujets de forum (Hugo 2026-08-04).
  //
  // Le chat admin est devenu un supergroupe avec Topics. Un topic par lead remplace
  // le fil unique : la conversation d'un lead devient un espace, pas une suite de
  // posts noyés dans le flux.
  //
  //   • admin_thread_id (+ admin_topic_chat_id) : LE routage. Un message d'opérateur
  //     posté dans un topic est résolu par son thread — plus besoin de « Répondre ».
  //     La paire est UNIQUE : un thread_id n'a de sens que dans son chat, indexer
  //     le thread seul casserait au moindre changement de ADMIN_CHAT_ID.
  //   • relay_map devient un FALLBACK (leads d'avant cette migration, et médias
  //     copiés) — conservée telle quelle, purge 30 j inchangée.
  //   • admin_card_message_id : la carte contexte épinglée. Stockée pour être ÉDITÉE
  //     à chaque changement d'étape plutôt que repostée — une carte épinglée obsolète
  //     est pire que pas de carte.
  //   • admin_topic_name : dernier nom appliqué. Sans lui, chaque passage du
  //     synchroniseur d'étape referait un editForumTopic identique, pour rien.
  //   • admin_topic_closed / admin_topic_last_at : hygiène 30 j (fermeture auto,
  //     réouverture à la volée si le lead réécrit).
  //
  //   • last_relayed_msg_id : LE curseur de relais, et la garantie « aucun message
  //     perdu ». Un entrant n'est marqué relayé qu'APRÈS un post réussi ; si la
  //     création du topic bute sur un rate limit, le curseur ne bouge pas et le
  //     drain périodique reprend exactement là où il s'était arrêté. Backfillé
  //     ci-dessous sur le maximum existant : les messages déjà relayés par la v1
  //     ne doivent surtout pas être rejoués dans les nouveaux topics.
  //
  //   • relay_map.from_msg_id : borne basse de la salve couverte par un post admin.
  //     Remplace la fenêtre temporelle par un intervalle d'ids — reconstruire une
  //     salve ne dépend plus de l'horloge. NULL sur les lignes d'avant migration,
  //     qui retombent sur l'ancien comportement.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_live_takeover_topics_v1");
    if (fix.changes > 0) {
      for (const sql of [
        `ALTER TABLE nexa_leads ADD COLUMN admin_topic_chat_id TEXT`,
        `ALTER TABLE nexa_leads ADD COLUMN admin_thread_id INTEGER`,
        `ALTER TABLE nexa_leads ADD COLUMN admin_topic_name TEXT`,
        `ALTER TABLE nexa_leads ADD COLUMN admin_card_message_id INTEGER`,
        `ALTER TABLE nexa_leads ADD COLUMN admin_topic_closed INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE nexa_leads ADD COLUMN admin_topic_last_at TEXT`,
        `ALTER TABLE nexa_leads ADD COLUMN last_relayed_msg_id INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE relay_map ADD COLUMN from_msg_id INTEGER`,
      ]) {
        try { db.exec(sql); } catch { /* colonne déjà là */ }
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_nexa_leads_admin_thread
          ON nexa_leads(admin_topic_chat_id, admin_thread_id)
          WHERE admin_thread_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_nexa_leads_topic_idle
          ON nexa_leads(admin_topic_closed, admin_topic_last_at)
          WHERE admin_thread_id IS NOT NULL;
      `);
      // Tout ce qui existe a déjà été relayé par la v1 : on pose le curseur au
      // maximum plutôt qu'à 0, sinon le premier drain reposterait l'historique
      // complet de chaque lead dans son tout nouveau topic.
      db.prepare(`
        UPDATE nexa_leads
        SET last_relayed_msg_id = COALESCE(
          (SELECT MAX(id) FROM bot_messages WHERE lead_id = nexa_leads.id AND direction = 'in'), 0)
      `).run();
      console.log("[MIGRATION] add_live_takeover_topics_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_live_takeover_topics_v1] FAILED:`, err.message);
  }

  // « Attente de réponse humaine » (Hugo 2026-08-04, après le test en prod).
  //
  // Incident constaté : le lead @jokerhehee écrit « Je ne veux pas », et le bot lui
  // renvoie le message d'accueil du scénario PAR-DESSUS la conversation qu'Hugo
  // était en train d'avoir avec lui.
  //
  // Cause : `takeover_until` n'est armé que par une RÉPONSE d'opérateur. Sur le tout
  // premier texte libre d'un lead, il est donc encore NULL, et handleNexaFunnelDm
  // rejoue l'étape courante. Autrement dit, le bot parlait toujours en premier — le
  // takeover arrivait systématiquement un message trop tard.
  //
  // `awaiting_human_since` comble ce trou : il est posé AVANT toute réponse
  // d'opérateur (clic « J'ai une question », ou texte libre que le scénario ne sait
  // pas consommer) et il suffit à museler tout envoi automatique. Colonne distincte
  // de `takeover_until`, et non une valeur sentinelle de celui-ci, parce que les deux
  // répondent à deux questions différentes :
  //   • takeover_until       → « un humain A RÉPONDU, il a la main pour 6 h »
  //   • awaiting_human_since → « un humain DOIT répondre, le bot se tait en attendant »
  // Le second n'expire pas : il est levé par une réponse d'opérateur ou par /bot.
  // Un lead qui attend est visible dans le filtre « À répondre » du back-office —
  // c'est ce qui empêche l'attente silencieuse de devenir un lead perdu.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_nexa_awaiting_human_v1");
    if (fix.changes > 0) {
      try { db.exec(`ALTER TABLE nexa_leads ADD COLUMN awaiting_human_since TEXT`); } catch { /* colonne déjà là */ }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_nexa_leads_awaiting
                 ON nexa_leads(awaiting_human_since)
                 WHERE awaiting_human_since IS NOT NULL`);
      console.log("[MIGRATION] add_nexa_awaiting_human_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_nexa_awaiting_human_v1] FAILED:`, err.message);
  }

  // Expiration du silence scripté (Hugo 2026-08-04, correctif du correctif).
  //
  // `awaiting_human_since` n'expirait pas : un lead qui écrivait une phrase sortait
  // DÉFINITIVEMENT du funnel automatique, sans que personne en soit averti. Un
  // prospect qui écrit la nuit pouvait ne plus jamais rien recevoir — pire que le
  // bug d'origine, qui lui envoyait au moins un message de trop.
  //
  // Le silence doit protéger une conversation humaine RÉELLE, pas hypothétique.
  // D'où deux colonnes de plus, chacune avec une seule raison d'exister :
  //
  //   • first_operator_reply_at : « un opérateur a réellement répondu, au moins une
  //     fois ». C'est le verrou qui interdit au bot de s'inviter dans une vraie
  //     conversation. Colonne explicite plutôt que de déduire depuis `takeover_by` :
  //     ce garde-fou ne doit pas dépendre d'un champ que quelqu'un pourrait
  //     réutiliser pour autre chose, son mode d'échec étant « le bot coupe la parole
  //     à un humain en direct ».
  //
  //   • question_open_since : « ce lead a posé une question restée sans réponse ».
  //     N'expire PAS, contrairement à `awaiting_human_since`. Sépare deux questions
  //     que la colonne unique confondait :
  //       - awaiting_human_since → le bot doit-il se taire ?        (expire à 90 min)
  //       - question_open_since  → dois-je encore à ce lead une réponse ? (jusqu'à
  //         réponse ou /bot)
  //     Sans elle, la reprise du bot faisait disparaître le lead du filtre
  //     « À répondre » : le scénario redémarre, donc la question serait réglée. Non.
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_nexa_awaiting_expiry_v1");
    if (fix.changes > 0) {
      for (const sql of [
        `ALTER TABLE nexa_leads ADD COLUMN question_open_since TEXT`,
        `ALTER TABLE nexa_leads ADD COLUMN first_operator_reply_at TEXT`,
      ]) {
        try { db.exec(sql); } catch { /* colonne déjà là */ }
      }
      // Les leads actuellement en attente gardent leur question ouverte.
      db.prepare(
        `UPDATE nexa_leads SET question_open_since = awaiting_human_since
         WHERE awaiting_human_since IS NOT NULL AND question_open_since IS NULL`
      ).run();
      // Reconstruit depuis l'historique : la première trace d'un message d'opérateur
      // EST la première réponse humaine. Sans ce backfill, un lead avec qui Hugo
      // discute déjà se ferait couper la parole par la première passe d'expiration.
      db.prepare(`
        UPDATE nexa_leads SET first_operator_reply_at = (
          SELECT MIN(created_at) FROM bot_messages
          WHERE lead_id = nexa_leads.id AND direction = 'out' AND sender LIKE 'operator:%')
        WHERE first_operator_reply_at IS NULL
      `).run();
      db.exec(`CREATE INDEX IF NOT EXISTS idx_nexa_leads_question_open
                 ON nexa_leads(question_open_since)
                 WHERE question_open_since IS NOT NULL`);
      console.log("[MIGRATION] add_nexa_awaiting_expiry_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_nexa_awaiting_expiry_v1] FAILED:`, err.message);
  }

  // Rappels opérateur sur les questions sans réponse (Hugo 2026-08-04, §5).
  //
  // Le sujet d'un lead se créait en silence : dans un groupe en mode Sujets,
  // Telegram ne notifie pas les membres des nouveaux sujets. Personne n'était donc
  // prévenu qu'un lead attendait — le relais fonctionnait, mais dans le vide.
  //
  // `question_nudge_level` est un COMPTEUR DE PALIER, pas un horodatage de dernier
  // rappel : 0 = aucun, 1 = les 15 min sont passées, 2 = les 60 min aussi. Comparer
  // un « last_nudge_at » à un intervalle aurait produit un rappel toutes les N
  // minutes ; ici chaque palier ne peut être franchi qu'une fois, par construction.
  // Remis à 0 en même temps que `question_open_since` (réponse d'opérateur ou /bot).
  try {
    const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_nexa_question_nudge_v1");
    if (fix.changes > 0) {
      try { db.exec(`ALTER TABLE nexa_leads ADD COLUMN question_nudge_level INTEGER NOT NULL DEFAULT 0`); } catch { /* déjà là */ }
      console.log("[MIGRATION] add_nexa_question_nudge_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_nexa_question_nudge_v1] FAILED:`, err.message);
  }

  // ── NEXA : rakeback joueur & parts d'action — SCHÉMA SEUL (Hugo 2026-08-04) ──
  //
  // Étape 1/7 du module. Rien n'est branché dessus : ni saisie, ni calcul, ni écran.
  // Ces tables restent vides jusqu'à l'étape 4. Aucune table existante n'est lue,
  // réécrite ou supprimée ici — les deux seuls ALTER sont additifs.
  //
  // SOURCE DES CHIFFRES. NEXA n'envoie pas de fichier : Hugo recopie à la main les
  // screenshots du report d'affiliation. `nexa_affiliate_weeks` est malgré tout LA
  // source de vérité du rake NEXA, indépendamment de la façon dont elle est remplie.
  // Un import XLSX pourra se brancher plus tard sur le même chemin d'écriture
  // (`commitWeek`, étape 3) sans une ligne de schéma en plus : d'où `source` et
  // `filename`/`file_hash` déjà présents sur `nexa_affiliate_entries`.
  //
  // CE QUI N'EST PAS TOUCHÉ. `nexa_weekly_stats` / `nexa_weekly_reports` (l'ancien
  // import hebdo de la room) restent en place. Constaté en prod avant d'écrire ce
  // bloc, le 2026-08-04 : 0 ligne dans les deux. L'import n'a jamais pu tourner
  // (`NEXA_COLUMN_MAP_READY` est false depuis l'origine). Leur retrait et la bascule
  // des deux requêtes de lib/nexa-funnel.ts sont une décision distincte, pas celle-ci.
  //
  // ⚠️ MARQUEUR ÉCRIT APRÈS SUCCÈS — dérogation ASSUMÉE au motif des 93 autres migrations.
  // Les autres font `INSERT INTO _applied_fixes` PUIS `db.exec(...)`. Si l'exec jette, le
  // marqueur est déjà posé : la migration se déclare appliquée sans avoir rien créé, et
  // ne se rejouera JAMAIS. Ce mode d'échec a été observé pour de vrai en test (2026-08-04,
  // sur base vierge) : ce bloc s'est retrouvé en position 94/94 de _applied_fixes avec zéro
  // table créée. Sur un schéma qui porte de l'argent, c'est inacceptable — d'où l'ordre
  // inversé ici, et ici seulement (décision Hugo).
  // Ce que ça impose en échange : le corps doit être REJOUABLE tel quel, puisqu'un échec
  // partiel sera retenté au boot suivant. Il l'est par construction — CREATE TABLE/INDEX
  // IF NOT EXISTS, INSERT OR IGNORE, ALTER TABLE sous try/catch — et c'est vérifié par un
  // test de rejeu explicite.
  try {
    const alreadyApplied = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`).get("add_nexa_affiliate_v1");
    if (!alreadyApplied) {
      db.exec(`
        -- La room devient un game. C'est ce qui ouvre, sans rien réinventer :
        -- player_game_ids (lien joueur ↔ Member ID, UNIQUE(game_id, external_id)),
        -- manual_settlements et le hub /payments.
        -- default_action_pct = 0 : le % d'action NEXA est historisé par joueur dans
        -- nexa_player_action_shares, il n'est pas porté par le game (même parti pris
        -- que QQPK).
        INSERT OR IGNORE INTO games (name, status, default_action_pct, currency)
          VALUES ('NEXAPOKER', 'active', 0, 'USDT');

        -- ── Historique des saisies ────────────────────────────────────────────
        -- Une ligne par semaine COMMITÉE, pas par fichier : une saisie manuelle en
        -- crée une, un futur XLSX de 3 semaines en créera 3 partageant un batch_id.
        -- La colonne actor vaut 'baki' en dur : l'app n'a pas d'auth (v1). Elle existe
        -- pour le jour où il y aura un login ; ce n'est pas une piste d'audit fiable.
        CREATE TABLE IF NOT EXISTS nexa_affiliate_entries (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          week_start    TEXT NOT NULL,                  -- lundi ISO 'YYYY-MM-DD'
          source        TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','xlsx')),
          actor         TEXT NOT NULL DEFAULT 'baki',
          batch_id      TEXT,                           -- regroupe les semaines d'un même fichier
          filename      TEXT,                           -- NULL en saisie manuelle
          file_hash     TEXT,                           -- idem — réservés au futur XLSX
          rows_total    INTEGER NOT NULL DEFAULT 0,
          rows_ok       INTEGER NOT NULL DEFAULT 0,
          rows_rejected INTEGER NOT NULL DEFAULT 0,
          rejects       TEXT,                           -- JSON du rapport d'erreurs
          note          TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_nexa_aff_entries_week
          ON nexa_affiliate_entries(week_start, created_at);

        -- ── Détail joueur × semaine — SOURCE DE VÉRITÉ du rake NEXA ───────────
        CREATE TABLE IF NOT EXISTS nexa_affiliate_weeks (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          entry_id     INTEGER REFERENCES nexa_affiliate_entries(id),
          week_start   TEXT NOT NULL,                   -- lundi ISO
          member_id    TEXT,                            -- NULL : absent du report, c'est fréquent
          nickname     TEXT NOT NULL,
          nickname_key TEXT NOT NULL,                   -- lower(trim(nickname)) : rattachement de secours

          -- Clé de dédup. Une UNIQUE(week_start, member_id) ne tiendrait PAS : SQLite
          -- tolère N NULL dans un UNIQUE, donc chaque re-saisie d'une ligne sans ID
          -- créerait un doublon. Colonne GÉNÉRÉE, pas calculée en JS : elle ne peut
          -- pas diverger de ses deux sources.
          -- Effet de bord assumé : deux joueurs homonymes SANS ID entrent en collision.
          -- La saisie les rejettera tous les deux explicitement plutôt que de les
          -- fusionner en silence (règle : jamais d'à-peu-près sur l'identité).
          row_key      TEXT GENERATED ALWAYS AS
                         (COALESCE(NULLIF(member_id, ''), 'nick:' || nickname_key)) STORED,

          -- Résolu à l'écriture (member_id → player_game_ids, puis nickname_key →
          -- nexa_nickname_links). NULL = à traiter dans l'écran de réconciliation.
          -- Le lien VALIDÉ ne vit jamais ici : il vit dans player_game_ids /
          -- nexa_nickname_links. C'est ce qui permet à la ré-écriture d'une semaine
          -- (DELETE + INSERT) de ne perdre aucun rattachement.
          player_id    INTEGER REFERENCES players(id) ON DELETE SET NULL,
          affiliate    TEXT,
          deal_text    TEXT NOT NULL,                   -- la chaîne brute, telle que lue

          nlh   REAL NOT NULL DEFAULT 0,
          mtt   REAL NOT NULL DEFAULT 0,
          plo   REAL NOT NULL DEFAULT 0,
          spins REAL NOT NULL DEFAULT 0,

          -- Taux effectivement APPLIQUÉS, en %, issus du parsing de deal_text.
          -- Stockés pour que le recalcul d'une semaine passée reste auditable même si
          -- le deal du joueur change ensuite.
          rate_nlh   REAL NOT NULL,
          rate_mtt   REAL NOT NULL,
          rate_plo   REAL NOT NULL,
          rate_spins REAL NOT NULL,

          affiliate_payment            REAL NOT NULL,   -- valeur lue sur le screenshot
          affiliate_payment_recomputed REAL NOT NULL,   -- Σ montant × taux
          check_delta                  REAL NOT NULL,   -- recomputed − saisi
          -- Générée : le verdict ne peut pas mentir sur son propre écart.
          check_ok INTEGER GENERATED ALWAYS AS
                     (CASE WHEN ABS(check_delta) <= 0.02 THEN 1 ELSE 0 END) STORED,
          -- Motif obligatoire pour écrire une ligne hors tolérance (cas du screenshot
          -- NEXA lui-même incohérent). Une telle ligne s'affiche en alerte partout ET
          -- coupe la chaîne de makeup du joueur (règle validée par Hugo).
          override_reason TEXT,

          created_at TEXT NOT NULL DEFAULT (datetime('now')),

          -- Le filet anti-faute de frappe, au niveau du schéma et pas seulement du code :
          -- hors tolérance sans motif explicite = écriture refusée par la base.
          CHECK (ABS(check_delta) <= 0.02 OR override_reason IS NOT NULL)
        );
        -- UNIQUE posé en index séparé plutôt qu'en contrainte inline : une UNIQUE
        -- inline portant sur une colonne générée est un terrain plus incertain selon
        -- les versions de SQLite, l'index l'est beaucoup moins.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_nexa_aff_weeks_key
          ON nexa_affiliate_weeks(week_start, row_key);
        CREATE INDEX IF NOT EXISTS idx_nexa_aff_weeks_player
          ON nexa_affiliate_weeks(player_id, week_start);
        CREATE INDEX IF NOT EXISTS idx_nexa_aff_weeks_member
          ON nexa_affiliate_weeks(member_id) WHERE member_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_nexa_aff_weeks_nick
          ON nexa_affiliate_weeks(nickname_key);
        -- Alimente l'alerte « semaines dont le recalcul ne retombe pas ».
        CREATE INDEX IF NOT EXISTS idx_nexa_aff_weeks_check
          ON nexa_affiliate_weeks(week_start) WHERE check_ok = 0;
        -- Alimente l'écran de réconciliation.
        CREATE INDEX IF NOT EXISTS idx_nexa_aff_weeks_unlinked
          ON nexa_affiliate_weeks(week_start) WHERE player_id IS NULL;

        -- ── Rattachement par pseudo, mémorisé ────────────────────────────────
        -- Rempli UNIQUEMENT par une validation manuelle dans l'écran de
        -- réconciliation. Aucune correspondance approximative n'écrit ici, jamais.
        -- (Le rattachement par Member ID n'a pas de table : il utilise player_game_ids
        -- avec le game NEXAPOKER, qui existe déjà.)
        CREATE TABLE IF NOT EXISTS nexa_nickname_links (
          nickname_key TEXT PRIMARY KEY,
          player_id    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_nexa_nickname_links_player
          ON nexa_nickname_links(player_id);

        -- ── Rakeback joueur, versionné dans le temps ─────────────────────────
        -- Périodes en semaines (lundis ISO), bornes incluses, end_week NULL = en cours.
        -- Versionné et non écrasé : changer un % ne doit pas réécrire rétroactivement
        -- des semaines déjà réglées.
        --
        -- makeup_carry : que devient le makeup accumulé quand cette période commence ?
        --   'carry' (défaut) → il se reporte depuis la période précédente
        --   'reset'          → il repart de 0
        -- Existe parce qu'un makeup accumulé sur la base « commission affilié » n'a pas
        -- la même unité qu'un makeup sur la base « rake brut » : au changement de
        -- basis, Hugo tranche explicitement (choix validé — pas de purge automatique).
        --
        -- Défauts globaux dans la table settings (voir seed plus bas).
        -- Le non-chevauchement des périodes d'un même joueur est vérifié à l'écriture :
        -- SQLite ne sait pas l'exprimer en contrainte.
        CREATE TABLE IF NOT EXISTS nexa_player_rakeback (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          player_id    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          pct          REAL NOT NULL CHECK(pct >= 0 AND pct <= 100),
          basis        TEXT NOT NULL CHECK(basis IN ('gross_rake','affiliate_commission')),
          makeup_carry TEXT NOT NULL DEFAULT 'carry' CHECK(makeup_carry IN ('carry','reset')),
          start_week   TEXT NOT NULL,
          end_week     TEXT,
          note         TEXT,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (end_week IS NULL OR end_week >= start_week)
        );
        CREATE INDEX IF NOT EXISTS idx_nexa_rb_player
          ON nexa_player_rakeback(player_id, start_week);

        -- ── Parts d'action, historisées ──────────────────────────────────────
        -- Append-only : modifier une part = clore la période courante (end_week) puis
        -- en insérer une nouvelle. Jamais d'UPDATE du pct sur une période passée.
        CREATE TABLE IF NOT EXISTS nexa_player_action_shares (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          pct        REAL NOT NULL CHECK(pct >= 0 AND pct <= 100),
          start_week TEXT NOT NULL,
          end_week   TEXT,
          note       TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (end_week IS NULL OR end_week >= start_week)
        );
        CREATE INDEX IF NOT EXISTS idx_nexa_action_player
          ON nexa_player_action_shares(player_id, start_week);

        -- ── Win/loss par joueur × semaine, saisi à la main ───────────────────
        -- L'assiette des parts d'action. Le report d'affiliation NEXA ne contient
        -- AUCUN win/loss : ses 4 colonnes (NLH/MTT/PLO/Spins) sont du rake. Cette
        -- donnée est donc celle d'Hugo, pas celle de la room — la re-saisie d'une
        -- semaine du report ne doit jamais l'écraser.
        CREATE TABLE IF NOT EXISTS nexa_player_weekly_winloss (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          week_start TEXT NOT NULL,
          amount     REAL NOT NULL,             -- signé : une semaine perdante est négative
          note       TEXT,
          entered_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(player_id, week_start)
        );
      `);

      // Lien lead ↔ joueur, 1-1 optionnel des DEUX côtés : un lead peut ne jamais
      // devenir joueur, et un joueur peut être arrivé hors funnel (bouche-à-oreille,
      // ou avant la mise en place du bot). L'index partiel donne l'unicité côté
      // joueur sans interdire les leads non rattachés.
      try { db.exec(`ALTER TABLE nexa_leads ADD COLUMN player_id INTEGER REFERENCES players(id)`); } catch { /* déjà là */ }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_nexa_leads_player
                 ON nexa_leads(player_id) WHERE player_id IS NOT NULL`);

      // manual_settlements accueille un second flux. Jusqu'ici toutes ses lignes
      // étaient de l'action (net_selected_usdt × action_pct) ; le rakeback NEXA a un
      // montant qui ne vient PAS d'une sélection de transactions.
      // DEFAULT 'action' : les lignes existantes gardent leur sens exact, aucun
      // backfill, aucune relecture de l'historique (invariant #6, additif seulement).
      try { db.exec(`ALTER TABLE manual_settlements ADD COLUMN kind TEXT NOT NULL DEFAULT 'action'`); } catch { /* déjà là */ }

      // Défauts globaux paramétrables. INSERT OR IGNORE : si Hugo les a déjà réglés,
      // une réapplication de la migration ne les réécrase pas.
      // Le texte de deal par défaut est une VALEUR DE DÉPART pré-remplie dans la
      // grille de saisie, jamais un taux appliqué en dur : les taux effectifs sont
      // toujours ceux parsés depuis le deal_text de la ligne.
      const seedSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
      seedSetting.run("nexa_default_deal_text", "40% NLH and MTT, 45% PLO, 55% Spins");
      seedSetting.run("nexa_default_rakeback_pct", "0");
      seedSetting.run("nexa_default_rakeback_basis", "affiliate_commission");

      // Tout est passé — SEULEMENT MAINTENANT on marque la migration comme appliquée.
      // Si une seule ligne au-dessus avait jeté, on n'arrive pas ici, aucun marqueur
      // n'est posé, et le boot suivant rejoue le bloc au lieu de le sauter en silence.
      db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_nexa_affiliate_v1");
      console.log("[MIGRATION] add_nexa_affiliate_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_nexa_affiliate_v1] FAILED (sera rejouée au prochain boot):`, err.message);
  }

  // ── Backfill : start_date du miroir NEXAPOKER ────────────────────────────
  // setActionShareOn recevait la semaine d'effet sans jamais l'écrire dans
  // player_game_deals.start_date. Or toutes les requêtes d'argent de queries.ts
  // bornent le deal par `pgd.start_date IS NULL OR wt.tx_datetime >= pgd.start_date` :
  // à NULL, la garde ne borne RIEN et le % courant s'applique rétroactivement à
  // toutes les semaines passées. On repose la date depuis la vérité historisée.
  //
  // PÉRIMÈTRE VOLONTAIREMENT ÉTROIT : game NEXAPOKER uniquement, start_date NULL
  // uniquement, et seulement si le joueur a une période d'action enregistrée.
  // Aucun deal d'une autre room ne peut être atteint par ce UPDATE.
  try {
    const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`).get("nexa_mirror_start_date_v1");
    if (!already) {
      const r = db.prepare(`
        UPDATE player_game_deals
           SET start_date = (SELECT MIN(s.start_week) FROM nexa_player_action_shares s
                              WHERE s.player_id = player_game_deals.player_id)
         WHERE start_date IS NULL
           AND game_id = (SELECT id FROM games WHERE name = 'NEXAPOKER')
           AND EXISTS (SELECT 1 FROM nexa_player_action_shares s2
                        WHERE s2.player_id = player_game_deals.player_id)
      `).run();
      db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("nexa_mirror_start_date_v1");
      console.log(`[MIGRATION] nexa_mirror_start_date_v1 applied — ${r.changes} deal(s) NEXAPOKER datés`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:nexa_mirror_start_date_v1] FAILED (sera rejouée au prochain boot):`, err.message);
  }

  // ── Règlement de la part d'action NEXAPOKER ───────────────────────────────
  //
  // Le flux de règlement standard des rooms adosse son montant à une SÉLECTION DE
  // TRANSACTIONS : `dû = net des transactions × action_pct`, et l'anti-double-comptage
  // est le drapeau `wallet_transactions.settled`. La part d'action NEXA ne marche pas
  // comme ça : son assiette est le win/loss saisi à la main, semaine par semaine, et
  // aucune transaction ne lui correspond. Il lui faut donc son propre ancrage.
  //
  // Cette table EST l'anti-double-comptage, et elle est aussi le FIGEMENT : le moteur
  // rejoue la chaîne à chaque lecture (aucun solde n'est stocké), mais un montant réglé,
  // lui, ne doit plus bouger même si la semaine est corrigée après coup. On recopie donc
  // ici le win/loss, le % et le montant tels qu'ils étaient AU RÈGLEMENT.
  //
  // UNIQUE(player_id, week_start) : régler deux fois la même semaine devient impossible
  // au niveau du schéma, pas seulement au niveau du code. C'est l'équivalent du
  // `settled = 1` des transactions, pour un flux qui n'en a pas.
  // ON DELETE CASCADE : déverrouiller un règlement (unlockSettlement supprime la ligne
  // manual_settlements) libère les semaines, qui redeviennent réglables.
  try {
    const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`).get("add_nexa_action_settlement_v1");
    if (!already) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS nexa_action_settlement_weeks (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          settlement_id INTEGER NOT NULL REFERENCES manual_settlements(id) ON DELETE CASCADE,
          player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          week_start    TEXT NOT NULL,
          winloss       REAL NOT NULL,
          action_pct    REAL NOT NULL,
          action_amount REAL NOT NULL,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(player_id, week_start)
        );
        CREATE INDEX IF NOT EXISTS idx_nexa_action_settle_settlement
          ON nexa_action_settlement_weeks(settlement_id);
      `);
      db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_nexa_action_settlement_v1");
      console.log("[MIGRATION] add_nexa_action_settlement_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_nexa_action_settlement_v1] FAILED (sera rejouée au prochain boot):`, err.message);
  }

  // ── Règlement du RAKEBACK NEXAPOKER ────────────────────────────────────────
  //
  // Deuxième flux de règlement de la room, à côté de la part d'action. Les deux
  // vivent dans manual_settlements et se distinguent par `kind` ('action' par
  // défaut, 'rakeback' ici) — la colonne existe déjà, aucun backfill n'est fait :
  // toutes les lignes antérieures sont bien des règlements d'action.
  //
  // SNAPSHOT COMPLET DES PARAMÈTRES APPLIQUÉS. Contrairement à l'action, dont le
  // calcul tient dans un % et un win/loss, le rakeback dépend d'une ASSIETTE
  // (base), d'un TAUX, et surtout d'un MAKEUP ENTRANT qui vient des semaines
  // précédentes. Rejouer un règlement passé sans ces trois valeurs est impossible :
  // le report a pu être corrigé depuis, et le rejeu donnerait un autre chiffre.
  // On fige donc, par semaine réglée : base, taux, makeup consommé, assiette nette,
  // dû, makeup sortant. C'est la seule façon de répondre plus tard à « pourquoi
  // ai-je payé ce montant-là ce jour-là ».
  //
  // UNIQUE(player_id, week_start) : une semaine ne peut pas être réglée deux fois,
  // garanti par le schéma et pas seulement par le code. Supprimer le règlement
  // (ON DELETE CASCADE depuis manual_settlements) libère les semaines.
  try {
    const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`)
      .get("add_nexa_rakeback_settlement_v1");
    if (!already) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS nexa_rakeback_settlement_weeks (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          settlement_id INTEGER NOT NULL REFERENCES manual_settlements(id) ON DELETE CASCADE,
          player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          week_start    TEXT NOT NULL,
          -- Paramètres EFFECTIVEMENT appliqués, figés au verrouillage.
          basis         TEXT NOT NULL CHECK(basis IN ('gross_rake','affiliate_commission')),
          rakeback_pct  REAL NOT NULL,
          base          REAL NOT NULL,   -- assiette brute de la semaine, selon la base
          makeup_in     REAL NOT NULL,   -- makeup consommé en entrée (<= 0)
          base_net      REAL NOT NULL,   -- base + makeup_in
          due           REAL NOT NULL,   -- ce qui a été payé pour cette semaine
          makeup_out    REAL NOT NULL,   -- reliquat sortant (<= 0)
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(player_id, week_start)
        );
        CREATE INDEX IF NOT EXISTS idx_nexa_rb_settle_settlement
          ON nexa_rakeback_settlement_weeks(settlement_id);
        CREATE INDEX IF NOT EXISTS idx_nexa_rb_settle_player
          ON nexa_rakeback_settlement_weeks(player_id, week_start);
      `);
      // SEULEMENT MAINTENANT on marque la migration comme appliquée. Poser le
      // marqueur AVANT le db.exec — ce que faisait la première version — le rend
      // persistant même si la création échoue (SQLITE_BUSY au boot, disque plein) :
      // la migration serait alors sautée DÉFINITIVEMENT, le catch mentirait en
      // annonçant « sera rejouée », et HUB_SELECT référencerait une table absente
      // → /payments en 500 pour TOUTES les rooms. (Constat money-auditor.)
      db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_nexa_rakeback_settlement_v1");
      console.log("[MIGRATION] add_nexa_rakeback_settlement_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_nexa_rakeback_settlement_v1] FAILED (sera rejouée au prochain boot):`, err.message);
  }

  // ── Règlement hebdomadaire sur BANKROLL (NEXAPOKER) ───────────────────────
  //
  // Le règlement des joueurs stakés ne part pas d'un win/loss connu : il part de
  // la photo de bankroll envoyée en fin de semaine, et le win/loss en est DÉDUIT.
  //   résultat = (BR fin + cash-outs) − (BR début + dépôts)
  //
  // CETTE TABLE NE PORTE PAS UN SECOND RÉSULTAT. Le résultat calculé est écrit
  // dans `nexa_player_weekly_winloss`, qui reste la SEULE table de résultat du
  // repo, et dont l'UNIQUE(player_id, week_start) rend structurellement
  // impossible qu'une semaine porte deux chiffres différents. Ici on garde la
  // PROVENANCE : les entrées figées du calcul, pour pouvoir le rejouer et le
  // justifier. (Arbitrage Hugo, 2026-08-17.)
  //
  // C'est aussi cette table qui dit « cette semaine est pilotée par la BR » :
  // setWeeklyWinlossOn refuse alors d'écraser la cellule depuis la grille, et
  // addMovementOn refuse un mouvement daté dans une semaine verrouillée. Pas de
  // colonne `source` dupliquée dans la table de win/loss — une seule source pour
  // une seule question, sinon les deux dérivent.
  //
  // settlement_id NULLABLE, et c'est délibéré : une semaine à part d'action nulle
  // (« BR inchangée ») ne produit AUCUNE ligne de règlement — un règlement à zéro
  // est du bruit dans le hub /payments, c'est déjà la doctrine du flux d'action.
  // La semaine reste figée par cette table-ci, qui suffit.
  //
  // transfer_movement_id : LE MOUVEMENT QUI SOLDE LA SEMAINE, dans un sens ou dans
  // l'autre — 'withdrawal' quand je verse ma part (semaine perdante), 'deposit'
  // quand le joueur me règle la sienne (semaine gagnante). Écrit au « marquer
  // payé », jamais au verrouillage : tant que le règlement est 'locked', l'argent
  // n'a pas bougé et l'inscrire fausserait tous les agrégats.
  //
  // Cette colonne sert à DISTINGUER leur effet sur la bankroll, qui n'est pas
  // celui de leur sens au grand livre (cf. getWeekMovementsOn) :
  //   • le versement est un 'withdrawal' qui ENTRE dans sa bankroll — il compte
  //     comme un dépôt dans la semaine de sa date de paiement ;
  //   • l'encaissement est un 'deposit' qui ne TOUCHE PAS sa bankroll — il me
  //     paie de sa poche, donc hors calcul.
  try {
    const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`)
      .get("add_nexa_bankroll_weeks_v1");
    if (!already) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS nexa_player_bankroll_weeks (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          player_id            INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          week_start           TEXT NOT NULL,
          -- Entrées du calcul, FIGÉES à la clôture. Le rejeu du moteur ne doit
          -- jamais pouvoir réécrire une semaine close (invariant #9).
          br_open              REAL NOT NULL,
          -- 'carry' = repris de la semaine précédente · 'manual' = première semaine
          -- du joueur, saisie à la main. Jamais un 0 par défaut : une BR de départ
          -- inconnue se demande, elle ne se suppose pas.
          br_open_source       TEXT NOT NULL CHECK(br_open_source IN ('carry','manual')),
          br_close             REAL NOT NULL,
          deposits             REAL NOT NULL,
          cashouts             REAL NOT NULL,
          -- Sorties du calcul, arrondies au centime (demi-supérieur en valeur
          -- absolue). result EST le win/loss écrit dans nexa_player_weekly_winloss.
          result               REAL NOT NULL,
          action_pct           REAL NOT NULL CHECK(action_pct > 0 AND action_pct <= 100),
          action_amount        REAL NOT NULL,
          transfer_movement_id INTEGER REFERENCES wallet_transactions(id),
          -- ⚠️ CE "ON DELETE CASCADE" EST UNE ERREUR, CORRIGÉE PAR
          -- add_nexa_bankroll_weeks_fk_v2 juste en dessous. Il est laissé tel quel
          -- ici parce que c'est ce que cette migration a RÉELLEMENT créé sur les
          -- bases où elle a déjà tourné : le texte d'une migration doit décrire ce
          -- qu'elle a fait, sinon plus rien ne dit dans quel état est une base
          -- donnée (invariant #6 — le critère est « a déjà tourné », pas « a déjà
          -- été committé »). Voir la v2 pour le pourquoi de la correction.
          settlement_id        INTEGER REFERENCES manual_settlements(id) ON DELETE CASCADE,
          note                 TEXT,
          locked_at            TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(player_id, week_start)
        );
        CREATE INDEX IF NOT EXISTS idx_nexa_br_player
          ON nexa_player_bankroll_weeks(player_id, week_start);
        -- Sert l'exclusion des versements de règlement du calcul de la semaine :
        -- la requête part de l'id du mouvement, pas du joueur.
        CREATE INDEX IF NOT EXISTS idx_nexa_br_transfer
          ON nexa_player_bankroll_weeks(transfer_movement_id)
          WHERE transfer_movement_id IS NOT NULL;
      `);
      // Marqueur posé SEULEMENT après le db.exec — même raison que ci-dessus :
      // le poser avant le rendrait persistant malgré un échec de création, et la
      // migration serait sautée définitivement en annonçant l'inverse.
      db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_nexa_bankroll_weeks_v1");
      console.log("[MIGRATION] add_nexa_bankroll_weeks_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_nexa_bankroll_weeks_v1] FAILED (sera rejouée au prochain boot):`, err.message);
  }

  // ── Correction de la FK settlement_id des semaines de bankroll ────────────
  //
  // POURQUOI. La v1 a posé `settlement_id … ON DELETE CASCADE`, par mimétisme avec
  // nexa_action_settlement_weeks — où la cascade est JUSTE : déverrouiller un
  // règlement doit libérer les semaines qu'il portait. Ici c'est l'inverse. La
  // ligne de bankroll est la PROVENANCE FIGÉE du calcul, et les deux écritures
  // qu'elle justifie — le win/loss et le versement — vivent dans d'autres tables.
  //
  // Le chemin dangereux n'est pas le nôtre : c'est le bouton « délock » de
  // /payments, qui fait DELETE FROM manual_settlements sans rien savoir de la
  // bankroll (PaymentsClient l'affiche pour toutes les rooms, NEXAPOKER comprise,
  // cf. SETTLE_ROOMS). Avec la cascade, ce clic effaçait la semaine figée ET son
  // ancrage en laissant DERRIÈRE lui le win/loss et le versement : semaine
  // dé-figée, résultat orphelin, et versement qui redevenait un cash-out ordinaire
  // — donc résultat de la semaine suivante faux du montant du versement, et
  // re-clôturer la semaine créait un SECOND versement pour la même dette.
  //
  // En NO ACTION, ce DELETE échoue au niveau du SCHÉMA : la garde ne dépend plus
  // de la vigilance de l'appelant. unlockSettlement porte en plus un refus nommé,
  // pour que l'écran dise où aller au lieu d'afficher une erreur de contrainte.
  // Le déverrouillage légitime (unlockBankrollWeekOn) retire la ligne de bankroll
  // AVANT le règlement — c'est le seul ordre qui passe, et c'est voulu.
  //
  // POURQUOI UNE MIGRATION SÉPARÉE plutôt qu'une correction du DDL de la v1 :
  // parce que la v1 a DÉJÀ TOURNÉ. Éditer son texte ne rejoue rien — son garde
  // `_applied_fixes` la saute — et laisserait les bases existantes en CASCADE tout
  // en prétendant l'inverse dans le code. C'est exactement ce que l'invariant #6
  // interdit, et le critère est « a déjà tourné », pas « a déjà été committé ».
  // (Constat money-auditor 2026-08-17 : l'édition du DDL de la v1 ne protégeait
  // aucune base réelle.)
  //
  // Rebuild complet plutôt qu'un ALTER : SQLite ne sait pas modifier une clé
  // étrangère en place. Procédure OFFICIELLE SQLite, dans cet ordre exact :
  //   PRAGMA foreign_keys=OFF → BEGIN → échange → foreign_key_check → COMMIT
  //   → PRAGMA foreign_keys=ON
  // Le PRAGMA doit être HORS transaction (il est sans effet dedans) ; le DDL, lui,
  // DOIT être dedans. Une première version les mettait tous les deux dehors, en
  // confondant les deux contraintes : le db.exec multi-instructions n'était alors
  // pas atomique, et trois états dégradés en découlaient, tous démontrés par
  // l'audit (2026-08-17) :
  //   • un reliquat `_new` d'un rebuild interrompu faisait échouer la migration à
  //     CHAQUE boot, pour toujours, en console.error seulement — donc FK restée en
  //     cascade, en silence ;
  //   • un crash entre le DROP et le RENAME PERDAIT la table, et les gardes
  //     `no such table` de players.ts échouaient alors OUVERTES (elles supposent
  //     « pas de table = pas de semaine BR », ce qui devient faux) ;
  //   • si le db.exec de la v1 jetait, la v2 ne trouvait pas de table et posait
  //     QUAND MÊME son marqueur : au boot suivant la v1 recréait la table en
  //     cascade et la v2 était sautée à jamais.
  // Le DROP IF EXISTS en tête, la transaction, et le marqueur conditionnel
  // ci-dessous ferment les trois.
  try {
    const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`)
      .get("add_nexa_bankroll_weeks_fk_v2");
    if (!already) {
      const t = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='nexa_player_bankroll_weeks'`
      ).get() as { sql: string } | undefined;
      // TABLE ABSENTE = la v1 n'a pas (encore) tourné. On ne pose PAS le marqueur :
      // sinon, si la v1 échoue ce boot-ci et réussit le suivant, elle recrée la
      // table en cascade et cette migration-ci ne repassera jamais. On repassera au
      // prochain boot, quand la table existera.
      const cascade = !!t && /ON DELETE CASCADE/i.test(t.sql.split("settlement_id")[1]?.split(",")[0] ?? "");

      // ON NE RECONSTRUIT PAS DANS LA TRANSACTION DE QUELQU'UN D'AUTRE.
      //
      // `add_a5poker_game_v1` (ligne ~1066) fait BEGIN … COMMIT et, sur une base
      // où il échoue en cours, son `finally` ne restaure que le PRAGMA : il ne
      // ROLLBACK pas. La transaction reste alors OUVERTE pour tout le reste
      // d'initSchema. Deux conséquences ici, et les deux sont graves :
      //   • `PRAGMA foreign_keys = OFF` est un NO-OP dans une transaction (doc
      //     SQLite) : le DROP/RENAME se ferait sous contrainte, et pourrait
      //     échouer ou casser des références ;
      //   • notre ROLLBACK de secours annulerait TOUT ce qui a été fait depuis ce
      //     BEGIN étranger — soit des milliers de lignes de schéma. Constaté pour
      //     de vrai : la suite group-provisioning perdait `group_creations`, créée
      //     1 100 lignes plus haut.
      // On reporte donc au prochain boot, sans poser le marqueur. Sur une base
      // saine (a5poker déjà appliqué), ce cas ne se présente pas.
      let reporte = false;
      if (db.inTransaction) {
        reporte = true;
        console.error(
          "[MIGRATION:add_nexa_bankroll_weeks_fk_v2] transaction déjà ouverte par une migration " +
          "antérieure — rebuild reporté au prochain boot (aucun marqueur posé).",
        );
      } else if (t && cascade) {
        db.pragma("foreign_keys = OFF");
        try {
          db.exec(`
            BEGIN;
            -- Reliquat d'un rebuild interrompu : sinon le CREATE ci-dessous jette
            -- « table already exists » à chaque boot, définitivement.
            DROP TABLE IF EXISTS nexa_player_bankroll_weeks_new;
            CREATE TABLE nexa_player_bankroll_weeks_new (
              id                   INTEGER PRIMARY KEY AUTOINCREMENT,
              player_id            INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
              week_start           TEXT NOT NULL,
              br_open              REAL NOT NULL,
              br_open_source       TEXT NOT NULL CHECK(br_open_source IN ('carry','manual')),
              br_close             REAL NOT NULL,
              deposits             REAL NOT NULL,
              cashouts             REAL NOT NULL,
              result               REAL NOT NULL,
              action_pct           REAL NOT NULL CHECK(action_pct > 0 AND action_pct <= 100),
              action_amount        REAL NOT NULL,
              transfer_movement_id INTEGER REFERENCES wallet_transactions(id),
              -- LA correction : plus de cascade. Voir l'encadré ci-dessus.
              settlement_id        INTEGER REFERENCES manual_settlements(id),
              note                 TEXT,
              locked_at            TEXT NOT NULL DEFAULT (datetime('now')),
              UNIQUE(player_id, week_start)
            );
            INSERT INTO nexa_player_bankroll_weeks_new
              SELECT id, player_id, week_start, br_open, br_open_source, br_close,
                     deposits, cashouts, result, action_pct, action_amount,
                     transfer_movement_id, settlement_id, note, locked_at
                FROM nexa_player_bankroll_weeks;
            DROP TABLE nexa_player_bankroll_weeks;
            ALTER TABLE nexa_player_bankroll_weeks_new RENAME TO nexa_player_bankroll_weeks;
            -- DROP TABLE a emporté les index : on les repose à l'identique.
            CREATE INDEX IF NOT EXISTS idx_nexa_br_player
              ON nexa_player_bankroll_weeks(player_id, week_start);
            CREATE INDEX IF NOT EXISTS idx_nexa_br_transfer
              ON nexa_player_bankroll_weeks(transfer_movement_id)
              WHERE transfer_movement_id IS NOT NULL;
          `);
          // Contrôle AVANT le COMMIT — c'est ce qui rend « migration annulée » vrai.
          // Un rebuild sous foreign_keys=OFF peut laisser des références pendantes
          // sans rien dire ; le ROLLBACK du catch les emporte.
          const violations = db.pragma("foreign_key_check(nexa_player_bankroll_weeks)") as unknown[];
          if (violations.length > 0) {
            throw new Error(`${violations.length} référence(s) pendante(s) après rebuild — migration annulée.`);
          }
          db.exec(`COMMIT;`);
          console.log("[MIGRATION] add_nexa_bankroll_weeks_fk_v2 — table reconstruite (FK sans cascade)");
        } catch (e) {
          // Le ROLLBACK est ce qui interdit l'état « table perdue » : soit l'échange
          // complet a eu lieu, soit rien. Il n'annule QUE notre transaction — on ne
          // rentre dans ce bloc que si db.inTransaction était faux au départ, donc
          // le BEGIN ci-dessus est le nôtre. Le test le redit ici : si le BEGIN
          // lui-même a échoué, il n'y a rien à annuler et un ROLLBACK aveugle
          // emporterait la transaction d'un autre. Son propre échec ne doit pas
          // masquer l'erreur d'origine, qui est la seule informative.
          if (db.inTransaction) { try { db.exec(`ROLLBACK;`); } catch { /* déjà annulée */ } }
          throw e;
        } finally {
          // finally : la garde doit être remise même si le rebuild jette, sinon
          // tout le reste du boot tournerait sans intégrité référentielle.
          db.pragma("foreign_keys = ON");
        }
      }
      // Marqueur posé UNIQUEMENT si la table existe ET qu'on n'a rien reporté —
      // reconstruite à l'instant, ou déjà dans la bonne forme. Table absente = la
      // v1 n'a pas encore tourné ; rebuild reporté = transaction étrangère ouverte.
      // Dans les deux cas on repasse au prochain boot plutôt que de se déclarer
      // fait sur du vide, ce qui laisserait la cascade en place pour toujours.
      if (t && !reporte) {
        db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_nexa_bankroll_weeks_fk_v2");
        console.log("[MIGRATION] add_nexa_bankroll_weeks_fk_v2 applied");
      } else if (!reporte) {
        console.log("[MIGRATION] add_nexa_bankroll_weeks_fk_v2 — table absente, reporté au prochain boot");
      }
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_nexa_bankroll_weeks_fk_v2] FAILED (sera rejouée au prochain boot):`, err.message);
  }

  // RichAds — tracking des clics d'acquisition payante (GO Baki 2026-08-08).
  //
  // Table AUTONOME, sans lien avec players, nexa_leads ni le money engine. Le
  // trafic acheté atterrit sur un lien d'invitation de groupe Telegram : aucun
  // /start, donc aucun lead créé, donc rien à quoi rattacher une source côté
  // funnel. `nexa_leads.source` n'est PAS un référentiel — c'est une colonne
  // texte libre alimentée au /start du bot. Y écrire des clics fabriquerait des
  // leads qui n'ont jamais parlé au bot et fausserait les compteurs du funnel.
  // (Option A tranchée par Baki ; option C — router vers le bot — écartée : le
  // scénario NEXA est FR/EN, le trafic dzpk est sinophone, mélanger les deux
  // polluerait nexa_leads.)
  //
  //   • source : 'richads/<cre>' — même convention de nommage que le funnel, de
  //     sorte qu'un vrai référentiel puisse un jour absorber ces lignes sans
  //     réécriture.
  //   • flags : CSV trié ('' = clic propre). is_unique en dur pour que les stats
  //     n'aient pas à parser la chaîne à chaque agrégat.
  //   • AUCUNE contrainte UNIQUE sur click_id : un doublon doit être LOGGÉ et
  //     marqué, pas rejeté — RichAds le facture, il doit rester visible.
  //   • ip_hash : HMAC salé, jamais l'IP en clair.
  try {
    const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`)
      .get("add_richads_clicks_v1");
    if (!already) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS richads_clicks (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          clicked_at  TEXT NOT NULL DEFAULT (datetime('now')),
          source      TEXT NOT NULL,              -- 'richads/<cre>'
          cre         TEXT NOT NULL,              -- [CREATIVE_ID] brut, 'unknown' si vide/malformé
          cid         TEXT,                       -- [CAMPAIGN_ID]
          sid         TEXT,                       -- [TG_PUB_ID]
          app         TEXT,                       -- [TG_APP_ID] : mini app d'affichage
          geo         TEXT,                       -- [COUNTRY] : NOM de pays, pas un code ISO
          cost        REAL,                       -- [BID_PRICE]
          user_type   TEXT,                       -- [TG_USER_TYPE], brut
          click_id    TEXT,                       -- [CLICK_ID]
          ip_hash     TEXT,
          user_agent  TEXT,
          flags       TEXT NOT NULL DEFAULT '',
          is_unique   INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_richads_clicks_at    ON richads_clicks(clicked_at);
        CREATE INDEX IF NOT EXISTS idx_richads_clicks_cre   ON richads_clicks(cre);
        CREATE INDEX IF NOT EXISTS idx_richads_clicks_click ON richads_clicks(click_id);
        CREATE INDEX IF NOT EXISTS idx_richads_clicks_ip    ON richads_clicks(ip_hash, clicked_at);
      `);
      db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_richads_clicks_v1");
      console.log("[MIGRATION] add_richads_clicks_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:add_richads_clicks_v1] FAILED (sera rejouée au prochain boot):`, err.message);
  }

  // Traçabilité de l'extraction d'IP (constat de prod 2026-08-08).
  //
  // Lire x-forwarded-for à hops[len-1] rendait une IP d'INFRASTRUCTURE Railway :
  // 44 requêtes émises depuis un seul poste avec 10 IP simulées produisaient
  // 5 ip_hash distincts. Le seuil de rafale se déclenchait donc par nœud edge,
  // ce qui aurait flagué la quasi-totalité du trafic réel en `suspect_ip` et vidé
  // la colonne « clics uniques » de son sens.
  //
  // On enregistre désormais QUEL en-tête a fourni l'IP (`ip_source`) et la
  // longueur de la chaîne de proxys (`ip_hops`), pour que la correction se
  // vérifie sur données réelles au lieu d'être affirmée.
  try {
    const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`)
      .get("richads_ip_source_v1");
    if (!already) {
      const cols = db.prepare(`PRAGMA table_info(richads_clicks)`).all() as { name: string }[];
      const names = new Set(cols.map(c => c.name));
      if (!names.has("ip_source")) db.exec(`ALTER TABLE richads_clicks ADD COLUMN ip_source TEXT`);
      if (!names.has("ip_hops")) db.exec(`ALTER TABLE richads_clicks ADD COLUMN ip_hops INTEGER`);
      db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("richads_ip_source_v1");
      console.log("[MIGRATION] richads_ip_source_v1 applied");
    }
  } catch (err: any) {
    console.error(`[MIGRATION:richads_ip_source_v1] FAILED (sera rejouée au prochain boot):`, err.message);
  }

  // ── Funnel d'acquisition dzpk (phase 1) ────────────────────────────────────
  //
  // Bot Telegram DÉDIÉ, séparé du bot principal et du funnel NEXA : token
  // distinct, webhook distinct, tables distinctes. Aucune de ces tables n'est
  // lue ni écrite par le code NEXA, et réciproquement.
  //
  // Choix de conception qui méritent d'être écrits, parce qu'ils ne se
  // déduisent pas du schéma :
  //
  //   • `source` est FIRST-TOUCH et ne change jamais (arbitrage Baki). Un
  //     re-/start avec une autre source loggue un événement mais ne réécrit
  //     pas la colonne : l'attribution appartient à la pub qui a payé le
  //     premier contact.
  //
  //   • Pas de colonne `state`. Les états ne sont pas ordonnés — un lead peut
  //     répondre sans avoir rejoint le club, et rejoindre sans jamais écrire.
  //     Une colonne unique forcerait un ordre faux et casserait tout taux de
  //     conversion calculé dessus. On stocke des HORODATAGES DE FAITS, et
  //     l'état affiché se dérive à la lecture.
  //
  //   • `dzpk_lead_events` est un journal append-only. Il porte notamment
  //     l'identité OBSERVÉE à chaque contact (pseudo, prénom, nom) : un lead
  //     qui renomme son compte Telegram entre son /start et sa première partie
  //     est le cas d'échec le plus fréquent de l'appariement par nom en phase 2.
  //     Sans cet historique, son ancien nom serait définitivement perdu.
  //
  //   • `dzpk_updates` duplique volontairement `telegram_updates` : deux bots
  //     ont des séquences d'`update_id` INDÉPENDANTES. Partager la table ferait
  //     passer un update dzpk pour un doublon parce que le bot principal a déjà
  //     vu ce numéro — un /start perdu, sans aucune trace.
  try {
    const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`)
      .get(DZPK_MIGRATION_V1);
    if (!already) {
      db.exec(DZPK_SCHEMA_SQL);
      db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run(DZPK_MIGRATION_V1);
      console.log(`[MIGRATION] ${DZPK_MIGRATION_V1} applied`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:${DZPK_MIGRATION_V1}] FAILED (sera rejouée au prochain boot):`, err.message);
  }

  // ── Ingestion des notifications du club dzpk (phase 2) ─────────────────────
  //
  // Le revenu de l'agent se scelle au PREMIER JEU d'un joueur, événement que le
  // club annonce par un DM au compte de Baki. Un bot ne peut pas lire les DM
  // d'un autre bot : la lecture passe par le userbot GramJS, en PULL sur un
  // seul peer (@dp_bot), avec curseur. Cf. docs/DZPK_BOT.md.
  //
  // Aucune de ces tables n'écrit sur `dzpk_leads` à ce stade : l'appariement
  // nom-de-club ↔ lead est manuel et arrive plus tard. Rien ne peut donc être
  // mal attribué par cette migration.
  try {
    const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`)
      .get(DZPK_MIGRATION_INGEST_V1);
    if (!already) {
      db.exec(DZPK_INGEST_SCHEMA_SQL);
      db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run(DZPK_MIGRATION_INGEST_V1);
      console.log(`[MIGRATION] ${DZPK_MIGRATION_INGEST_V1} applied`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:${DZPK_MIGRATION_INGEST_V1}] FAILED (sera rejouée au prochain boot):`, err.message);
  }

  // ── Matching nom-de-club ↔ lead dzpk (phase 2) ─────────────────────────────
  //
  // Le club reprend AUTOMATIQUEMENT le nom du compte Telegram du joueur : le nom
  // qui apparaît dans « 已绑定为代理 » est donc le display_name capturé au /start.
  // D'où une colonne dédiée + son index, et un tableau de liens appris pour les
  // cas que l'exact ne couvre pas (joueur renommé, homonymes).
  //
  // Les ALTER sont joués séparément et tolèrent la colonne déjà présente :
  // SQLite n'a pas d'`ADD COLUMN IF NOT EXISTS`, et une migration doit pouvoir
  // être rejouée après un échec partiel sans rester bloquée.
  try {
    const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`)
      .get(DZPK_MIGRATION_MATCH_V1);
    if (!already) {
      const cols = new Set((db.prepare(`PRAGMA table_info(dzpk_leads)`).all() as { name: string }[]).map(c => c.name));
      if (!cols.has("display_name")) db.exec(DZPK_MATCH_SCHEMA_SQL);
      if (!cols.has("display_name_key")) db.exec(DZPK_MATCH_SCHEMA_SQL_2);
      db.exec(DZPK_MATCH_SCHEMA_SQL_3);

      // Backfill des leads déjà capturés, qui n'ont que first_name/last_name.
      //
      // ⚠️ La CLÉ doit être backfillée elle aussi, et en TypeScript.
      //
      // `display_name_key` est la seule colonne que le matcher interroge. Remplir
      // `display_name` sans la clé laissait ces leads invisibles à l'appariement —
      // et, bien pire, produisait de FAUX POSITIFS : un homonyme plus récent
      // devenait « nom unique » alors que deux leads portaient le même nom, et le
      // crédit partait sur la mauvaise source sans la moindre trace d'ambiguïté.
      // (audit money du 2026-08-12, MA1)
      //
      // Un `LOWER(TRIM(...))` en SQL ne convient pas : il ne retire ni emoji ni
      // pleine chasse, donc il fabriquerait des clés incompatibles avec celles
      // que `recordStart` écrit via nameKey().
      db.exec(`
        UPDATE dzpk_leads
           SET display_name = TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))
         WHERE display_name IS NULL
      `);
      const aBackfiller = db.prepare(
        `SELECT id, display_name FROM dzpk_leads WHERE display_name_key IS NULL`
      ).all() as Array<{ id: number; display_name: string | null }>;
      const setKey = db.prepare(`UPDATE dzpk_leads SET display_name_key = ? WHERE id = ?`);
      for (const l of aBackfiller) setKey.run(dzpkNameKey(l.display_name ?? ""), l.id);
      if (aBackfiller.length) console.log(`[MIGRATION] ${DZPK_MIGRATION_MATCH_V1} — ${aBackfiller.length} clé(s) backfillée(s)`);

      db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run(DZPK_MIGRATION_MATCH_V1);
      console.log(`[MIGRATION] ${DZPK_MIGRATION_MATCH_V1} applied`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:${DZPK_MIGRATION_MATCH_V1}] FAILED (sera rejouée au prochain boot):`, err.message);
  }

  // ── Diffusions vers les leads dzpk (phase 3a) ──────────────────────────────
  //
  // `dzpk_broadcast_targets` est à la fois la file d'envoi et le mécanisme de
  // reprise : un statut par destinataire, commité au fil de l'eau. La diffusion
  // historique (`lib/telegram-commands/broadcast.ts`) n'a rien de tel — elle
  // boucle en mémoire, et un redéploiement en cours d'envoi perd sans trace qui
  // a reçu quoi. Sur quelques joueurs ça ne se voit pas ; sur une liste de
  // leads achetés à la pub, c'est un budget qu'on ne sait plus rapprocher.
  //
  // Aucune de ces tables ne touche aux leads eux-mêmes, à une exception près et
  // documentée : un 403 marque `dzpk_leads.blocked` (via markBlocked), parce
  // qu'un compte qui a bloqué le bot doit sortir de TOUS les envois futurs, pas
  // seulement de celui-ci.
  try {
    const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`)
      .get(DZPK_MIGRATION_BROADCAST_V1);
    if (!already) {
      db.exec(DZPK_BROADCAST_SCHEMA_SQL);
      db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run(DZPK_MIGRATION_BROADCAST_V1);
      console.log(`[MIGRATION] ${DZPK_MIGRATION_BROADCAST_V1} applied`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:${DZPK_MIGRATION_BROADCAST_V1}] FAILED (sera rejouée au prochain boot):`, err.message);
  }

  // ── Fil de conversation lead ↔ opérateur dzpk (phase 3b) ───────────────────
  //
  // Le webhook capte les messages libres depuis la phase 1, mais il les range
  // dans `dzpk_lead_events`, un journal qui ne connaît pas la notion de
  // direction et n'enregistre aucun sortant. On ne peut pas en tirer un fil.
  //
  // `dzpk_bot_messages` le peut, et porte dès maintenant ce qu'un relais
  // Telegram exigera plus tard : id de message Telegram, unicité des entrants,
  // horodatage à la milliseconde. Le curseur `last_relayed_msg_id` est posé
  // maintenant pour la raison expliquée dans schema.ts — l'ajouter le jour du
  // relais impose de rejouer le piège du backfill que NEXA a rencontré.
  //
  // Ne touche à AUCUNE table de matching, ni au broadcast, ni à NEXA.
  try {
    const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`)
      .get(DZPK_MIGRATION_TAKEOVER_V1);
    if (!already) {
      db.exec(DZPK_TAKEOVER_SCHEMA_SQL);
      // ALTER TABLE n'a pas d'IF NOT EXISTS : on interroge le schéma, comme la
      // migration de matching juste au-dessus.
      const cols = new Set(
        (db.prepare(`PRAGMA table_info(dzpk_leads)`).all() as any[]).map(c => c.name)
      );
      if (!cols.has("last_read_msg_id")) db.exec(DZPK_TAKEOVER_ALTER_READ);
      if (!cols.has("last_relayed_msg_id")) db.exec(DZPK_TAKEOVER_ALTER_RELAY);
      db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run(DZPK_MIGRATION_TAKEOVER_V1);
      console.log(`[MIGRATION] ${DZPK_MIGRATION_TAKEOVER_V1} applied`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:${DZPK_MIGRATION_TAKEOVER_V1}] FAILED (sera rejouée au prochain boot):`, err.message);
  }

  // ── Postbacks S2S de conversion dzpk (phase 5) ─────────────────────────────
  //
  // Trois colonnes sur `dzpk_leads`, aucune table nouvelle : le postback est un
  // ATTRIBUT du lead (son click id, l'instant où on a posté, ce que le réseau a
  // répondu), pas un objet de domaine avec un cycle de vie propre.
  //
  // `postback_sent_at` fait office de verrou : il est posé par un UPDATE
  // conditionnel avant l'appel réseau, ce qui rend le double-envoi impossible
  // même si deux passes du cron tombaient ensemble sur le même join.
  //
  // Rien ici ne touche à NEXA, aux tables d'argent, ni au matching : ces trois
  // colonnes ne sont lues que par `lib/funnels/dzpk/postback.ts`.
  try {
    const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`)
      .get(DZPK_MIGRATION_POSTBACK_V1);
    if (!already) {
      // Même parti pris que les migrations dzpk précédentes : SQLite n'a pas
      // d'`ADD COLUMN IF NOT EXISTS`, donc on interroge le schéma pour qu'un
      // échec partiel puisse être rejoué au boot suivant sans rester coincé.
      const cols = new Set(
        (db.prepare(`PRAGMA table_info(dzpk_leads)`).all() as any[]).map(c => c.name)
      );
      if (!cols.has("click_id")) db.exec(DZPK_POSTBACK_ALTER_CLICK);
      if (!cols.has("postback_sent_at")) db.exec(DZPK_POSTBACK_ALTER_SENT);
      if (!cols.has("postback_result")) db.exec(DZPK_POSTBACK_ALTER_RESULT);
      db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run(DZPK_MIGRATION_POSTBACK_V1);
      console.log(`[MIGRATION] ${DZPK_MIGRATION_POSTBACK_V1} applied`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:${DZPK_MIGRATION_POSTBACK_V1}] FAILED (sera rejouée au prochain boot):`, err.message);
  }

  // ── Goal secondaire de conversion dzpk : le join (étape 2 optimisation) ────
  //
  // Depuis cette étape, le goal PRINCIPAL part au /start (webhook dzpk). Le
  // join devient un goal séparé, sur SES colonnes de verrou/résultat : les deux
  // goals d'un même lead se déclenchent, échouent et se rejouent indépendamment.
  //
  // Même parti pris que la v1 : deux colonnes sur `dzpk_leads`, aucune table
  // nouvelle, rien de NEXA ni d'argent touché — colonnes lues uniquement par
  // `lib/funnels/dzpk/postback.ts`.
  try {
    const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`)
      .get(DZPK_MIGRATION_POSTBACK_V2);
    if (!already) {
      const cols = new Set(
        (db.prepare(`PRAGMA table_info(dzpk_leads)`).all() as any[]).map(c => c.name)
      );
      if (!cols.has("join_postback_sent_at")) db.exec(DZPK_POSTBACK_ALTER_JOIN_SENT);
      if (!cols.has("join_postback_result")) db.exec(DZPK_POSTBACK_ALTER_JOIN_RESULT);
      db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run(DZPK_MIGRATION_POSTBACK_V2);
      console.log(`[MIGRATION] ${DZPK_MIGRATION_POSTBACK_V2} applied`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:${DZPK_MIGRATION_POSTBACK_V2}] FAILED (sera rejouée au prochain boot):`, err.message);
  }

  // ── Test A/B d'accueil dzpk (étape 5 optimisation) ─────────────────────────
  //
  // Une colonne, écrite à la première exposition d'un lead au test. NULL =
  // lead accueilli avant la mise en service — exclu des stats A/B. Lue par
  // report.ts (stats) et followup.ts (la relance reprend la variante vue).
  try {
    const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`)
      .get(DZPK_MIGRATION_WELCOME_AB_V1);
    if (!already) {
      const cols = new Set(
        (db.prepare(`PRAGMA table_info(dzpk_leads)`).all() as any[]).map(c => c.name)
      );
      if (!cols.has("welcome_variant")) db.exec(DZPK_WELCOME_AB_ALTER);
      db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run(DZPK_MIGRATION_WELCOME_AB_V1);
      console.log(`[MIGRATION] ${DZPK_MIGRATION_WELCOME_AB_V1} applied`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:${DZPK_MIGRATION_WELCOME_AB_V1}] FAILED (sera rejouée au prochain boot):`, err.message);
  }

  // ── Quarantaine des mouvements wallet invraisemblables ─────────────────────
  //
  // Une colonne d'état sur wallet_transactions. 'active' = compté partout, comme
  // avant. 'quarantined' = importé, visible, mais EXCLU de tous les calculs de
  // solde et de règlement jusqu'à arbitrage manuel sur /wallets/quarantine.
  //
  // Pourquoi : les 29/07 et 16/08/2026, un lot de transactions fantômes a
  // corrompu un solde sans que rien ne s'y oppose. Les gardes amont (adresse,
  // type d'événement) traitent les causes connues ; cette colonne est le filet
  // pour celles qu'on n'a pas encore vues. Le seuil vit dans
  // lib/wallet-address.ts (PLAUSIBILITY_THRESHOLD_USDT = 100 000).
  //
  // Défaut 'active' : les 4 420 lignes existantes gardent leur comportement,
  // la migration ne déplace aucun solde.
  try {
    const already = db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`)
      .get(WALLET_TX_QUARANTINE_V1);
    if (!already) {
      const cols = new Set(
        (db.prepare(`PRAGMA table_info(wallet_transactions)`).all() as any[]).map(c => c.name)
      );
      if (!cols.has("status")) {
        db.exec(`ALTER TABLE wallet_transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_wallet_tx_status ON wallet_transactions(status) WHERE status != 'active'`);
      db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run(WALLET_TX_QUARANTINE_V1);
      console.log(`[MIGRATION] ${WALLET_TX_QUARANTINE_V1} applied`);
    }
  } catch (err: any) {
    console.error(`[MIGRATION:${WALLET_TX_QUARANTINE_V1}] FAILED (sera rejouée au prochain boot):`, err.message);
  }
}
