import { NextRequest, NextResponse } from "next/server";
import { deletePlayerGameDeal } from "@/lib/queries";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deletePlayerGameDeal(Number(id));
  return NextResponse.json({ ok: true });
}
