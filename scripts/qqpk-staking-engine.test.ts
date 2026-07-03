// Unit tests for the QQPK staking engine (pure C/T math).
// Run: npx tsx scripts/qqpk-staking-engine.test.ts
// Lives under scripts/ (excluded from tsconfig) so it never touches the Next build.
//
// Float-safe assertions (invariant #9: never compare money floats with ===).

import {
  computeStakingBlock,
  projectStakingBlock,
  operatorPnlFromReglement,
  QQPK_HANDS_THRESHOLD,
} from "../lib/qqpk-staking-engine";

let passed = 0;
let failed = 0;

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

function eq(label: string, actual: number, expected: number) {
  if (approx(actual, expected)) {
    passed++;
    console.log(`  ✓ ${label}: ${actual}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}: got ${actual}, expected ${expected}`);
  }
}

function isTrue(label: string, actual: boolean, expected: boolean) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${label}: ${actual}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}: got ${actual}, expected ${expected}`);
  }
}

// ── Spec example: S1 loss −1000, S2 gain +3000 within ONE block ──────────────
console.log("Spec example (S1 −1000, S2 +3000, ≥30k hands):");
{
  // S1: résultat −1000 → C=−1000 → T=+700 → Cercle verse 700
  const s1 = computeStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode: -1000, mains: 35000, is_final_settlement: false });
  eq("S1.c", s1.c, -1000);
  eq("S1.t", s1.t, 700);
  eq("S1.reglement (Cercle verse +700)", s1.reglement, 700);
  isTrue("S1.condition_30k_applied", s1.condition_30k_applied, false);

  // S2 (final): résultat +3000 → C=+2000 → T=−600 → reglement = −600 − 700 = −1300
  const s2 = computeStakingBlock({ c_prec: s1.c, t_prec: s1.t, resultat_periode: 3000, mains: 35000, is_final_settlement: true });
  eq("S2.c", s2.c, 2000);
  eq("S2.t", s2.t, -600);
  eq("S2.reglement (joueur verse 1300)", s2.reglement, -1300);
  isTrue("S2.condition_30k_applied", s2.condition_30k_applied, false);

  // Bilan: Σreglement = 700 − 1300 = −600 = T_final.
  const sumReglement = s1.reglement + s2.reglement;
  eq("Σreglement == T_final", sumReglement, s2.t);
  // Player keeps 1400 (70% of 2000 on-chain), Cercle keeps 600 (30%).
  const onChainTotal = 2000; // −1000 + 3000
  const cercleNet = -sumReglement; // operator P&L = −Σreglement
  eq("Cercle net == 30% of profit", cercleNet, 0.30 * onChainTotal); // 600
  eq("Player net == 70% of profit", onChainTotal - cercleNet, 0.70 * onChainTotal); // 1400
}

// ── 30k condition: LOSS under 30k hands at final settlement → no coverage ─────
console.log("30k condition — loss <30k hands (final): Cercle ne couvre pas:");
{
  const r = computeStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode: -1000, mains: 10000, is_final_settlement: true });
  eq("c", r.c, -1000);
  eq("t (no coverage)", r.t, 0);
  eq("reglement (Cercle verse 0)", r.reglement, 0);
  isTrue("condition_30k_applied", r.condition_30k_applied, true);
  eq("operator P&L (=−reglement, neutral)", operatorPnlFromReglement(r.reglement), 0);
}

// ── 30k condition: loss <30k but with prior provisional coverage → clawback ───
console.log("30k condition — loss <30k after interim coverage: clawback to net-zero:");
{
  // Interim (not final): coverage accrues normally.
  const interim = computeStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode: -1000, mains: 8000, is_final_settlement: false });
  eq("interim.t (provisional 700)", interim.t, 700);
  eq("interim.reglement (+700)", interim.reglement, 700);
  isTrue("interim.condition_30k_applied", interim.condition_30k_applied, false);

  // Final, still <30k, still a loss → T forced to 0, reglement claws back the 700.
  const final = computeStakingBlock({ c_prec: interim.c, t_prec: interim.t, resultat_periode: 0, mains: 8000, is_final_settlement: true });
  eq("final.t (no coverage)", final.t, 0);
  eq("final.reglement (claw back −700)", final.reglement, -700);
  isTrue("final.condition_30k_applied", final.condition_30k_applied, true);
  // Net Cercle coverage over the block = 700 + (−700) = 0 → player bears 100%.
  eq("net coverage over block == 0", interim.reglement + final.reglement, 0);
}

// ── 30k condition: GAIN under 30k hands → 70/30 STILL applies ────────────────
console.log("30k condition — gain <30k hands: split still applies (Cercle takes 30%):");
{
  const r = computeStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode: 3000, mains: 5000, is_final_settlement: true });
  eq("c", r.c, 3000);
  eq("t (=−30% of 3000)", r.t, -900);
  eq("reglement (joueur verse 900)", r.reglement, -900);
  isTrue("condition_30k_applied (false on gain)", r.condition_30k_applied, false);
  eq("operator P&L (=+900)", operatorPnlFromReglement(r.reglement), 900);
}

// ── Loss WITH ≥30k hands → normal 70% coverage ──────────────────────────────
console.log("Loss ≥30k hands: normal 70% coverage:");
{
  const r = computeStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode: -1000, mains: QQPK_HANDS_THRESHOLD, is_final_settlement: true });
  eq("t (=70% of 1000)", r.t, 700);
  eq("reglement (Cercle verse 700)", r.reglement, 700);
  isTrue("condition_30k_applied (≥30k → false)", r.condition_30k_applied, false);
}

// ── Reset: a fresh block opens at c_prec=0, t_prec=0 (caller responsibility) ──
console.log("Block reset — next block starts fresh after a settled block:");
{
  // Previous block ended at c=2000, t=−600. Next block resets to 0/0.
  const next = computeStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode: -500, mains: 31000, is_final_settlement: false });
  eq("next.c (no carry of 2000)", next.c, -500);
  eq("next.t (fresh 70% coverage)", next.t, 350);
  eq("next.reglement (+350)", next.reglement, 350);
}

// ═══ PROJECTION (projectStakingBlock) — prévisionnel as-if-covered ═══════════

// ── Projection: WIN → 30% au Cercle, identique au réel ────────────────────────
console.log("Projection — gain: −30% (identique au réel, ex. +382.46 → Cercle +114.74):");
{
  const p = projectStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode: 382.46, mains: 40000 });
  eq("c", p.c, 382.46);
  eq("t_projected (=−30%)", p.t_projected, -114.738);
  eq("reglement_projected", p.reglement_projected, -114.738);
  isTrue("conditional_30k (false on gain)", p.conditional_30k, false);
  // projected == real settlement for a gain (gate never bites on profit)
  const real = computeStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode: 382.46, mains: 40000, is_final_settlement: true });
  eq("projected == real (gain)", p.reglement_projected, real.reglement);
}

// ── Projection: perte COUVERTE (≥30k) → 70%, identique au réel ────────────────
console.log("Projection — perte ≥30k: 70% couverture (identique au réel):");
{
  const p = projectStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode: -1000, mains: 35000 });
  eq("t_projected (=70% de 1000)", p.t_projected, 700);
  eq("reglement_projected (+700)", p.reglement_projected, 700);
  isTrue("conditional_30k (≥30k → false)", p.conditional_30k, false);
  const real = computeStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode: -1000, mains: 35000, is_final_settlement: true });
  eq("projected == real (perte couverte)", p.reglement_projected, real.reglement);
}

// ── Projection: perte <30k → 70% QUAND MÊME (conditionnel), réel reste 0 ──────
console.log("Projection — perte <30k: prévisionnel −70% (conditionnel), réel (lock) = 0:");
{
  // Cas Xabi: perte 3000, <30k → exposition prévisionnelle 2100 (Cercle), Part Cercle −2100.
  const p = projectStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode: -3000, mains: 10000 });
  eq("c", p.c, -3000);
  eq("t_projected (=70% de 3000)", p.t_projected, 2100);
  eq("reglement_projected (+2100 au joueur)", p.reglement_projected, 2100);
  eq("Part Cercle prévisionnelle (=−règlement)", operatorPnlFromReglement(p.reglement_projected), -2100);
  isTrue("conditional_30k (perte + <30k → true)", p.conditional_30k, true);
  // LA RÈGLE DE SETTLEMENT NE CHANGE PAS: le réel (lock) reste 0 réglable.
  const real = computeStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode: -3000, mains: 10000, is_final_settlement: true });
  eq("réel au lock: t=0", real.t, 0);
  eq("réel au lock: reglement=0", real.reglement, 0);
  isTrue("réel au lock: condition_30k_applied", real.condition_30k_applied, true);
}

// ── Projection: résultat 0 → 0 partout ────────────────────────────────────────
console.log("Projection — résultat 0: tout à 0 (pas de −0):");
{
  const p = projectStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode: 0, mains: 0 });
  eq("c", p.c, 0);
  eq("t_projected", p.t_projected, 0);
  eq("reglement_projected", p.reglement_projected, 0);
  isTrue("pas de -0 (Object.is)", Object.is(p.t_projected, -0), false);
  isTrue("conditional_30k (c=0 n'est pas une perte)", p.conditional_30k, false);
}

// ── Projection: mix avec carry (c_prec/t_prec) → même branche que l'interim ───
console.log("Projection — mix avec carry: réutilise exactement la branche interim:");
{
  // carry perte −1000 déjà couverte 700, période +3000 → C=+2000 → T=−600, règlement −1300.
  const p = projectStakingBlock({ c_prec: -1000, t_prec: 700, resultat_periode: 3000, mains: 20000 });
  eq("c", p.c, 2000);
  eq("t_projected", p.t_projected, -600);
  eq("reglement_projected (joueur verse 1300)", p.reglement_projected, -1300);
  isTrue("conditional_30k (profit cumulé → false)", p.conditional_30k, false);
  const interim = computeStakingBlock({ c_prec: -1000, t_prec: 700, resultat_periode: 3000, mains: 20000, is_final_settlement: false });
  eq("projection ≡ branche interim (t)", p.t_projected, interim.t);
  eq("projection ≡ branche interim (règlement)", p.reglement_projected, interim.reglement);
}

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
