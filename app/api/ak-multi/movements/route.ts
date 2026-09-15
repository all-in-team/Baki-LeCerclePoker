// AK multi-Account — mouvements externes du pool (déclarés par Baki ; les règlements
// s'écrivent au markPaid de /payments, jamais ici).
import { NextRequest, NextResponse } from "next/server";
import { listMovements, addDeclaredMovement, deleteDeclaredMovement, setSettlementInstant, addPoolOpenCorrection } from "@/lib/pool/periods";
import { poolNow } from "@/lib/pool/clock";

export async function GET(req: NextRequest) {
  const playerId = Number(req.nextUrl.searchParams.get("player_id"));
  if (!Number.isInteger(playerId) || playerId <= 0) return NextResponse.json({ error: "player_id invalide." }, { status: 400 });
  return NextResponse.json({ ok: true, movements: listMovements(playerId) });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => null);
    // Correction tracée du pool de départ : { player_id, correct_pool_open, note }.
    if (b && Number.isInteger(b.player_id) && typeof b.correct_pool_open === "number") {
      const r = addPoolOpenCorrection({ player_id: b.player_id, new_pool_open: b.correct_pool_open, note: typeof b.note === "string" ? b.note : "" });
      if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
      return NextResponse.json({ ok: true, id: r.id, delta: r.delta });
    }
    if (!b || !Number.isInteger(b.player_id) || (b.direction !== "in" && b.direction !== "out")
        || typeof b.amount !== "number" || typeof b.occurred_at !== "string") {
      return NextResponse.json({ error: "Corps invalide : { player_id, direction: in|out, amount, occurred_at, note? } attendu." }, { status: 400 });
    }
    const r = addDeclaredMovement({ player_id: b.player_id, direction: b.direction, amount: b.amount, occurred_at: b.occurred_at, note: b.note ?? null });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true, id: r.id });
  } catch (e: any) {
    console.error("[AKMULTI_MOVEMENTS_POST]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "id invalide." }, { status: 400 });
  const r = deleteDeclaredMovement(id);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
  return NextResponse.json({ ok: true });
}

/** PATCH { id, occurred_at } → heure exacte déclarée d'un règlement daté au jour. */
export async function PATCH(req: NextRequest) {
  try {
    const b = await req.json().catch(() => null);
    if (!b || !Number.isInteger(b.id) || typeof b.occurred_at !== "string") return NextResponse.json({ error: "Corps invalide : { id, occurred_at } attendu." }, { status: 400 });
    const r = setSettlementInstant(b.id, b.occurred_at, poolNow());
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true, occurred_at: r.occurred_at });
  } catch (e: any) {
    console.error("[AKMULTI_MOVEMENTS_PATCH]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
