// QQPK STAKING — pure C/T calculation engine.
//
// PURE FUNCTION. No DB access, no side effects, fully unit-testable. Isolated BY DESIGN
// from lib/settlement-engine.ts (the production weekly TELE engine) — the two share
// nothing. Phase 3 ships this engine + its table; the UI (Phase 4) and the dashboard
// rollup (Phase 5) are NOT here.
//
// MODEL (validated business logic — do not deviate):
//   resultat_periode = on-chain net of the month = withdrawals − deposits (USDT)
//   C = c_prec + resultat_periode            cumulative net over the block (1 calendar month)
//   C < 0  → T = 0.70 × (−C)                 Cercle advanced 70% of the cumulative loss → owed TO the player
//   C ≥ 0  → T = −0.30 × C                   player owes 30% of the cumulative profit
//   reglement = T − t_prec
//
// SIGN CONVENTION (MONEY-CRITICAL — FROZEN HERE, do not reinterpret downstream):
//   reglement > 0  → Cercle PAYS the player  → cash OUT → operator P&L NEGATIVE
//   reglement < 0  → player PAYS the Cercle   → cash IN  → operator P&L POSITIVE
//   ⇒ operator P&L contribution = −reglement   (use operatorPnlFromReglement, never inline the sign)
//
// 30k-HANDS CONDITION (checked ONLY at end-of-block settlement, is_final_settlement=true):
//   • mains < 30000 AND C < 0 (loss): the Cercle does NOT cover → the player bears 100%
//     of the loss. Coverage T is forced to 0; reglement = 0 − t_prec then claws back any
//     provisional coverage shown earlier in the block, so NET Cercle coverage = 0.
//   • C ≥ 0 (gain): the 70/30 split ALWAYS applies, even under 30000 hands. The condition
//     never bites on a profit.
//
// BLOCK RESET (caller responsibility, Phase 4): after the final settlement of a block, the
// next block opens fresh with c_prec = 0 and t_prec = 0 ("solde au C final, puis C=0/T=0").
// This engine is per-step and never carries state itself.

export const QQPK_HANDS_THRESHOLD = 30000; // mains floor below which losses are not covered
export const QQPK_LOSS_COVERAGE = 0.70;    // Cercle covers 70% of cumulative loss
export const QQPK_PROFIT_SHARE = 0.30;     // Cercle takes 30% of cumulative profit

export interface StakingBlockInput {
  c_prec: number;               // cumulative net carried from the previous period (USDT)
  t_prec: number;               // settled position carried from the previous period (USDT)
  resultat_periode: number;     // this period's on-chain net = withdrawals − deposits (USDT)
  mains: number;                // hands played in the block so far (manual entry)
  is_final_settlement: boolean; // true ONLY for the closing settlement of a block (30k gate)
}

export interface StakingBlockResult {
  c: number;                      // new cumulative net
  t: number;                      // new settled position
  reglement: number;              // T − t_prec  (>0 Cercle pays player, <0 player pays Cercle)
  condition_30k_applied: boolean; // true iff the no-coverage rule actively suppressed coverage
}

export function computeStakingBlock(input: StakingBlockInput): StakingBlockResult {
  const { c_prec, t_prec, resultat_periode, mains, is_final_settlement } = input;

  const c = c_prec + resultat_periode;

  let t: number;
  let condition_30k_applied = false;

  if (c < 0) {
    // Cumulative loss. Default: Cercle advances 70% of it (owed to the player).
    if (is_final_settlement && mains < QQPK_HANDS_THRESHOLD) {
      // 30k condition fires: no coverage at all — the player bears 100% of the loss.
      t = 0;
      condition_30k_applied = true;
    } else {
      t = QQPK_LOSS_COVERAGE * -c;
    }
  } else {
    // Cumulative profit (C ≥ 0). Player owes 30% — ALWAYS, even under 30000 hands.
    t = -QQPK_PROFIT_SHARE * c;
  }

  // Normalize a computed -0 (e.g. -0.30 × 0) to +0 so downstream display / equality is clean.
  if (Object.is(t, -0)) t = 0;

  const reglement = t - t_prec;

  return { c, t, reglement, condition_30k_applied };
}

// Operator P&L contribution of a règlement, per the FROZEN sign convention above.
// This is the ONLY place the reglement→operator-P&L sign flip lives. Phase 5's dashboard
// rollup MUST go through this helper (operator contribution = −Σ reglement).
export function operatorPnlFromReglement(reglement: number): number {
  return -reglement;
}

// ── PROJECTION (décision Baki, jul 2026) ─────────────────────────────────────
// Prévisionnel du cycle en cours: the as-if-covered 70/30 split, INCLUDING losses
// under 30k hands. The 30k gate stays a settlement-time rule (computeStakingBlock,
// is_final_settlement=true, unchanged above) — the projection deliberately ignores
// it so the board shows the real exposure of the cycle, and flags the projection
// as CONDITIONAL instead (below 30k at cycle end → coverage cancelled, réglable 0).
//
// Implementation reuses the EXISTING split branch: a non-final step of the engine
// is exactly the as-if-covered computation (the gate only fires at final settlement).
// No math is duplicated here.

export interface StakingProjection {
  c: number;                    // cumulative net (same as the real computation)
  t_projected: number;          // as-if-covered position (70% loss / −30% profit)
  reglement_projected: number;  // t_projected − t_prec (same sign convention as reglement)
  conditional_30k: boolean;     // c<0 AND mains<30k → this coverage is conditional (0 réglable today)
}

export function projectStakingBlock(input: Omit<StakingBlockInput, "is_final_settlement">): StakingProjection {
  const res = computeStakingBlock({ ...input, is_final_settlement: false });
  return {
    c: res.c,
    t_projected: res.t,
    reglement_projected: res.reglement,
    conditional_30k: res.c < 0 && input.mains < QQPK_HANDS_THRESHOLD,
  };
}
