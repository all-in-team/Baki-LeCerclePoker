import { getDb } from "@/lib/db";
import { convertCnyToUsdt, getCnyRate } from "@/lib/currency";

// ── Types ────────────────────────────────────────────────

interface AffRel {
  id: number;
  affiliate_player_id: number;
  referred_player_id: number;
  origin_game_id: number;
  start_date: string;
  status: string;
  disclosed_action_pct: number | null;
  disclosed_rakeback_pct: number | null;
  disclosed_insurance_pct: number | null;
  exclude_agency_extras: number;
  notes: string | null;
}

interface Deal {
  action_pct: number;
  rakeback_pct: number;
  insurance_pct: number;
  start_date: string | null;
  end_date: string | null;
}

export interface GameBreakdown {
  game_id: number;
  game_name: string;
  rate: number;
  rate_label: "éligible" | "hors_fenetre";
  agency_pnl_lifetime: number;
  earned_lifetime: number;
  paid_lifetime: number;
  due_now: number;
  // ── Additive audit-trail fields (NO math change — intermediate values only) ──
  player_pnl_lifetime: number | null; // raw player net BEFORE ×action (wallet); null for Wepoker composite
  effective_action_pct: number;       // the disclosed action % applied (the "deal agence %")
  currency: string;                   // native currency of the driver: 'USDT' | 'CNY'
  agency_pnl_native: number;          // agency P&L in native currency (= agency_pnl_lifetime for USDT)
  cny_rate_missing: boolean;          // true if Wepoker CNY→USDT rate is unset (=0)
  is_composite: boolean;              // Wepoker uses winnings/rake/insurance formula, not a single net×action
}

// Structured result of the agency P&L computation — exposes intermediates for audit.
interface AgencyPnLDetail {
  agency_pnl: number;       // USDT — IDENTICAL to the legacy scalar return (drives earned/due)
  player_pnl: number | null;
  effective_action_pct: number;
  currency: string;
  agency_pnl_native: number;
  cny_rate_missing: boolean;
  is_composite: boolean;
}

export interface WindowStatus {
  is_open: boolean;
  days_remaining?: number;
  days_elapsed?: number;
}

export interface CommissionResult {
  relationship_id: number;
  affiliate: { id: number; name: string; telegram_handle: string | null };
  referred: { id: number; name: string; telegram_handle: string | null };
  breakdown: GameBreakdown[];
  total_due_now: number;
  total_earned_lifetime: number;
  total_paid_lifetime: number;
  last_paid_at: string | null;
  window_status: WindowStatus;
}

export interface AffiliateGroup {
  affiliate: { id: number; name: string; telegram_handle: string | null };
  total_due: number;
  relationships: CommissionResult[];
}

// ── 1. Commission rate ──────────────────────────────────

function getCommissionRate(
  rel: AffRel,
  gameId: number,
): { rate: number; label: "éligible" | "hors_fenetre" } {
  const db = getDb();
  const pgd = db.prepare(
    `SELECT created_at FROM player_game_deals WHERE player_id = ? AND game_id = ?`
  ).get(rel.referred_player_id, gameId) as { created_at: string | null } | undefined;

  if (!pgd?.created_at) return { rate: 0, label: "hors_fenetre" };

  const relStart = new Date(rel.start_date + "T00:00:00Z");
  const dealCreated = new Date(pgd.created_at);
  const diffDays = (dealCreated.getTime() - relStart.getTime()) / (1000 * 86400);

  return diffDays <= 30
    ? { rate: 0.50, label: "éligible" }
    : { rate: 0, label: "hors_fenetre" };
}

export function getEligibilityWindowStatus(rel: AffRel): WindowStatus {
  const now = new Date();
  const relStart = new Date(rel.start_date + "T00:00:00Z");
  const daysSince = Math.floor((now.getTime() - relStart.getTime()) / (1000 * 86400));
  if (daysSince <= 30) return { is_open: true, days_remaining: 30 - daysSince };
  return { is_open: false, days_elapsed: daysSince - 30 };
}

