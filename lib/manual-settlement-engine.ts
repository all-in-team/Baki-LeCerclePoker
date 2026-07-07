/**
 * Manual settlement engine — action games (A5POKER / KKPOKER / AKS).
 *
 * Replaces the weekly auto-settlement (lib/settlement-engine.ts, kept read-only) with an
 * explicit, per-game, per-player transaction-SELECTION model:
 *   pick wallet txs → preview the amount due → LOCK the selection → mark PAID.
 *
 * Money math lives HERE (invariant #2 — never in routes/components). Phase 2 = engine only, no UI.
 *
 * Hard money invariants enforced in this file:
 *  - Anti-double-counting: a wallet tx can belong to AT MOST one settlement (guarded on lock).
 *  - Atomic lock: insert ledger row + flag txs in ONE SQL transaction (no half-lock).
 *  - No double payment: markPaid refuses an already-paid settlement.
 *  - No unlock of a paid settlement.
 *  - net is SYMMETRIC: withdrawals add, deposits subtract — wins AND losses treated identically.
 *  - action_pct is FROZEN into action_pct_applied at lock time for traceability.
 *  - source guard (#10): only 'sync' / 'manual' txs are eligible; 'unknown' excluded.
 *  - cross-currency safety (#3): per-tx amounts pass through toUsdt(); a tx with no FX rate
 *    is unconvertible and blocks the lock (action games are USDT, so this never fires in practice).
 *
 * QQPK is NOT concerned here — its monthly staking cycle lives in lib/qqpk-staking-engine.ts
 * and writes to qqpk_staking_blocks, never to manual_settlements.
 */

import { getDb } from "./db";
import { toUsdt, getExchangeRate } from "./queries";

// ── Types ────────────────────────────────────────────────

export interface AvailableTx {
  id: number;
  tx_datetime: string;
  tx_date: string;
  type: "deposit" | "withdrawal";
  amount: number;
  currency: string;
  source: string | null;
  tron_tx_hash: string | null;
}

export interface SettlementPreview {
  ok: boolean;
  error?: string;
  game_id: number;
  player_id: number;
  tx_count: number;
  period_start: string | null;   // earliest selected tx_datetime
  period_end: string | null;     // latest selected tx_datetime
  total_deposited_usdt: number;
  total_withdrawn_usdt: number;
  net_selected_usdt: number;     // Σ withdrawals − Σ deposits (USDT, symmetric)
  action_pct: number;
  amount_due_usdt: number;       // net_selected_usdt × action_pct / 100 (positive = operator owes player)
}

export interface ManualSettlementRow {
  id: number;
  game_id: number;
  player_id: number;
  player_name: string;
  net_selected_usdt: number;
  action_pct_applied: number;
  amount_due_usdt: number;
  status: "locked" | "paid";
  tx_hash: string | null;
  notes: string | null;
  locked_at: string;
  paid_at: string | null;
  created_at: string;
  tx_count: number;
}

interface TxRecord {
  id: number;
  player_id: number;
  game_id: number | null;
  type: "deposit" | "withdrawal";
  amount: number;
  currency: string;
  source: string | null;
  settled: number;
  tx_datetime: string | null;
  tx_date: string;
}

// ── Game scope ───────────────────────────────────────────
// Every entry point accepts a single game_id OR an ordered list of game_ids for merged views
// (A5NUTS = [A5POKER, NUTSPK] — same owner, same wallets, winnings indissociables par game).
// The FIRST id is the CANONICAL game: new manual_settlements rows are written under it.
// Reads (available/preview/history) span the whole scope so no tx or past settlement escapes.

export type GameScope = number | number[];

function scopeIds(scope: GameScope): number[] {
  return Array.isArray(scope) ? scope : [scope];
}

// ── 1) getAvailableTransactions ──────────────────────────
// Player's still-unsettled txs for a game scope (settled=0), real sources only, oldest→newest.

