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

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE CHECK(name IN ('TELE','Wepoker','Xpoker','ClubGG'))
    );
    INSERT OR IGNORE INTO games (name) VALUES ('TELE'),('Wepoker'),('Xpoker'),('ClubGG');

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

  // Exchange rates for multi-currency P&L normalization
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run("exchange_rate_cny_usdt", "0.138");
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run("exchange_rate_eur_usdt", "1.08");
}
