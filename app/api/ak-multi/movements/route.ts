// AK multi-Account — mouvements externes du pool (déclarés par Baki ; les règlements
// s'écrivent au markPaid de /payments, jamais ici).
import { NextRequest, NextResponse } from "next/server";
import { listMovements, addDeclaredMovement, deleteDeclaredMovement } from "@/lib/pool/periods";

export async function GET(req: NextRequest) {
  const playerId = Number(req.nextUrl.searchParams.get("player_id"));
  if (!Number.isInteger(playerId) || playerId <= 0) return NextResponse.json({ error: "player_id invalide." }, { status: 400 });
  return NextResponse.json({ ok: true, movements: listMovements(playerId) });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => null);
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
