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

  const rows = db.prepare(`
    SELECT wt.*, p.name AS player_name
    FROM wallet_transactions wt
    JOIN players p ON p.id = wt.player_id
    WHERE wt.source = 'unknown'
    ORDER BY wt.tx_date DESC
  `).all() as any[];

  const deposit_total = rows.filter(r => r.type === "deposit").reduce((s: number, r: any) => s + r.amount, 0);
  const withdrawal_total = rows.filter(r => r.type === "withdrawal").reduce((s: number, r: any) => s + r.amount, 0);
  const players = [...new Set(rows.map(r => r.player_name))];

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    count: rows.length,
    total_by_type: { deposit: deposit_total, withdrawal: withdrawal_total },
    players_affected: players,
    rows,
  });
}
