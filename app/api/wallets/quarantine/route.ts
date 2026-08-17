import { NextRequest, NextResponse } from "next/server";
import {
  getQuarantinedTransactions,
  countQuarantinedTransactions,
  arbitrateQuarantinedTransaction,
  getQuarantineArbitrationBlocker,
} from "@/lib/queries";

// Arbitrage des mouvements wallet mis en quarantaine par le sync (montant au-delà
// du seuil de vraisemblance, cf. PLAUSIBILITY_THRESHOLD_USDT). Tant qu'une ligne
// est ici, elle n'entre dans AUCUN solde ni règlement.
//
// Route fine : validation de paramètre + appel DB, la règle vit dans queries.ts
// (invariant #2).

export async function GET() {
  return NextResponse.json({
    count: countQuarantinedTransactions(),
    transactions: getQuarantinedTransactions(),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  const decision = body.decision;

  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "id requis" }, { status: 400 });
  }
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json({ error: "decision doit valoir 'approve' ou 'reject'" }, { status: 400 });
  }

  const changes = arbitrateQuarantinedTransaction(id, decision);
  if (changes === 0) {
    // Le UPDATE porte `status='quarantined'` sur les deux décisions, et
    // `settled=0` sur le seul rejet. Sans distinction, un refus pour cause de
    // ligne déjà réglée s'afficherait « déjà arbitrée » — Baki chercherait un
    // arbitrage qui n'a jamais eu lieu. On relit la ligne, avec la décision
    // demandée, pour dire laquelle des conditions a bloqué.
    const row = getQuarantineArbitrationBlocker(id, decision);
    return NextResponse.json({ error: row }, { status: 409 });
  }

  return NextResponse.json({
    ok: true,
    id,
    decision,
    status: decision === "approve" ? "active" : "rejected",
    remaining: countQuarantinedTransactions(),
  });
}
