import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// GET /api/clubs?game_id=1            → list all clubs for a game
// GET /api/clubs?game_id=1&club_id=X  → lookup single club
export async function GET(req: NextRequest) {
  const game_id = req.nextUrl.searchParams.get("game_id");
  const club_id = req.nextUrl.searchParams.get("club_id");
  if (!game_id) return NextResponse.json([]);
  const db = getDb();
  if (club_id) {
    const row = db.prepare(`SELECT * FROM clubs WHERE game_id = ? AND external_club_id = ?`).get(Number(game_id), club_id);
    return NextResponse.json(row ?? null);
  }
  const rows = db.prepare(`SELECT * FROM clubs WHERE game_id = ? ORDER BY club_name ASC`).all(Number(game_id));
  return NextResponse.json(rows);
}

// POST /api/clubs — upsert
export async function POST(req: NextRequest) {
  const { game_id, external_club_id, club_name, rb_pct, ins_pct } = await req.json();
  if (!game_id || !external_club_id) return NextResponse.json({ error: "game_id + external_club_id requis" }, { status: 400 });
  getDb().prepare(`
    INSERT INTO clubs (game_id, external_club_id, club_name, rb_pct, ins_pct)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(game_id, external_club_id) DO UPDATE SET
      club_name = CASE WHEN excluded.club_name IS NOT NULL THEN excluded.club_name ELSE club_name END,
      rb_pct    = CASE WHEN excluded.rb_pct    IS NOT NULL THEN excluded.rb_pct    ELSE rb_pct    END,
      ins_pct   = CASE WHEN excluded.ins_pct   IS NOT NULL THEN excluded.ins_pct   ELSE ins_pct   END
  `).run(game_id, external_club_id, club_name ?? null, rb_pct ?? null, ins_pct ?? null);
  return NextResponse.json({ ok: true });
}
