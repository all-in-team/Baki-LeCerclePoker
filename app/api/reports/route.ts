import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET() {
  const db = getDb();
  const reports = db.prepare(`
    SELECT rr.id, rr.period_label, rr.report_date, rr.created_at, rr.club_id, rr.club_name, g.name AS game_name,
      COUNT(re.id) AS entry_count,
      COALESCE(SUM(re.amount), 0) AS total_amount,
      SUM(CASE WHEN re.player_id IS NULL THEN 1 ELSE 0 END) AS unmatched_count
    FROM rakeback_reports rr
    JOIN games g ON g.id = rr.game_id
    LEFT JOIN rakeback_entries re ON re.report_id = rr.id
    GROUP BY rr.id
    ORDER BY rr.created_at DESC
  `).all();
  return NextResponse.json(reports);
}
