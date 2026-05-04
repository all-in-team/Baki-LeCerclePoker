import { NextRequest, NextResponse } from "next/server";
import { getWalletMeres, addWalletMere } from "@/lib/queries";

export async function GET() {
  return NextResponse.json({ wallets: getWalletMeres() });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const address = (body.address ?? "").trim();
  const label = (body.label ?? "").trim() || null;

  if (!/^T[a-zA-Z0-9]{33}$/.test(address)) {
    return NextResponse.json({ error: "Adresse TRON invalide (T + 33 caractères)" }, { status: 400 });
  }

  try {
    const wallet = addWalletMere(address, label);
    return NextResponse.json(wallet, { status: 201 });
  } catch (e: any) {
    if (e.message?.includes("UNIQUE")) {
      return NextResponse.json({ error: "Cette adresse existe déjà" }, { status: 409 });
    }
    throw e;
  }
}
