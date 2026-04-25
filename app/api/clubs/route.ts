import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// GET /api/clubs?game_id=1&club_id=12345
export async function GET(req: NextRequest) {
  const game_id = req.nextUrl.searchParams.get("game_id");
  const club_id = req.nextUrl.searchParams.get("club_id");
  if (!game_id || !club_id) return NextResponse.json(null);
  const row = getDb().prepare(`
    SELECT * FROM clubs WHERE game_id = ? AND external_club_id = ?
  `).get(Number(game_id), club_id);
  return NextResponse.json(row ?? null);
}

// POST /api/clubs — upsert
export async function POST(req: NextRequest) {
  const { game_id, external_club_id, club_name, rb_pct, ins_pct } = await req.json();
  if (!game_id || !external_club_id) return NextResponse.json({ error: "game_id + external_club_id requis" }, { status: 400 });
  getDb().prepare(`
    INSERT INTO clubs (game_id, external_club_id, club_name, rb_pct, ins_pct)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(game_id, external_club_id) DO UPDATE SET
      club_name = COALESCE(excluded.club_name, club_name),
      rb_pct    = COALESCE(excluded.rb_pct,    rb_pct),
      ins_pct   = COALESCE(excluded.ins_pct,   ins_pct)
  `).run(game_id, external_club_id, club_name ?? null, rb_pct ?? null, ins_pct ?? null);
  return NextResponse.json({ ok: true });
}