export function getAvailableTransactions(gameId: GameScope, playerId: number): AvailableTx[] {
  const db = getDb();
  const ids = scopeIds(gameId);
  const placeholders = ids.map(() => "?").join(", ");
  return db.prepare(`
    SELECT id, tx_datetime, tx_date, type, amount, currency, source, tron_tx_hash
    FROM wallet_transactions
    WHERE game_id IN (${placeholders})
      AND player_id = ?
      AND settled = 0
      AND source IN ('sync', 'manual')
    ORDER BY COALESCE(tx_datetime, tx_date) ASC, id ASC
  `).all(...ids, playerId) as AvailableTx[];
}

// ── Shared selection loader + validator ──────────────────
// Fetches the exact selected rows and validates ownership/eligibility. Pure read; used by both
// preview and lock so they compute on IDENTICAL data. Returns {error} on any invalid id.

function loadSelection(
  db: ReturnType<typeof getDb>,
  gameIds: number[],
  playerId: number,
  txIds: number[],
): { rows?: TxRecord[]; error?: string } {
  if (!Array.isArray(txIds) || txIds.length === 0) return { error: "Aucune transaction sélectionnée" };
  // de-dup ids defensively
  const ids = [...new Set(txIds)];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, player_id, game_id, type, amount, currency, source, settled, tx_datetime, tx_date
    FROM wallet_transactions
    WHERE id IN (${placeholders})
  `).all(...ids) as TxRecord[];

  if (rows.length !== ids.length) {
    const found = new Set(rows.map(r => r.id));
    const missing = ids.filter(i => !found.has(i));
    return { error: `Transaction(s) introuvable(s): ${missing.join(", ")}` };
  }
  for (const r of rows) {
    if (r.player_id !== playerId || r.game_id === null || !gameIds.includes(r.game_id)) {
      return { error: `Transaction ${r.id} n'appartient pas à ce joueur/game` };
    }
    if (r.source !== "sync" && r.source !== "manual") {
      return { error: `Transaction ${r.id} a une source invalide (${r.source ?? "null"}) — non réglable` };
    }
    if (getExchangeRate(r.currency) === 0) {
      return { error: `Taux de change manquant pour ${r.currency} (tx ${r.id}) — règlement bloqué` };
    }
  }
  return { rows };
}

