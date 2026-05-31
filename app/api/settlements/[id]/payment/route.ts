import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const settlementId = parseInt(id);
  if (isNaN(settlementId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const received: boolean = body.received === true;
  const receivedBy: string = body.received_by ?? "Baki";

  const db = getDb();
  const row = db.prepare(`SELECT id FROM weekly_settlements WHERE id = ?`).get(settlementId);
  if (!row) return NextResponse.json({ error: "Settlement not found" }, { status: 404 });

  if (received) {
    db.prepare(`UPDATE weekly_settlements SET payment_received = 1, received_at = datetime('now'), received_by = ? WHERE id = ?`).run(receivedBy, settlementId);
  } else {
    db.prepare(`UPDATE weekly_settlements SET payment_received = 0, received_at = NULL, received_by = NULL WHERE id = ?`).run(settlementId);
  }

  return NextResponse.json({ ok: true, settlement_id: settlementId, payment_received: received });
}
