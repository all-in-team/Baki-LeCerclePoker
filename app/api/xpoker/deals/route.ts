// XPoker Twd — deal du joueur (action %, RB %), versionné par semaine d'effet.
// Route fine (invariant #2). La garde F2 (jamais sur une semaine importée) et
// l'unité (POURCENT, ]0,1[ refusé) vivent dans setDealOn ; le refus rend
// blocking_weeks pour l'écran.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { setDealOn, dealHistoryOn } from "@/lib/games/xpoker/engine";

export async function GET(req: NextRequest) {
  const pid = Number(req.nextUrl.searchParams.get("player_id"));
  if (!pid) return NextResponse.json({ error: "player_id requis" }, { status: 400 });
  return NextResponse.json({ ok: true, history: dealHistoryOn(getDb(), pid) });
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  if (!b || !b.player_id || typeof b.start_week !== "string") return NextResponse.json({ error: "player_id, action_pct, rb_pct, start_week requis" }, { status: 400 });
  const r = setDealOn(getDb(), { player_id: Number(b.player_id), action_pct: Number(b.action_pct), rb_pct: Number(b.rb_pct ?? 0), start_week: b.start_week, note: b.note ?? null });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, blocking_weeks: r.blocking_weeks ?? [] }, { status: 409 });
  return NextResponse.json({ ok: true, history: dealHistoryOn(getDb(), Number(b.player_id)) });
}
