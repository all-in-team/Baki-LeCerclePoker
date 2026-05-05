/**
 * Settlement engine — weekly P&L computation and lock management.
 * Supports per-player transaction overrides (include/exclude).
 * Math lives here (parallel to queries.ts for settlement-specific logic).
 */

import { getDb } from "./db";
import { getWeekBounds, toUTCISO, toParisDate } from "./date-utils";

// ── Types ────────────────────────────────────────────────

export interface SettlementRow {
  id: number;
  week_start: string;
  player_id: number;
  player_name: string;
  status: "auto_settled" | "pending_manual" | "carry_over" | "settled" | "conflict";
  pnl_player: number | null;
  pnl_operator: number | null;
  action_pct_snapshot: number | null;
  lock_anchor_tx_id: number | null;
  lock_anchor_datetime: string | null;
  locked_at: string | null;
  locked_by: string | null;
  manual_close_amount: number | null;
  note: string | null;
  override_count: number;
}

export interface PeriodRow {
  id: number;
  week_start: string;
  week_end: string;
  status: "open" | "computed" | "locked";
  computed_at: string | null;
  locked_at: string | null;
}

export interface ComputeResult {
  week_start: string;
  week_end: string;
  total_players: number;
  auto_settled: number;
  pending_manual: number;
  period_locked: boolean;
  overrides_deleted: number;
}

export interface TxRow {
  id: number;
  tx_datetime: string;
  type: "deposit" | "withdrawal";
  amount: number;
  source: string | null;
  tron_tx_hash: string | null;
  is_override: boolean;
  override_action?: "include";
}

// ── computeWeek ──────────────────────────────────────────

export function computeWeek(weekOffset: number): ComputeResult {
  const { start, end } = getWeekBounds(weekOffset);
  const startISO = toUTCISO(start);
  const endISO = toUTCISO(end);
  const weekStart = toParisDate(startISO);
  const weekEnd = toParisDate(endISO);
  return _computeWeekInternal(weekStart, weekEnd, startISO, endISO);
}

