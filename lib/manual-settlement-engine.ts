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
  game_id: number | null;
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
  /** Declared payment day (set from /payments). Rooms display it in preference to paid_at
   *  so a back-dated payment shows the SAME date on both screens. */
  paid_date: string | null;
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

// Selection-scope resolution for pages mixing INDEPENDENT settle buckets (decision Hugo
// 2026-07-20: WN a son propre % — la page A5NUTS affiche tout mais un règlement porte UN
// seul %). The scope of a settlement is the bucket containing ALL selected txs; a mixed
// selection is refused with an explicit error, never split silently.
export function resolveSelectionScope(
  txIds: number[],
  buckets: number[][],
): { scope: number[] } | { error: string } {
  if (!Array.isArray(txIds) || txIds.length === 0) return { error: "Aucune transaction sélectionnée" };
  const ids = [...new Set(txIds)];
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb().prepare(
    `SELECT DISTINCT game_id FROM wallet_transactions WHERE id IN (${placeholders})`
  ).all(...ids) as { game_id: number | null }[];
  const games = rows.map((r) => r.game_id).filter((g): g is number => g !== null);
  const matching = buckets.filter((b) => games.some((g) => b.includes(g)));
  if (matching.length > 1) {
    return { error: "Sélection mixte (A5/NUTS et WN) — règle-les séparément : les % sont indépendants." };
  }
  if (matching.length === 0) return { error: "Aucun game reconnu dans la sélection" };
  return { scope: matching[0] };
}

// ── 1) getAvailableTransactions ──────────────────────────
// Player's still-unsettled txs for a game scope (settled=0), real sources only, oldest→newest.

