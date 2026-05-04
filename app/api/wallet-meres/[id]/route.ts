import { NextRequest, NextResponse } from "next/server";
import { deleteWalletMere } from "@/lib/queries";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return NextResponse.json({ error: "ID invalide" }, { status: 400 });

  const deleted = deleteWalletMere(numId);
  if (!deleted) return NextResponse.json({ error: "Wallet mère introuvable" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
