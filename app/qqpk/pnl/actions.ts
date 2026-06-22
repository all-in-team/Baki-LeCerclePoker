"use server";

import { setQqpkMains, previewQqpkSettlement, settleQqpkMonth } from "@/lib/queries";

// Thin wrappers — all money math lives in lib/queries.ts (invariant #2).

export async function saveMainsAction(playerId: number, blockMonth: string, mains: number) {
  return setQqpkMains(playerId, blockMonth, mains);
}

export async function previewSettlementAction(playerId: number, blockMonth: string) {
  return previewQqpkSettlement(playerId, blockMonth);
}

export async function settleMonthAction(playerId: number, blockMonth: string) {
  return settleQqpkMonth(playerId, blockMonth);
}
