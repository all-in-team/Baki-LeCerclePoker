import { NextRequest, NextResponse } from "next/server";
import { deleteAssignment } from "@/lib/queries";

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteAssignment(Number(id));
  return NextResponse.json({ ok: true });
}
