// XPoker Twd — deal du joueur (action %, RB %), versionné par semaine d'effet.
// Route fine (invariant #2). La garde F2 recalibrée (figé = semaine RÉGLÉE, pas
// importée), l'aperçu avant/après d'un changement rétroactif, la trace automatique
// et l'unité (POURCENT, ]0,1[ refusé) vivent dans setDealOn. Trois réponses :
//   200 ok · 409 needs_confirmation (aperçu, rien écrit) · 409 refus (settled_weeks).
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
  const r = setDealOn(getDb(), {
    player_id: Number(b.player_id), action_pct: Number(b.action_pct), rb_pct: Number(b.rb_pct ?? 0), start_week: b.start_week,
    note: b.note ?? null, confirm_retroactive: b.confirm_retroactive === true,
  });
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: r.error, needs_confirmation: r.needs_confirmation === true, preview: r.preview ?? null, settled_weeks: r.settled_weeks ?? [] }, { status: 409 });
  }
  return NextResponse.json({ ok: true, retroactive: r.retroactive === true, history: dealHistoryOn(getDb(), Number(b.player_id)) });
}
