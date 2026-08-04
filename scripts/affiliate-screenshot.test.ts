/**
 * Harnais du post-traitement des screenshots NEXA.
 * Run: npx tsx scripts/affiliate-screenshot.test.ts
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────┐
 * │ Le post-traitement DÉTERMINISTE d'une transcription : plage de dates →  │
 * │ lundi ISO (chevauchements de mois et d'année compris), montants "$1,111.95"│
 * │ et négatifs, cellules vides = 0, ligne de total exclue, checksum, et la │
 * │ conversion en RawAffiliateRow.                                          │
 * └─────────────────────────────────────────────────────────────────────────┘
 * ┌─ CE QU'ILS NE PROUVENT PAS ─────────────────────────────────────────────┐
 * │ QUE LA LECTURE D'IMAGE EST CORRECTE. Les trois FIXTURES ci-dessous sont │
 * │ transcrites À LA MAIN depuis les screenshots réels d'Hugo — elles       │
 * │ figurent ce que le modèle vision DEVRAIT rendre, pas ce qu'il rend.     │
 * │ Aucun appel API n'a lieu ici. Le module vision se teste séparément,     │
 * │ avec une clé, sur les vraies images.                                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Les trois fixtures sont les reports du 13.07, 20.07 et 27.07 2026, avec le
 * deal « 40% NLH and MTT, 45% PLO, 55% SPINS » (en majuscules, comme à l'écran).
 * Chaque montant a été relevé cellule par cellule sur l'image.
 */

import {
  parseAmount, parseWeekRange, isTotalRow, buildSheet, CHECKSUM_PER_ROW,
  type ExtractedSheet, type ExtractedRow,
} from "../lib/funnels/nexa/affiliate-screenshot";
import { validateRow } from "../lib/funnels/nexa/affiliate-deal";

let passed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log("   ✔", label); }
  else { failures.push(label); console.log("   ✘", label, detail); }
}
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(label, g === w, g === w ? "" : `attendu ${w}, obtenu ${g}`);
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const DEAL = "40% NLH and MTT, 45% PLO, 55% SPINS";
const row = (o: Partial<ExtractedRow>): ExtractedRow => ({
  nickname: "", member_id: "", affiliate: "Hugo", deal_text: DEAL,
  nlh: "", mtt: "", plo: "", spins: "", affiliate_payment: "", ...o,
});
/** La dernière ligne des screenshots : total en gras, aucune autre cellule. */
const totalRow = (payment: string): ExtractedRow =>
  ({ nickname: "", member_id: "", affiliate: "", deal_text: "",
     nlh: "", mtt: "", plo: "", spins: "", affiliate_payment: payment });

// ── Les 3 screenshots réels, transcrits à la main ────────────────────────
const SCREEN_1: ExtractedSheet = {
  month_label: "July 2026", week_label: "13.07.-19.07.",
  rows: [
    row({ nickname: "LeCercle", member_id: "2231053", nlh: "$73.30", affiliate_payment: "$29.32" }),
    row({ nickname: "SistheR", member_id: "2231148", affiliate_payment: "$0.00" }),
    row({ nickname: "ImLePAD" }),
    row({ nickname: "themozz" }),
    totalRow("$29.32"),
  ],
  total_payment: "$29.32",
};

const SCREEN_2: ExtractedSheet = {
  month_label: "July 2026", week_label: "20.07.-26.07.",
  rows: [
    row({ nickname: "LeCercle", member_id: "2231053", nlh: "$713.50", spins: "$1.26", affiliate_payment: "$286.09" }),
    row({ nickname: "SistheR", member_id: "2231148", affiliate_payment: "$0.00" }),
    row({ nickname: "ImLePAD", nlh: "-$61.46", plo: "$17.05", spins: "$3.01", affiliate_payment: "-$15.26" }),
    row({ nickname: "themozz", nlh: "$283.40", spins: "$0.01", affiliate_payment: "$113.37" }),
    totalRow("$384.20"),
  ],
  total_payment: "$384.20",
};

