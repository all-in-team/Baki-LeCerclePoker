import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const rows = getDb().prepare(`
    SELECT pgi.id, pgi.game_id, g.name AS game_name, pgi.external_id
    FROM player_game_ids pgi
    JOIN games g ON g.id = pgi.game_id
    WHERE pgi.player_id = ?
    ORDER BY g.name, pgi.external_id
  `).all(Number(id));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const { game_id, external_id } = await req.json();
  if (!game_id || !external_id?.trim()) {
    return NextResponse.json({ error: "game_id + external_id requis" }, { status: 400 });
  }
  try {
    const row = getDb().prepare(`
      INSERT INTO player_game_ids (player_id, game_id, external_id)
      VALUES (?, ?, ?)
    `).run(Number(id), game_id, external_id.trim());
    return NextResponse.json({ ok: true, id: Number(row.lastInsertRowid) });
  } catch {
    return NextResponse.json({ error: "Cet ID existe déjà pour cette game" }, { status: 409 });
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const { game_id_row_id } = await req.json();
  getDb().prepare(`
    DELETE FROM player_game_ids WHERE id = ? AND player_id = ?
  `).run(game_id_row_id, Number(id));
  return NextResponse.json({ ok: true });
}
