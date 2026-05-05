"use server";

import {
  computeWeekByDate,
  lockWeek,
  validatePlayer,
  addOverride,
  removeOverride,
  getSettlementTransactions,
  getAvailableTransactions,
  type TxRow,
} from "@/lib/settlement-engine";

export async function runSettlement(weekStart: string, force = false) {
  return computeWeekByDate(weekStart, force);
}

export async function lockWeekAction(weekStart: string) {
  return lockWeek(weekStart);
}

export async function validatePlayerAction(
  playerId: number,
  weekStart: string,
  action: "carry_over" | "manual_close",
  payload?: { amount?: number; note?: string }
) {
  return validatePlayer(playerId, weekStart, action, payload);
}

export async function excludeTransaction(settlementId: number, txId: number, reason?: string) {
  return addOverride(settlementId, txId, "exclude", reason);
}

export async function includeTransaction(settlementId: number, txId: number, reason?: string) {
  return addOverride(settlementId, txId, "include", reason);
}

export async function removeOverrideAction(settlementId: number, txId: number) {
  return removeOverride(settlementId, txId);
}

export async function getTransactionsForSettlement(settlementId: number): Promise<TxRow[]> {
  return getSettlementTransactions(settlementId);
}

export async function getAvailableTransactionsAction(playerId: number, weekStart: string, settlementId: number): Promise<TxRow[]> {
  return getAvailableTransactions(playerId, weekStart, settlementId);
}
