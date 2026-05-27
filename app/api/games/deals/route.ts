import { NextRequest, NextResponse } from "next/server";
import { getPlayerGameDeals, upsertPlayerGameDeal } from "@/lib/queries";
import { getDb } from "@/lib/db";

export async function GET(req: NextRequest) {
  const player_id = req.nextUrl.searchParams.get("player_id");
  if (!player_id) return NextResponse.json({ error: "player_id required" }, { status: 400 });
  return NextResponse.json(getPlayerGameDeals(Number(player_id)));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.player_id || !body.game_id || body.action_pct === undefined || body.rakeback_pct === undefined)
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });

  const playerId = Number(body.player_id);
  const gameId = Number(body.game_id);

  const id = upsertPlayerGameDeal({
    player_id: playerId,
    game_id: gameId,
    action_pct: Number(body.action_pct),
    rakeback_pct: Number(body.rakeback_pct),
    start_date: body.start_date || null,
    end_date: body.end_date !== undefined ? (body.end_date || null) : undefined,
  });

  // Set origin_game_id on affiliate relationship if still NULL (first deal)
  const db = getDb();
  const pendingRel = db.prepare(
    `SELECT id FROM affiliate_relationships WHERE referred_player_id = ? AND origin_game_id IS NULL`
  ).get(playerId) as { id: number } | undefined;

  if (pendingRel) {
    db.prepare(`UPDATE affiliate_relationships SET origin_game_id = ? WHERE id = ?`).run(gameId, pendingRel.id);
    console.log(`[AFFILIATE] origin_game_id set to ${gameId} for relationship ${pendingRel.id}`);
  }

  return NextResponse.json({ id }, { status: 201 });
}
