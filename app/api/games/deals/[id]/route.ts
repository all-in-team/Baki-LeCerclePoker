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
  const body = await req.json();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.action_pct !== undefined) { sets.push("action_pct = ?"); vals.push(body.action_pct); }
  if (body.rakeback_pct !== undefined) { sets.push("rakeback_pct = ?"); vals.push(body.rakeback_pct); }
  if ("start_date" in body) { sets.push("start_date = ?"); vals.push(body.start_date ?? null); }
  if (sets.length === 0) return NextResponse.json({ ok: true });
  vals.push(Number(id));
  getDb().prepare(`UPDATE player_game_deals SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return NextResponse.json({ ok: true });
}
