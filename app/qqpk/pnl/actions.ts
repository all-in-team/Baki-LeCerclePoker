"use server";

import { setQqpkMains, setQqpkCycleRakeback, previewQqpkSettlement, settleQqpkCycle } from "@/lib/queries";

// Thin wrappers — all money math lives in lib/queries.ts (invariant #2).
// Cycle is per-player and resolved server-side (active = earliest unsettled rolling cycle).

export async function saveMainsAction(playerId: number, mains: number) {
  return setQqpkMains(playerId, mains);
}

// RB manuel (owner-only, hors deal, invisible joueur) — upsert sur le cycle actif.
// AUCUN message envoyé, aucun impact settlement/lock.
export async function saveCycleRakebackAction(playerId: number, amount: number) {
  return setQqpkCycleRakeback(playerId, amount);
}

export async function previewSettlementAction(playerId: number) {
  return previewQqpkSettlement(playerId);
}

export async function settleCycleAction(playerId: number) {
  return settleQqpkCycle(playerId);
}
