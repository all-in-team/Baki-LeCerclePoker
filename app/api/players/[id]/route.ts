import { NextRequest, NextResponse } from "next/server";
import { updatePlayer, deletePlayer } from "@/lib/queries";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  updatePlayer(Number(id), body);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    deletePlayer(Number(id));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    // Money-history guard or FK failure — surface the reason instead of a silent 500
    // (the CRM used to swallow it and the player "reappeared" on refresh).
    return NextResponse.json({ error: e.message }, { status: 409 });
  }
}
