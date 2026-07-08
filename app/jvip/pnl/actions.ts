"use server";

import { getDb } from "@/lib/db";
import { previewSettlement, lockSettlement, markPaid, unlockSettlement } from "@/lib/manual-settlement-engine";

// Thin server actions — all money math lives in lib/manual-settlement-engine.ts
// (invariant #2). Mirror of app/aks/pnl/actions.ts for JVIP.
// gameId resolved server-side, never hardcoded.

function jvipGameId(): number {
  const row = getDb().prepare(`SELECT id FROM games WHERE name = 'JVIP'`).get() as { id: number } | undefined;
  if (!row) throw new Error("JVIP game not found");
  return row.id;
}

export async function previewAction(playerId: number, txIds: number[]) {
  return previewSettlement(jvipGameId(), playerId, txIds);
}

export async function lockAction(playerId: number, txIds: number[], notes?: string) {
  return lockSettlement(jvipGameId(), playerId, txIds, notes);
}

export async function markPaidAction(settlementId: number, txHash?: string) {
  return markPaid(settlementId, txHash);
}

export async function unlockAction(settlementId: number) {
  return unlockSettlement(settlementId);
}

export async function updateActionPctAction(playerId: number, oldPct: number, newPct: number) {
  const { updateDealActionPct } = await import("@/lib/deal-edit");
  return updateDealActionPct(playerId, ["JVIP"], "JVIP", oldPct, newPct);
}
