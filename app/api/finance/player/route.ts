import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

const AGENCY_RB = `(re.amount + re.insurance_amount) * COALESCE(rr.rakeback_pct, 0) / 100.0`;
const PLAYER_RB = `(re.amount + re.insurance_amount) * COALESCE(pgd.rakeback_pct, 0) / 100.0`;
const WL_AGENCY = `re.winnings_amount * COALESCE(pgd.action_pct, 0) / 100.0`;
const WL_PLAYER = `re.winnings_amount * (1.0 - COALESCE(pgd.action_pct, 0) / 100.0)`;

function rangeCond(range: string | null) {
  if (range === "48h")   return ` AND rr.report_date >= date('now', '-2 days')`;
  if (range === "week")  return ` AND rr.report_date >= date('now', '-7 days')`;
  if (range === "month") return ` AND rr.report_date >= date('now', '-30 days')`;
  return "";
}

export async function GET(req: NextRequest) {
  const db = getDb();
  const player_id = req.nextUrl.searchParams.get("player_id");
  const range = req.nextUrl.searchParams.get("range");
  if (!player_id) return NextResponse.json([]);

  const entries = db.prepare(`
    SELECT
      rr.id AS report_id,
      COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) AS date,
      rr.period_label,
      rr.club_name,
      re.currency,
      re.amount          AS rake,
      re.insurance_amount AS insurance,
      re.winnings_amount  AS winnings,
      ${AGENCY_RB}       AS agency_rb,
      ${PLAYER_RB}       AS player_rb,
      ${WL_AGENCY}       AS wl_agency,
      ${WL_PLAYER}       AS wl_player
    FROM rakeback_entries re
    JOIN rakeback_reports rr ON rr.id = re.report_id
    LEFT JOIN player_game_deals pgd ON pgd.player_id = re.player_id AND pgd.game_id = rr.game_id
    WHERE re.player_id = ?${rangeCond(range)}
    ORDER BY COALESCE(rr.report_date, rr.created_at) DESC
  `).all(Number(player_id));

  return NextResponse.json(entries);
}
