export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token || req.headers.get("x-admin-token") !== token)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getDb();
  const r: Record<string, any> = {};

  // Hugo = player_id 1
  r["hugo_player"] = db.prepare(`SELECT * FROM players WHERE id = 1`).get();

  // All transactions for Hugo — with both date fields
  r["hugo_txs"] = db.prepare(`
    SELECT id, type, amount, currency, source, tron_tx_hash, tx_date, tx_datetime, created_at, game_id, note
    FROM wallet_transactions WHERE player_id = 1
    ORDER BY tx_datetime ASC
  `).all();

  // Sum using the DASHBOARD method (source filter, no unknown)
  r["dashboard_method"] = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN wt.type='deposit' THEN wt.amount ELSE 0 END), 0) AS deposited,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE 0 END), 0) AS withdrawn,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) AS net
    FROM wallet_transactions wt
    WHERE wt.player_id = 1 AND (wt.source IS NULL OR wt.source != 'unknown')
  `).get();

  // Sum using the BOT get_player_detail method (NO source filter)
  r["bot_method"] = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN wt.type='deposit' THEN wt.amount ELSE -wt.amount END), 0) AS net
    FROM wallet_transactions wt
    JOIN games g ON g.id = wt.game_id
    WHERE wt.player_id = 1
  `).get();

  // Sum using bot method but WITHOUT the games JOIN (includes txs with NULL game_id)
  r["bot_method_no_game_join"] = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN wt.type='deposit' THEN wt.amount ELSE -wt.amount END), 0) AS net
    FROM wallet_transactions wt
    WHERE wt.player_id = 1
  `).get();

  // Check for unknown source txs
  r["unknown_source_txs"] = db.prepare(`
    SELECT id, type, amount, source, tx_datetime, tron_tx_hash
    FROM wallet_transactions WHERE player_id = 1 AND source = 'unknown'
  `).all();

  // Check for duplicate tx hashes
  r["dup_hashes"] = db.prepare(`
    SELECT tron_tx_hash, COUNT(*) AS cnt
    FROM wallet_transactions WHERE player_id = 1 AND tron_tx_hash IS NOT NULL
    GROUP BY tron_tx_hash HAVING cnt > 1
  `).all();

  // Transaction count by source
  r["source_counts"] = db.prepare(`
    SELECT source, COUNT(*) AS cnt, SUM(amount) AS total
    FROM wallet_transactions WHERE player_id = 1 GROUP BY source
  `).all();

  // What the dashboard /tele page actually computes for Hugo (using the deal join)
  r["dashboard_with_deal"] = db.prepare(`
    SELECT pgd.action_pct,
      COALESCE(SUM(CASE WHEN wt.type='deposit' THEN wt.amount ELSE 0 END), 0) AS deposited,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE 0 END), 0) AS withdrawn,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) AS net,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) * pgd.action_pct / 100.0 AS my_pnl
    FROM player_game_deals pgd
    JOIN games g ON g.id = pgd.game_id
    LEFT JOIN wallet_transactions wt ON wt.player_id = pgd.player_id AND wt.game_id = pgd.game_id
      AND (wt.source IS NULL OR wt.source != 'unknown')
      AND (pgd.start_date IS NULL OR wt.tx_datetime >= pgd.start_date)
    WHERE pgd.player_id = 1
    GROUP BY pgd.game_id
  `).all();

  return NextResponse.json(r);
}
