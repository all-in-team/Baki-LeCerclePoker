import { NextRequest, NextResponse } from "next/server";
import { getPlayerGameWallets, setPlayerGameWallets } from "@/lib/queries";
import { WalletAddressError } from "@/lib/wallet-address";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(getPlayerGameWallets(Number(id)));
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  if (!Array.isArray(body.addresses)) {
    return NextResponse.json({ error: "addresses array required" }, { status: 400 });
  }
  const gameId = typeof body.game_id === "number" ? body.game_id : undefined;
  const cleaned = body.addresses
    .filter((a: any) => typeof a === "object" && typeof a.address === "string")
    .map((a: any) => ({ address: a.address.trim(), label: a.label?.trim() || null }))
    .filter((a: any) => a.address.length > 0);
  try {
    setPlayerGameWallets(Number(id), cleaned, gameId);
  } catch (e) {
    // Adresse refusée par la garde : c'est une erreur de saisie, pas une panne.
    // 400 + message exploitable, et AUCUNE adresse n'a été touchée (la garde
    // tourne avant le DELETE du setter).
    if (e instanceof WalletAddressError) {
      return NextResponse.json({ error: e.message, code: e.code, address: e.address }, { status: 400 });
    }
    throw e;
  }
  return NextResponse.json({ ok: true, count: cleaned.length });
}
