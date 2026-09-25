import { getDb } from "@/lib/db";
import { relationLinesOn, computeAgentCommissionOn, agentPortalViewOn, type BlockReason, type PortalAgentView } from "@/lib/affiliate/agent-rates";

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

export interface GameBreakdown {
  game_id: number;
  game_name: string;
  rate: number;
  rate_label: "éligible" | "hors_fenetre";
  agency_pnl_lifetime: number;
  earned_lifetime: number;
  paid_lifetime: number;
  due_now: number | null;             // null = part agence sans taux agent (incalculable, jamais un 0 inventé)
  // ── Additive audit-trail fields (NO math change — intermediate values only) ──
  player_pnl_lifetime: number | null; // raw player net BEFORE ×action (wallet); null for Wepoker composite
  effective_action_pct: number;       // the disclosed action % applied (the "deal agence %")
  currency: string;                   // native currency of the driver: 'USDT' | 'CNY'
  agency_pnl_native: number;          // agency P&L in native currency (= agency_pnl_lifetime for USDT)
  cny_rate_missing: boolean;          // true if Wepoker CNY→USDT rate is unset (=0)
  is_composite: boolean;              // Wepoker uses winnings/rake/insurance formula, not a single net×action
  // ── Taux agent versionné (affiliate_agent_rates) ──
  agent_pct_current: number | null;   // taux agent (POURCENT de la part agence) de la semaine en cours
  counted_part: number;               // Σ part agence des semaines à taux > 0
  unrated_part: number;               // Σ part agence des semaines SANS taux (≠ 0 ⇒ agent bloqué)
  unrated_weeks: (string | null)[];
  rate_periods: { id: number | null; agent_pct: number; start_week: string | null; end_week: string | null; kind: string; note: string | null; created_at: string | null; base_at_start: number | null }[];
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
  total_due_now: number | null;       // null dès qu'un game est incalculable
  total_earned_lifetime: number;
  total_paid_lifetime: number;
  last_paid_at: string | null;
  window_status: WindowStatus;
}

export interface AffiliateGroup {
  affiliate: { id: number; name: string; telegram_handle: string | null };
  total_due: number | null;   // null = agent BLOQUÉ (part agence sans taux) — listé, jamais payable
  relationships: CommissionResult[];
}

// ── 1. Taux agent ───────────────────────────────────────
// Plus de 0.50 en dur ni de règle des 30 jours relue ici : le taux agent vit dans
// affiliate_agent_rates, par (relation, game), versionné par semaine. La règle des
// 30 jours a été FIGÉE dans cette table à la migration (lib/affiliate/agent-rates-schema.ts).

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

// ── 2. Commission for one relationship ──────────────────
// Lecture game par game d'UNE relation, via le moteur (lib/affiliate/agent-rates.ts).
// `rate` = taux agent de la semaine en cours (fraction, informatif), `rate_label` =
// « éligible » si le game compte à un taux > 0 sur au moins une période — champs
// gardés pour les consommateurs existants (portail, drawers).

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

  const paidStmt = db.prepare(
    `SELECT COALESCE(SUM(amount_usdt), 0) AS paid
     FROM affiliate_payments WHERE relationship_id = ? AND game_id = ?`
  );

  const breakdown: GameBreakdown[] = relationLinesOn(db, relationshipId).map(l => {
    const paid = (paidStmt.get(relationshipId, l.game_id) as { paid: number }).paid;
    return {
      game_id: l.game_id,
      game_name: l.game_name,
      rate: l.current_pct === null ? 0 : l.current_pct / 100,
      rate_label: l.periods.some(p => p.agent_pct > 0) ? "éligible" : "hors_fenetre",
      agency_pnl_lifetime: l.part_agence,
      // Contribution SIGNÉE de ce game à la commission agent (Σ part × taux par semaine).
      earned_lifetime: l.commission,
      paid_lifetime: paid,
      due_now: l.unrated_weeks.length ? null : Math.max(0, l.commission - paid),
      player_pnl_lifetime: l.player_pnl,
      effective_action_pct: l.effective_action_pct,
      currency: l.currency,
      agency_pnl_native: l.agency_native,
      cny_rate_missing: l.cny_rate_missing,
      is_composite: l.is_composite,
      agent_pct_current: l.current_pct,
      counted_part: l.counted_part,
      unrated_part: l.unrated_part,
      unrated_weeks: l.unrated_weeks,
      rate_periods: l.periods.map((p, i) => ({
        id: p.id ?? null, agent_pct: p.agent_pct, start_week: p.start_week, end_week: p.end_week,
        kind: p.kind, note: p.note, created_at: p.created_at ?? null,
        base_at_start: l.period_eff[i],   // perçu au début de la période (null = composite) — affichage en % du résultat joueur
      })),
    };
  });

  const lastPaidRow = db.prepare(
    `SELECT MAX(paid_at) AS last_paid_at FROM affiliate_payments WHERE relationship_id = ?`
  ).get(relationshipId) as { last_paid_at: string | null };

  return {
    relationship_id: relationshipId,
    affiliate: { id: rel.affiliate_player_id, name: rel.aff_name, telegram_handle: rel.aff_handle },
    referred: { id: rel.referred_player_id, name: rel.ref_name, telegram_handle: rel.ref_handle },
    breakdown,
    window_status: getEligibilityWindowStatus(rel),
    total_due_now: breakdown.some(b => b.due_now === null) ? null : breakdown.reduce((s, b) => s + (b.due_now as number), 0),
    total_earned_lifetime: breakdown.reduce((s, b) => s + b.earned_lifetime, 0),
    total_paid_lifetime: breakdown.reduce((s, b) => s + b.paid_lifetime, 0),
    last_paid_at: lastPaidRow.last_paid_at,
  };
}

