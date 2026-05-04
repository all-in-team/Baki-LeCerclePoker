/**
 * Settlement engine — weekly P&L computation and lock management.
 * Math lives here (parallel to queries.ts for settlement-specific logic).
 * Pure functions + documented INSERT/UPDATE on weekly_settlements / weekly_settlement_periods.
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
}

// ── computeWeek ──────────────────────────────────────────

export function computeWeek(weekOffset: number): ComputeResult {
  const db = getDb();
  const { start, end } = getWeekBounds(weekOffset);
  const startISO = toUTCISO(start);
  const endISO = toUTCISO(end);
  const weekStart = toParisDate(startISO);
  const weekEnd = toParisDate(endISO);

  // Skip if period is already locked
  const existingPeriod = db.prepare(`SELECT status FROM weekly_settlement_periods WHERE week_start = ?`).get(weekStart) as { status: string } | undefined;
  if (existingPeriod?.status === "locked") {
    const existing = db.prepare(`SELECT COUNT(*) as cnt FROM weekly_settlements WHERE week_start = ?`).get(weekStart) as { cnt: number };
    return { week_start: weekStart, week_end: weekEnd, total_players: existing.cnt, auto_settled: 0, pending_manual: 0 };
  }

  // Upsert period
  db.prepare(`
    INSERT INTO weekly_settlement_periods (week_start, week_end, status, computed_at)
    VALUES (@week_start, @week_end, 'computed', datetime('now'))
    ON CONFLICT(week_start) DO UPDATE SET
      computed_at = datetime('now'),
      status = CASE WHEN weekly_settlement_periods.status = 'locked' THEN 'locked' ELSE 'computed' END
  `).run({ week_start: weekStart, week_end: weekEnd });

  // Get all TELE players with their deals
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
      END
  `);

  for (const player of players) {
    // Get wallet tx in range for this player
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

    // Find last withdrawal (anchor)
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

    const status = anchor ? "auto_settled" : "pending_manual";
    if (anchor) autoSettled++; else pendingManual++;

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

  return { week_start: weekStart, week_end: weekEnd, total_players: players.length, auto_settled: autoSettled, pending_manual: pendingManual };
}

// ── getQueue ─────────────────────────────────────────────

export function getQueue(weekStart: string): { period: PeriodRow | null; rows: SettlementRow[] } {
  const db = getDb();
  const period = db.prepare(`SELECT * FROM weekly_settlement_periods WHERE week_start = ?`).get(weekStart) as PeriodRow | undefined;
  const rows = db.prepare(`
    SELECT ws.*, p.name AS player_name
    FROM weekly_settlements ws
    JOIN players p ON p.id = ws.player_id
    WHERE ws.week_start = ?
    ORDER BY ws.status, p.name
  `).all(weekStart) as SettlementRow[];
  return { period: period ?? null, rows };
}

// ── validatePlayer ───────────────────────────────────────

export function validatePlayer(
  playerId: number,
  weekStart: string,
  action: "confirm" | "carry_over" | "manual_close",
  payload?: { amount?: number; note?: string }
): { ok: boolean; error?: string } {
  const db = getDb();

  const row = db.prepare(`SELECT * FROM weekly_settlements WHERE week_start = ? AND player_id = ?`).get(weekStart, playerId) as any;
  if (!row) return { ok: false, error: "Settlement row not found" };

  // Check period is not locked
  const period = db.prepare(`SELECT status FROM weekly_settlement_periods WHERE week_start = ?`).get(weekStart) as any;
  if (period?.status === "locked") return { ok: false, error: "Week is already locked" };

  if (action === "confirm") {
    if (row.status !== "auto_settled") return { ok: false, error: `Cannot confirm: status is '${row.status}', expected 'auto_settled'` };
    db.prepare(`
      UPDATE weekly_settlements SET status = 'settled', locked_at = datetime('now'), locked_by = 'baki'
      WHERE week_start = ? AND player_id = ?
    `).run(weekStart, playerId);
    return { ok: true };
  }

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

// ── confirmAllAuto ───────────────────────────────────────

export function confirmAllAuto(weekStart: string): { ok: boolean; count: number; error?: string } {
  const db = getDb();
  const period = db.prepare(`SELECT status FROM weekly_settlement_periods WHERE week_start = ?`).get(weekStart) as any;
  if (period?.status === "locked") return { ok: false, count: 0, error: "Week is already locked" };

  const result = db.prepare(`
    UPDATE weekly_settlements
    SET status = 'settled', locked_at = datetime('now'), locked_by = 'baki'
    WHERE week_start = ? AND status = 'auto_settled'
  `).run(weekStart);
  return { ok: true, count: result.changes };
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
    WHERE ws.week_start = ? AND ws.status IN ('auto_settled', 'pending_manual', 'conflict')
  `).all(weekStart) as { name: string }[];

  if (pending.length > 0) {
    return { ok: false, error: `Cannot lock: ${pending.length} player(s) still pending: ${pending.map(p => p.name).join(", ")}` };
  }

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
