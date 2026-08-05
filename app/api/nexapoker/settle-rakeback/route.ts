// Règlement du RAKEBACK NEXAPOKER.
//
// GET  → ce qui est réglable et ce qu'il faut avoir vu avant (avertissements).
// POST → verrouille, et REFUSE tant que les avertissements ne sont pas confirmés.
//
// Route mince (invariant #2) : validation des paramètres, appel au module, réponse.
// Tout le calcul — et le recalcul au verrouillage — vit dans
// lib/funnels/nexa/rakeback-settlement.ts.
import { NextRequest, NextResponse } from "next/server";
import {
  getOpenRbWeeks, getBlockingWeekOn, getRbSettlementWarningsOn, lockNexaRakebackSettlement,
} from "@/lib/funnels/nexa/rakeback-settlement";
import { getDb } from "@/lib/db";

export async function GET(req: NextRequest) {
  try {
    const raw = req.nextUrl.searchParams.get("player_id");
    const playerId = Number(raw);
    if (!raw || !Number.isInteger(playerId)) {
      return NextResponse.json({ error: "player_id requis." }, { status: 400 });
    }
    const open = getOpenRbWeeks(playerId);
    // Les avertissements sont calculés sur la plage MAXIMALE proposée : l'écran
    // doit pouvoir les montrer avant même que Baki ait choisi jusqu'où régler.
    const through = open.length > 0 ? open[open.length - 1].week_start : null;
    const warnings = through ? getRbSettlementWarningsOn(getDb(), playerId, through) : [];
    // Le plafond n'est pas un avertissement : c'est une information permanente,
    // l'écran doit pouvoir dire POURQUOI il ne propose pas d'aller plus loin.
    return NextResponse.json({
      ok: true, weeks: open, warnings,
      blocking_week: getBlockingWeekOn(getDb(), playerId),
    });
  } catch (e: any) {
    console.error("[NEXAPOKER_SETTLE_RB_GET]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => null);
    if (!b || typeof b.player_id !== "number" || typeof b.through_week !== "string") {
      return NextResponse.json(
        { error: "Corps invalide : { player_id, through_week, acknowledge_warnings? } attendu." },
        { status: 400 },
      );
    }
    const r = lockNexaRakebackSettlement({
      player_id: b.player_id,
      through_week: b.through_week,
      acknowledge_warnings: b.acknowledge_warnings === true,
      notes: b.notes ?? null,
    });
    // 409 et non 500 : un refus pour avertissements non confirmés est une réponse
    // NORMALE du domaine, pas une panne. L'écran doit pouvoir les afficher.
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error, warnings: r.warnings ?? [] }, { status: 409 });
    return NextResponse.json(r);
  } catch (e: any) {
    console.error("[NEXAPOKER_SETTLE_RB]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
