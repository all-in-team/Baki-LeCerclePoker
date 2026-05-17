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
