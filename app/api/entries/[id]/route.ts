import { NextRequest, NextResponse } from "next/server";
import { deleteEntry } from "@/lib/queries";

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteEntry(Number(id));
  return NextResponse.json({ ok: true });
}
