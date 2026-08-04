// Joueurs NEXAPOKER : liste + création manuelle.
// Routes fines (invariant #2) : validation de paramètres, appel lib, réponse.
// Toute la logique (transactions, miroir, rattrapage) est dans
// lib/funnels/nexa/players.ts.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getNexaPlayers, getUnreconciled, createNexaPlayer } from "@/lib/funnels/nexa/players";

export async function GET() {
  try {
    // Liste des joueurs de TOUS les games : le sélecteur « rattacher à un joueur
    // existant » doit pouvoir viser quelqu'un qui n'est pas encore un joueur NEXA.
    const allPlayers = getDb().prepare(
      `SELECT id, name, telegram_handle FROM players ORDER BY name`
    ).all() as { id: number; name: string; telegram_handle: string | null }[];

    return NextResponse.json({
      ok: true,
      players: getNexaPlayers(),
      unreconciled: getUnreconciled(),
      allPlayers,
    });
  } catch (e: any) {
    console.error("[NEXAPOKER_PLAYERS_GET]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => null);
    if (!b || typeof b.nickname !== "string") {
      return NextResponse.json({ error: "Corps invalide : { nickname } attendu." }, { status: 400 });
    }
    const r = createNexaPlayer({
      nickname: b.nickname,
      member_id: b.member_id ?? null,
      telegram_handle: b.telegram_handle ?? null,
      action_pct: typeof b.action_pct === "number" ? b.action_pct : 0,
      action_start_week: b.action_start_week ?? null,
    });
    // Un refus métier (ID déjà pris, pseudo déjà lié) n'est pas une erreur serveur :
    // 409, avec le message tel quel pour l'écran.
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true, player_id: r.player_id, backfilled: r.backfilled });
  } catch (e: any) {
    console.error("[NEXAPOKER_PLAYERS_POST]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