export function getAvailableTransactions(gameId: GameScope, playerId: number): AvailableTx[] {
  const db = getDb();
  const ids = scopeIds(gameId);
  const placeholders = ids.map(() => "?").join(", ");
  return db.prepare(`
    SELECT id, game_id, tx_datetime, tx_date, type, amount, currency, source, tron_tx_hash
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
  // SENS (corrigé 2026-07-25) : positif = le JOUEUR doit au Cercle. Formule identique à
  // `my_pnl` / `agency_cut_usdt` (lib/queries.ts l.587 & 1517), qui se lit partout dans l'app
  // « positif = ce que le joueur rapporte ». L'ancien commentaire disait l'inverse
  // ("positive = operator owes player") et c'est ce qui a fait colorer /paiements à l'envers.
  // La VALEUR n'a jamais changé, seule sa lecture est corrigée.
  const due = net * actionPct / 100;               // positive = player owes the Cercle
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

export function markPaid(settlementId: number, txHash?: string, paidDate?: string): { ok: boolean; error?: string } {
  const db = getDb();
  const row = db.prepare(`SELECT id, status FROM manual_settlements WHERE id = ?`).get(settlementId) as { id: number; status: string } | undefined;
  if (!row) return { ok: false, error: "Règlement introuvable" };
  if (row.status === "paid") return { ok: false, error: "Déjà payé — double-paiement refusé" };

  // paid_date = the day the money actually moved (declared on /payments). paid_at stays the
  // untouched audit timestamp of the click. Omitted → NULL, readers fall back to date(paid_at),
  // which is exactly the pre-existing behaviour for every room-side call.
  // Strict calendar validation (not just the shape): server actions are HTTP-callable, and a
  // bogus far-future date would sort out of every history filter and vanish from the ledger.
  if (paidDate !== undefined) {
    if (!isValidISODate(paidDate)) {
      return { ok: false, error: `Date de paiement invalide (${paidDate}) — format attendu YYYY-MM-DD` };
    }
    if (paidDate > todayUTC()) {
      return { ok: false, error: `Date de paiement dans le futur (${paidDate}) — refusé` };
    }
  }

  // WHERE status='locked' is the authoritative guard: if a concurrent caller already paid,
  // this flips 0 rows → report failure instead of a spurious ok (belt-and-suspenders).
  const upd = db.prepare(`
    UPDATE manual_settlements SET status = 'paid', paid_at = datetime('now'), tx_hash = ?, paid_date = ?
    WHERE id = ? AND status = 'locked'
  `).run(txHash ?? null, paidDate ?? null, settlementId);
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

// ═════════════════════════════════════════════════════════
// PAYMENTS HUB — cross-room aggregated read layer (/payments)
// ═════════════════════════════════════════════════════════
//
// Pure READS over the SAME manual_settlements table the rooms write to. No parallel state,
// no mirror table: a settlement paid from /payments IS the row the room displays, and vice
// versa. The only writer this hub uses is markPaid()/unlockSettlement() above — unchanged
// semantics, unchanged guards.
//
// Scope: wallet-based action games only. Deliberately EXCLUDED:
//   - QQPK   → monthly staking cycle (qqpk_staking_blocks), never writes manual_settlements
//   - TELE   → archived AKPOKER, carries ~417 fossil settled=0 rows that would drown §Impayés
//   - Wepoker/Xpoker/ClubGG/AAPKMY/India/TW72 → no settle flow at all

export interface SettleRoom {
  label: string;      // badge shown in the hub
  games: string[];    // games.name members of the settle bucket (ids resolved at runtime)
  basePath: string;   // room page the "aller régler" link points to
  color: string;      // badge accent
}

// Buckets mirror the room pages' settle scopes exactly (see app/*/pnl/actions.ts).
// WN is its OWN bucket even though it lives on the A5NUTS page: its action_pct is
// independent, so its settlements are separate rows — the badge must say so.
export const SETTLE_ROOMS: SettleRoom[] = [
  { label: "KKPOKER", games: ["KKPOKER"],            basePath: "/kkpoker/pnl", color: "#38BDF8" },
  { label: "A5NUTS",  games: ["A5POKER", "NUTSPK"],  basePath: "/a5nuts/pnl",  color: "#10B981" },
  { label: "WN",      games: ["WN"],                 basePath: "/a5nuts/pnl",  color: "#A855F7" },
  { label: "AKS/OK",  games: ["AKS", "OKPOKER"],     basePath: "/aks/pnl",     color: "#F5C518" },
  { label: "JVIP",    games: ["JVIP"],               basePath: "/jvip/pnl",    color: "#F97316" },
  { label: "TTPOKER", games: ["TTPOKER"],            basePath: "/ttpoker/pnl", color: "#EC4899" },
  // NEXAPOKER n'est pas un règlement adossé à des transactions : ce qui s'y règle est la
  // PART D'ACTION, dont l'assiette est le win/loss saisi à la main. Ses lignes sont écrites
  // par lockNexaActionSettlementOn (lib/funnels/nexa/action-settlement.ts), jamais par
  // lockSettlement — qui calculerait `net des transactions × action_pct` et lirait le % dans
  // le miroir player_game_deals, deux choses fausses ici. Le hub, lui, les affiche comme les
  // autres : elles portent bien un game_id et un amount_due_usdt dans la même convention.
  { label: "NEXAPOKER", games: ["NEXAPOKER"],        basePath: "/nexapoker",   color: "#22D3EE" },
];

// games.name → room, resolved once per call. A game absent from SETTLE_ROOMS returns null
// and is skipped: adding a new room = one line in SETTLE_ROOMS, nothing else.
function roomByGameName(): Map<string, SettleRoom> {
  const m = new Map<string, SettleRoom>();
  for (const r of SETTLE_ROOMS) for (const g of r.games) m.set(g, r);
  return m;
}

function scopedGameIds(db: ReturnType<typeof getDb>): { ids: number[]; byId: Map<number, SettleRoom> } {
  const byName = roomByGameName();
  const names = [...byName.keys()];
  const placeholders = names.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT id, name FROM games WHERE name IN (${placeholders})`).all(...names) as { id: number; name: string }[];
  const byId = new Map<number, SettleRoom>();
  for (const r of rows) { const room = byName.get(r.name); if (room) byId.set(r.id, room); }
  return { ids: rows.map(r => r.id), byId };
}

// ── ISO week helpers (UTC, Monday-anchored) ──────────────
// Mirrors weekInfo() in components/ledger/extras/SettlementFlow.tsx so a settlement labelled
// "W30" here is the SAME W30 Baki sees on the room page. Operates on YYYY-MM-DD prefixes.

