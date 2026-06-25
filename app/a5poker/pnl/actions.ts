"use server";

import { getDb } from "@/lib/db";
import {
  getAvailableTransactions, previewSettlement, lockSettlement,
  markPaid, unlockSettlement, getManualSettlementHistory,
} from "@/lib/manual-settlement-engine";

// Thin server actions — all money math lives in lib/manual-settlement-engine.ts (invariant #2).
// A5POKER only (Phase 3). gameId resolved server-side, never hardcoded.

function a5GameId(): number {
  const row = getDb().prepare(`SELECT id FROM games WHERE name = 'A5POKER'`).get() as { id: number } | undefined;
  if (!row) throw new Error("A5POKER game not found");
  return row.id;
}

export async function getAvailableAction(playerId: number) {
  return getAvailableTransactions(a5GameId(), playerId);
}

export async function previewAction(playerId: number, txIds: number[]) {
  return previewSettlement(a5GameId(), playerId, txIds);
}

export async function lockAction(playerId: number, txIds: number[], notes?: string) {
  return lockSettlement(a5GameId(), playerId, txIds, notes);
}

export async function markPaidAction(settlementId: number, txHash?: string) {
  return markPaid(settlementId, txHash);
}

export async function unlockAction(settlementId: number) {
  return unlockSettlement(settlementId);
}

export async function historyAction() {
  return getManualSettlementHistory(a5GameId());
}
