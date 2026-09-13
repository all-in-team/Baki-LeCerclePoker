import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { deleteGameIdRowOn, linkMemberIdOn } from "@/lib/games/xpoker/engine";
import { XPOKER_GAME_NAME } from "@/lib/games/xpoker/config";

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
  // XPoker Twd : UN seul chemin d'écriture du lien (refus des comptes agence, reliaison
  // des semaines orphelines, réactivation d'un ID archivé) — cf. linkMemberIdOn.
  const db = getDb();
  const xp = db.prepare(`SELECT id FROM games WHERE name = ?`).get(XPOKER_GAME_NAME) as { id: number } | undefined;
  if (xp && Number(game_id) === xp.id) {
    const r = linkMemberIdOn(db, { player_id: Number(id), member_id: external_id.trim() });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true, id: r.account_id });
  }
  try {
    const row = db.prepare(`
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
  // GARDE (lib/games/xpoker/engine.ts) : un Player ID XPoker Twd porteur de semaines
  // importées ne se supprime pas, il s'archive. Les autres games : DELETE inchangé.
  const r = deleteGameIdRowOn(getDb(), Number(game_id_row_id), Number(id));
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
  return NextResponse.json({ ok: true });
}