// Returns null on a malformed stamp instead of throwing. A single bad tx_date must never be
// able to take down the overdue detector — an anti-oubli feature that crashes reads as
// "rien à faire", which is the exact failure it exists to prevent.
function mondayOf(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  // Reject overflow dates (2026-13-45 would silently roll into the next year).
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const dow = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() - (dow - 1));
  return dt.toISOString().slice(0, 10);
}

/** Strict YYYY-MM-DD calendar check — the regex alone accepts 2026-13-45. */
export function isValidISODate(s: string): boolean {
  return mondayOf(s) !== null;
}

function isoWeekLabel(mondayStr: string): string {
  const monday = new Date(mondayStr + "T00:00:00Z");
  const thu = new Date(monday); thu.setUTCDate(monday.getUTCDate() + 3);
  const firstThu = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4));
  const firstThuDow = firstThu.getUTCDay() || 7;
  const week1Mon = new Date(firstThu); week1Mon.setUTCDate(firstThu.getUTCDate() - (firstThuDow - 1));
  const weekNum = Math.round((monday.getTime() - week1Mon.getTime()) / (7 * 86400000)) + 1;
  return `W${weekNum}`;
}

function todayUTC(): string { return new Date().toISOString().slice(0, 10); }
function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((new Date(toDate + "T00:00:00Z").getTime() - new Date(fromDate + "T00:00:00Z").getTime()) / 86400000);
}

/**
 * Grace period before an unsettled past week is called "en retard".
 * A week runs Mon→Sun; +3 days means it only turns red on the WEDNESDAY after it closed,
 * so Monday/Tuesday settling of the weekend produces zero false alarms (decision Hugo,
 * "fais au mieux pour que ce soit smooth").
 */
export const OVERDUE_GRACE_DAYS = 3;

// ── Pending settlements (§"À régler") ────────────────────

export interface HubSettlement {
  id: number;
  game_id: number;
  game_name: string;
  room_label: string;
  room_color: string;
  room_base_path: string;
  player_id: number;
  player_name: string;
  net_selected_usdt: number;
  action_pct_applied: number;
  amount_due_usdt: number;      // >0 = le joueur doit au Cercle (ça rentre) · <0 = on doit au joueur (ça sort)
  status: "locked" | "paid";
  tx_hash: string | null;
  notes: string | null;
  locked_at: string;
  paid_at: string | null;
  paid_date: string | null;     // declared payment day; falls back to date(paid_at) in `paid_on`
  paid_on: string | null;       // resolved YYYY-MM-DD actually used for display/filtering
  tx_count: number;
  period_start: string | null;  // derived MIN(tx_datetime) of the settled txs
  period_end: string | null;    // derived MAX(tx_datetime)
  week_label: string | null;    // "W30" from period_end
  age_days: number;             // days since lock (pending) — drives the ancienneté badge
}

// period_start/period_end are DERIVED from the back-linked wallet_transactions rather than
// stored: the link (settlement_id) is already authoritative, so a stored copy could only
// drift. Same reason week_label is computed, never persisted.
const HUB_SELECT = `
  SELECT ms.id, ms.game_id, g.name AS game_name, ms.player_id, p.name AS player_name,
         ms.net_selected_usdt, ms.action_pct_applied, ms.amount_due_usdt,
         ms.status, ms.tx_hash, ms.notes, ms.locked_at, ms.paid_at, ms.paid_date,
         (SELECT COUNT(*) FROM wallet_transactions wt WHERE wt.settlement_id = ms.id) AS tx_count,
         -- COALESCE sur nexa_action_settlement_weeks : un règlement de part d'action NEXA
         -- n'a AUCUNE transaction back-linkée (son assiette est le win/loss saisi), sa
         -- période est donc portée par les semaines couvertes. Sans ce repli, la ligne
         -- s'afficherait dans le hub sans période ni libellé de semaine.
         COALESCE(
           (SELECT MIN(COALESCE(wt.tx_datetime, wt.tx_date)) FROM wallet_transactions wt WHERE wt.settlement_id = ms.id),
           (SELECT MIN(nw.week_start) FROM nexa_action_settlement_weeks nw WHERE nw.settlement_id = ms.id)
         ) AS period_start,
         COALESCE(
           (SELECT MAX(COALESCE(wt.tx_datetime, wt.tx_date)) FROM wallet_transactions wt WHERE wt.settlement_id = ms.id),
           (SELECT MAX(nw.week_start) FROM nexa_action_settlement_weeks nw WHERE nw.settlement_id = ms.id)
         ) AS period_end
  FROM manual_settlements ms
  JOIN games g ON g.id = ms.game_id
  JOIN players p ON p.id = ms.player_id
`;

