// Buy-in / cash-out manuels NEXAPOKER.
// Route fine (invariant #2) : validation de paramètres, appel lib, réponse.
// L'écriture passe par addMovement → insertWalletTransaction (source='manual'),
// seul chemin d'écriture manuelle de wallet_transactions du repo.
import { NextRequest, NextResponse } from "next/server";
import { addMovement, getMovements, deleteMovement } from "@/lib/funnels/nexa/players";

export async function GET(req: NextRequest) {
  try {
    const pid = Number(req.nextUrl.searchParams.get("player_id"));
    if (!Number.isInteger(pid) || pid <= 0) {
      return NextResponse.json({ error: "player_id manquant ou invalide." }, { status: 400 });
    }
    return NextResponse.json({ ok: true, movements: getMovements(pid) });
  } catch (e: any) {
    console.error("[NEXAPOKER_MOVEMENTS_GET]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => null);
    if (!b || typeof b.player_id !== "number" || typeof b.amount !== "number" || typeof b.tx_date !== "string") {
      return NextResponse.json({ error: "Corps invalide : { player_id, kind, amount, tx_date } attendu." }, { status: 400 });
    }
    const r = addMovement({ player_id: b.player_id, kind: b.kind, amount: b.amount, tx_date: b.tx_date, note: b.note ?? null });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true, id: r.id });
  } catch (e: any) {
    console.error("[NEXAPOKER_MOVEMENTS_POST]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = Number(req.nextUrl.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "id manquant ou invalide." }, { status: 400 });
    }
    const r = deleteMovement(id);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[NEXAPOKER_MOVEMENTS_DELETE]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
