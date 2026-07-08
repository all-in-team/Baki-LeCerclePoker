"use server";

import { getDb } from "@/lib/db";
import { previewSettlement, lockSettlement, markPaid, unlockSettlement } from "@/lib/manual-settlement-engine";

// Thin server actions — all money math lives in lib/manual-settlement-engine.ts
// (invariant #2). Mirror of app/aks/pnl/actions.ts for TTPOKER.
// gameId resolved server-side, never hardcoded.

function ttpokerGameId(): number {
  const row = getDb().prepare(`SELECT id FROM games WHERE name = 'TTPOKER'`).get() as { id: number } | undefined;
  if (!row) throw new Error("TTPOKER game not found");
  return row.id;
}

export async function previewAction(playerId: number, txIds: number[]) {
  return previewSettlement(ttpokerGameId(), playerId, txIds);
}

export async function lockAction(playerId: number, txIds: number[], notes?: string) {
  return lockSettlement(ttpokerGameId(), playerId, txIds, notes);
}

export async function markPaidAction(settlementId: number, txHash?: string) {
  return markPaid(settlementId, txHash);
}

export async function unlockAction(settlementId: number) {
  return unlockSettlement(settlementId);
}
