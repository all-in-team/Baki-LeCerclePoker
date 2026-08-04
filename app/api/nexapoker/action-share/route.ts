// Part d'action d'un joueur NEXAPOKER — append-only.
// La semaine d'effet est OBLIGATOIRE dans le corps : c'est Hugo qui la choisit à
// chaque édition (défaut proposé par l'écran = lundi de la semaine en cours).
// Le miroir player_game_deals est posé par setActionShare, dans la même
// transaction — voir l'encadré de lib/funnels/nexa/players.ts.
import { NextRequest, NextResponse } from "next/server";
import { setActionShare } from "@/lib/funnels/nexa/players";

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => null);
    if (!b || typeof b.player_id !== "number" || typeof b.pct !== "number" || typeof b.start_week !== "string") {
      return NextResponse.json({ error: "Corps invalide : { player_id, pct, start_week } attendu." }, { status: 400 });
    }
    const r = setActionShare({ player_id: b.player_id, pct: b.pct, start_week: b.start_week, note: b.note ?? null });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true, created: r.created, closed_previous: r.closed_previous });
  } catch (e: any) {
    console.error("[NEXAPOKER_ACTION_SHARE]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