function hydrate(row: any, byId: Map<number, SettleRoom>): HubSettlement | null {
  const room = byId.get(row.game_id);
  if (!room) return null;   // game outside the settle scope (QQPK/TELE/…) — not a payment
  const today = todayUTC();
  const paidOn: string | null = row.paid_date ?? (row.paid_at ? String(row.paid_at).slice(0, 10) : null);
  const weekMonday = mondayOf(row.period_end);
  const lockedDay = mondayOf(row.locked_at) !== null ? String(row.locked_at).slice(0, 10) : null;
  return {
    ...row,
    room_label: room.label,
    room_color: room.color,
    room_base_path: room.basePath,
    paid_on: paidOn,
    week_label: weekMonday ? isoWeekLabel(weekMonday) : null,
    age_days: lockedDay ? Math.max(0, daysBetween(lockedDay, today)) : 0,
  };
}

/** All settlements awaiting payment, every room. Oldest lock first (= most urgent). */
export function getPendingSettlements(): HubSettlement[] {
  const db = getDb();
  const { ids, byId } = scopedGameIds(db);
  if (ids.length === 0) return [];
  const rows = db.prepare(`
    ${HUB_SELECT} WHERE ms.status = 'locked' AND ms.game_id IN (${ids.map(() => "?").join(", ")})
    ORDER BY ms.locked_at ASC
  `).all(...ids) as any[];
  return rows.map(r => hydrate(r, byId)).filter((r): r is HubSettlement => r !== null);
}

export interface PaidFilters {
  from?: string;        // YYYY-MM-DD on the resolved payment day (inclusive)
  to?: string;          // YYYY-MM-DD (inclusive)
  room?: string;        // SettleRoom.label
  playerId?: number;
  /**
   * Omit for the full history — which is what the hub does. A LIMIT here combined with
   * client-side filtering would make an old month render as "aucun règlement" instead of
   * "tronqué", i.e. silently hide paid money. At ~10 settlements/week single-operator scale
   * the unbounded read is a few hundred rows; correctness wins over a cap nobody needs.
   */
  limit?: number;
}

/** Settled + paid history, newest payment first. Filters are applied on the resolved paid day. */
export function getPaidSettlements(f: PaidFilters = {}): HubSettlement[] {
  const db = getDb();
  const { ids, byId } = scopedGameIds(db);
  if (ids.length === 0) return [];
  // Scope filtered in SQL, not only after hydration: otherwise LIMIT would count rows that
  // hydrate() then drops, silently shortening the history.
  const where: string[] = [`ms.status = 'paid'`, `ms.game_id IN (${ids.map(() => "?").join(", ")})`];
  const params: any[] = [...ids];
  // COALESCE mirrors `paid_on`: rows predating the paid_date column filter on date(paid_at).
  if (f.from) { where.push(`COALESCE(ms.paid_date, substr(ms.paid_at, 1, 10)) >= ?`); params.push(f.from); }
  if (f.to)   { where.push(`COALESCE(ms.paid_date, substr(ms.paid_at, 1, 10)) <= ?`); params.push(f.to); }
  if (f.playerId) { where.push(`ms.player_id = ?`); params.push(f.playerId); }
  if (f.limit !== undefined) params.push(f.limit);
  const rows = db.prepare(`
    ${HUB_SELECT} WHERE ${where.join(" AND ")}
    ORDER BY COALESCE(ms.paid_date, substr(ms.paid_at, 1, 10)) DESC, ms.paid_at DESC, ms.id DESC
    ${f.limit !== undefined ? "LIMIT ?" : ""}
  `).all(...params) as any[];
  const hydrated = rows.map(r => hydrate(r, byId)).filter((r): r is HubSettlement => r !== null);
  // Room filter applied post-hydration: a "room" is a bucket of game_ids, not a column.
  // Safe with no LIMIT — with one it would drop rows the cap already counted.
  return f.room ? hydrated.filter(r => r.room_label === f.room) : hydrated;
}

