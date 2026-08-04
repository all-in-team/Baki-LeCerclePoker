// Rattache une ligne du report à un joueur EXISTANT, sur action explicite.
// Rien ne se rattache par approximation : le hint affiché à l'écran vient de
// resolveRows et n'est jamais appliqué seul.
// Le rattachement rattrape tout l'historique déjà saisi (backfilled).
import { NextRequest, NextResponse } from "next/server";
import { linkRowToPlayer } from "@/lib/funnels/nexa/players";

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => null);
    if (!b || typeof b.player_id !== "number" || typeof b.nickname !== "string") {
      return NextResponse.json({ error: "Corps invalide : { player_id, nickname } attendu." }, { status: 400 });
    }
    const r = linkRowToPlayer({ player_id: b.player_id, member_id: b.member_id ?? null, nickname: b.nickname });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true, backfilled: r.backfilled });
  } catch (e: any) {
    console.error("[NEXAPOKER_LINK]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
