import { NextRequest, NextResponse } from "next/server";
import { getPlayerGameDeals, upsertPlayerGameDeal } from "@/lib/queries";

export async function GET(req: NextRequest) {
  const player_id = req.nextUrl.searchParams.get("player_id");
  if (!player_id) return NextResponse.json({ error: "player_id required" }, { status: 400 });
  return NextResponse.json(getPlayerGameDeals(Number(player_id)));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.player_id || !body.game_id || body.action_pct === undefined || body.rakeback_pct === undefined)
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  const id = upsertPlayerGameDeal({
    player_id: Number(body.player_id),
    game_id: Number(body.game_id),
    action_pct: Number(body.action_pct),
    rakeback_pct: Number(body.rakeback_pct),
  });
  return NextResponse.json({ id }, { status: 201 });
}