// ── Overdue buckets (§"Impayés / en retard") ─────────────

export interface OverdueBucket {
  player_id: number;
  player_name: string;
  room_label: string;
  room_color: string;
  room_base_path: string;
  week_monday: string;     // YYYY-MM-DD
  week_label: string;      // "W29"
  tx_count: number;
  /**
   * Σ withdrawals − Σ deposits (USDT) of the unsettled txs — the PLAYER-side raw net,
   * NOT an amount due: it has not been multiplied by action_pct (no settlement exists yet,
   * so no pct is frozen). Display it as "net brut", never with the on-doit/il-nous-doit
   * wording used for amount_due_usdt, or a 10 000 net at 20% reads as a 10 000 debt.
   */
  net_usdt: number;
  weeks_late: number;      // 1 = last closed week, 2+ = piling up
  severity: "late" | "critical";
  never_settled: boolean;  // this player has NEVER been settled in this room
  unconvertible: number;   // txs with no FX rate, excluded from net_usdt (should be 0)
}

/**
 * Weeks a player has unsettled transactions in, that closed long enough ago to count as
 * forgotten. This is the anti-oubli detector: it fires on transactions that never entered
 * ANY settlement, so a player Baki simply never opened surfaces here without him having to
 * visit the room.
 *
 * A bucket is overdue when its week's Sunday is at least OVERDUE_GRACE_DAYS in the past.
 */
