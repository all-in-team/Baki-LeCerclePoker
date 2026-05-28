import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  const db = getDb();
  const rows = db.prepare(`
    SELECT gs.*, p.name AS player_name, g.name AS game_name
    FROM grindhouse_sessions gs
    JOIN players p ON p.id = gs.player_id
    JOIN games g ON g.id = gs.game_id
    WHERE gs.session_date = ?
    ORDER BY gs.created_at DESC
  `).all(date);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { player_id, game_id, session_date, duration_hours, net_result_usdt, notes } = body;

  if (!player_id || !game_id || duration_hours == null || net_result_usdt == null)
    return NextResponse.json({ error: "player_id, game_id, duration_hours, net_result_usdt requis" }, { status: 400 });

  const db = getDb();
  const r = db.prepare(`
    INSERT INTO grindhouse_sessions (player_id, game_id, session_date, duration_hours, net_result_usdt, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(player_id, game_id, session_date ?? new Date().toISOString().slice(0, 10), duration_hours, net_result_usdt, notes ?? null);

  const row = db.prepare(`
    SELECT gs.*, p.name AS player_name, g.name AS game_name
    FROM grindhouse_sessions gs JOIN players p ON p.id = gs.player_id JOIN games g ON g.id = gs.game_id
    WHERE gs.id = ?
  `).get(Number(r.lastInsertRowid));

  return NextResponse.json(row, { status: 201 });
}
