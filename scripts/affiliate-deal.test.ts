/**
 * Harnais du parsing de deal NEXA et du contrôle Affiliate Payment.
 * Run: npx tsx scripts/affiliate-deal.test.ts
 *
 * Porte sur le VRAI module (lib/funnels/nexa/affiliate-deal.ts), importé tel quel :
 * aucune réimplémentation de la grammaire ni du recalcul ici. Le module étant pur
 * (zéro import, zéro DB), il n'y a rien à stubber et rien à nettoyer.
 *
 * Cas couverts :
 *   parseDealRates  — nominal, casse, espaces multiples, virgule finale, % collé,
 *                     décimal, variante en double, inconnue, absente, vide, null,
 *                     non-chaîne, taux hors bornes, décimal à la française
 *   recomputePayment— l'exemple de référence du brief
 *   validateRow     — nominal, faute de frappe, bords exacts de la tolérance,
 *                     semaine perdante (montants négatifs), variante absente avec
 *                     et sans montant, montants non finis, nickname vide
 */

import {
  parseDealRates, recomputePayment, validateRow,
  PAYMENT_TOLERANCE, VARIANTS,
  type RawAffiliateRow, type DealRates,
} from "../lib/funnels/nexa/affiliate-deal";

let passed = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log("   ✔", label); }
  else { failures.push(`${label}${detail ? ` → ${detail}` : ""}`); console.log("   ✘", label, detail); }
}
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(label, g === w, g === w ? "" : `attendu ${w}, obtenu ${g}`);
}

/** Taux du deal de référence. */
const REF: DealRates = { nlh: 40, mtt: 40, plo: 45, spins: 55 };
const REF_TEXT = "40% NLH and MTT, 45% PLO, 55% Spins";

/** Raccourci : ne garde que les taux d'un parse réussi (échec → le code). */
function rates(input: unknown): DealRates | string {
  const r = parseDealRates(input);
  return r.ok ? r.rates : r.code;
}

console.log("\n══ parseDealRates — formes acceptées ══");
eq("format de référence", rates(REF_TEXT), REF);
eq("casse libre", rates("40% nlh AND mtt, 45% Plo, 55% SPINS"), REF);
eq("espaces multiples", rates("40%    NLH   and    MTT ,   45%  PLO ,  55%   Spins"), REF);
eq("virgule finale", rates("40% NLH and MTT, 45% PLO, 55% Spins,"), REF);
eq("virgules doublées", rates("40% NLH and MTT,, 45% PLO, 55% Spins"), REF);
eq("pourcentage collé", rates("40%NLH and MTT, 45%PLO, 55%SPINS"), REF);
eq("espace avant le %", rates("40 % NLH and MTT, 45 % PLO, 55 % Spins"), REF);
eq("séparateur &", rates("40% NLH & MTT, 45% PLO, 55% Spins"), REF);
eq("séparateur +", rates("40% NLH + MTT, 45% PLO, 55% Spins"), REF);
eq("taux décimal", rates("42.5% NLH and MTT, 45% PLO, 55% Spins"),
   { nlh: 42.5, mtt: 42.5, plo: 45, spins: 55 });
eq("taux 0 explicite", rates("0% NLH, 40% MTT, 45% PLO, 55% Spins"),
   { nlh: 0, mtt: 40, plo: 45, spins: 55 });
eq("taux 100", rates("100% NLH, 40% MTT, 45% PLO, 55% Spins"),
   { nlh: 100, mtt: 40, plo: 45, spins: 55 });
eq("une seule variante", rates("40% NLH"), { nlh: 40, mtt: 0, plo: 0, spins: 0 });
eq("les 4 séparément", rates("10% NLH, 20% MTT, 30% PLO, 40% Spins"),
   { nlh: 10, mtt: 20, plo: 30, spins: 40 });

console.log("\n══ parseDealRates — variante absente : taux 0 SIGNALÉ ══");
{
  const p = parseDealRates("40% NLH and MTT, 45% PLO");
  check("parse OK", p.ok);
  if (p.ok) {
    eq("spins à 0", p.rates.spins, 0);
    eq("spins listée dans missing", p.missing, ["spins"]);
  }
}
{
  const p = parseDealRates(REF_TEXT);
  check("aucune variante manquante sur le deal complet", p.ok && p.missing.length === 0);
}

