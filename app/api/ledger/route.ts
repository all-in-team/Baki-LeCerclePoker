import { NextRequest, NextResponse } from "next/server";
import { getLedger, insertTransaction } from "@/lib/queries";

export async function GET() {
  return NextResponse.json(getLedger());
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.direction || !body.amount || !body.tx_date) {
    return NextResponse.json({ error: "direction, amount, tx_date required" }, { status: 400 });
  }
  const id = insertTransaction({
    player_id: body.player_id || null,
    direction: body.direction,
    amount: Number(body.amount),
    currency: body.currency || "EUR",
    note: body.note || null,
    tx_date: body.tx_date,
  });
  return NextResponse.json({ id }, { status: 201 });
}
