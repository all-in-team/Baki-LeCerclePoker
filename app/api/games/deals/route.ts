import { NextRequest, NextResponse } from "next/server";
import { getPlayerGameDeals, upsertPlayerGameDeal } from "@/lib/queries";
import { getDb } from "@/lib/db";
import { isNexaGameId, NEXA_DEAL_GUARD_MESSAGE } from "@/lib/deal-edit";

export async function GET(req: NextRequest) {
  const player_id = req.nextUrl.searchParams.get("player_id");
  if (!player_id) return NextResponse.json({ error: "player_id required" }, { status: 400 });
  return NextResponse.json(getPlayerGameDeals(Number(player_id)));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.player_id || !body.game_id || body.action_pct === undefined || body.rakeback_pct === undefined)
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });

  const playerId = Number(body.player_id);
  const gameId = Number(body.game_id);

  // Un upsert ici écraserait le cache d'action NEXA sans toucher l'historique :
  // le miroir mentirait dès la première divergence.
  if (isNexaGameId(gameId)) {
    return NextResponse.json({ error: NEXA_DEAL_GUARD_MESSAGE }, { status: 409 });
  }

  const id = upsertPlayerGameDeal({
    player_id: playerId,
    game_id: gameId,
    action_pct: Number(body.action_pct),
    rakeback_pct: Number(body.rakeback_pct),
    // Symétrique de end_date juste en dessous, et ce n'est pas cosmétique.
    // `body.start_date || null` ne rend JAMAIS undefined : un POST sans start_date
    // l'EFFAÇAIT. Or PlayerEditModal re-POSTe chaque deal coché à chaque sauvegarde
    // de la fiche — corriger un numéro de téléphone effaçait donc start_date sur
    // toutes les games ouvertes du joueur. Cette borne conditionne
    // `pgd.start_date IS NULL OR wt.tx_datetime >= pgd.start_date` dans une quinzaine
    // de requêtes d'argent (soldes, KPI, séries) et l'ancre de cycle QQPK.
    start_date: body.start_date !== undefined ? (body.start_date || null) : undefined,
    end_date: body.end_date !== undefined ? (body.end_date || null) : undefined,
  });

  // Set origin_game_id on affiliate relationship if still NULL (first deal)
  const db = getDb();
  const pendingRel = db.prepare(
    `SELECT id FROM affiliate_relationships WHERE referred_player_id = ? AND origin_game_id IS NULL`
  ).get(playerId) as { id: number } | undefined;

  if (pendingRel) {
    db.prepare(`UPDATE affiliate_relationships SET origin_game_id = ? WHERE id = ?`).run(gameId, pendingRel.id);
    console.log(`[AFFILIATE] origin_game_id set to ${gameId} for relationship ${pendingRel.id}`);
  }

  return NextResponse.json({ id }, { status: 201 });
}
