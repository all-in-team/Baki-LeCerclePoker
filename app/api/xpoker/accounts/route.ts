// XPoker Twd — comptes (Player ID) : rattacher, archiver, DÉPLACER (R1).
// Route fine (invariant #2). Toute garde vit dans lib/games/xpoker/engine.ts.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { linkMemberIdOn, archiveAccountOn, relinkMemberIdOn } from "@/lib/games/xpoker/engine";

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  if (!b || typeof b.action !== "string") return NextResponse.json({ error: "Corps invalide : { action } attendu." }, { status: 400 });
  const db = getDb();
  if (b.action === "link") {
    if (!b.player_id || !b.member_id) return NextResponse.json({ error: "player_id et member_id requis" }, { status: 400 });
    const r = linkMemberIdOn(db, { player_id: Number(b.player_id), member_id: String(b.member_id), nickname: b.nickname ?? null });
    return r.ok ? NextResponse.json(r) : NextResponse.json({ ok: false, error: r.error }, { status: 409 });
  }
  if (b.action === "archive") {
    if (!b.account_id || !b.player_id) return NextResponse.json({ error: "account_id et player_id requis" }, { status: 400 });
    const r = archiveAccountOn(db, Number(b.account_id), Number(b.player_id));
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false, error: r.error }, { status: 409 });
  }
  if (b.action === "relink") {
    if (!b.member_id || !b.to_player_id) return NextResponse.json({ error: "member_id et to_player_id requis" }, { status: 400 });
    // Jamais silencieux : un motif est demandé, et le refus (semaine réglée) rend la liste.
    const r = relinkMemberIdOn(db, { member_id: String(b.member_id), to_player_id: Number(b.to_player_id), reason: b.reason ?? null });
    return r.ok ? NextResponse.json(r) : NextResponse.json({ ok: false, error: r.error, blocking: r.blocking ?? [] }, { status: 409 });
  }
  return NextResponse.json({ error: `action inconnue : ${b.action}` }, { status: 400 });
}
