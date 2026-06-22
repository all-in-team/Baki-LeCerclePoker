"use server";

import { setQqpkMains, previewQqpkSettlement, settleQqpkCycle } from "@/lib/queries";

// Thin wrappers — all money math lives in lib/queries.ts (invariant #2).
// Cycle is per-player and resolved server-side (active = earliest unsettled rolling cycle).

export async function saveMainsAction(playerId: number, mains: number) {
  return setQqpkMains(playerId, mains);
}

export async function previewSettlementAction(playerId: number) {
  return previewQqpkSettlement(playerId);
}

export async function settleCycleAction(playerId: number) {
  return settleQqpkCycle(playerId);
}
