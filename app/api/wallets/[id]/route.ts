import { NextRequest, NextResponse } from "next/server";
import { deleteWalletTransaction } from "@/lib/queries";

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteWalletTransaction(Number(id));
  return NextResponse.json({ ok: true });
}