export function getOverdueBuckets(): OverdueBucket[] {
  const db = getDb();
  const { ids: allIds, byId } = scopedGameIds(db);
  // NEXAPOKER est EXCLU de la détection d'impayés, et c'est structurel, pas un oubli.
  //
  // Ce détecteur repose entièrement sur `wallet_transactions.settled` : une tx non
  // réglée vieillit, passe en retard, puis en critique. Or ce qui se règle sur NEXA
  // est la PART D'ACTION, dont l'assiette est le win/loss saisi à la main — aucune
  // transaction n'est back-linkée, et lockNexaActionSettlementOn ne met JAMAIS
  // settled = 1. Les buy-ins et cash-outs NEXA resteraient donc à `settled = 0`
  // pour toujours : ils deviendraient un impayé permanent, impossible à éteindre,
  // répété chaque jour dans le résumé Telegram et dans get_unpaid_settlements — en
  // dégradant précisément le détecteur anti-oubli qu'ils polluent.
  //
  // Une room dont le règlement n'est pas adossé aux transactions n'a pas d'impayé
  // transactionnel. Ses règlements en attente restent visibles par ailleurs, via
  // getPendingSettlements (manual_settlements en statut 'locked').
  const nexaIds = new Set(
    (db.prepare(`SELECT id FROM games WHERE UPPER(name) = 'NEXAPOKER'`).all() as { id: number }[])
      .map(g => g.id),
  );
  const ids = allIds.filter(id => !nexaIds.has(id));
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");

  const txs = db.prepare(`
    SELECT wt.id, wt.player_id, p.name AS player_name, wt.game_id, wt.type, wt.amount, wt.currency,
           COALESCE(wt.tx_datetime, wt.tx_date) AS stamp
    FROM wallet_transactions wt
    JOIN players p ON p.id = wt.player_id
    WHERE wt.game_id IN (${placeholders})
      AND wt.settled = 0
      AND wt.source IN ('sync', 'manual')
    ORDER BY stamp ASC
  `).all(...ids) as { id: number; player_id: number; player_name: string; game_id: number; type: string; amount: number; currency: string; stamp: string }[];

  const today = todayUTC();
  const currentMonday = mondayOf(today) ?? today;
  const buckets = new Map<string, OverdueBucket>();

  for (const tx of txs) {
    const room = byId.get(tx.game_id);
    if (!room) continue;
    const monday = mondayOf(tx.stamp);
    if (monday === null) continue;   // malformed stamp — skipped, never fatal
    // Sunday of that week + grace must be behind us.
    if (daysBetween(monday, today) < 6 + OVERDUE_GRACE_DAYS) continue;

    const key = `${tx.player_id}|${room.label}|${monday}`;
    let b = buckets.get(key);
    if (!b) {
      const weeksLate = Math.max(1, Math.floor(daysBetween(monday, currentMonday) / 7));
      b = {
        player_id: tx.player_id, player_name: tx.player_name,
        room_label: room.label, room_color: room.color, room_base_path: room.basePath,
        week_monday: monday, week_label: isoWeekLabel(monday),
        tx_count: 0, net_usdt: 0,
        weeks_late: weeksLate,
        severity: weeksLate >= 2 ? "critical" : "late",
        never_settled: false, unconvertible: 0,
      };
      buckets.set(key, b);
    }
    b.tx_count++;
    // Invariant #3: cross-currency amounts go through toUsdt. A missing rate makes toUsdt
    // return 0, which would silently understate the net — count those instead of hiding them.
    if (!tx.currency || getExchangeRate(tx.currency) === 0) { b.unconvertible++; continue; }
    const usdt = toUsdt(tx.amount, tx.currency);
    b.net_usdt += tx.type === "withdrawal" ? usdt : -usdt;
  }

  const out = [...buckets.values()];
  if (out.length === 0) return out;

  // "Jamais réglé" — the deepest miss: a player with activity in a room that has never had a
  // single settlement there. Checked per (player, room bucket) against the room's game ids.
  const settledPairs = new Set<string>();
  const rows = db.prepare(`
    SELECT DISTINCT ms.player_id, g.name AS game_name
    FROM manual_settlements ms JOIN games g ON g.id = ms.game_id
  `).all() as { player_id: number; game_name: string }[];
  const byName = roomByGameName();
  for (const r of rows) {
    const room = byName.get(r.game_name);
    if (room) settledPairs.add(`${r.player_id}|${room.label}`);
  }
  for (const b of out) b.never_settled = !settledPairs.has(`${b.player_id}|${b.room_label}`);

  // Worst first: critical before late, then oldest week, then biggest absolute net.
  out.sort((a, b) =>
    (b.weeks_late - a.weeks_late) ||
    a.week_monday.localeCompare(b.week_monday) ||
    (Math.abs(b.net_usdt) - Math.abs(a.net_usdt))
  );
  return out;
}

// ── Regroupements par joueur (vues calculées) ────────────
//
// Fonctions PURES sur les tableaux déjà renvoyés par getPendingSettlements() /
// getOverdueBuckets() : aucune requête, aucune nouvelle math métier, aucune écriture.
// Elles regroupent et additionnent des montants DÉJÀ figés — même nature que le
// « Net cumulé » de l'historique. Un règlement garde toujours son état propre :
// markPaid() ne s'applique jamais à un agrégat, seulement à un settlement_id réel.

/** Solde net d'un joueur, toutes rooms compensées, sur ses règlements lockés non payés. */
export interface PlayerPendingGroup {
  player_id: number;
  player_name: string;
  settlements: HubSettlement[];
  count: number;
  /**
   * Σ amount_due_usdt SIGNÉE, toutes rooms confondues. Les sens opposés se compensent
   * d'eux-mêmes puisque le signe porte déjà l'information (>0 ça rentre / <0 ça sort) :
   * +300 (il nous doit sur KKPOKER) − 500 (on lui doit sur A5NUTS) = −200 → on lui doit 200.
   * Sert à décider du virement final ; le détail par room reste dans `rooms` + `settlements`
   * pour la traçabilité. Jamais persisté.
   */
  net_usdt: number;
  incoming_usdt: number;   // Σ des règlements > 0 — ce qui rentre, avant compensation
  outgoing_usdt: number;   // Σ |règlements < 0| — ce qui sort
  /** Détail par room : ce qui justifie le net global. */
  rooms: { label: string; color: string; base_path: string; net_usdt: number; count: number }[];
  oldest_age_days: number;
}

