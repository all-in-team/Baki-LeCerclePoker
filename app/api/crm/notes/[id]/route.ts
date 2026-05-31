import { NextRequest, NextResponse } from "next/server";
import { deleteCrmNote } from "@/lib/queries";

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteCrmNote(Number(id));
  return NextResponse.json({ ok: true });
}
