"use server";

import { getDb } from "@/lib/db";
import { previewSettlement, lockSettlement, markPaid, unlockSettlement } from "@/lib/manual-settlement-engine";

// Thin server actions — all money math lives in lib/manual-settlement-engine.ts
// (invariant #2). AKS/OK POKER = merged AKS + OKPOKER scope (same club, same
// wallet mère): reads span BOTH game_ids; new settlements are written under the
// CANONICAL game, AKS (first id — all settlement history lives there).
// gameIds resolved server-side, never hardcoded. Mirror of a5nuts/pnl/actions.ts.

function aksOkGameIds(): number[] {
  const db = getDb();
  const ids: number[] = [];
  for (const name of ["AKS", "OKPOKER"]) {
    const row = db.prepare(`SELECT id FROM games WHERE name = ?`).get(name) as { id: number } | undefined;
    if (row) ids.push(row.id);
  }
  if (ids.length === 0) throw new Error("AKS/OKPOKER games not found");
  return ids;
}

export async function previewAction(playerId: number, txIds: number[]) {
  return previewSettlement(aksOkGameIds(), playerId, txIds);
}

export async function lockAction(playerId: number, txIds: number[], notes?: string) {
  return lockSettlement(aksOkGameIds(), playerId, txIds, notes);
}

export async function markPaidAction(settlementId: number, txHash?: string) {
  return markPaid(settlementId, txHash);
}

export async function unlockAction(settlementId: number) {
  return unlockSettlement(settlementId);
}
