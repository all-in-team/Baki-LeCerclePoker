import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { computeAgentCommission } from "@/lib/queries/affiliate";

export async function GET(req: NextRequest) {
  const relId = req.nextUrl.searchParams.get("relationship_id");
  if (!relId) return NextResponse.json({ error: "relationship_id required" }, { status: 400 });
  const db = getDb();
  const rows = db.prepare(`
    SELECT ap.*, g.name AS game_name
    FROM affiliate_payments ap
    LEFT JOIN games g ON g.id = ap.game_id
    WHERE ap.relationship_id = ?
    ORDER BY ap.paid_at DESC LIMIT 20
  `).all(Number(relId)) as any[];
  return NextResponse.json(rows);
}

// AGENT-LEVEL payment (D2): pays the agent's global due (cross-makeup).
// affiliate_payments still requires relationship_id + game_id (NOT NULL), so the row is
// attached to a representative active relationship/game of the agent — paid_agent sums
// across ALL the agent's relationships, so attribution choice does not affect the total.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { affiliate_player_id, amount_usdt, week_start_date, week_end_date, tx_hash, notes } = body;

  if (!affiliate_player_id || !amount_usdt || !week_start_date || !week_end_date)
    return NextResponse.json({ error: "affiliate_player_id, amount_usdt, week_start_date, week_end_date requis" }, { status: 400 });

  if (amount_usdt <= 0)
    return NextResponse.json({ error: "amount_usdt doit être > 0" }, { status: 400 });

  const db = getDb();

  const repRel = db.prepare(
    `SELECT id, origin_game_id, referred_player_id FROM affiliate_relationships
     WHERE affiliate_player_id = ? AND status = 'active' ORDER BY id LIMIT 1`
  ).get(affiliate_player_id) as { id: number; origin_game_id: number | null; referred_player_id: number } | undefined;
  if (!repRel) return NextResponse.json({ error: "Agent sans relation active" }, { status: 400 });

  let gameId = repRel.origin_game_id;
  if (!gameId) {
    const g = db.prepare(`SELECT game_id FROM player_game_deals WHERE player_id = ? LIMIT 1`).get(repRel.referred_player_id) as { game_id: number } | undefined;
    gameId = g?.game_id ?? null;
  }
  if (!gameId) return NextResponse.json({ error: "Aucun game rattaché à l'agent — impossible d'enregistrer le paiement" }, { status: 400 });

  // Agent-level audit snapshot (state at payment time)
  const ac = computeAgentCommission(affiliate_player_id);

  const r = db.prepare(`
    INSERT INTO affiliate_payments
      (relationship_id, game_id, week_start_date, week_end_date, amount_usdt, tx_hash, notes,
       snapshot_agency_pnl_lifetime, snapshot_commission_rate, snapshot_total_earned, snapshot_total_paid_before)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    repRel.id, gameId, week_start_date, week_end_date, amount_usdt,
    tx_hash ?? null, notes ?? null,
    ac.cumul_agence_eligible, 0.50, ac.earned, ac.paid,
  );

  return NextResponse.json({ ok: true, id: Number(r.lastInsertRowid) }, { status: 201 });
}
