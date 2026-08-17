import { NextRequest, NextResponse } from "next/server";
import { getSettlementCoveredTransactions } from "@/lib/queries";

// Transactions couvertes par un règlement — LECTURE SEULE.
//
// Chargées à la demande, au dépliage d'une ligne sur /payments : l'historique
// compte ~157 règlements, les précharger toutes pour n'en ouvrir qu'une ferait
// payer à chaque rendu de page un travail que personne ne regarde.
//
// GET uniquement : ce fichier n'exporte aucun POST/PUT/DELETE, la route ne peut
// rien muter.

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("settlement_id");
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "settlement_id requis" }, { status: 400 });
  }
  return NextResponse.json({ settlement_id: id, transactions: getSettlementCoveredTransactions(id) });
}
