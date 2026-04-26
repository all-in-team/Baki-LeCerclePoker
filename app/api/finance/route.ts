import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

const AGENCY_RB  = `(re.amount + re.insurance_amount) * COALESCE(rr.rakeback_pct, 0) / 100.0`;
const PLAYER_RB  = `(re.amount + re.insurance_amount) * COALESCE(pgd.rakeback_pct, 0) / 100.0`;
const WL_AGENCY  = `re.winnings_amount * COALESCE(pgd.action_pct, 0) / 100.0`;
const WL_PLAYER  = `re.winnings_amount * (1.0 - COALESCE(pgd.action_pct, 0) / 100.0)`;

function rangeCond(range: string | null) {
  if (range === "48h")   return ` AND rr.report_date >= date('now', '-2 days')`;
  if (range === "week")  return ` AND rr.report_date >= date('now', '-7 days')`;
  if (range === "month") return ` AND rr.report_date >= date('now', '-30 days')`;
  return "";
}

export async function GET(req: NextRequest) {
  const db = getDb();
  const range = req.nextUrl.searchParams.get("range");
  const rc = rangeCond(range);

  const kpis = db.prepare(`
    SELECT
      re.currency,
      COALESCE(SUM(${AGENCY_RB}), 0) AS agency_rb,
      COALESCE(SUM(${PLAYER_RB}), 0) AS player_rb,
      COALESCE(SUM(${WL_AGENCY}),  0) AS wl_agency,
      COALESCE(SUM(${WL_PLAYER}),  0) AS wl_player,
      COUNT(DISTINCT re.player_id) AS player_count,
      COUNT(DISTINCT rr.id)        AS report_count
    FROM rakeback_entries re
    JOIN rakeback_reports rr ON rr.id = re.report_id
    LEFT JOIN player_game_deals pgd ON pgd.player_id = re.player_id AND pgd.game_id = rr.game_id
    WHERE re.player_id IS NOT NULL${rc}
    GROUP BY re.currency
    ORDER BY re.currency
  `).all();

  const byPlayer = db.prepare(`
    SELECT
      p.id   AS player_id,
      p.name AS player_name,
      re.currency,
      COALESCE(SUM(${AGENCY_RB}), 0) AS agency_rb,
      COALESCE(SUM(${PLAYER_RB}), 0) AS player_rb,
      COALESCE(SUM(${WL_AGENCY}),  0) AS wl_agency,
      COALESCE(SUM(${WL_PLAYER}),  0) AS wl_player,
      COUNT(DISTINCT rr.id)        AS report_count
    FROM rakeback_entries re
    JOIN rakeback_reports rr ON rr.id = re.report_id
    JOIN players p ON p.id = re.player_id
    LEFT JOIN player_game_deals pgd ON pgd.player_id = re.player_id AND pgd.game_id = rr.game_id
    WHERE re.player_id IS NOT NULL${rc}
    GROUP BY p.id, re.currency
    ORDER BY ABS(player_rb + wl_player) DESC
  `).all();

  // Period history always shows all reports (the range filter is on the KPIs/players above)
  const byPeriod = db.prepare(`
    SELECT
      rr.id AS report_id,
      COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) AS report_date,
      rr.period_label,
      re.currency,
      rr.created_at AS latest_date,
      COALESCE(SUM(${AGENCY_RB}), 0) AS agency_rb,
      COALESCE(SUM(${PLAYER_RB}), 0) AS player_rb,
      COALESCE(SUM(${WL_AGENCY}),  0) AS wl_agency,
      COALESCE(SUM(${WL_PLAYER}),  0) AS wl_player,
      COUNT(DISTINCT re.player_id) AS player_count
    FROM rakeback_entries re
    JOIN rakeback_reports rr ON rr.id = re.report_id
    LEFT JOIN player_game_deals pgd ON pgd.player_id = re.player_id AND pgd.game_id = rr.game_id
    WHERE re.player_id IS NOT NULL
    GROUP BY rr.id, re.currency
    ORDER BY latest_date DESC
  `).all();

  return NextResponse.json({ kpis, byPlayer, byPeriod });
}
