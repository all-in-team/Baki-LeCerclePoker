import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (req.headers.get("x-admin-token") !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getDb();

  const akDeals = db.prepare(`
    SELECT pgd.id, pgd.player_id, p.name AS player_name, p.status AS player_status,
           g.name AS game_name, pgd.action_pct, pgd.rakeback_pct,
           COALESCE(pgd.insurance_pct, 0) AS insurance_pct, pgd.start_date
    FROM player_game_deals pgd
    JOIN players p ON p.id = pgd.player_id
    JOIN games g ON g.id = pgd.game_id
    WHERE g.name = 'TELE'
    ORDER BY p.name
  `).all();

  const kkDeals = db.prepare(`
    SELECT pgd.id, pgd.player_id, p.name AS player_name,
           g.name AS game_name, pgd.action_pct, pgd.rakeback_pct,
           COALESCE(pgd.insurance_pct, 0) AS insurance_pct
    FROM player_game_deals pgd
    JOIN players p ON p.id = pgd.player_id
    JOIN games g ON g.id = pgd.game_id
    WHERE g.name = 'KKPOKER'
  `).all();

  const distribution = db.prepare(`
    SELECT pgd.action_pct, pgd.rakeback_pct, COALESCE(pgd.insurance_pct, 0) AS insurance_pct, COUNT(*) AS cnt
    FROM player_game_deals pgd
    JOIN games g ON g.id = pgd.game_id
    WHERE g.name = 'TELE'
    GROUP BY pgd.action_pct, pgd.rakeback_pct, insurance_pct
  `).all();

  return NextResponse.json({ akpoker_deals: akDeals, kkpoker_deals: kkDeals, distribution });
}

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (req.headers.get("x-admin-token") !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getDb();
  const kkGame = db.prepare(`SELECT id FROM games WHERE name = 'KKPOKER'`).get() as { id: number } | undefined;
  if (!kkGame) return NextResponse.json({ error: "KKPOKER game not found" }, { status: 500 });

  const allGames = db.prepare(`SELECT id, name, status FROM games`).all();

  const today = new Date().toISOString().slice(0, 10);
  const akDeals = db.prepare(`
    SELECT pgd.player_id, pgd.action_pct, pgd.rakeback_pct, COALESCE(pgd.insurance_pct, 0) AS insurance_pct
    FROM player_game_deals pgd
    JOIN games g ON g.id = pgd.game_id
    WHERE g.name = 'TELE'
  `).all() as { player_id: number; action_pct: number; rakeback_pct: number; insurance_pct: number }[];

  // Check FK enforcement
  const fkStatus = db.prepare(`PRAGMA foreign_keys`).get() as any;

  // The games table was recreated by kkpoker_launch_v1 migration, which breaks
  // SQLite's FK schema cache for player_game_deals. Temporarily disable FK checks.
  let inserted = 0;
  const errors: string[] = [];
  db.pragma("foreign_keys = OFF");
  for (const d of akDeals) {
    try {
      const r = db.prepare(`
        INSERT OR IGNORE INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct, insurance_pct, start_date)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(d.player_id, kkGame.id, d.action_pct, d.rakeback_pct, d.insurance_pct, today);
      if (r.changes > 0) inserted++;
    } catch (e: any) {
      errors.push(`player_id=${d.player_id}: ${e.message}`);
    }
  }
  db.pragma("foreign_keys = ON");

  return NextResponse.json({
    ok: errors.length === 0,
    kkpoker_game_id: kkGame.id,
    all_games: allGames,
    fk_enabled: fkStatus,
    akpoker_count: akDeals.length,
    inserted,
    skipped: akDeals.length - inserted - errors.length,
    errors,
  });
}
