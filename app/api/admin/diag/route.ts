export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token || req.headers.get("x-admin-token") !== token)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getDb();
  const r: Record<string, any> = {};

  r["weekly_cashout_state_all"] = db.prepare(
    `SELECT wcs.*, p.name as player_name
     FROM weekly_cashout_state wcs
     JOIN players p ON p.id = wcs.player_id
     ORDER BY wcs.week_start DESC, wcs.player_id`
  ).all();

  r["row_counts_per_player_per_week"] = db.prepare(
    `SELECT player_id, week_start, COUNT(*) as row_count
     FROM weekly_cashout_state
     GROUP BY player_id, week_start
     HAVING row_count > 1`
  ).all();

  r["total_rows"] = (db.prepare(`SELECT COUNT(*) as n FROM weekly_cashout_state`).get() as any).n;

  r["distinct_week_starts"] = db.prepare(
    `SELECT DISTINCT week_start FROM weekly_cashout_state ORDER BY week_start DESC`
  ).all();

  return NextResponse.json(r);
}
