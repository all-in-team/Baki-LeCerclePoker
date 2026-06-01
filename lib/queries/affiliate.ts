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

// ── 2. Disclosed agency P&L ─────────────────────────────
// Mirrors the real agency P&L formula from lib/queries.ts
// but substitutes disclosed rates when provided.

function getAgencyPnLDisclosed(
  referredPlayerId: number,
  gameId: number,
  rel: AffRel,
): number {
  const db = getDb();

  const deal = db.prepare(
    `SELECT action_pct, rakeback_pct, COALESCE(insurance_pct, 0) AS insurance_pct, start_date, end_date
     FROM player_game_deals WHERE player_id = ? AND game_id = ?`
  ).get(referredPlayerId, gameId) as Deal | undefined;

  if (!deal) return 0;

  const perGame = db.prepare(
    `SELECT disclosed_action_pct, disclosed_rakeback_pct, disclosed_insurance_pct
     FROM affiliate_relationship_games WHERE relationship_id = ? AND game_id = ?`
  ).get(rel.id, gameId) as { disclosed_action_pct: number | null; disclosed_rakeback_pct: number | null; disclosed_insurance_pct: number | null } | undefined;

  const game = db.prepare(
    `SELECT name, perceived_action_pct, perceived_rakeback_pct, perceived_insurance_pct FROM games WHERE id = ?`
  ).get(gameId) as { name: string; perceived_action_pct: number | null; perceived_rakeback_pct: number | null; perceived_insurance_pct: number | null } | undefined;
  if (!game) return 0;

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

    return convertCnyToUsdt(agencyCny, getCnyRate());
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

  return row.net * effAction / 100;
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
    const agencyPnl = getAgencyPnLDisclosed(rel.referred_player_id, g.game_id, rel);
    const earnedLifetime = Math.max(0, agencyPnl * rate);

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

// ── 4. All pending payouts grouped by affiliate ─────────

export function getPendingPayoutsForAllAffiliates(): AffiliateGroup[] {
  const db = getDb();
  const rels = db.prepare(
    `SELECT id FROM affiliate_relationships WHERE status = 'active'`
  ).all() as { id: number }[];

  const commissions: CommissionResult[] = [];
  for (const r of rels) {
    const c = computeAffiliateCommission(r.id);
    if (c && c.total_due_now > 0) commissions.push(c);
  }

  const grouped = new Map<number, AffiliateGroup>();
  for (const c of commissions) {
    const key = c.affiliate.id;
    if (!grouped.has(key)) {
      grouped.set(key, { affiliate: c.affiliate, total_due: 0, relationships: [] });
    }
    const g = grouped.get(key)!;
    g.relationships.push(c);
    g.total_due += c.total_due_now;
  }

  return [...grouped.values()].sort((a, b) => b.total_due - a.total_due);
}