const SCREEN_3: ExtractedSheet = {
  month_label: "July 2026", week_label: "27.07.-02.08.",
  rows: [
    row({ nickname: "LeCercle", member_id: "2231053", nlh: "$367.12", affiliate_payment: "$146.85" }),
    row({ nickname: "SistheR", member_id: "2231148", affiliate_payment: "$0.00" }),
    row({ nickname: "ImLePAD", nlh: "$288.87", plo: "$1.00", spins: "$6.25", affiliate_payment: "$119.44" }),
    row({ nickname: "themozz", nlh: "$1,111.95", affiliate_payment: "$444.78" }),
    totalRow("$711.06"),
  ],
  total_payment: "$711.06",
};

console.log("\n══ parseAmount ══");
const amt = (r: unknown) => { const p = parseAmount(r as never); return p.ok ? p.value : `REJET(${p.reason})`; };
eq("dollar simple", amt("$73.30"), 73.30);
eq("séparateur de milliers", amt("$1,111.95"), 1111.95);
eq("négatif, signe devant le $", amt("-$61.46"), -61.46);
eq("négatif, signe après le $", amt("$-61.46"), -61.46);
eq("zéro explicite", amt("$0.00"), 0);
eq("cellule vide = 0 (format NEXA)", amt(""), 0);
eq("tiret = 0", amt("—"), 0);
eq("nombre brut", amt(1111.95), 1111.95);
eq("espaces parasites", amt("  $ 1,234.56 "), 1234.56);
check("cellule illisible (null) → REJET", !parseAmount(null).ok);
check("texte parasite → REJET", !parseAmount("environ 300").ok);
check("NaN → REJET", !parseAmount(NaN).ok);

console.log("\n══ parseWeekRange ══");
const wk = (m: string, w: string) => { const r = parseWeekRange(m, w); return r.ok ? r.week_start : `REJET(${r.reason})`; };
eq("screen 1", wk("July 2026", "13.07.-19.07."), "2026-07-13");
eq("screen 2", wk("July 2026", "20.07.-26.07."), "2026-07-20");
eq("screen 3 — chevauchement de MOIS", wk("July 2026", "27.07.-02.08."), "2026-07-27");
{
  const r = parseWeekRange("July 2026", "27.07.-02.08.");
  check("screen 3 : fin bien en août", r.ok && r.week_end === "2026-08-02", r.ok ? r.week_end : "");
}
{
  // 2026-12-28 est un lundi ; la semaine finit le 2027-01-03.
  const r = parseWeekRange("December 2026", "28.12.-03.01.");
  check("chevauchement d'ANNÉE : début", r.ok && r.week_start === "2026-12-28");
  check("chevauchement d'ANNÉE : fin bascule en 2027", r.ok && r.week_end === "2027-01-03", r.ok ? r.week_end : "");
}
eq("espaces autour du tiret", wk("July 2026", "13.07. - 19.07."), "2026-07-13");
eq("point final absent", wk("July 2026", "13.07.-19.07"), "2026-07-13");
eq("casse du mois libre", wk("JULY 2026", "13.07.-19.07."), "2026-07-13");
check("début non-lundi → REJET", !parseWeekRange("July 2026", "14.07.-20.07.").ok);
check("plage de 6 jours → REJET", !parseWeekRange("July 2026", "13.07.-18.07.").ok);
check("mois du libellé ≠ mois de début → REJET", !parseWeekRange("August 2026", "13.07.-19.07.").ok);
check("mois inconnu (français) → REJET", !parseWeekRange("Juillet 2026", "13.07.-19.07.").ok);
check("libellé de mois absent → REJET", !parseWeekRange("", "13.07.-19.07.").ok);
check("plage absente → REJET", !parseWeekRange("July 2026", "").ok);
check("date inexistante (31.02) → REJET", !parseWeekRange("February 2026", "31.02.-06.03.").ok);

console.log("\n══ Ligne de total ══");
check("total détecté (payment seul)", isTotalRow(totalRow("$29.32")));
check("ligne joueur non prise pour un total", !isTotalRow(row({ nickname: "LeCercle", affiliate_payment: "$29.32" })));
check("ligne joueur sans ID non prise pour un total", !isTotalRow(row({ nickname: "ImLePAD", affiliate_payment: "$113.37" })));

