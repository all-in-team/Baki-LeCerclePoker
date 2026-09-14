// AK multi-Account — comptes d'un joueur (N variable, soft-close).
// GET ?player_id → comptes ouverts et clos · POST → ajouter · DELETE ?id → clore (refus si solde figé ≠ 0).
import { NextRequest, NextResponse } from "next/server";
import { listAccounts, addAccount, closeAccount } from "@/lib/pool/periods";

export async function GET(req: NextRequest) {
  const playerId = Number(req.nextUrl.searchParams.get("player_id"));
  if (!Number.isInteger(playerId) || playerId <= 0) return NextResponse.json({ error: "player_id invalide." }, { status: 400 });
  return NextResponse.json({ ok: true, accounts: listAccounts(playerId, true) });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => null);
    if (!b || !Number.isInteger(b.player_id)) return NextResponse.json({ error: "player_id attendu." }, { status: 400 });
    const r = addAccount({
      player_id: b.player_id,
      label: typeof b.label === "string" ? b.label : null,
      ak_ref: typeof b.ak_ref === "string" && b.ak_ref.trim() ? b.ak_ref.trim() : null,
      okpay_tg_id: typeof b.okpay_tg_id === "string" && b.okpay_tg_id.trim() ? b.okpay_tg_id.trim() : null,
    });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true, id: r.id, label: r.label });
  } catch (e: any) {
    console.error("[AKMULTI_ACCOUNTS_POST]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "id invalide." }, { status: 400 });
  const r = closeAccount(id);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
  return NextResponse.json({ ok: true });
}
