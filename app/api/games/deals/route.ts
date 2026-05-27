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

  // Auto-create affiliate_relationship on first deal for converted leads
  const db = getDb();
  const lead = db.prepare(
    `SELECT affiliate_player_id FROM affiliate_leads WHERE converted_player_id = ? AND status = 'converted'`
  ).get(playerId) as { affiliate_player_id: number } | undefined;

  if (lead) {
    const existingRel = db.prepare(
      `SELECT 1 FROM affiliate_relationships WHERE referred_player_id = ?`
    ).get(playerId);

    if (!existingRel) {
      db.prepare(
        `INSERT INTO affiliate_relationships (affiliate_player_id, referred_player_id, origin_game_id, start_date) VALUES (?, ?, ?, date('now'))`
      ).run(lead.affiliate_player_id, playerId, gameId);
      console.log(`[AFFILIATE] Relationship auto-created: affiliate=${lead.affiliate_player_id} referred=${playerId} origin_game=${gameId}`);
    }
  }

  return NextResponse.json({ id }, { status: 201 });
}