// Uniform action_pct over the scope: on a merged view (A5NUTS) a player may hold a deal on one
// or both games — net × pct only makes sense with ONE pct, so DIVERGENT deals block the flow
// (gate G1 aligned them in DB; this guard keeps it that way).
function getDealActionPct(
  db: ReturnType<typeof getDb>,
  gameIds: number[],
  playerId: number,
): { pct: number } | { error: string } {
  const placeholders = gameIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT DISTINCT action_pct FROM player_game_deals WHERE player_id = ? AND game_id IN (${placeholders})
  `).all(playerId, ...gameIds) as { action_pct: number }[];
  if (rows.length === 0) return { error: "Aucun deal (action_pct) pour ce joueur sur ce game" };
  if (rows.length > 1) {
    return { error: `Deals divergents (${rows.map(r => r.action_pct + "%").join(" vs ")}) — alignez les deals avant de régler` };
  }
  return { pct: rows[0].action_pct };
}

// Compute net (symmetric) + due from validated rows. No rounding (invariant #9 — round at display).
function computeTotals(rows: TxRecord[], actionPct: number) {
  let deposited = 0;
  let withdrawn = 0;
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  for (const r of rows) {
    const usdt = toUsdt(r.amount, r.currency);
    if (r.type === "withdrawal") withdrawn += usdt;
    else deposited += usdt;
    const stamp = r.tx_datetime ?? r.tx_date;
    if (periodStart === null || stamp < periodStart) periodStart = stamp;
    if (periodEnd === null || stamp > periodEnd) periodEnd = stamp;
  }
  const net = withdrawn - deposited;               // symmetric: wins (+) and losses (−)
  const due = net * actionPct / 100;               // positive = operator owes player
  return { deposited, withdrawn, net, due, periodStart, periodEnd };
}

// ── 2) previewSettlement ─────────────────────────────────
// Pure read — computes the recap for confirmation. Writes nothing.

export function previewSettlement(gameId: GameScope, playerId: number, txIds: number[]): SettlementPreview {
  const db = getDb();
  const ids = scopeIds(gameId);
  const canonicalGameId = ids[0];
  const base: SettlementPreview = {
    ok: false, game_id: canonicalGameId, player_id: playerId, tx_count: 0,
    period_start: null, period_end: null,
    total_deposited_usdt: 0, total_withdrawn_usdt: 0,
    net_selected_usdt: 0, action_pct: 0, amount_due_usdt: 0,
  };

  const sel = loadSelection(db, ids, playerId, txIds);
  if (sel.error || !sel.rows) return { ...base, error: sel.error };

  // Preview surfaces already-settled txs as an error so the user can't build a stale recap.
  const alreadySettled = sel.rows.filter(r => r.settled === 1).map(r => r.id);
  if (alreadySettled.length > 0) {
    return { ...base, error: `Transaction(s) déjà réglée(s): ${alreadySettled.join(", ")}` };
  }

  const deal = getDealActionPct(db, ids, playerId);
  if ("error" in deal) return { ...base, error: deal.error };

  const t = computeTotals(sel.rows, deal.pct);
  return {
    ok: true,
    game_id: canonicalGameId,
    player_id: playerId,
    tx_count: sel.rows.length,
    period_start: t.periodStart,
    period_end: t.periodEnd,
    total_deposited_usdt: t.deposited,
    total_withdrawn_usdt: t.withdrawn,
    net_selected_usdt: t.net,
    action_pct: deal.pct,
    amount_due_usdt: t.due,
  };
}

// ── 3) lockSettlement (ATOMIC) ───────────────────────────
// Anti-double-count guard + single SQL transaction. Either the ledger row is created AND every
// selected tx is flagged, or nothing changes.

export function lockSettlement(
  gameId: GameScope,
  playerId: number,
  txIds: number[],
  notes?: string,
): { ok: boolean; error?: string; settlement_id?: number; amount_due_usdt?: number; net_selected_usdt?: number; action_pct?: number } {
  const db = getDb();
  const gids = scopeIds(gameId);
  // Merged scope (A5NUTS): the ledger row is written under the CANONICAL game (first id).
  const canonicalGameId = gids[0];

  const sel = loadSelection(db, gids, playerId, txIds);
  if (sel.error || !sel.rows) return { ok: false, error: sel.error };

  // Anti-double-count: refuse if ANY selected tx is already settled.
  const already = sel.rows.filter(r => r.settled === 1).map(r => r.id);
  if (already.length > 0) {
    return { ok: false, error: `Refusé — transaction(s) déjà réglée(s): ${already.join(", ")}` };
  }

  const deal = getDealActionPct(db, gids, playerId);
  if ("error" in deal) return { ok: false, error: deal.error };
  const actionPct = deal.pct;

  const ids = [...new Set(txIds)];
  const t = computeTotals(sel.rows, actionPct);

  try {
    const runTx = db.transaction(() => {
      const ins = db.prepare(`
        INSERT INTO manual_settlements
          (game_id, player_id, net_selected_usdt, action_pct_applied, amount_due_usdt, status, notes, locked_at)
        VALUES (@game_id, @player_id, @net, @action_pct, @due, 'locked', @notes, datetime('now'))
      `).run({ game_id: canonicalGameId, player_id: playerId, net: t.net, action_pct: actionPct, due: t.due, notes: notes ?? null });
      const settlementId = Number(ins.lastInsertRowid);

      // Flag ONLY rows still unsettled — settled=0 in the WHERE is a second-line race guard.
      const placeholders = ids.map(() => "?").join(",");
      const upd = db.prepare(`
        UPDATE wallet_transactions
        SET settled = 1, settlement_id = ?
        WHERE id IN (${placeholders}) AND settled = 0
      `).run(settlementId, ...ids);

      // If we didn't flag exactly the selection, something raced/changed → abort the whole tx.
      if (upd.changes !== ids.length) {
        throw new Error(`Lock aborted: flagged ${upd.changes}/${ids.length} txs (concurrent change?)`);
      }
      return settlementId;
    });
    const settlementId = runTx();
    return { ok: true, settlement_id: settlementId, amount_due_usdt: t.due, net_selected_usdt: t.net, action_pct: actionPct };
  } catch (e: any) {
    return { ok: false, error: e.message ?? "Lock failed" };
  }
}

// ── 4) markPaid ──────────────────────────────────────────
// No double payment: refuse if already paid.

export function markPaid(settlementId: number, txHash?: string): { ok: boolean; error?: string } {
  const db = getDb();
  const row = db.prepare(`SELECT id, status FROM manual_settlements WHERE id = ?`).get(settlementId) as { id: number; status: string } | undefined;
  if (!row) return { ok: false, error: "Règlement introuvable" };
  if (row.status === "paid") return { ok: false, error: "Déjà payé — double-paiement refusé" };

  // WHERE status='locked' is the authoritative guard: if a concurrent caller already paid,
  // this flips 0 rows → report failure instead of a spurious ok (belt-and-suspenders).
  const upd = db.prepare(`
    UPDATE manual_settlements SET status = 'paid', paid_at = datetime('now'), tx_hash = ?
    WHERE id = ? AND status = 'locked'
  `).run(txHash ?? null, settlementId);
  if (upd.changes !== 1) return { ok: false, error: "Déjà payé — double-paiement refusé" };
  return { ok: true };
}

// ── 5) unlockSettlement (locked only) ────────────────────
// Reverses a lock while still 'locked'. A paid settlement is immutable.

export function unlockSettlement(settlementId: number): { ok: boolean; error?: string; unflagged?: number } {
  const db = getDb();
  const row = db.prepare(`SELECT id, status FROM manual_settlements WHERE id = ?`).get(settlementId) as { id: number; status: string } | undefined;
  if (!row) return { ok: false, error: "Règlement introuvable" };
  if (row.status === "paid") return { ok: false, error: "Règlement payé — délock interdit" };

  try {
    let unflagged = 0;
    const runTx = db.transaction(() => {
      const upd = db.prepare(`
        UPDATE wallet_transactions SET settled = 0, settlement_id = NULL WHERE settlement_id = ?
      `).run(settlementId);
      unflagged = upd.changes;
      const del = db.prepare(`DELETE FROM manual_settlements WHERE id = ? AND status = 'locked'`).run(settlementId);
      if (del.changes !== 1) throw new Error("Unlock aborted: settlement not in 'locked' state");
    });
    runTx();
    return { ok: true, unflagged };
  } catch (e: any) {
    return { ok: false, error: e.message ?? "Unlock failed" };
  }
}

// ── 6) getManualSettlementHistory ────────────────────────
// All settlements (locked + paid) for a game scope, newest first, with their tx count.
// Merged views pass both game_ids so past settlements of EITHER game count in the history/dû.

export function getManualSettlementHistory(gameId: GameScope): ManualSettlementRow[] {
  const db = getDb();
  const ids = scopeIds(gameId);
  const placeholders = ids.map(() => "?").join(", ");
  return db.prepare(`
    SELECT ms.id, ms.game_id, ms.player_id, p.name AS player_name,
           ms.net_selected_usdt, ms.action_pct_applied, ms.amount_due_usdt,
           ms.status, ms.tx_hash, ms.notes, ms.locked_at, ms.paid_at, ms.created_at,
           (SELECT COUNT(*) FROM wallet_transactions wt WHERE wt.settlement_id = ms.id) AS tx_count
    FROM manual_settlements ms
    JOIN players p ON p.id = ms.player_id
    WHERE ms.game_id IN (${placeholders})
    ORDER BY ms.created_at DESC, ms.id DESC
  `).all(...ids) as ManualSettlementRow[];
}
