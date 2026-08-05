// Tests du moteur de rakeback NEXAPOKER (module pur, zéro DB).
// Run: npx tsx scripts/nexa-rakeback-engine.test.ts
// Lives under scripts/ (exclu du tsconfig) : ne touche jamais le build Next.
//
// Assertions float-safe (invariant #9 : jamais de === sur des montants).
//
// Les chaînes « réelles » (ImLePAD, SistheR) reprennent au chiffre près les
// lignes de nexa_affiliate_weeks au 2026-08-05. Si le report est ré-uploadé et
// que ces semaines bougent, ces cas doivent être re-figés à la main : ils sont
// là pour verrouiller le REJEU, pas pour suivre la base.

import {
  computeRakeback,
  settleableWeeks,
  type WeekInput,
  type RakebackPeriod,
  type ActionPeriod,
  type EngineConfig,
} from "../lib/funnels/nexa/rakeback-engine";

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

function is<T>(label: string, actual: T, expected: T) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${label}: ${String(actual)}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}: got ${String(actual)}, expected ${String(expected)}`);
  }
}

/** Semaine du report, avec des défauts neutres : on ne saisit que ce qui compte. */
function week(week_start: string, p: Partial<WeekInput> = {}): WeekInput {
  return {
    week_start,
    gross_rake: 0,
    affiliate_commission: 0,
    check_ok: true,
    winloss: null,
    ...p,
  };
}

const NO_ACTION: ActionPeriod[] = [];
/** Défaut « settings » du projet : nexa_default_rakeback_pct / _basis. */
const SETTINGS: EngineConfig = { defaultPct: 0, defaultBasis: "affiliate_commission" };

// ─────────────────────────────────────────────────────────────────────────────
// 1. SistheR — 3 semaines à 0 de rake : AUCUN dû, AUCUNE ligne de règlement.
//    (nexa_affiliate_weeks, player_id 4 : 07-13 / 07-20 / 07-27 tout à zéro.)
// ─────────────────────────────────────────────────────────────────────────────
console.log("SistheR — 3 semaines à 0 de rake :");
{
  const weeks = [week("2026-07-13"), week("2026-07-20"), week("2026-07-27")];
  const periods: RakebackPeriod[] = [
    { pct: 40, basis: "gross_rake", start_week: "2026-07-06", end_week: null, makeup_carry: "carry" },
  ];
  // Part d'action réelle de SistheR : 50 % depuis le 2026-07-06.
  const action: ActionPeriod[] = [{ pct: 50, start_week: "2026-07-06", end_week: null }];

  const r = computeRakeback(weeks, periods, action, SETTINGS);

  is("3 semaines calculées", r.weeks.length, 3);
  for (const w of r.weeks) {
    is(`${w.week_start} status`, w.status, "ok");
    eq(`${w.week_start} base`, w.base, 0);
    eq(`${w.week_start} dû`, w.due, 0);
    eq(`${w.week_start} makeup_out`, w.makeup_out, 0);
    // Un rake nul n'est pas une perte : il ne doit pas créer de makeup fantôme.
    is(`${w.week_start} pas de -0 sur makeup_out`, Object.is(w.makeup_out, -0), false);
  }
  eq("total dû", r.totals.due, 0);
  eq("makeup final", r.makeup_final, 0);
  is("aucune semaine bloquée", r.blocked.length, 0);
  // Le point du cas : zéro ligne poussée vers le règlement, pas trois lignes à 0.
  is("AUCUNE ligne réglable", settleableWeeks(r).length, 0);

  // Le win/loss n'est pas saisi → on n'invente pas un 0.
  is("action_amount null (win/loss non saisi)", r.weeks[0].action_amount, null);
  is("net_operator null (win/loss non saisi)", r.weeks[0].net_operator, null);
  is("compteur semaines sans win/loss", r.totals.weeks_missing_winloss, 3);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. ImLePAD — chaîne réelle sur ses 3 semaines (player_id 3).
//    07-13 : rien · 07-20 : rake NÉGATIF (−41.40) → makeup · 07-27 : +296.12,
//    le makeup se reporte SUR L'ASSIETTE avant application du %.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nImLePAD — chaîne réelle (rake négatif au 20.07 qui se reporte) :");
{
  // Valeurs brutes du report, gardées en somme visible (nlh + plo + spins).
  const weeks = [
    week("2026-07-13", { gross_rake: 0, affiliate_commission: 0 }),
    week("2026-07-20", { gross_rake: -61.46 + 17.05 + 3.01, affiliate_commission: -15.26 }),
    week("2026-07-27", { gross_rake: 288.87 + 1 + 6.25, affiliate_commission: 119.44 }),
  ];
  const periods: RakebackPeriod[] = [
    { pct: 40, basis: "gross_rake", start_week: "2026-07-06", end_week: null, makeup_carry: "carry" },
  ];
  const r = computeRakeback(weeks, periods, NO_ACTION, SETTINGS);
  const [s1, s2, s3] = r.weeks;

  // S1 — semaine vide : rien de dû, rien à reporter.
  eq("S1 base", s1.base, 0);
  eq("S1 dû", s1.due, 0);
  eq("S1 makeup_out", s1.makeup_out, 0);

  // S2 — rake négatif : aucun dû, le déficit part en makeup (et PAS en dû négatif).
  eq("S2 base (rake négatif)", s2.base, -41.4);
  eq("S2 makeup_in", s2.makeup_in, 0);
  eq("S2 base_net", s2.base_net, -41.4);
  eq("S2 dû (jamais négatif)", s2.due, 0);
  eq("S2 makeup_out", s2.makeup_out, -41.4);

  // S3 — le makeup s'applique À L'ASSIETTE, avant le pourcentage.
  eq("S3 base", s3.base, 296.12);
  eq("S3 makeup_in", s3.makeup_in, -41.4);
  eq("S3 base_net (296.12 − 41.40)", s3.base_net, 254.72);
  eq("S3 dû = base_net × 40 %", s3.due, 101.888);
  eq("S3 makeup_out (soldé)", s3.makeup_out, 0);

  // Le piège que ce cas verrouille : appliquer le % PUIS retrancher le makeup
  // donnerait 296.12 × 40 % − 41.40 = 77.048. Ce n'est PAS la règle.
  is("≠ pct-puis-makeup (77.048)", approx(s3.due, 77.048), false);

  eq("total dû", r.totals.due, 101.888);
  eq("makeup final soldé", r.makeup_final, 0);
  is("1 seule ligne réglable (la 07-27)", settleableWeeks(r).length, 1);
  is("ligne réglable = 2026-07-27", settleableWeeks(r)[0].week_start, "2026-07-27");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 bis. Même joueur, base = affiliate_commission : la chaîne suit l'autre
//        assiette (−15.26 puis 119.44), pas le rake brut.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nImLePAD — même semaines, base affiliate_commission :");
{
  const weeks = [
    week("2026-07-13"),
    week("2026-07-20", { gross_rake: -41.4, affiliate_commission: -15.26 }),
    week("2026-07-27", { gross_rake: 296.12, affiliate_commission: 119.44 }),
  ];
  const periods: RakebackPeriod[] = [
    { pct: 40, basis: "affiliate_commission", start_week: "2026-07-06", end_week: null, makeup_carry: "carry" },
  ];
  const r = computeRakeback(weeks, periods, NO_ACTION, SETTINGS);

  eq("S2 base = commission", r.weeks[1].base, -15.26);
  eq("S2 makeup_out", r.weeks[1].makeup_out, -15.26);
  eq("S3 base_net (119.44 − 15.26)", r.weeks[2].base_net, 104.18);
  eq("S3 dû = 104.18 × 40 %", r.weeks[2].due, 41.672);
  is("base retenue", r.weeks[2].basis, "affiliate_commission");
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Cas d'arbitrage : S1 base −200 → S2 base 300, pct 50 % → dû 50.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nS1 −200 → S2 +300 à 50 % → dû 50 :");
{
  const weeks = [
    week("2026-07-13", { gross_rake: -200 }),
    week("2026-07-20", { gross_rake: 300 }),
  ];
  const periods: RakebackPeriod[] = [
    { pct: 50, basis: "gross_rake", start_week: "2026-07-06", end_week: null, makeup_carry: "carry" },
  ];
  const r = computeRakeback(weeks, periods, NO_ACTION, SETTINGS);

  eq("S1 dû", r.weeks[0].due, 0);
  eq("S1 makeup_out", r.weeks[0].makeup_out, -200);
  eq("S2 makeup_in", r.weeks[1].makeup_in, -200);
  eq("S2 base_net", r.weeks[1].base_net, 100);
  eq("S2 dû (100 × 50 %)", r.weeks[1].due, 50);
  eq("S2 makeup_out", r.weeks[1].makeup_out, 0);
  // Le contre-exemple explicite de la spec : 150 − 200 = −50 serait faux.
  is("≠ 150 − 200", approx(r.weeks[1].due, -50), false);
  is("1 ligne réglable", settleableWeeks(r).length, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 bis. Makeup qui survit à plusieurs semaines sans jamais être soldé.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nMakeup qui traverse plusieurs semaines déficitaires :");
{
  const weeks = [
    week("2026-07-06", { gross_rake: -100 }),
    week("2026-07-13", { gross_rake: -50 }),
    week("2026-07-20", { gross_rake: 60 }),
    week("2026-07-27", { gross_rake: 200 }),
  ];
  const periods: RakebackPeriod[] = [
    { pct: 50, basis: "gross_rake", start_week: "2026-07-06", end_week: null, makeup_carry: "carry" },
  ];
  const r = computeRakeback(weeks, periods, NO_ACTION, SETTINGS);

  eq("S1 makeup_out", r.weeks[0].makeup_out, -100);
  eq("S2 makeup_out (cumulé)", r.weeks[1].makeup_out, -150);
  eq("S3 base_net (60 − 150)", r.weeks[2].base_net, -90);
  eq("S3 dû (toujours rien)", r.weeks[2].due, 0);
  eq("S3 makeup_out", r.weeks[2].makeup_out, -90);
  eq("S4 base_net (200 − 90)", r.weeks[3].base_net, 110);
  eq("S4 dû (110 × 50 %)", r.weeks[3].due, 55);
  eq("makeup final soldé", r.makeup_final, 0);
  is("1 seule ligne réglable sur 4 semaines", settleableWeeks(r).length, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 ter. Le rejeu ne dépend pas de l'ordre d'arrivée des lignes : un report
//        ré-uploadé dans le désordre doit donner la même chaîne.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nRejeu indépendant de l'ordre d'entrée :");
{
  const periods: RakebackPeriod[] = [
    { pct: 50, basis: "gross_rake", start_week: "2026-07-06", end_week: null, makeup_carry: "carry" },
  ];
  const desordre = [
    week("2026-07-20", { gross_rake: 300 }),
    week("2026-07-13", { gross_rake: -200 }),
  ];
  const r = computeRakeback(desordre, periods, NO_ACTION, SETTINGS);

  is("1re semaine rejouée = la plus ancienne", r.weeks[0].week_start, "2026-07-13");
  eq("dû de la 07-20 identique", r.weeks[1].due, 50);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. check_ok = 0 → la chaîne de makeup est COUPÉE.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\ncheck_ok = 0 → chaîne coupée :");
{
  const weeks = [
    week("2026-07-13", { gross_rake: 100 }),
    week("2026-07-20", { gross_rake: 500, check_ok: false }),
    week("2026-07-27", { gross_rake: 400 }),
  ];
  const periods: RakebackPeriod[] = [
    { pct: 50, basis: "gross_rake", start_week: "2026-07-06", end_week: null, makeup_carry: "carry" },
  ];
  const r = computeRakeback(weeks, periods, NO_ACTION, SETTINGS);

  // La semaine saine AVANT la coupure reste calculée et réglable.
  is("S1 status", r.weeks[0].status, "ok");
  eq("S1 dû (50 % de 100)", r.weeks[0].due, 50);

  // La semaine en échec : bloquée, rien de dû, assiette non fiable.
  is("S2 status", r.weeks[1].status, "blocked");
  eq("S2 dû", r.weeks[1].due, 0);
  is("S2 motif renseigné", r.weeks[1].blocked_reason !== null, true);
  is("S2 net_operator null", r.weeks[1].net_operator, null);

  // Et TOUT l'aval est bloqué : une assiette fausse ne doit pas contaminer la suite.
  is("S3 status (aval coupé)", r.weeks[2].status, "blocked");
  eq("S3 dû", r.weeks[2].due, 0);
  is("S3 motif = chaîne coupée en amont", r.weeks[2].blocked_reason?.includes("Chaîne coupée") ?? false, true);

  is("2 semaines bloquées", r.blocked.length, 2);
  is("blocked = les deux dernières", r.blocked.join(","), "2026-07-20,2026-07-27");
  eq("total dû = la seule semaine saine", r.totals.due, 50);
  is("1 seule ligne réglable", settleableWeeks(r).length, 1);
  is("ligne réglable = 2026-07-13", settleableWeeks(r)[0].week_start, "2026-07-13");

  // NON VERROUILLÉ ICI, EN ATTENTE D'ARBITRAGE : totals.gross_rake et
  // totals.commission somment TOUTES les semaines (bloquées comprises), alors
  // que totals.due / action_amount / net_operator ne somment que les « ok ».
  // Les quatre totaux ne se réconcilient donc pas entre eux dès qu'une semaine
  // est bloquée. Idem net_operator, qui compte 0 pour une semaine sans win/loss
  // au lieu de rester incalculable comme au niveau semaine. Ces agrégats
  // resteront sans assertion tant que la règle n'est pas tranchée.
}

// ─────────────────────────────────────────────────────────────────────────────
// 4 bis. La part d'action est un flux INDÉPENDANT : un contrôle de rake en
//        échec ne rend pas le win/loss saisi à la main faux.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nPart d'action sur une semaine bloquée (flux indépendant) :");
{
  const weeks = [week("2026-07-20", { gross_rake: 500, check_ok: false, winloss: -300 })];
  const action: ActionPeriod[] = [{ pct: 50, start_week: "2026-07-06", end_week: null }];
  const r = computeRakeback(weeks, [], action, SETTINGS);

  is("semaine bloquée", r.weeks[0].status, "blocked");
  eq("part d'action calculée quand même", r.weeks[0].action_amount!, -150);
  eq("win/loss inchangé", r.weeks[0].winloss!, -300);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Changement de basis — le makeup se reporte ou se purge, sur choix EXPLICITE.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nChangement de basis — makeup_carry = 'carry' (report + alerte) :");
{
  const weeks = [
    week("2026-07-20", { gross_rake: -200, affiliate_commission: -80 }),
    week("2026-07-27", { gross_rake: 400, affiliate_commission: 300 }),
  ];
  const periods: RakebackPeriod[] = [
    { pct: 50, basis: "gross_rake", start_week: "2026-07-06", end_week: "2026-07-20", makeup_carry: "carry" },
    { pct: 50, basis: "affiliate_commission", start_week: "2026-07-27", end_week: null, makeup_carry: "carry" },
  ];
  const r = computeRakeback(weeks, periods, NO_ACTION, SETTINGS);

  is("S1 basis", r.weeks[0].basis, "gross_rake");
  eq("S1 makeup_out (sur rake brut)", r.weeks[0].makeup_out, -200);

  is("S2 basis", r.weeks[1].basis, "affiliate_commission");
  eq("S2 base = commission", r.weeks[1].base, 300);
  eq("S2 makeup_in (reporté malgré le changement d'unité)", r.weeks[1].makeup_in, -200);
  eq("S2 base_net", r.weeks[1].base_net, 100);
  eq("S2 dû", r.weeks[1].due, 50);

  // Reporter un makeup « rake brut » sur une assiette « commission » mélange
  // deux unités : le moteur le fait, mais il doit le DIRE.
  is("1 alerte émise", r.warnings.length, 1);
  is("alerte sur la bonne semaine", r.warnings[0].week_start, "2026-07-27");
  is("alerte mentionne le changement de base", r.warnings[0].message.includes("gross_rake"), true);
}

console.log("\nChangement de basis — makeup_carry = 'reset' (purge + alerte) :");
{
  const weeks = [
    week("2026-07-20", { gross_rake: -200, affiliate_commission: -80 }),
    week("2026-07-27", { gross_rake: 400, affiliate_commission: 300 }),
  ];
  const periods: RakebackPeriod[] = [
    { pct: 50, basis: "gross_rake", start_week: "2026-07-06", end_week: "2026-07-20", makeup_carry: "carry" },
    { pct: 50, basis: "affiliate_commission", start_week: "2026-07-27", end_week: null, makeup_carry: "reset" },
  ];
  const r = computeRakeback(weeks, periods, NO_ACTION, SETTINGS);

  eq("S2 makeup_in purgé", r.weeks[1].makeup_in, 0);
  eq("S2 base_net = assiette pleine", r.weeks[1].base_net, 300);
  eq("S2 dû (300 × 50 %)", r.weeks[1].due, 150);
  is("1 alerte de purge", r.warnings.length, 1);
  is("alerte dit 'purgé'", r.warnings[0].message.includes("purgé"), true);
}

console.log("\nChangement de pct seul (même base) — le makeup se reporte sans alerte :");
{
  const weeks = [
    week("2026-07-20", { gross_rake: -200 }),
    week("2026-07-27", { gross_rake: 400 }),
  ];
  const periods: RakebackPeriod[] = [
    { pct: 50, basis: "gross_rake", start_week: "2026-07-06", end_week: "2026-07-20", makeup_carry: "carry" },
    { pct: 30, basis: "gross_rake", start_week: "2026-07-27", end_week: null, makeup_carry: "carry" },
  ];
  const r = computeRakeback(weeks, periods, NO_ACTION, SETTINGS);

  eq("S2 pct appliqué", r.weeks[1].rakeback_pct, 30);
  eq("S2 makeup_in reporté", r.weeks[1].makeup_in, -200);
  eq("S2 dû (200 × 30 %)", r.weeks[1].due, 60);
  is("aucune alerte (même unité d'assiette)", r.warnings.length, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Défauts « settings » quand aucune période ne couvre la semaine.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nDéfaut settings quand aucune période ne couvre la semaine :");
{
  const weeks = [week("2026-07-20", { gross_rake: 500, affiliate_commission: 200 })];
  const r = computeRakeback(weeks, [], NO_ACTION, { defaultPct: 40, defaultBasis: "affiliate_commission" });

  is("basis par défaut", r.weeks[0].basis, "affiliate_commission");
  eq("pct par défaut", r.weeks[0].rakeback_pct, 40);
  eq("assiette = commission, pas le rake brut", r.weeks[0].base, 200);
  eq("dû (200 × 40 %)", r.weeks[0].due, 80);

  // Défaut réel du projet : pct 0 → rien de dû, et donc aucune ligne à régler.
  const r0 = computeRakeback(weeks, [], NO_ACTION, SETTINGS);
  eq("avec le défaut projet (pct 0) : dû", r0.weeks[0].due, 0);
  is("aucune ligne réglable à 0 %", settleableWeeks(r0).length, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Part d'action : assiette = win/loss manuel, jamais écrasé, jamais supposé.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nPart d'action = win/loss manuel :");
{
  const weeks = [
    week("2026-07-13", { gross_rake: 100, affiliate_commission: 40, winloss: 1000 }),
    week("2026-07-20", { gross_rake: 100, affiliate_commission: 40, winloss: -600 }),
    week("2026-07-27", { gross_rake: 100, affiliate_commission: 40, winloss: null }),
  ];
  const action: ActionPeriod[] = [{ pct: 50, start_week: "2026-07-06", end_week: null }];
  const periods: RakebackPeriod[] = [
    { pct: 40, basis: "gross_rake", start_week: "2026-07-06", end_week: null, makeup_carry: "carry" },
  ];
  const r = computeRakeback(weeks, periods, action, SETTINGS);

  // L'action porte les deux sens : gain ET perte.
  eq("action sur un gain", r.weeks[0].action_amount!, 500);
  eq("action sur une perte", r.weeks[1].action_amount!, -300);
  // Non saisi ≠ zéro.
  is("action null si non saisi", r.weeks[2].action_amount, null);
  is("net_operator null si non saisi", r.weeks[2].net_operator, null);
  is("compteur semaines sans win/loss", r.totals.weeks_missing_winloss, 1);

  // Le rakeback ne touche pas au win/loss et réciproquement : deux flux.
  eq("dû S1 inchangé par l'action", r.weeks[0].due, 40);
  eq("net_operator S1 (40 − 40 + 500)", r.weeks[0].net_operator!, 500);

  // Une part d'action nulle (aucune période) ne doit pas inventer de montant.
  const sansAction = computeRakeback(weeks, periods, [], SETTINGS);
  eq("action_pct 0 sans période", sansAction.weeks[0].action_pct, 0);
  eq("action_amount 0 sans période", sansAction.weeks[0].action_amount!, 0);
}

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
