export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token || req.headers.get("x-admin-token") !== token)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();
  const rows = db.prepare(`SELECT wcs.*, p.name FROM weekly_cashout_state wcs JOIN players p ON p.id = wcs.player_id WHERE wcs.player_id IN (8, 16) ORDER BY wcs.player_id`).all();
  const all = db.prepare(`SELECT wcs.*, p.name FROM weekly_cashout_state wcs JOIN players p ON p.id = wcs.player_id ORDER BY wcs.player_id`).all();
  return NextResponse.json({ slava_raph: rows, all_players: all });
}
