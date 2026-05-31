import { NextRequest, NextResponse } from "next/server";
import { listAllWalletMeres, addWalletMere, retireWalletMere } from "@/lib/queries";

export async function GET() {
  return NextResponse.json({ wallets: listAllWalletMeres() });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const address = (body.address ?? "").trim();
  const label = (body.label ?? "").trim() || null;
  const gameId = body.game_id as number | undefined;

  if (!/^T[a-zA-Z0-9]{33}$/.test(address)) {
    return NextResponse.json({ error: "Adresse TRON invalide (T + 33 caractères)" }, { status: 400 });
  }
  if (!gameId) {
    return NextResponse.json({ error: "game_id is required" }, { status: 400 });
  }

  try {
    const wallet = addWalletMere(address, label, gameId);
    return NextResponse.json(wallet, { status: 201 });
  } catch (e: any) {
    if (e.message?.includes("UNIQUE")) {
      return NextResponse.json({ error: "Cette adresse existe déjà" }, { status: 409 });
    }
    throw e;
  }
}

export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { id, action } = body;
  if (action === "retire" && id) {
    const ok = retireWalletMere(id);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found or already retired" }, { status: 404 });
  }
  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
