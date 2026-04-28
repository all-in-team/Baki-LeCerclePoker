export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getPlayerBalance } from "@/lib/queries";

export async function GET(req: NextRequest) {
  const playerId = req.nextUrl.searchParams.get("player_id");
  const balances = getPlayerBalance(playerId ? Number(playerId) : undefined);
  return NextResponse.json(balances);
}
