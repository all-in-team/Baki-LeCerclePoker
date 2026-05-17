import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.key !== "db-diag-20260518") {
    return NextResponse.json({ error: "bad key" }, { status: 403 });
  }

  const db = getDb();
  const action = body.action ?? "inspect";

  if (action === "inspect") {
    const results: Record<string, any> = {};
    results["row_counts"] = {
      player_game_deals: (db.prepare("SELECT COUNT(*) AS n FROM player_game_deals").get() as any).n,
      wallet_transactions: (db.prepare("SELECT COUNT(*) AS n FROM wallet_transactions").get() as any).n,
    };
    results["indexes"] = db.prepare(`
      SELECT name, tbl_name, sql FROM sqlite_master
      WHERE type='index' AND tbl_name IN ('player_game_deals','wallet_transactions')
      ORDER BY tbl_name, name
    `).all();
    results["triggers"] = db.prepare(`
      SELECT name, tbl_name, sql FROM sqlite_master
      WHERE type='trigger' AND tbl_name IN ('player_game_deals','wallet_transactions')
      ORDER BY tbl_name, name
    `).all();
    results["schemas"] = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE name IN ('player_game_deals','wallet_transactions')
    `).all();
    return NextResponse.json(results);
  }

  if (action === "backup") {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    try {
      const fs = await import("fs");
      const path = await import("path");
      const dir = path.join(process.cwd(), "data");
      const dbPath = path.join(dir, "lecercle.db");
      const backupPath = path.join(dir, "lecercle-backup-fkfix.db");
      const dirExists = fs.existsSync(dir);
      const dbExists = fs.existsSync(dbPath);
      if (!dirExists || !dbExists) {
        return NextResponse.json({ ok: false, error: `dir=${dirExists} db=${dbExists} dbPath=${dbPath}` }, { status: 500 });
      }
      await db.backup(backupPath);
      const stat = fs.statSync(backupPath);
      const pgdCount = (db.prepare("SELECT COUNT(*) AS n FROM player_game_deals").get() as any).n;
      const wtCount = (db.prepare("SELECT COUNT(*) AS n FROM wallet_transactions").get() as any).n;
      return NextResponse.json({ ok: true, backupPath, sizeBytes: stat.size, row_counts: { player_game_deals: pgdCount, wallet_transactions: wtCount } });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
    }
  }

  if (action === "reset-player") {
    const pid = body.player_id as number;
    if (!pid) return NextResponse.json({ error: "player_id required" }, { status: 400 });
    const player = db.prepare(`SELECT id, name, telegram_id, telegram_chat_id FROM players WHERE id = ?`).get(pid) as any;
    if (!player) return NextResponse.json({ error: "player not found" }, { status: 404 });
    const tx = db.transaction(() => {
      if (player.telegram_chat_id) db.prepare(`DELETE FROM telegram_sessions WHERE chat_id = ?`).run(player.telegram_chat_id);
      db.prepare(`DELETE FROM player_wallet_games WHERE player_id = ?`).run(pid);
      db.prepare(`DELETE FROM player_wallet_cashouts WHERE player_id = ?`).run(pid);
      db.prepare(`DELETE FROM player_game_deals WHERE player_id = ?`).run(pid);
      db.prepare(`DELETE FROM crm_notes WHERE player_id = ?`).run(pid);
      db.prepare(`DELETE FROM players WHERE id = ?`).run(pid);
      if (player.telegram_id) db.prepare(`DELETE FROM onboarding_leads WHERE telegram_id = ?`).run(player.telegram_id);
    });
    tx();
    return NextResponse.json({ ok: true, deleted: player.name, id: pid, telegram_id: player.telegram_id });
  }

  if (action === "migrate") {
    try {
      db.pragma("foreign_keys = OFF");

      const tx = db.transaction(() => {
        // ── player_game_deals rebuild ──
        db.exec(`
          CREATE TABLE player_game_deals_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
            game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
            action_pct REAL NOT NULL DEFAULT 50,
            rakeback_pct REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            insurance_pct REAL,
            start_date TEXT,
            UNIQUE(player_id, game_id)
          )
        `);
        db.exec(`INSERT INTO player_game_deals_new SELECT * FROM player_game_deals`);
        db.exec(`DROP TABLE player_game_deals`);
        db.exec(`ALTER TABLE player_game_deals_new RENAME TO player_game_deals`);

        // ── wallet_transactions rebuild ──
        db.exec(`
          CREATE TABLE wallet_transactions_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
            app_id INTEGER REFERENCES poker_apps(id) ON DELETE SET NULL,
            game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
            type TEXT NOT NULL CHECK(type IN ('deposit','withdrawal')),
            amount REAL NOT NULL,
            currency TEXT NOT NULL DEFAULT 'USDT',
            note TEXT,
            tron_tx_hash TEXT,
            tx_date TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            counterparty_address TEXT,
            source TEXT DEFAULT 'unknown',
            tx_datetime TEXT
          )
        `);
        db.exec(`INSERT INTO wallet_transactions_new SELECT * FROM wallet_transactions`);
        db.exec(`DROP TABLE wallet_transactions`);
        db.exec(`ALTER TABLE wallet_transactions_new RENAME TO wallet_transactions`);

        // ── Recreate indexes (exact match to production) ──
        db.exec(`CREATE UNIQUE INDEX idx_wallet_tron_hash ON wallet_transactions(tron_tx_hash, player_id) WHERE tron_tx_hash IS NOT NULL`);

        // ── Recreate trigger (exact match to production) ──
        db.exec(`
          CREATE TRIGGER wallet_tx_source_check BEFORE INSERT ON wallet_transactions
          BEGIN
            SELECT RAISE(ABORT, 'wallet_transactions: source must be sync (with tron_tx_hash) or manual')
            WHERE (NEW.source = 'sync' AND (NEW.tron_tx_hash IS NULL OR NEW.tron_tx_hash = ''))
               OR NEW.source NOT IN ('sync', 'manual', 'unknown');
          END
        `);
      });
      tx();

      db.pragma("foreign_keys = ON");

      // Verify
      const pgdCount = (db.prepare("SELECT COUNT(*) AS n FROM player_game_deals").get() as any).n;
      const wtCount = (db.prepare("SELECT COUNT(*) AS n FROM wallet_transactions").get() as any).n;
      const fkViolations = db.pragma("foreign_key_check");
      const fkList_pgd = db.pragma("foreign_key_list('player_game_deals')");
      const fkList_wt = db.pragma("foreign_key_list('wallet_transactions')");

      // Test insert (rolled back)
      let insertTest = "not run";
      try {
        const testTx = db.transaction(() => {
          db.prepare("INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct) VALUES (55, 5, 40, 0)").run();
          throw new Error("ROLLBACK_SENTINEL");
        });
        try { testTx(); } catch (e: any) {
          insertTest = e.message === "ROLLBACK_SENTINEL" ? "INSERT succeeded (rolled back)" : `FAILED: ${e.message}`;
        }
      } catch (e: any) {
        insertTest = `FAILED: ${e.message}`;
      }

      return NextResponse.json({
        ok: true,
        post_migrate: {
          player_game_deals_count: pgdCount,
          wallet_transactions_count: wtCount,
          fk_violations_count: (fkViolations as any[]).length,
          fk_violations: (fkViolations as any[]).slice(0, 5),
          fk_list_pgd: fkList_pgd,
          fk_list_wt: fkList_wt,
          insert_test: insertTest,
        }
      });
    } catch (e: any) {
      db.pragma("foreign_keys = ON");
      return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