/**
 * Un groupe par joueur, tous ses règlements lockés de toutes les rooms.
 * Tri : le plus vieux lock d'abord (= le plus urgent), puis |net| décroissant.
 */
export function groupPendingByPlayer(pending: HubSettlement[]): PlayerPendingGroup[] {
  const byPlayer = new Map<number, PlayerPendingGroup>();

  for (const s of pending) {
    let g = byPlayer.get(s.player_id);
    if (!g) {
      g = {
        player_id: s.player_id, player_name: s.player_name,
        settlements: [], count: 0,
        net_usdt: 0, incoming_usdt: 0, outgoing_usdt: 0,
        rooms: [], oldest_age_days: 0,
      };
      byPlayer.set(s.player_id, g);
    }
    g.settlements.push(s);
    g.count++;
    g.net_usdt += s.amount_due_usdt;
    if (s.amount_due_usdt > 0) g.incoming_usdt += s.amount_due_usdt;
    else if (s.amount_due_usdt < 0) g.outgoing_usdt += -s.amount_due_usdt;
    if (s.age_days > g.oldest_age_days) g.oldest_age_days = s.age_days;

    const room = g.rooms.find(r => r.label === s.room_label);
    if (room) { room.net_usdt += s.amount_due_usdt; room.count++; }
    else g.rooms.push({ label: s.room_label, color: s.room_color, base_path: s.room_base_path, net_usdt: s.amount_due_usdt, count: 1 });
  }

  const out = [...byPlayer.values()];
  for (const g of out) {
    // Dans le dépli : le plus ancien lock en haut, comme la vue plate triée par ancienneté.
    g.settlements.sort((a, b) => b.age_days - a.age_days || a.room_label.localeCompare(b.room_label));
    g.rooms.sort((a, b) => a.label.localeCompare(b.label));
  }
  out.sort((a, b) => (b.oldest_age_days - a.oldest_age_days) || (Math.abs(b.net_usdt) - Math.abs(a.net_usdt)) || a.player_name.localeCompare(b.player_name));
  return out;
}

/**
 * Semaines impayées regroupées par (joueur, room).
 *
 * ATTENTION — `net_brut_usdt` est la somme des `OverdueBucket.net_usdt`, donc un net JOUEUR
 * BRUT (retraits − dépôts) : aucun action_pct n'y est appliqué, puisqu'aucun règlement
 * n'existe encore. Ce n'est PAS un « total dû » et ça ne doit jamais être présenté comme tel
 * (un net de 10 000 à 20 % se lirait sinon comme une dette de 10 000). Le montant dû
 * n'existera qu'au règlement dans la room.
 */
export interface PlayerOverdueGroup {
  player_id: number;
  player_name: string;
  room_label: string;
  room_color: string;
  room_base_path: string;
  buckets: OverdueBucket[];
  weeks_count: number;
  net_brut_usdt: number;
  tx_count: number;
  unconvertible: number;
  oldest_week_monday: string;
  oldest_week_label: string;
  max_weeks_late: number;
  /** Pire cas du groupe : critical dès qu'une seule semaine du groupe l'est. */
  severity: "late" | "critical";
  never_settled: boolean;
}