// ── 3. AGENT-LEVEL commission (cross-makeup + carry-forward) ──────────────
// Formule (Baki, money-critical, révisée 2026-09-26) — le détail vit dans le moteur :
//   commission(f, g, s) = part_agence(f, g, s) × taux_agent(f, g, s)   SIGNÉE, par semaine
//   earned              = max(0, Σ commission)       (taux AVANT compensation, un seul plancher)
//   due_now             = max(0, earned − paid_agent)
// earned / due_now valent null quand l'agent est BLOQUÉ (part agence sans taux) :
// jamais de zéro inventé, jamais de paiement sur un chiffre amputé.

export interface AgentFilleulLine {
  relationship_id: number;
  referred: { id: number; name: string; telegram_handle: string | null };
  part_agence_eligible: number; // signed Σ of this filleul's part agence over weeks counted (rate > 0)
  commission: number;           // signed Σ of this filleul's commission (part × rate, per week)
}

export interface AgentCommissionResult {
  affiliate_player_id: number;
  cumul_agence_eligible: number; // signed Σ part agence over weeks counted (rate > 0)
  commission_signed: number;     // signed Σ commission (before the single floor)
  earned: number | null;         // max(0, commission_signed) — null when blocked
  paid: number;                  // Σ all payments across the agent's relationships (any status)
  due_now: number | null;        // max(0, earned − paid) — null when blocked
  blocked: BlockReason[];
  frozen_through: string | null; // last Monday frozen by a payment
  filleuls: AgentFilleulLine[];
}

export function computeAgentCommission(affiliatePlayerId: number): AgentCommissionResult {
  const db = getDb();
  const d = computeAgentCommissionOn(db, affiliatePlayerId);
  const handles = new Map((db.prepare(
    `SELECT ar.id, p.telegram_handle FROM affiliate_relationships ar JOIN players p ON p.id = ar.referred_player_id WHERE ar.affiliate_player_id = ?`
  ).all(affiliatePlayerId) as { id: number; telegram_handle: string | null }[]).map(r => [r.id, r.telegram_handle]));
  const byRel = new Map<number, AgentFilleulLine>();
  for (const l of d.lines) {
    const f = byRel.get(l.relationship_id) ?? {
      relationship_id: l.relationship_id,
      referred: { id: l.referred.id, name: l.referred.name, telegram_handle: handles.get(l.relationship_id) ?? null },
      part_agence_eligible: 0, commission: 0,
    };
    f.part_agence_eligible += l.counted_part;
    f.commission += l.commission;
    byRel.set(l.relationship_id, f);
  }
  return {
    affiliate_player_id: affiliatePlayerId,
    cumul_agence_eligible: d.cumul_agence_eligible,
    commission_signed: d.commission_signed,
    earned: d.earned,
    paid: d.paid,
    due_now: d.due_now,
    blocked: d.blocked,
    frozen_through: d.frozen_through,
    filleuls: [...byRel.values()],
  };
}

// ── 4. All pending payouts grouped by affiliate (agent-level) ─────────

export function getPendingPayoutsForAllAffiliates(): AffiliateGroup[] {
  const db = getDb();
  const agents = db.prepare(
    `SELECT DISTINCT affiliate_player_id FROM affiliate_relationships WHERE status = 'active'`
  ).all() as { affiliate_player_id: number }[];

  const groups: AffiliateGroup[] = [];
  for (const { affiliate_player_id } of agents) {
    const ac = computeAgentCommission(affiliate_player_id);
    if (ac.due_now !== null && ac.due_now <= 0) continue;
    const player = db.prepare(
      `SELECT id, name, telegram_handle FROM players WHERE id = ?`
    ).get(affiliate_player_id) as { id: number; name: string; telegram_handle: string | null } | undefined;
    groups.push({
      affiliate: { id: affiliate_player_id, name: player?.name ?? `#${affiliate_player_id}`, telegram_handle: player?.telegram_handle ?? null },
      total_due: ac.due_now,
      relationships: [],
    });
  }

  // Bloqués en fin de liste : un dû incalculable ne se trie pas comme un zéro.
  return groups.sort((a, b) => (b.total_due ?? -Infinity) - (a.total_due ?? -Infinity));
}

// ── 5. Vue PORTAIL d'un agent (Mini App) — le calcul vit dans le moteur ────
export function agentPortalView(affiliatePlayerId: number): PortalAgentView {
  return agentPortalViewOn(getDb(), affiliatePlayerId);
}
