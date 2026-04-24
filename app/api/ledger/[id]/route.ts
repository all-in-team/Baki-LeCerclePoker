import { NextRequest, NextResponse } from "next/server";
import { deleteTransaction } from "@/lib/queries";

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteTransaction(Number(id));
  return NextResponse.json({ ok: true });
}