console.log("\n══ parseDealRates — rejets explicites ══");
function rejectCase(label: string, input: unknown, code: string, fragment?: string | null) {
  const p = parseDealRates(input);
  if (p.ok) { check(label, false, `attendu un rejet ${code}, obtenu un succès`); return; }
  check(`${label} → ${p.code}`, p.code === code, p.code === code ? "" : `attendu ${code}`);
  // Le texte brut doit TOUJOURS revenir, c'est lui qu'on réaffiche à l'opérateur.
  // Sur une entrée chaîne (le seul cas réel : la grille envoie du texte), à
  // l'identique. Sur une entrée aberrante — bug d'appelant — on exige seulement
  // une chaîne : `asRaw` en donne une représentation plutôt que de perdre l'info.
  if (typeof input === "string") {
    check(`${label} : brut conservé à l'identique`, p.raw === input, `raw=${JSON.stringify(p.raw)}`);
  } else {
    check(`${label} : brut représentable`, typeof p.raw === "string", `raw=${JSON.stringify(p.raw)}`);
  }
  check(`${label} : message non vide`, p.message.length > 0);
  if (fragment !== undefined) eq(`${label} : fragment fautif`, p.fragment, fragment);
}
rejectCase("texte vide", "", "empty", null);
rejectCase("espaces seuls", "   ", "empty", null);
rejectCase("null", null, "empty", null);
rejectCase("undefined", undefined, "empty", null);
rejectCase("nombre", 40, "empty", null);
rejectCase("objet", { pct: 40 }, "empty", null);
rejectCase("virgules seules", ",,,", "no_variant", null);
rejectCase("variante inconnue NLHE", "40% NLHE, 45% PLO", "unknown_variant", "NLHE");
rejectCase("alias non inventé : HOLDEM", "40% HOLDEM", "unknown_variant", "HOLDEM");
rejectCase("alias non inventé : OMAHA", "45% OMAHA", "unknown_variant", "OMAHA");
rejectCase("alias non inventé : Global Spins", "55% Global Spins", "unknown_variant", "Global Spins");
rejectCase("alias non inventé : SPIN au singulier", "55% Spin", "unknown_variant", "Spin");
rejectCase("variante en double", "40% NLH and MTT, 45% NLH", "duplicate_variant", "NLH");
rejectCase("variante en double dans le même segment", "40% NLH and NLH", "duplicate_variant", "NLH");
rejectCase("pas de %", "40 NLH and MTT", "segment_unparsable", "40 NLH and MTT");
rejectCase("taux manquant", "% NLH", "segment_unparsable", "% NLH");
rejectCase("taux > 100", "140% NLH", "rate_out_of_range", "140% NLH");
rejectCase("taux négatif", "-5% NLH", "segment_unparsable", "-5% NLH");
rejectCase("décimal à la française (limite documentée)", "42,5% NLH", "segment_unparsable", "42");
rejectCase("variantes accolées sans séparateur", "40% NLH MTT", "unknown_variant", "NLH MTT");
rejectCase("prose libre", "on est à 40 pourcent", "segment_unparsable", "on est à 40 pourcent");

console.log("\n══ recomputePayment ══");
{
  // L'exemple de référence : 800×40% + 200×40% + 400×45% + 100×55% = 320+80+180+55
  const got = recomputePayment({ nlh: 800, mtt: 200, plo: 400, spins: 100 }, REF);
  check("exemple du brief = 635.00", Math.abs(got - 635) < 1e-9, `obtenu ${got}`);
  eq("taux 0 partout → 0", recomputePayment({ nlh: 800, mtt: 200, plo: 400, spins: 100 },
     { nlh: 0, mtt: 0, plo: 0, spins: 0 }), 0);
  const neg = recomputePayment({ nlh: -500, mtt: 0, plo: 0, spins: 0 }, REF);
  check("montant négatif → commission négative", Math.abs(neg - -200) < 1e-9, `obtenu ${neg}`);
  check("pas d'arrondi interne",
        Math.abs(recomputePayment({ nlh: 1, mtt: 0, plo: 0, spins: 0 }, { nlh: 33.33, mtt: 0, plo: 0, spins: 0 }) - 0.3333) < 1e-12);
}

console.log("\n══ validateRow ══");
const baseRow = (over: Partial<RawAffiliateRow> = {}): RawAffiliateRow => ({
  nickname: "Jopok", member_id: "2518550", deal_text: REF_TEXT,
  nlh: 800, mtt: 200, plo: 400, spins: 100, affiliate_payment: 635, ...over,
});

