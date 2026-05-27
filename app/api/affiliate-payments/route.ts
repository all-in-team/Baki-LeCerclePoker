import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { computeAffiliateCommission } from "@/lib/queries/affiliate";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { relationship_id, game_id, amount_usdt, week_start_date, week_end_date, tx_hash, notes } = body;

  if (!relationship_id || !game_id || !amount_usdt || !week_start_date || !week_end_date)
    return NextResponse.json({ error: "relationship_id, game_id, amount_usdt, week_start_date, week_end_date requis" }, { status: 400 });

  if (amount_usdt <= 0)
    return NextResponse.json({ error: "amount_usdt doit être > 0" }, { status: 400 });

  const db = getDb();

  const rel = db.prepare(
    `SELECT id, status FROM affiliate_relationships WHERE id = ?`
  ).get(relationship_id) as { id: number; status: string } | undefined;
  if (!rel) return NextResponse.json({ error: "Relation introuvable" }, { status: 404 });
  if (rel.status !== "active") return NextResponse.json({ error: "Relation non active" }, { status: 400 });

  const snapshot = computeAffiliateCommission(relationship_id);
  const gameBreakdown = snapshot?.breakdown.find(b => b.game_id === game_id);

  const r = db.prepare(`
    INSERT INTO affiliate_payments
      (relationship_id, game_id, week_start_date, week_end_date, amount_usdt, tx_hash, notes,
       snapshot_agency_pnl_lifetime, snapshot_commission_rate, snapshot_total_earned, snapshot_total_paid_before)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    relationship_id, game_id, week_start_date, week_end_date, amount_usdt,
    tx_hash ?? null, notes ?? null,
    gameBreakdown?.agency_pnl_lifetime ?? null,
    gameBreakdown?.rate ?? null,
    gameBreakdown?.earned_lifetime ?? null,
    gameBreakdown?.paid_lifetime ?? null,
  );

  return NextResponse.json({ ok: true, id: Number(r.lastInsertRowid) }, { status: 201 });
}
