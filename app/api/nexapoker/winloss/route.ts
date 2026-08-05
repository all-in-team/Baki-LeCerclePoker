// Win/loss hebdomadaire d'un joueur NEXAPOKER — l'assiette des parts d'action.
//
// `amount: null` DÉ-SAISIT la semaine (elle redevient « non saisie »), il ne met pas
// zéro. Un zéro dirait « le joueur a fini à l'équilibre » ; l'absence dit « je ne sais
// pas encore », et le moteur refuse de calculer une part d'action dessus.
//
// Le report d'affiliation n'écrit jamais dans cette table : la saisie manuelle ne peut
// pas être écrasée par une re-saisie de semaine.
import { NextRequest, NextResponse } from "next/server";
import { setWeeklyWinloss, clearWeeklyWinloss, getNexaPlayerDetail } from "@/lib/funnels/nexa/players";

export async function GET(req: NextRequest) {
  try {
    const raw = req.nextUrl.searchParams.get("player_id");
    const playerId = Number(raw);
    if (!raw || !Number.isInteger(playerId)) {
      return NextResponse.json({ error: "player_id requis." }, { status: 400 });
    }
    const detail = getNexaPlayerDetail(playerId);
    if (!detail) return NextResponse.json({ ok: false, error: `Joueur ${playerId} introuvable.` }, { status: 404 });
    return NextResponse.json({ ok: true, detail });
  } catch (e: any) {
    console.error("[NEXAPOKER_WINLOSS_GET]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => null);
    if (!b || typeof b.player_id !== "number" || typeof b.week_start !== "string"
        || (b.amount !== null && typeof b.amount !== "number")) {
      return NextResponse.json(
        { error: "Corps invalide : { player_id, week_start, amount (number ou null) } attendu." },
        { status: 400 },
      );
    }
    const r = b.amount === null
      ? clearWeeklyWinloss(b.player_id, b.week_start)
      : setWeeklyWinloss({ player_id: b.player_id, week_start: b.week_start, amount: b.amount, note: b.note ?? null });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
    // On renvoie le détail recalculé : l'écran ne doit jamais deviner la part d'action,
    // c'est le moteur qui la donne, rejouée sur toute la chaîne.
    return NextResponse.json({ ok: true, cleared: b.amount === null, detail: getNexaPlayerDetail(b.player_id) });
  } catch (e: any) {
    console.error("[NEXAPOKER_WINLOSS]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
