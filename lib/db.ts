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
  try { db.exec(`ALTER TABLE players ADD COLUMN tier TEXT DEFAULT 'A' CHECK(tier IN ('S','A','B'))`); } catch {}
  try { db.exec(`ALTER TABLE players ADD COLUMN telegram_phone TEXT`); } catch {}
  try { db.exec(`ALTER TABLE players ADD COLUMN tron_address TEXT`); } catch {}
  try { db.exec(`ALTER TABLE players ADD COLUMN tron_app_id INTEGER REFERENCES poker_apps(id) ON DELETE SET NULL`); } catch {}
  try { db.exec(`ALTER TABLE wallet_transactions ADD COLUMN tron_tx_hash TEXT`); } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tron_hash ON wallet_transactions(tron_tx_hash) WHERE tron_tx_hash IS NOT NULL`); } catch {}

  // telegram_id for deduplication when auto-importing from groups
  try { db.exec(`ALTER TABLE players ADD COLUMN telegram_id INTEGER`); } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_players_telegram_id ON players(telegram_id) WHERE telegram_id IS NOT NULL`); } catch {}

  // One-time fix: flip deposit/withdrawal directions (to=player means deposit, from=player means withdrawal)
  db.exec(`CREATE TABLE IF NOT EXISTS _applied_fixes (name TEXT PRIMARY KEY)`);
  const fixFlip = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("flip_wallet_directions_v2");
  if (fixFlip.changes > 0) {
    db.exec(`UPDATE wallet_transactions SET type = CASE WHEN type='deposit' THEN 'withdrawal' ELSE 'deposit' END`);
  }
}