console.log("\n══ Screen 1 — 13.07 ══");
{
  const r = buildSheet(SCREEN_1);
  check("traité", r.ok);
  if (r.ok) {
    eq("semaine", r.week_start, "2026-07-13");
    eq("4 joueurs (total exclu)", r.rows.length, 4);
    eq("aucun rejet", r.rejected, []);
    eq("LeCercle : ID conservé", r.rows[0].member_id, "2231053");
    check("LeCercle : NLH 73.30", near(r.rows[0].nlh, 73.30));
    check("LeCercle : payment 29.32", near(r.rows[0].affiliate_payment, 29.32));
    eq("ImLePAD : pas d'ID → null", r.rows[2].member_id, null);
    check("ImLePAD : tout à 0", [r.rows[2].nlh, r.rows[2].mtt, r.rows[2].plo, r.rows[2].spins].every(v => v === 0));
    check("checksum OK", r.checksum.ok, r.checksum.message ?? "");
    check("Σ = total", near(r.checksum.sum_rows, 29.32) && near(r.checksum.total_read!, 29.32));
  }
}

console.log("\n══ Screen 2 — 20.07 (montants négatifs) ══");
{
  const r = buildSheet(SCREEN_2);
  check("traité", r.ok);
  if (r.ok) {
    eq("semaine", r.week_start, "2026-07-20");
    eq("4 joueurs", r.rows.length, 4);
    const pad = r.rows[2];
    eq("ImLePAD identifié", pad.nickname, "ImLePAD");
    check("NLH négatif conservé", near(pad.nlh, -61.46));
    check("PLO 17.05", near(pad.plo, 17.05));
    check("Spins 3.01", near(pad.spins, 3.01));
    check("payment négatif conservé", near(pad.affiliate_payment, -15.26));
    check("checksum OK", r.checksum.ok, r.checksum.message ?? "");
    check("Σ = 384.20 exactement", near(r.checksum.sum_rows, 384.20));
  }
}

console.log("\n══ Screen 3 — 27.07 (l'arrondi de NEXA) ══");
{
  const r = buildSheet(SCREEN_3);
  check("traité", r.ok);
  if (r.ok) {
    eq("semaine (chevauchement de mois)", r.week_start, "2026-07-27");
    eq("4 joueurs", r.rows.length, 4);
    check("themozz : 1,111.95 lu correctement", near(r.rows[3].nlh, 1111.95));
    // Σ affichés = 711.07, total imprimé = 711.06 : NEXA somme avant d'arrondir.
    check("Σ des payments affichés = 711.07", near(r.checksum.sum_rows, 711.07), `${r.checksum.sum_rows}`);
    eq("total lu = 711.06", r.checksum.total_read, 711.06);
    check("écart ≈ 0.01", Math.abs(Math.abs(r.checksum.delta!) - 0.01) < 1e-9, `${r.checksum.delta}`);
    eq("tolérance = 0,02 × 4 lignes", r.checksum.tolerance, 0.08);
    check("checksum OK malgré l'arrondi NEXA", r.checksum.ok, r.checksum.message ?? "");
  }
}

console.log("\n══ Checksum — ce qu'il doit attraper ══");
{
  // Une ligne perdue par la lecture : le vrai risque de l'extraction.
  const amputé: ExtractedSheet = { ...SCREEN_3, rows: SCREEN_3.rows.filter(r => r.nickname !== "themozz") };
  const r = buildSheet(amputé);
  check("ligne perdue → checksum en ALERTE", r.ok && !r.checksum.ok);
  if (r.ok) check("écart chiffré dans le message", /444\.78|711\.06/.test(r.checksum.message ?? ""), r.checksum.message ?? "");
}
{
  // Un montant mal lu de quelques centimes doit passer ; c'est le rôle du
  // contrôle par ligne (tolérance 0,02) de l'attraper, pas du checksum.
  const rows = SCREEN_2.rows.map(x => x.nickname === "themozz" ? { ...x, affiliate_payment: "$113.38" } : x);
  const r = buildSheet({ ...SCREEN_2, rows });
  check("écart d'un centime → checksum tolérant", r.ok && r.checksum.ok);
}
{
  const r = buildSheet({ ...SCREEN_1, total_payment: null });
  check("total illisible → checksum en ALERTE (pas de silence)", r.ok && !r.checksum.ok);
  if (r.ok) eq("total_read null", r.checksum.total_read, null);
}
eq("tolérance par ligne = 0,02", CHECKSUM_PER_ROW, 0.02);

