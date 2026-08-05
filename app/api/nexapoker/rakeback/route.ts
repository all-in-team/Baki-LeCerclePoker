// Rakeback d'un joueur NEXAPOKER — append-only, même modèle que action-share.
// La semaine d'effet est OBLIGATOIRE dans le corps : c'est Hugo qui la choisit à
// chaque édition (défaut proposé par l'écran = lundi de la semaine en cours).
// Deux champs en plus de la part d'action : `basis` (assiette du %) et
// `makeup_carry` (au changement de base : reporter le makeup, ou le purger).
// Aucun miroir vers player_game_deals — voir setRakebackOn.
import { NextRequest, NextResponse } from "next/server";
import { setRakeback } from "@/lib/funnels/nexa/players";
import type { Basis, MakeupCarry } from "@/lib/funnels/nexa/rakeback-engine";

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => null);
    if (
      !b || typeof b.player_id !== "number" || typeof b.pct !== "number"
      || typeof b.start_week !== "string" || typeof b.basis !== "string"
      || typeof b.makeup_carry !== "string"
    ) {
      return NextResponse.json(
        { error: "Corps invalide : { player_id, pct, basis, makeup_carry, start_week } attendu." },
        { status: 400 },
      );
    }
    // Les valeurs de `basis` / `makeup_carry` sont validées par setRakeback, qui
    // refuse en 409 avec un message affichable — la route reste fine (invariant #2).
    const r = setRakeback({
      player_id: b.player_id,
      pct: b.pct,
      basis: b.basis as Basis,
      makeup_carry: b.makeup_carry as MakeupCarry,
      start_week: b.start_week,
      note: b.note ?? null,
    });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true, created: r.created, closed_previous: r.closed_previous });
  } catch (e: any) {
    console.error("[NEXAPOKER_RAKEBACK]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