/** Tri : plus vieille semaine impayée d'abord (l'ancienneté est ce qui fait mal). */
export function groupOverdueByPlayer(buckets: OverdueBucket[]): PlayerOverdueGroup[] {
  const byKey = new Map<string, PlayerOverdueGroup>();

  for (const b of buckets) {
    const key = `${b.player_id}|${b.room_label}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        player_id: b.player_id, player_name: b.player_name,
        room_label: b.room_label, room_color: b.room_color, room_base_path: b.room_base_path,
        buckets: [], weeks_count: 0, net_brut_usdt: 0, tx_count: 0, unconvertible: 0,
        oldest_week_monday: b.week_monday, oldest_week_label: b.week_label,
        max_weeks_late: 0, severity: "late", never_settled: b.never_settled,
      };
      byKey.set(key, g);
    }
    g.buckets.push(b);
    g.weeks_count++;
    g.net_brut_usdt += b.net_usdt;
    g.tx_count += b.tx_count;
    g.unconvertible += b.unconvertible;
    if (b.week_monday < g.oldest_week_monday) { g.oldest_week_monday = b.week_monday; g.oldest_week_label = b.week_label; }
    if (b.weeks_late > g.max_weeks_late) g.max_weeks_late = b.weeks_late;
    if (b.severity === "critical") g.severity = "critical";
    if (b.never_settled) g.never_settled = true;
  }

  const out = [...byKey.values()];
  for (const g of out) g.buckets.sort((a, b) => a.week_monday.localeCompare(b.week_monday));
  out.sort((a, b) =>
    a.oldest_week_monday.localeCompare(b.oldest_week_monday) ||
    (b.weeks_count - a.weeks_count) ||
    a.player_name.localeCompare(b.player_name)
  );
  return out;
}

// ── Header totals ────────────────────────────────────────

export interface PaymentsTotals {
  // Renommés 2026-07-25 : les anciens noms (owed_to_players / owed_by_players) affirmaient le
  // sens INVERSE de la réalité et ont fait afficher les totaux à l'envers dans le hub ET dans
  // le résumé Telegram quotidien. due > 0 = le joueur doit au Cercle, cf. computeTotals().
  incoming_usdt: number;   // Σ due des règlements en attente où due > 0 — entrées attendues
  outgoing_usdt: number;   // Σ |due| des règlements en attente où due < 0 — sorties à faire
  pending_count: number;
  overdue_count: number;
  oldest_pending_days: number;
  /**
   * Unsettled txs with game_id IS NULL (the column is ON DELETE SET NULL). They are
   * unreachable from every settle flow — getAvailableTransactions filters on game_id — so
   * they can never be settled and would otherwise be invisible here too. Surfaced as a count
   * so forgotten money has somewhere to show up rather than nowhere.
   */
  unassigned_tx: number;
}

/** Unsettled, real-source transactions attached to no game — unsettleable by construction. */
export function getUnassignedTxCount(): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n FROM wallet_transactions
    WHERE game_id IS NULL AND settled = 0 AND source IN ('sync', 'manual')
  `).get() as { n: number };
  return row?.n ?? 0;
}

export function getPaymentsTotals(pending?: HubSettlement[], overdue?: OverdueBucket[]): PaymentsTotals {
  const p = pending ?? getPendingSettlements();
  const o = overdue ?? getOverdueBuckets();
  let incoming = 0, outgoing = 0, oldest = 0;
  for (const s of p) {
    if (s.amount_due_usdt > 0) incoming += s.amount_due_usdt;
    else if (s.amount_due_usdt < 0) outgoing += -s.amount_due_usdt;
    if (s.age_days > oldest) oldest = s.age_days;
  }
  return {
    incoming_usdt: incoming,
    outgoing_usdt: outgoing,
    pending_count: p.length,
    overdue_count: o.length,
    oldest_pending_days: oldest,
    unassigned_tx: getUnassignedTxCount(),
  };
}

export function getManualSettlementHistory(gameId: GameScope): ManualSettlementRow[] {
  const db = getDb();
  const ids = scopeIds(gameId);
  const placeholders = ids.map(() => "?").join(", ");
  return db.prepare(`
    SELECT ms.id, ms.game_id, ms.player_id, p.name AS player_name,
           ms.net_selected_usdt, ms.action_pct_applied, ms.amount_due_usdt,
           ms.status, ms.tx_hash, ms.notes, ms.locked_at, ms.paid_at, ms.paid_date, ms.created_at,
           (SELECT COUNT(*) FROM wallet_transactions wt WHERE wt.settlement_id = ms.id) AS tx_count
    FROM manual_settlements ms
    JOIN players p ON p.id = ms.player_id
    WHERE ms.game_id IN (${placeholders})
    ORDER BY ms.created_at DESC, ms.id DESC
  `).all(...ids) as ManualSettlementRow[];
}