// Affiliation status for ONE referred player — used by the CRM player page (/crm/[id]) to show a
// simple eligibility line. Reuses getEligibilityWindowStatus (relStart-based 30-day window), so it
// stays consistent with the /crm/affiliates branches badge. expires_on = relStart + 30 days (the
// last eligible day; window is open while daysSince <= 30).
export interface PlayerAffiliation {
  affiliated: boolean;
  agent: { id: number; name: string; telegram_handle: string | null } | null;
  start_date: string | null;
  is_open: boolean;
  expires_on: string | null; // YYYY-MM-DD
}
export function getPlayerAffiliation(playerId: number): PlayerAffiliation {
  const db = getDb();
  const empty: PlayerAffiliation = { affiliated: false, agent: null, start_date: null, is_open: false, expires_on: null };
  const rel = db.prepare(
    `SELECT * FROM affiliate_relationships WHERE referred_player_id = ? AND status = 'active' ORDER BY start_date DESC LIMIT 1`
  ).get(playerId) as AffRel | undefined;
  if (!rel) return empty;

  const agent = db.prepare(
    `SELECT id, name, telegram_handle FROM players WHERE id = ?`
  ).get(rel.affiliate_player_id) as { id: number; name: string; telegram_handle: string | null } | undefined;

  const win = getEligibilityWindowStatus(rel);
  const relStart = new Date(rel.start_date + "T00:00:00Z");
  const expires_on = new Date(relStart.getTime() + 30 * 86400000).toISOString().slice(0, 10);

  return {
    affiliated: true,
    agent: agent ? { id: agent.id, name: agent.name, telegram_handle: agent.telegram_handle } : null,
    start_date: rel.start_date,
    is_open: win.is_open,
    expires_on,
  };
}

// ── 2. Disclosed agency P&L ─────────────────────────────
// Mirrors the real agency P&L formula from lib/queries.ts
// but substitutes disclosed rates when provided.

function getAgencyPnLDisclosed(
  referredPlayerId: number,
  gameId: number,
  rel: AffRel,
): AgencyPnLDetail {
  const db = getDb();
  const zero: AgencyPnLDetail = { agency_pnl: 0, player_pnl: 0, effective_action_pct: 0, currency: "USDT", agency_pnl_native: 0, cny_rate_missing: false, is_composite: false };

  const deal = db.prepare(
    `SELECT action_pct, rakeback_pct, COALESCE(insurance_pct, 0) AS insurance_pct, start_date, end_date
     FROM player_game_deals WHERE player_id = ? AND game_id = ?`
  ).get(referredPlayerId, gameId) as Deal | undefined;

  if (!deal) return zero;

  const perGame = db.prepare(
    `SELECT disclosed_action_pct, disclosed_rakeback_pct, disclosed_insurance_pct, excluded
     FROM affiliate_relationship_games WHERE relationship_id = ? AND game_id = ?`
  ).get(rel.id, gameId) as { disclosed_action_pct: number | null; disclosed_rakeback_pct: number | null; disclosed_insurance_pct: number | null; excluded: number } | undefined;

  if (perGame?.excluded) return zero;

  const game = db.prepare(
    `SELECT name, perceived_action_pct, perceived_rakeback_pct, perceived_insurance_pct FROM games WHERE id = ?`
  ).get(gameId) as { name: string; perceived_action_pct: number | null; perceived_rakeback_pct: number | null; perceived_insurance_pct: number | null } | undefined;
  if (!game) return zero;

  // Cascade: per-relation-game → game perceived → relation-level → deal
  const effAction = perGame?.disclosed_action_pct ?? game.perceived_action_pct ?? rel.disclosed_action_pct ?? deal.action_pct;
  const effRb = perGame?.disclosed_rakeback_pct ?? game.perceived_rakeback_pct ?? rel.disclosed_rakeback_pct ?? deal.rakeback_pct;
  const effIns = perGame?.disclosed_insurance_pct ?? game.perceived_insurance_pct ?? rel.disclosed_insurance_pct ?? deal.insurance_pct;

  if (game.name === "Wepoker") {
    // Rakeback-based P&L (CNY) — mirrors getWepokerPnL lines 1242-1267
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(re.winnings_amount), 0) AS winnings,
        COALESCE(SUM(re.amount), 0) AS rake,
        COALESCE(SUM(re.insurance_amount), 0) AS insurance
      FROM rakeback_entries re
      JOIN rakeback_reports rr ON rr.id = re.report_id
      LEFT JOIN player_game_deals pgd ON pgd.player_id = re.player_id AND pgd.game_id = rr.game_id
      WHERE re.player_id = ? AND rr.game_id = ?
        AND (pgd.start_date IS NULL OR COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) >= pgd.start_date)
    `).get(referredPlayerId, gameId) as { winnings: number; rake: number; insurance: number };

    const agencyCny =
      row.winnings * effAction / 100 +
      row.rake * effRb / 100 +
      row.insurance * effIns / 100;

    const cnyRate = getCnyRate();
    return {
      agency_pnl: convertCnyToUsdt(agencyCny, cnyRate), // identical to legacy: convertCnyToUsdt(agencyCny, getCnyRate())
      player_pnl: null,
      effective_action_pct: effAction,
      currency: "CNY",
      agency_pnl_native: agencyCny,
      cny_rate_missing: cnyRate === 0,
      is_composite: true,
    };
  }

  // Wallet-based P&L (USDT) — mirrors getWalletSummaryByPlayer lines 377-394
  const conditions: string[] = [
    `wt.player_id = ?`,
    `wt.game_id = ?`,
    `(wt.source IS NULL OR wt.source != 'unknown')`,
  ];
  const params: unknown[] = [referredPlayerId, gameId];

  if (deal.start_date) {
    conditions.push(`wt.tx_datetime >= ?`);
    params.push(deal.start_date);
  }
  if (deal.end_date) {
    conditions.push(`wt.tx_datetime <= ?`);
    params.push(deal.end_date);
  }

  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) AS net
    FROM wallet_transactions wt
    WHERE ${conditions.join(" AND ")}
  `).get(...params) as { net: number };

  const agency_pnl = row.net * effAction / 100; // identical to legacy return
  return {
    agency_pnl,
    player_pnl: row.net,
    effective_action_pct: effAction,
    currency: "USDT",
    agency_pnl_native: agency_pnl,
    cny_rate_missing: false,
    is_composite: false,
  };
}

