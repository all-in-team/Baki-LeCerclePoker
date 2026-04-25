import { NextRequest, NextResponse } from "next/server";
import { getLedger, insertTransaction } from "@/lib/queries";

export async function GET(req: NextRequest) {
  const player_id = req.nextUrl.searchParams.get("player_id");
  if (player_id) {
    const { getDb } = await import("@/lib/db");
    const rows = getDb().prepare(`
      SELECT tt.*, p.name AS player_name
      FROM telegram_transactions tt
      LEFT JOIN players p ON p.id = tt.player_id
      WHERE tt.player_id = ?
      ORDER BY tt.tx_date DESC, tt.created_at DESC
      LIMIT 50
    `).all(Number(player_id));
    return NextResponse.json(rows);
  }
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
