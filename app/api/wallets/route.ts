import { NextRequest, NextResponse } from "next/server";
import { getWalletTransactions, insertWalletTransaction } from "@/lib/queries";

export async function GET() {
  return NextResponse.json(getWalletTransactions({ limit: 200 }));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.player_id || !body.game_id || !body.type || !body.amount || !body.tx_date)
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  const id = insertWalletTransaction({
    player_id: Number(body.player_id),
    game_id: Number(body.game_id),
    type: body.type,
    amount: Number(body.amount),
    currency: body.currency || "USDT",
    note: body.note || null,
    tx_date: body.tx_date,
  });
  return NextResponse.json({ id }, { status: 201 });
}