// ── 3. Compute commission for one relationship ──────────

export function computeAffiliateCommission(relationshipId: number): CommissionResult | null {
  const db = getDb();

  const rel = db.prepare(`
    SELECT ar.*,
      a.name AS aff_name, a.telegram_handle AS aff_handle,
      r.name AS ref_name, r.telegram_handle AS ref_handle
    FROM affiliate_relationships ar
    JOIN players a ON a.id = ar.affiliate_player_id
    JOIN players r ON r.id = ar.referred_player_id
    WHERE ar.id = ?
  `).get(relationshipId) as (AffRel & {
    aff_name: string; aff_handle: string | null;
    ref_name: string; ref_handle: string | null;
  }) | undefined;

  if (!rel) return null;

  const games = db.prepare(
    `SELECT DISTINCT pgd.game_id, g.name AS game_name
     FROM player_game_deals pgd
     JOIN games g ON g.id = pgd.game_id
     WHERE pgd.player_id = ?`
  ).all(rel.referred_player_id) as { game_id: number; game_name: string }[];

  const breakdown: GameBreakdown[] = [];

  for (const g of games) {
    const { rate, label } = getCommissionRate(rel, g.game_id);
    const detail = getAgencyPnLDisclosed(rel.referred_player_id, g.game_id, rel);
    const agencyPnl = detail.agency_pnl;
    // NOTE: per-(rel,game) floor REMOVED — negatives must propagate up to the agent-level
    // cumul (cross-makeup). The single max(0) now lives in computeAgentCommission.
    // earned_lifetime here is the SIGNED raw contribution (agencyPnl × rate), informational only.
    const earnedLifetime = agencyPnl * rate;

    const paidRow = db.prepare(
      `SELECT COALESCE(SUM(amount_usdt), 0) AS paid
       FROM affiliate_payments WHERE relationship_id = ? AND game_id = ?`
    ).get(relationshipId, g.game_id) as { paid: number };

    const dueNow = Math.max(0, earnedLifetime - paidRow.paid);

    breakdown.push({
      game_id: g.game_id,
      game_name: g.game_name,
      rate,
      rate_label: label,
      agency_pnl_lifetime: agencyPnl,
      earned_lifetime: earnedLifetime,
      paid_lifetime: paidRow.paid,
      due_now: dueNow,
      player_pnl_lifetime: detail.player_pnl,
      effective_action_pct: detail.effective_action_pct,
      currency: detail.currency,
      agency_pnl_native: detail.agency_pnl_native,
      cny_rate_missing: detail.cny_rate_missing,
      is_composite: detail.is_composite,
    });
  }

  const lastPaidRow = db.prepare(
    `SELECT MAX(paid_at) AS last_paid_at FROM affiliate_payments WHERE relationship_id = ?`
  ).get(relationshipId) as { last_paid_at: string | null };

  return {
    relationship_id: relationshipId,
    affiliate: { id: rel.affiliate_player_id, name: rel.aff_name, telegram_handle: rel.aff_handle },
    referred: { id: rel.referred_player_id, name: rel.ref_name, telegram_handle: rel.ref_handle },
    breakdown,
    window_status: getEligibilityWindowStatus(rel),
    total_due_now: breakdown.reduce((s, b) => s + b.due_now, 0),
    total_earned_lifetime: breakdown.reduce((s, b) => s + b.earned_lifetime, 0),
    total_paid_lifetime: breakdown.reduce((s, b) => s + b.paid_lifetime, 0),
    last_paid_at: lastPaidRow.last_paid_at,
  };
}

