// XPoker Twd — règlement joueur : semaines réglables / bloquées, verrouillage.
// Route fine (invariant #2) : toute la math et les refus vivent dans
// lib/games/xpoker/settlement.ts. Marquer payé et déverrouiller passent par le
// hub /payments (markPaid / unlockSettlement du moteur commun), pas par ici.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getSettleableWeeksOn, lockXpokerSettlementOn, getXpokerSettlementsOn } from "@/lib/games/xpoker/settlement";

export async function GET(req: NextRequest) {
  const pid = Number(req.nextUrl.searchParams.get("player_id"));
  if (!pid) return NextResponse.json({ error: "player_id requis" }, { status: 400 });
  const db = getDb();
  return NextResponse.json({ ok: true, ...getSettleableWeeksOn(db, pid), settlements: getXpokerSettlementsOn(db, pid) });
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  if (!b || !b.player_id || !Array.isArray(b.week_starts)) return NextResponse.json({ error: "player_id et week_starts[] requis" }, { status: 400 });
  const r = lockXpokerSettlementOn(getDb(), { player_id: Number(b.player_id), week_starts: b.week_starts.map(String), notes: b.notes ?? null });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
  return NextResponse.json({ ok: true, settlement_id: r.settlement_id, due_chips: r.due_chips, due_usd: r.due_usd, weeks: r.weeks.map(w => w.week_start) });
}
