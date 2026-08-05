// Règlement de la part d'action NEXAPOKER.
//
// GET  → les semaines réglables aujourd'hui pour un joueur.
// POST → verrouille le règlement des semaines demandées.
//
// Le corps ne porte QUE des semaines, jamais un montant : le montant est recalculé
// par le moteur dans la transaction de lock. Ce que l'écran affichait a pu être
// calculé sur un report modifié depuis.
import { NextRequest, NextResponse } from "next/server";
import {
  getSettleableActionWeeks, lockNexaActionSettlement,
} from "@/lib/funnels/nexa/action-settlement";
import { getNexaPlayerDetail } from "@/lib/funnels/nexa/players";

export async function GET(req: NextRequest) {
  try {
    const raw = req.nextUrl.searchParams.get("player_id");
    const playerId = Number(raw);
    if (!raw || !Number.isInteger(playerId)) {
      return NextResponse.json({ error: "player_id requis." }, { status: 400 });
    }
    return NextResponse.json({ ok: true, weeks: getSettleableActionWeeks(playerId) });
  } catch (e: any) {
    console.error("[NEXAPOKER_SETTLE_ACTION_GET]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => null);
    if (!b || typeof b.player_id !== "number" || !Array.isArray(b.week_starts)
        || b.week_starts.some((w: unknown) => typeof w !== "string")) {
      return NextResponse.json(
        { error: "Corps invalide : { player_id, week_starts: string[], acknowledge_warnings? } attendu." },
        { status: 400 },
      );
    }
    const r = lockNexaActionSettlement({
      player_id: b.player_id, week_starts: b.week_starts,
      acknowledge_warnings: b.acknowledge_warnings === true,
      notes: b.notes ?? null,
    });
    // Les avertissements accompagnent le refus : l'écran doit pouvoir les montrer
    // et proposer la confirmation, pas seulement afficher « refusé ».
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: r.error, warnings: r.warnings ?? [] }, { status: 409 });
    }
    return NextResponse.json({
      ok: true,
      settlement_id: r.settlement_id,
      amount_due_usdt: r.amount_due_usdt,
      weeks: r.weeks,
      warnings: r.warnings,
      detail: getNexaPlayerDetail(b.player_id),
    });
  } catch (e: any) {
    console.error("[NEXAPOKER_SETTLE_ACTION]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
