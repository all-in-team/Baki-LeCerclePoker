import { NextRequest, NextResponse } from "next/server";
import { deletePlayerGameDeal } from "@/lib/queries";
import { getDb } from "@/lib/db";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deletePlayerGameDeal(Number(id));
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { action_pct, rakeback_pct } = await req.json();
  getDb().prepare(`
    UPDATE player_game_deals SET
      action_pct   = COALESCE(?, action_pct),
      rakeback_pct = COALESCE(?, rakeback_pct)
    WHERE id = ?
  `).run(action_pct ?? null, rakeback_pct ?? null, Number(id));
  return NextResponse.json({ ok: true });
}