// ── 4. AGENT-LEVEL commission (cross-makeup + carry-forward) ──────────────
// Validated formula (Baki, money-critical):
//   cumul_agence = Σ part_agence_lifetime over ALL active filleuls × ELIGIBLE games
//                  (positives AND negatives mixed — cross-makeup)
//   earned       = max(0, cumul_agence) × 0.50   (single floor, at agent level)
//   due_now      = max(0, earned − paid_agent)   (carry-forward is automatic since
//                  cumul is lifetime: a past loss stays in the sum until future gains fill it)

export interface AgentFilleulLine {
  relationship_id: number;
  referred: { id: number; name: string; telegram_handle: string | null };
  part_agence_eligible: number; // signed Σ of this filleul's eligible per-game agency P&L
}

export interface AgentCommissionResult {
  affiliate_player_id: number;
  cumul_agence_eligible: number; // signed — can be negative (carry-forward debt)
  earned: number;                // max(0, cumul) × 0.50
  paid: number;                  // Σ all payments across the agent's relationships (any status)
  due_now: number;               // max(0, earned − paid)
  filleuls: AgentFilleulLine[];
}

export function computeAgentCommission(affiliatePlayerId: number): AgentCommissionResult {
  const db = getDb();

  const rels = db.prepare(
    `SELECT id FROM affiliate_relationships WHERE affiliate_player_id = ? AND status = 'active'`
  ).all(affiliatePlayerId) as { id: number }[];

  let cumul = 0;
  const filleuls: AgentFilleulLine[] = [];
  for (const { id } of rels) {
    const c = computeAffiliateCommission(id);
    if (!c) continue;
    // Eligible games only (deal within the 30-day window → rate_label 'éligible').
    const partEligible = c.breakdown
      .filter(b => b.rate_label === "éligible")
      .reduce((s, b) => s + b.agency_pnl_lifetime, 0);
    cumul += partEligible;
    filleuls.push({ relationship_id: id, referred: c.referred, part_agence_eligible: partEligible });
  }

  // paid = every payment ever made on ANY of the agent's relationships (status-agnostic,
  // so money paid is never lost from the ledger).
  const paidRow = db.prepare(
    `SELECT COALESCE(SUM(amount_usdt), 0) AS paid
     FROM affiliate_payments
     WHERE relationship_id IN (SELECT id FROM affiliate_relationships WHERE affiliate_player_id = ?)`
  ).get(affiliatePlayerId) as { paid: number };

  const earned = Math.max(0, cumul) * 0.50;
  const due_now = Math.max(0, earned - paidRow.paid);

  return {
    affiliate_player_id: affiliatePlayerId,
    cumul_agence_eligible: cumul,
    earned,
    paid: paidRow.paid,
    due_now,
    filleuls,
  };
}

// ── 5. All pending payouts grouped by affiliate (agent-level) ─────────

export function getPendingPayoutsForAllAffiliates(): AffiliateGroup[] {
  const db = getDb();
  const agents = db.prepare(
    `SELECT DISTINCT affiliate_player_id FROM affiliate_relationships WHERE status = 'active'`
  ).all() as { affiliate_player_id: number }[];

  const groups: AffiliateGroup[] = [];
  for (const { affiliate_player_id } of agents) {
    const ac = computeAgentCommission(affiliate_player_id);
    if (ac.due_now <= 0) continue;
    const player = db.prepare(
      `SELECT id, name, telegram_handle FROM players WHERE id = ?`
    ).get(affiliate_player_id) as { id: number; name: string; telegram_handle: string | null } | undefined;
    groups.push({
      affiliate: { id: affiliate_player_id, name: player?.name ?? `#${affiliate_player_id}`, telegram_handle: player?.telegram_handle ?? null },
      total_due: ac.due_now,
      relationships: [],
    });
  }

  return groups.sort((a, b) => b.total_due - a.total_due);
}
