"use server";

import { getDb } from "@/lib/db";
import { previewSettlement, lockSettlement, markPaid, unlockSettlement } from "@/lib/manual-settlement-engine";

// Thin server actions — all money math lives in lib/manual-settlement-engine.ts
// (invariant #2). A5NUTS = merged A5POKER + NUTSPK scope (same owner, same wallets):
// reads span BOTH game_ids; new settlements are written under the CANONICAL game,
// A5POKER (first id). gameIds resolved server-side, never hardcoded.

function a5nutsGameIds(): number[] {
  const db = getDb();
  const ids: number[] = [];
  for (const name of ["A5POKER", "NUTSPK"]) {
    const row = db.prepare(`SELECT id FROM games WHERE name = ?`).get(name) as { id: number } | undefined;
    if (row) ids.push(row.id);
  }
  if (ids.length === 0) throw new Error("A5POKER/NUTSPK games not found");
  return ids;
}

export async function previewAction(playerId: number, txIds: number[]) {
  return previewSettlement(a5nutsGameIds(), playerId, txIds);
}

export async function lockAction(playerId: number, txIds: number[], notes?: string) {
  return lockSettlement(a5nutsGameIds(), playerId, txIds, notes);
}

export async function markPaidAction(settlementId: number, txHash?: string) {
  return markPaid(settlementId, txHash);
}

export async function unlockAction(settlementId: number) {
  return unlockSettlement(settlementId);
}

export async function updateActionPctAction(playerId: number, oldPct: number, newPct: number) {
  const { updateDealActionPct } = await import("@/lib/deal-edit");
  return updateDealActionPct(playerId, ["A5POKER", "NUTSPK"], "A5NUTS", oldPct, newPct);
}
