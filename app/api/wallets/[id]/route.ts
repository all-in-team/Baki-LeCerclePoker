import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();

  const tx = db.prepare(`SELECT id, source, player_id FROM wallet_transactions WHERE id = ?`).get(Number(id)) as { id: number; source: string | null; player_id: number } | undefined;
  if (!tx) return NextResponse.json({ error: "Transaction not found" }, { status: 404 });

  if (tx.source !== "manual") {
    return NextResponse.json({ error: "Seules les transactions manuelles peuvent être supprimées" }, { status: 403 });
  }

  db.prepare(`DELETE FROM wallet_transactions WHERE id = ? AND source = 'manual'`).run(Number(id));
  return NextResponse.json({ ok: true, player_id: tx.player_id });
}
