// XPoker Twd — ajout manuel d'un joueur. Route fine (invariant #2) : validation,
// appel moteur, réponse. 409 = refus métier avec le message tel quel pour l'écran.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createXpokerPlayerOn } from "@/lib/games/xpoker/engine";

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  if (!b || typeof b.name !== "string") return NextResponse.json({ error: "Corps invalide : { name } attendu." }, { status: 400 });
  const num = (v: unknown) => (v === null || v === undefined || v === "") ? null : Number(v);
  const r = createXpokerPlayerOn(getDb(), {
    name: b.name, telegram_handle: b.telegram_handle ?? null, member_id: b.member_id ?? null, nickname: b.nickname ?? null,
    action_pct: num(b.action_pct), rb_pct: num(b.rb_pct), start_week: b.start_week ?? null,
  });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
  return NextResponse.json({ ok: true, player_id: r.player_id });
}