export function computeWeekByDate(weekStartDate: string, force = false): ComputeResult & { needs_confirm?: boolean; override_count?: number } {
  const target = new Date(weekStartDate + "T00:00:00Z");
  const { start: currentWeekStart } = getWeekBounds(0);
  const currentMonday = new Date(toParisDate(toUTCISO(currentWeekStart)) + "T00:00:00Z");
  let offset = Math.round((target.getTime() - currentMonday.getTime()) / (7 * 86400000));
  let bounds = getWeekBounds(offset);
  if (toParisDate(toUTCISO(bounds.start)) !== weekStartDate) {
    offset += toParisDate(toUTCISO(bounds.start)) < weekStartDate ? 1 : -1;
    bounds = getWeekBounds(offset);
  }
  const weekEnd = toParisDate(toUTCISO(bounds.end));

  // Check for existing overrides if not forced
  if (!force) {
    const db = getDb();
    const existingPeriod = db.prepare(`SELECT id FROM weekly_settlement_periods WHERE week_start = ?`).get(weekStartDate) as { id: number } | undefined;
    if (existingPeriod) {
      const overrideCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM weekly_settlement_tx_overrides
        WHERE settlement_id IN (SELECT id FROM weekly_settlements WHERE week_start = ?)
      `).get(weekStartDate) as { cnt: number };
      if (overrideCount.cnt > 0) {
        return {
          week_start: weekStartDate, week_end: weekEnd, total_players: 0,
          auto_settled: 0, pending_manual: 0, period_locked: false,
          overrides_deleted: 0, needs_confirm: true, override_count: overrideCount.cnt
        };
      }
    }
  }

  return _computeWeekInternal(weekStartDate, weekEnd, toUTCISO(bounds.start), toUTCISO(bounds.end));
}

function _computeWeekInternal(weekStart: string, weekEnd: string, startISO: string, endISO: string): ComputeResult {
  const db = getDb();

  const existingPeriod = db.prepare(`SELECT status FROM weekly_settlement_periods WHERE week_start = ?`).get(weekStart) as { status: string } | undefined;
  if (existingPeriod?.status === "locked") {
    const existing = db.prepare(`SELECT COUNT(*) as cnt FROM weekly_settlements WHERE week_start = ?`).get(weekStart) as { cnt: number };
    return { week_start: weekStart, week_end: weekEnd, total_players: existing.cnt, auto_settled: 0, pending_manual: 0, period_locked: true, overrides_deleted: 0 };
  }

  // Delete existing overrides on recompute
  let overridesDeleted = 0;
  const existingSettlements = db.prepare(`SELECT id FROM weekly_settlements WHERE week_start = ?`).all(weekStart) as { id: number }[];
  if (existingSettlements.length > 0) {
    const ids = existingSettlements.map(s => s.id);
    const result = db.prepare(`DELETE FROM weekly_settlement_tx_overrides WHERE settlement_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    overridesDeleted = result.changes;
  }

  // Upsert period
  db.prepare(`
    INSERT INTO weekly_settlement_periods (week_start, week_end, status, computed_at)
    VALUES (@week_start, @week_end, 'computed', datetime('now'))
    ON CONFLICT(week_start) DO UPDATE SET
      computed_at = datetime('now'),
      status = CASE WHEN weekly_settlement_periods.status = 'locked' THEN 'locked' ELSE 'computed' END
  `).run({ week_start: weekStart, week_end: weekEnd });

  const players = db.prepare(`
    SELECT p.id AS player_id, p.name AS player_name, pgd.action_pct
    FROM players p
    JOIN player_game_deals pgd ON pgd.player_id = p.id
    JOIN games g ON g.id = pgd.game_id AND g.name = 'TELE'
  `).all() as { player_id: number; player_name: string; action_pct: number }[];

  let autoSettled = 0;
  let pendingManual = 0;

  const upsert = db.prepare(`
    INSERT INTO weekly_settlements (week_start, player_id, status, pnl_player, pnl_operator, action_pct_snapshot, lock_anchor_tx_id, lock_anchor_datetime)
    VALUES (@week_start, @player_id, @status, @pnl_player, @pnl_operator, @action_pct_snapshot, @lock_anchor_tx_id, @lock_anchor_datetime)
    ON CONFLICT(week_start, player_id) DO UPDATE SET
      status = CASE
        WHEN weekly_settlements.status IN ('settled', 'carry_over') AND weekly_settlements.locked_at IS NOT NULL
        THEN weekly_settlements.status
        ELSE excluded.status
      END,
      pnl_player = CASE
        WHEN weekly_settlements.status IN ('settled', 'carry_over') AND weekly_settlements.locked_at IS NOT NULL
        THEN weekly_settlements.pnl_player
        ELSE excluded.pnl_player
      END,
      pnl_operator = CASE
        WHEN weekly_settlements.status IN ('settled', 'carry_over') AND weekly_settlements.locked_at IS NOT NULL
        THEN weekly_settlements.pnl_operator
        ELSE excluded.pnl_operator
      END,
      action_pct_snapshot = CASE
        WHEN weekly_settlements.status IN ('settled', 'carry_over') AND weekly_settlements.locked_at IS NOT NULL
        THEN weekly_settlements.action_pct_snapshot
        ELSE excluded.action_pct_snapshot
      END,
      lock_anchor_tx_id = CASE
        WHEN weekly_settlements.status IN ('settled', 'carry_over') AND weekly_settlements.locked_at IS NOT NULL
        THEN weekly_settlements.lock_anchor_tx_id
        ELSE excluded.lock_anchor_tx_id
      END,
      lock_anchor_datetime = CASE
        WHEN weekly_settlements.status IN ('settled', 'carry_over') AND weekly_settlements.locked_at IS NOT NULL
        THEN weekly_settlements.lock_anchor_datetime
        ELSE excluded.lock_anchor_datetime
      END,
      locked_at = CASE
        WHEN weekly_settlements.status IN ('settled', 'carry_over') AND weekly_settlements.locked_at IS NOT NULL
        THEN weekly_settlements.locked_at
        ELSE NULL
      END,
      locked_by = CASE
        WHEN weekly_settlements.status IN ('settled', 'carry_over') AND weekly_settlements.locked_at IS NOT NULL
        THEN weekly_settlements.locked_by
        ELSE NULL
      END
  `);

  for (const player of players) {
    const txData = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END), 0) AS deposited,
        COALESCE(SUM(CASE WHEN type='withdrawal' THEN amount ELSE 0 END), 0) AS withdrawn
      FROM wallet_transactions
      WHERE player_id = @player_id
        AND tx_datetime >= @start AND tx_datetime <= @end
        AND (source IS NULL OR source != 'unknown')
    `).get({ player_id: player.player_id, start: startISO, end: endISO }) as { deposited: number; withdrawn: number };

    const pnlPlayer = txData.withdrawn - txData.deposited;
    const pnlOperator = pnlPlayer * player.action_pct / 100;

    const anchor = db.prepare(`
      SELECT id, tx_datetime
      FROM wallet_transactions
      WHERE player_id = @player_id
        AND type = 'withdrawal'
        AND tx_datetime >= @start AND tx_datetime <= @end
        AND (source IS NULL OR source != 'unknown')
      ORDER BY tx_datetime DESC
      LIMIT 1
    `).get({ player_id: player.player_id, start: startISO, end: endISO }) as { id: number; tx_datetime: string } | undefined;

    const hasAnchor = !!anchor;
    const status = hasAnchor ? "auto_settled" : "pending_manual";
    if (hasAnchor) autoSettled++; else pendingManual++;

    upsert.run({
      week_start: weekStart,
      player_id: player.player_id,
      status,
      pnl_player: pnlPlayer,
      pnl_operator: pnlOperator,
      action_pct_snapshot: player.action_pct,
      lock_anchor_tx_id: anchor?.id ?? null,
      lock_anchor_datetime: anchor?.tx_datetime ?? null,
    });
  }

  return { week_start: weekStart, week_end: weekEnd, total_players: players.length, auto_settled: autoSettled, pending_manual: pendingManual, period_locked: false, overrides_deleted: overridesDeleted };
}

// ── getQueue ─────────────────────────────────────────────

export function getQueue(weekStart: string): { period: PeriodRow | null; rows: SettlementRow[] } {
  const db = getDb();
  const period = db.prepare(`SELECT * FROM weekly_settlement_periods WHERE week_start = ?`).get(weekStart) as PeriodRow | undefined;
  const rows = db.prepare(`
    SELECT ws.*, p.name AS player_name,
      (SELECT COUNT(*) FROM weekly_settlement_tx_overrides WHERE settlement_id = ws.id) AS override_count
    FROM weekly_settlements ws
    JOIN players p ON p.id = ws.player_id
    WHERE ws.week_start = ?
    ORDER BY
      CASE ws.status WHEN 'auto_settled' THEN 1 WHEN 'pending_manual' THEN 2 WHEN 'settled' THEN 3 WHEN 'carry_over' THEN 4 ELSE 5 END,
      p.name
  `).all(weekStart) as SettlementRow[];
  return { period: period ?? null, rows };
}

// ── getSettlementTransactions ────────────────────────────

export function getSettlementTransactions(settlementId: number): TxRow[] {
  const db = getDb();
  const settlement = db.prepare(`SELECT * FROM weekly_settlements WHERE id = ?`).get(settlementId) as any;
  if (!settlement) return [];

  const period = db.prepare(`SELECT * FROM weekly_settlement_periods WHERE week_start = ?`).get(settlement.week_start) as any;
  if (!period) return [];

  const { start, end } = _getWeekBoundsForDate(settlement.week_start);
  const startISO = toUTCISO(start);
  const endISO = toUTCISO(end);

  // Base transactions in window
  const baseTxs = db.prepare(`
    SELECT id, tx_datetime, type, amount, source, tron_tx_hash
    FROM wallet_transactions
    WHERE player_id = @player_id
      AND tx_datetime >= @start AND tx_datetime <= @end
      AND (source IS NULL OR source != 'unknown')
  `).all({ player_id: settlement.player_id, start: startISO, end: endISO }) as any[];

  // Get overrides
  const overrides = db.prepare(`
    SELECT wallet_transaction_id, action FROM weekly_settlement_tx_overrides
    WHERE settlement_id = ?
  `).all(settlementId) as { wallet_transaction_id: number; action: string }[];

  const excludeIds = new Set(overrides.filter(o => o.action === "exclude").map(o => o.wallet_transaction_id));
  const includeIds = overrides.filter(o => o.action === "include").map(o => o.wallet_transaction_id);

  // Filter base (remove excluded)
  const result: TxRow[] = baseTxs
    .filter(tx => !excludeIds.has(tx.id))
    .map(tx => ({ ...tx, is_override: false }));

  // Add included (from outside window)
  if (includeIds.length > 0) {
    const includedTxs = db.prepare(`
      SELECT id, tx_datetime, type, amount, source, tron_tx_hash
      FROM wallet_transactions WHERE id IN (${includeIds.map(() => '?').join(',')})
    `).all(...includeIds) as any[];
    for (const tx of includedTxs) {
      result.push({ ...tx, is_override: true, override_action: "include" });
    }
  }

  result.sort((a, b) => a.tx_datetime.localeCompare(b.tx_datetime));
  return result;
}

// ── getAvailableTransactions ─────────────────────────────

export function getAvailableTransactions(playerId: number, weekStart: string, settlementId: number): TxRow[] {
  const db = getDb();
  const { start, end } = _getWeekBoundsForDate(weekStart);
  const startISO = toUTCISO(start);
  const endISO = toUTCISO(end);

  // Get IDs already in the settlement (in-window not excluded + included)
  const currentTxs = getSettlementTransactions(settlementId);
  const currentIds = new Set(currentTxs.map(t => t.id));

  // Also get excluded IDs (they should appear as available to re-add)
  const excludedOverrides = db.prepare(`
    SELECT wallet_transaction_id FROM weekly_settlement_tx_overrides
    WHERE settlement_id = ? AND action = 'exclude'
  `).all(settlementId) as { wallet_transaction_id: number }[];
  const excludedIds = new Set(excludedOverrides.map(o => o.wallet_transaction_id));

  // All player's transactions (broader window: ±2 weeks)
  const broaderStart = new Date(new Date(startISO).getTime() - 14 * 86400000).toISOString();
  const broaderEnd = new Date(new Date(endISO).getTime() + 14 * 86400000).toISOString();

  const allTxs = db.prepare(`
    SELECT id, tx_datetime, type, amount, source, tron_tx_hash
    FROM wallet_transactions
    WHERE player_id = ?
      AND tx_datetime >= ? AND tx_datetime <= ?
      AND (source IS NULL OR source != 'unknown')
    ORDER BY tx_datetime DESC
  `).all(playerId, broaderStart, broaderEnd) as any[];

  return allTxs
    .filter(tx => !currentIds.has(tx.id) || excludedIds.has(tx.id))
    .map(tx => ({ ...tx, is_override: false }));
}

// ── Override management ──────────────────────────────────

export function addOverride(settlementId: number, txId: number, action: "exclude" | "include", reason?: string): { ok: boolean; error?: string } {
  const db = getDb();

  const settlement = db.prepare(`SELECT * FROM weekly_settlements WHERE id = ?`).get(settlementId) as any;
  if (!settlement) return { ok: false, error: "Settlement not found" };
  if (settlement.locked_at) return { ok: false, error: "Player row is already locked" };

  const period = db.prepare(`SELECT status FROM weekly_settlement_periods WHERE week_start = ?`).get(settlement.week_start) as any;
  if (period?.status === "locked") return { ok: false, error: "Week is locked" };

  db.prepare(`
    INSERT OR REPLACE INTO weekly_settlement_tx_overrides (settlement_id, wallet_transaction_id, action, reason)
    VALUES (?, ?, ?, ?)
  `).run(settlementId, txId, action, reason ?? null);

  _recomputeSettlementPnl(settlementId);
  return { ok: true };
}

export function removeOverride(settlementId: number, txId: number): { ok: boolean; error?: string } {
  const db = getDb();

  const settlement = db.prepare(`SELECT * FROM weekly_settlements WHERE id = ?`).get(settlementId) as any;
  if (!settlement) return { ok: false, error: "Settlement not found" };
  if (settlement.locked_at) return { ok: false, error: "Player row is already locked" };

  const period = db.prepare(`SELECT status FROM weekly_settlement_periods WHERE week_start = ?`).get(settlement.week_start) as any;
  if (period?.status === "locked") return { ok: false, error: "Week is locked" };

  db.prepare(`DELETE FROM weekly_settlement_tx_overrides WHERE settlement_id = ? AND wallet_transaction_id = ?`).run(settlementId, txId);

  _recomputeSettlementPnl(settlementId);
  return { ok: true };
}

function _recomputeSettlementPnl(settlementId: number) {
  const db = getDb();
  const settlement = db.prepare(`SELECT * FROM weekly_settlements WHERE id = ?`).get(settlementId) as any;
  if (!settlement) return;

  const txs = getSettlementTransactions(settlementId);

  let deposited = 0;
  let withdrawn = 0;
  let lastWithdrawal: { id: number; tx_datetime: string } | null = null;

  for (const tx of txs) {
    if (tx.type === "deposit") deposited += tx.amount;
    else if (tx.type === "withdrawal") {
      withdrawn += tx.amount;
      if (!lastWithdrawal || tx.tx_datetime > lastWithdrawal.tx_datetime) {
        lastWithdrawal = { id: tx.id, tx_datetime: tx.tx_datetime };
      }
    }
  }

  const pnlPlayer = withdrawn - deposited;
  const pnlOperator = pnlPlayer * (settlement.action_pct_snapshot ?? 0) / 100;
  const hasAnchor = !!lastWithdrawal;
  const newStatus = hasAnchor ? "auto_settled" : "pending_manual";

  // Only update status if not already in a terminal locked state
  if (settlement.locked_at) return;

  db.prepare(`
    UPDATE weekly_settlements
    SET pnl_player = ?, pnl_operator = ?, status = ?,
        lock_anchor_tx_id = ?, lock_anchor_datetime = ?
    WHERE id = ?
  `).run(
    pnlPlayer, pnlOperator, newStatus,
    lastWithdrawal?.id ?? null, lastWithdrawal?.tx_datetime ?? null,
    settlementId
  );
}

// ── validatePlayer ───────────────────────────────────────

export function validatePlayer(
  playerId: number,
  weekStart: string,
  action: "carry_over" | "manual_close",
  payload?: { amount?: number; note?: string }
): { ok: boolean; error?: string } {
  const db = getDb();

  const row = db.prepare(`SELECT * FROM weekly_settlements WHERE week_start = ? AND player_id = ?`).get(weekStart, playerId) as any;
  if (!row) return { ok: false, error: "Settlement row not found" };

  const period = db.prepare(`SELECT status FROM weekly_settlement_periods WHERE week_start = ?`).get(weekStart) as any;
  if (period?.status === "locked") return { ok: false, error: "Week is already locked" };

  if (action === "carry_over") {
    if (row.status !== "pending_manual") return { ok: false, error: `Cannot carry over: status is '${row.status}', expected 'pending_manual'` };
    db.prepare(`
      UPDATE weekly_settlements SET status = 'carry_over', pnl_player = 0, pnl_operator = 0, locked_at = datetime('now'), locked_by = 'baki'
      WHERE week_start = ? AND player_id = ?
    `).run(weekStart, playerId);
    return { ok: true };
  }

  if (action === "manual_close") {
    if (row.status !== "pending_manual") return { ok: false, error: `Cannot manual close: status is '${row.status}', expected 'pending_manual'` };
    if (payload?.amount === undefined) return { ok: false, error: "manual_close requires payload.amount" };
    const pnlOperator = payload.amount * (row.action_pct_snapshot ?? 0) / 100;
    db.prepare(`
      UPDATE weekly_settlements
      SET status = 'settled', pnl_player = @amount, pnl_operator = @pnl_operator,
          manual_close_amount = @amount, locked_at = datetime('now'), locked_by = 'baki',
          note = @note
      WHERE week_start = @week_start AND player_id = @player_id
    `).run({ amount: payload.amount, pnl_operator: pnlOperator, week_start: weekStart, player_id: playerId, note: payload.note ?? null });
    return { ok: true };
  }

  return { ok: false, error: "Unknown action" };
}

// ── lockWeek ─────────────────────────────────────────────

export function lockWeek(weekStart: string): { ok: boolean; error?: string } {
  const db = getDb();
  const period = db.prepare(`SELECT status FROM weekly_settlement_periods WHERE week_start = ?`).get(weekStart) as any;
  if (!period) return { ok: false, error: "Period not found — run computeWeek first" };
  if (period.status === "locked") return { ok: false, error: "Already locked" };

  const pending = db.prepare(`
    SELECT p.name FROM weekly_settlements ws
    JOIN players p ON p.id = ws.player_id
    WHERE ws.week_start = ? AND ws.status IN ('pending_manual', 'conflict')
  `).all(weekStart) as { name: string }[];

  if (pending.length > 0) {
    return { ok: false, error: `Cannot lock: ${pending.length} player(s) still pending: ${pending.map(p => p.name).join(", ")}` };
  }

  // Flip all auto_settled → settled with lock snapshot
  db.prepare(`
    UPDATE weekly_settlements
    SET status = 'settled', locked_at = datetime('now'), locked_by = 'baki'
    WHERE week_start = ? AND status = 'auto_settled'
  `).run(weekStart);

  // Lock the period
  db.prepare(`
    UPDATE weekly_settlement_periods SET status = 'locked', locked_at = datetime('now')
    WHERE week_start = ?
  `).run(weekStart);
  return { ok: true };
}

// ── Helpers ──────────────────────────────────────────────

export function getLockedWeeks(): string[] {
  const db = getDb();
  return (db.prepare(`SELECT week_start FROM weekly_settlement_periods WHERE status = 'locked' ORDER BY week_start`).all() as { week_start: string }[]).map(r => r.week_start);
}

export function getPeriod(weekStart: string): PeriodRow | null {
  const db = getDb();
  return (db.prepare(`SELECT * FROM weekly_settlement_periods WHERE week_start = ?`).get(weekStart) as PeriodRow) ?? null;
}

function _getWeekBoundsForDate(weekStartDate: string): { start: Date; end: Date } {
  const target = new Date(weekStartDate + "T00:00:00Z");
  const { start: currentWeekStart } = getWeekBounds(0);
  const currentMonday = new Date(toParisDate(toUTCISO(currentWeekStart)) + "T00:00:00Z");
  let offset = Math.round((target.getTime() - currentMonday.getTime()) / (7 * 86400000));
  let bounds = getWeekBounds(offset);
  if (toParisDate(toUTCISO(bounds.start)) !== weekStartDate) {
    offset += toParisDate(toUTCISO(bounds.start)) < weekStartDate ? 1 : -1;
    bounds = getWeekBounds(offset);
  }
  return bounds;
}
