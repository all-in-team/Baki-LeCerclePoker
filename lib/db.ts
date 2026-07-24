import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

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
}