console.log("\n══ Rejets — jamais de valeur inventée ══");
{
  const rows = [row({ nickname: "LeCercle", member_id: "2231053", nlh: null, affiliate_payment: "$29.32" })];
  const r = buildSheet({ ...SCREEN_1, rows: [...rows, totalRow("$29.32")] });
  check("cellule illisible → ligne rejetée", r.ok && r.rows.length === 0 && r.rejected.length === 1);
  if (r.ok) check("motif nommé", /NLH/.test(r.rejected[0].reason), r.rejected[0].reason);
}
{
  const rows = [row({ nickname: "", nlh: "$100.00", affiliate_payment: "$40.00" })];
  const r = buildSheet({ ...SCREEN_1, rows });
  check("pseudo illisible → rejet", r.ok && r.rejected.length === 1 && r.rows.length === 0);
}
{
  const rows = [row({ nickname: "LeCercle", deal_text: "", nlh: "$100.00", affiliate_payment: "$40.00" })];
  const r = buildSheet({ ...SCREEN_1, rows });
  check("deal absent → rejet (taux inconnus)", r.ok && r.rejected.length === 1);
}
{
  const r = buildSheet({ ...SCREEN_1, week_label: "13.07.-18.07." });
  check("plage incohérente → tout le screenshot est rejeté", !r.ok);
}
{
  // Une ligne dont TOUTES les cellules sont vides est un artefact de grille.
  const blank: ExtractedRow = { nickname: "", member_id: "", affiliate: "", deal_text: "",
    nlh: "", mtt: "", plo: "", spins: "", affiliate_payment: "" };
  const r = buildSheet({ ...SCREEN_1, rows: [...SCREEN_1.rows, blank] });
  check("ligne entièrement vide ignorée sans rejet", r.ok && r.rows.length === 4 && r.rejected.length === 0);
}
{
  // En revanche une ligne PORTANT un deal mais sans pseudo n'est pas un artefact :
  // c'est soit un pseudo non lu, soit une ligne inattendue. Rejet nommé.
  const r = buildSheet({ ...SCREEN_1, rows: [row({}), totalRow("$29.32")] });
  check("deal présent mais pseudo absent → rejet, pas d'ignorance silencieuse",
        r.ok && r.rows.length === 0 && r.rejected.length === 1);
  if (r.ok && r.rejected.length) check("motif = pseudo", /pseudo/.test(r.rejected[0].reason), r.rejected[0].reason);
}

console.log("\n══ Bout en bout : extraction → validateRow ══");
{
  // Le vrai point : ce que produit l'extraction doit passer le contrôle à 0,02
  // du chemin normal, sans retouche. C'est la preuve que le contrat est le bon.
  for (const [nom, sheet] of [["13.07", SCREEN_1], ["20.07", SCREEN_2], ["27.07", SCREEN_3]] as const) {
    const r = buildSheet(sheet);
    if (!r.ok) { check(`${nom} : traité`, false); continue; }
    const verdicts = r.rows.map(validateRow);
    const bad = verdicts.filter(v => !v.ok);
    check(`${nom} : les ${r.rows.length} lignes passent validateRow`, bad.length === 0,
          bad.length ? (bad[0] as { message: string }).message : "");
  }
}
{
  // Et le deal en MAJUSCULES des screens est bien accepté.
  const r = buildSheet(SCREEN_2);
  if (r.ok) {
    const v = validateRow(r.rows[0]);
    check("deal en majuscules accepté", v.ok);
    if (v.ok) check("recalcul = 286.093", Math.abs(v.recomputed - 286.093) < 1e-9, `${v.recomputed}`);
  }
}

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} passés, ${failures.length} échoués`);
if (failures.length) { failures.forEach(f => console.log("   ✘", f)); process.exit(1); }
