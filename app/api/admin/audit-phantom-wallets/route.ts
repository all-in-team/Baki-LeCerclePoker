import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(req: Request) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN env var is not set on the server" }, { status: 503 });
  }
  const provided = req.headers.get("x-admin-token");
  if (provided !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();

  const total_rows = (db.prepare(`SELECT COUNT(*) AS c FROM wallet_transactions`).get() as { c: number }).c;

  const phantom_rows = db.prepare(`
    SELECT wt.id, wt.player_id, p.name AS player_name, wt.type, wt.amount, wt.currency,
           wt.tx_date, wt.tron_tx_hash, wt.counterparty_address, wt.note, wt.source, wt.created_at
    FROM wallet_transactions wt
    JOIN players p ON p.id = wt.player_id
    WHERE (wt.tron_tx_hash IS NULL OR wt.tron_tx_hash = '')
      AND (wt.source IS NULL OR wt.source != 'manual')
    ORDER BY wt.tx_date DESC
  `).all() as any[];

  const deposit_total = phantom_rows.filter(r => r.type === "deposit").reduce((s, r) => s + r.amount, 0);
  const withdrawal_total = phantom_rows.filter(r => r.type === "withdrawal").reduce((s, r) => s + r.amount, 0);

  return NextResponse.json({
    total_rows,
    phantom_rows,
    summary: {
      count: phantom_rows.length,
      total_amount_by_type: { deposit: deposit_total, withdrawal: withdrawal_total },
    },
  });
}
