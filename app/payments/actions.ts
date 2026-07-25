"use server";

import { markPaid, unlockSettlement } from "@/lib/manual-settlement-engine";

/**
 * Payments hub server actions — deliberately as thin as the per-room ones
 * (app/kkpoker/pnl/actions.ts & co, invariant #2): they call the SAME engine
 * functions the rooms call, on the SAME manual_settlements rows.
 *
 * That is what makes the hub and the rooms a single source of truth: there is no
 * hub-side state to keep in sync — paying here IS paying in the room.
 *
 * All room pages are `force-dynamic`, so a payment made here shows up on the next
 * room render with no cache invalidation to orchestrate.
 */

export async function markPaidAction(settlementId: number, txHash?: string, paidDate?: string) {
  return markPaid(settlementId, txHash, paidDate);
}

export async function unlockAction(settlementId: number) {
  return unlockSettlement(settlementId);
}