{
  const v = validateRow(baseRow());
  check("ligne nominale acceptée", v.ok);
  if (v.ok) {
    eq("taux appliqués", v.rates, REF);
    check("recalcul = 635", Math.abs(v.recomputed - 635) < 1e-9, `obtenu ${v.recomputed}`);
    check("écart nul", Math.abs(v.delta) < 1e-9);
    eq("aucune variante à taux 0 signalée", v.zeroRated, []);
  }
}
{
  // Faute de frappe : 404 au lieu de 440 sur un autre jeu de montants.
  const v = validateRow(baseRow({ nlh: 950, mtt: 150, plo: 0, spins: 0, affiliate_payment: 404 }));
  check("faute de frappe rejetée", !v.ok);
  if (!v.ok) {
    eq("code", v.code, "payment_mismatch");
    check("attendu remonté (440)", v.expected !== null && Math.abs(v.expected - 440) < 1e-9, `expected=${v.expected}`);
    check("écart remonté (+36)", v.delta !== null && Math.abs(v.delta - 36) < 1e-9, `delta=${v.delta}`);
    check("deal brut conservé", v.raw_deal === REF_TEXT);
    check("message chiffré", /440\.00/.test(v.message) && /404\.00/.test(v.message), v.message);
  }
}
{
  const justIn = validateRow(baseRow({ affiliate_payment: 635 - PAYMENT_TOLERANCE }));
  check("écart pile à la tolérance → accepté", justIn.ok);
  const justOut = validateRow(baseRow({ affiliate_payment: 635 - PAYMENT_TOLERANCE - 0.001 }));
  check("écart juste au-delà → rejeté", !justOut.ok && justOut.code === "payment_mismatch");
  const cent = validateRow(baseRow({ affiliate_payment: 635.01 }));
  check("écart d'un centime → accepté", cent.ok);
}
{
  // Semaine perdante : tous les montants négatifs, commission négative.
  const v = validateRow(baseRow({ nlh: -800, mtt: -200, plo: -400, spins: -100, affiliate_payment: -635 }));
  check("semaine perdante acceptée (montants négatifs)", v.ok);
  if (v.ok) check("commission négative", Math.abs(v.recomputed - -635) < 1e-9, `${v.recomputed}`);
}
{
  const v = validateRow(baseRow({ nlh: 0, mtt: 0, plo: 0, spins: 0, affiliate_payment: 0 }));
  check("semaine à zéro acceptée", v.ok);
}
{
  // Variante absente du deal, montant nul → toléré et SIGNALÉ.
  const v = validateRow(baseRow({ deal_text: "40% NLH and MTT, 45% PLO", spins: 0, affiliate_payment: 580 }));
  check("variante absente + montant 0 → acceptée", v.ok);
  if (v.ok) {
    eq("spins signalée en taux 0", v.zeroRated, ["spins"]);
    eq("taux spins", v.rates.spins, 0);
  }
}
{
  // Variante absente du deal, montant non nul → REJET DUR.
  const v = validateRow(baseRow({ deal_text: "40% NLH and MTT, 45% PLO", spins: 100, affiliate_payment: 635 }));
  check("variante absente + montant ≠ 0 → rejetée", !v.ok);
  if (!v.ok) {
    eq("code", v.code, "variant_missing_with_amount");
    eq("variante fautive", v.fragment, "spins");
    check("montant cité dans le message", /100/.test(v.message), v.message);
  }
}
{
  const v = validateRow(baseRow({ deal_text: "40% NLHE and MTT" }));
  check("deal invalide propagé", !v.ok);
  if (!v.ok) {
    eq("code propagé", v.code, "unknown_variant");
    eq("fragment propagé", v.fragment, "NLHE");
    check("brut propagé", v.raw_deal === "40% NLHE and MTT");
  }
}
{
  for (const v of VARIANTS) {
    const r = validateRow(baseRow({ [v]: NaN } as Partial<RawAffiliateRow>));
    check(`montant ${v.toUpperCase()} NaN rejeté`, !r.ok && r.code === "amount_not_finite");
  }
  const inf = validateRow(baseRow({ nlh: Infinity }));
  check("montant Infinity rejeté", !inf.ok && inf.code === "amount_not_finite");
  const str = validateRow(baseRow({ nlh: "800" as unknown as number }));
  check("montant en chaîne rejeté (pas de coercition)", !str.ok && str.code === "amount_not_finite");
  const pay = validateRow(baseRow({ affiliate_payment: NaN }));
  check("Affiliate Payment NaN rejeté", !pay.ok && pay.code === "amount_not_finite");
}
{
  check("nickname vide rejeté", (() => { const v = validateRow(baseRow({ nickname: "" })); return !v.ok && v.code === "nickname_empty"; })());
  check("nickname blanc rejeté", (() => { const v = validateRow(baseRow({ nickname: "   " })); return !v.ok && v.code === "nickname_empty"; })());
  check("member_id absent accepté", validateRow(baseRow({ member_id: null })).ok);
  check("member_id vide accepté", validateRow(baseRow({ member_id: "" })).ok);
}
{
  // La tolérance du module doit rester alignée sur le CHECK de la base.
  eq("PAYMENT_TOLERANCE = 0.02 (aligné sur le CHECK SQL)", PAYMENT_TOLERANCE, 0.02);
}

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} passés, ${failures.length} échoués`);
if (failures.length) { failures.forEach(f => console.log("   ✘", f)); process.exit(1); }
