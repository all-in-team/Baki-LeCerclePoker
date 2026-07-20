"use server";

import { getDb } from "@/lib/db";
import { previewSettlement, lockSettlement, markPaid, unlockSettlement, resolveSelectionScope } from "@/lib/manual-settlement-engine";

// Thin server actions — all money math lives in lib/manual-settlement-engine.ts
// (invariant #2). A5NUTS = merged A5POKER + NUTSPK scope (same owner, same wallets):
// reads span BOTH game_ids; new settlements are written under the CANONICAL game,
// A5POKER (first id). gameIds resolved server-side, never hardcoded.

// Deux buckets de règlement INDÉPENDANTS (Hugo 2026-07-20) : A5/NUTS (canonique A5POKER,
// % A5) et WN (% WN). Le scope d'un règlement = le bucket des tx sélectionnées ; une
// sélection mixte est refusée par resolveSelectionScope (jamais de % moyen).
function gameIdsByNames(names: string[]): number[] {
  const db = getDb();
  const ids: number[] = [];
  for (const name of names) {
    const row = db.prepare(`SELECT id FROM games WHERE name = ?`).get(name) as { id: number } | undefined;
    if (row) ids.push(row.id);
  }
  return ids;
}

function settleBuckets(): number[][] {
  const a5nuts = gameIdsByNames(["A5POKER", "NUTSPK"]);
  if (a5nuts.length === 0) throw new Error("A5POKER/NUTSPK games not found");
  const wn = gameIdsByNames(["WN"]);
  return wn.length ? [a5nuts, wn] : [a5nuts];
}

export async function previewAction(playerId: number, txIds: number[]) {
  const r = resolveSelectionScope(txIds, settleBuckets());
  if ("error" in r) return { ok: false as const, error: r.error, game_id: 0, player_id: playerId, tx_count: 0, period_start: null, period_end: null, total_deposited_usdt: 0, total_withdrawn_usdt: 0, net_selected_usdt: 0, action_pct: 0, amount_due_usdt: 0 };
  return previewSettlement(r.scope, playerId, txIds);
}

export async function lockAction(playerId: number, txIds: number[], notes?: string) {
  const r = resolveSelectionScope(txIds, settleBuckets());
  if ("error" in r) return { ok: false, error: r.error };
  return lockSettlement(r.scope, playerId, txIds, notes);
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

// % WN indépendant (jamais aligné sur A5/NUTS — decision Hugo 2026-07-20).
export async function updateWnActionPctAction(playerId: number, oldPct: number, newPct: number) {
  const { updateDealActionPct } = await import("@/lib/deal-edit");
  return updateDealActionPct(playerId, ["WN"], "WN", oldPct, newPct);
}
