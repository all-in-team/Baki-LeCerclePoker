/**
 * Harnais du parseur XPoker Twd (libellés) et de la math du règlement club.
 * Run: npx tsx scripts/xpoker-parse.test.ts
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────┐
 * │ Les 2 cas d'acceptation du brief (§4) retombent au 1/100 de centime ;    │
 * │ la part d'action est calculée LIGNE PAR LIGNE (§5, 4107823 → +1405.356) ;│
 * │ le mapping est dérivé des LIBELLÉS : le même bloc décalé de 4 colonnes   │
 * │ et 6 lignes, entouré d'autres blocs de clubs, donne le même résultat ;   │
 * │ un CSV natif (« 80% » en texte, onglet « Sheet1 ») donne le même         │
 * │ résultat ; vide ≠ 0 (refus) ; TAX paramètre ≠ formule ⇒ checksum KO ;     │
 * │ sous-agent compté (Q4), compte agence marqué (Q5), ligne étrangère       │
 * │ exclue et signalée ; 總交收 ≠ Total signalé (Q6) ; libellé absent ⇒ erreur │
 * │ nommée ; nom d'onglet ⇒ candidats sans année (Q7).                       │
 * │ CONTREFACTUELS : les formules fausses (TAX en valeur absolue, prorata du │
 * │ total) sont vues ÉCHOUER sur les mêmes données.                          │
 * └─────────────────────────────────────────────────────────────────────────┘
 * ┌─ CE QU'ILS NE PROUVENT PAS ─────────────────────────────────────────────┐
 * │ Que le classeur RÉEL du club a ce format : les fixtures reproduisent la  │
 * │ disposition observée, pas le fichier. L'ingestion réelle n'est pas       │
 * │ câblée tant que la source n'est pas confirmée (étape 2b-a).              │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import * as XLSX from "xlsx";
import {
  parseXpokerTab, readXpokerWorkbook, XpokerParseError, parsePct, parseNum, isMemberId, type XpokerParseOptions,
} from "../lib/games/xpoker/parse-sheet";
import { clubSettlement, actionShareChips, rakebackChips, weekDueChips, chipsToUsd } from "../lib/games/xpoker/club-math";
import { tabDateCandidates, proposeWeek } from "../lib/games/xpoker/tab-date";

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
/** Égalité au 1/100 de centime, via chaîne à 4 décimales — jamais == sur des flottants. */
function eq4(label: string, got: number, want: number) {
  const g = got.toFixed(4), w = want.toFixed(4);
  check(label, g === w, g === w ? "" : `attendu ${w}, obtenu ${g}`);
}
function throwsParse(label: string, fn: () => void, re: RegExp) {
  try { fn(); check(label, false, "aucune erreur levée"); }
  catch (e: any) { check(label, e instanceof XpokerParseError && re.test(e.message), `message: ${e?.message}`); }
}

// ── fixture : la disposition observée, paramétrable (décalage, formats, blocs voisins) ──

type FixRow = { id?: string; pid: string; nick?: string; agent?: string; agentId?: string; sagentId?: string; wl: number | ""; rake: number | "" };
type FixOpts = {
  club?: string; chip?: number; rb?: number; taxParam?: number; taxFormula?: number;
  rows: FixRow[]; dc?: number; dr?: number; asText?: boolean; clearedFrom?: "total" | "rb";
  otherBlocks?: boolean; dropLabel?: string; clubHeader?: string;
};

function buildAoa(o: FixOpts): unknown[][] {
  const club = o.club ?? "花順", chip = o.chip ?? 1, rb = o.rb ?? 0.8, taxParam = o.taxParam ?? 0.05, taxF = o.taxFormula ?? 0.05;
  const dc = o.dc ?? 0, dr = o.dr ?? 0;
  const pct = (x: number) => o.asText ? `${Math.round(x * 100)}%` : x;
  const g: unknown[][] = [];
  const set = (r: number, c: number, v: unknown) => { (g[r + dr] ??= [])[c + dc] = v; };
  const L = (s: string) => s === o.dropLabel ? "" : s;
  // paramètres B1:D1 / A2:D2
  set(0, 1, L("幣值")); set(0, 2, L("反水")); set(0, 3, L("TAX"));
  set(1, 0, club); set(1, 1, chip); set(1, 2, pct(rb)); set(1, 3, pct(taxParam));
  // en-tête grille Q2:Z2 (T sans en-tête)
  const Q = 16;
  set(1, Q, o.clubHeader ?? club); set(1, Q + 1, L("ID")); set(1, Q + 2, L("Player ID")); set(1, Q + 4, L("Agent"));
  set(1, Q + 5, L("Agent ID")); set(1, Q + 6, L("Super Agent")); set(1, Q + 7, L("Super Agent ID")); set(1, Q + 8, L("Win/Lose")); set(1, Q + 9, L("Rake(without MTT)"));
  // lignes 3.. (grille à hauteur fixe : on laisse des trous)
  o.rows.forEach((r, i) => {
    const rr = 2 + i;
    set(rr, Q + 1, r.id ?? r.nick ?? `XP${r.pid}`); set(rr, Q + 2, Number(r.pid)); set(rr, Q + 3, r.nick ?? `XP${r.pid}`);
    set(rr, Q + 4, r.agent ?? "LeCercleAdmin2"); set(rr, Q + 5, Number(r.agentId ?? "3970004"));
    set(rr, Q + 6, "LeCercleAdmin2"); set(rr, Q + 7, Number(r.sagentId ?? "3970004"));
    set(rr, Q + 8, r.wl); set(rr, Q + 9, r.rake);
  });
  // totaux calculés comme la feuille (sur TOUTES les lignes du bloc)
  const num = o.rows.filter(r => r.wl !== "" && r.rake !== "");
  const twl = num.reduce((s, r) => s + (r.wl as number), 0), trake = num.reduce((s, r) => s + (r.rake as number), 0);
  const tax = (twl + trake) * -taxF, rbAmt = trake * rb, total = rbAmt + tax;
  // bloc de règlement A10/A11/A20
  set(9, 1, "交收"); set(10, 0, club); set(10, 1, o.clearedFrom === "rb" ? rbAmt : total);
  set(19, 0, L("總交收")); set(19, 1, o.clearedFrom === "rb" ? rbAmt : total);
  // pied T18:U22
  const T = Q + 3;
  set(17, T, L("Total Win/Lose")); set(17, T + 1, twl);
  set(18, T, L("Total Rake")); set(18, T + 1, trake);
  set(19, T, L("TAX")); set(19, T + 1, tax);
  set(20, T, pct(rb)); set(20, T + 1, rbAmt);
  set(21, T, L("Total")); set(21, T + 1, total);
  if (o.otherBlocks) {
    // blocs d'autres clubs, vides, avec leurs propres 總交收 et taux — comme dans le classeur
    set(16, 30, "總輸贏"); set(16, 31, 0); set(17, 30, "總服務費"); set(17, 31, 0); set(19, 30, "總交收"); set(19, 31, 0);
    set(45, 50, "總輸贏"); set(45, 51, 0); set(47, 50, 0.6); set(48, 50, "總交收"); set(48, 51, 0);
    set(81, 10, "總輸贏"); set(81, 11, 0); set(83, 10, 0.65); set(84, 10, "總交收"); set(84, 11, 0);
  }
  // normaliser (aoa_to_sheet veut des tableaux denses)
  const maxC = Math.max(...g.filter(Boolean).map(r => r.length));
  for (let r = 0; r < g.length; r++) { g[r] ??= []; for (let c = 0; c < maxC; c++) if (g[r][c] === undefined) g[r][c] = null; }
  return g;
}
const sheet = (o: FixOpts) => XLSX.utils.aoa_to_sheet(buildAoa(o) as any[][]);

const OPTS: XpokerParseOptions = { agentId: "3970004", clubName: "花順", agencyMemberIds: new Set(["3970004", "3999050"]) };

const CAS1: FixRow[] = [{ id: "冲浪者", pid: "3062825", nick: "Carolina", wl: -136.2, rake: 256.43 }];
const CAS2: FixRow[] = [
  { id: "冲浪者", pid: "3062825", nick: "Carolina", wl: -31267.4, rake: 4647.88 },
  { pid: "4136708", wl: -11722.87, rake: 2731.06 },
  { id: "jsuisAll-in", pid: "4107823", nick: "jsuisAll-in", wl: 14053.56, rake: 2845.38 },
];

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n── 1. Cas d'acceptation 1 — 1 joueur, TAX négative ──");
{
  const b = parseXpokerTab(sheet({ rows: CAS1 }), "8/3", OPTS);
  eq4("反水 80 %", b.recompute.rb, 205.144);
  eq4("TAX signée", b.recompute.tax, -6.0115);
  eq4("Total", b.recompute.total, 199.1325);
  eq("paramètres lus", b.params, { club: "花順", chip_value: 1, rb_pct: 0.8, tax_pct: 0.05 });
  eq("contrôles", b.checks, { checksum_ok: true, check_delta: b.checks.check_delta, rb_ok: true, tax_ok: true, cleared_matches: true, rb_rate_label_matches: true, sub_agent_present: false, foreign_rows: 0 });
  check("check_delta ≈ 0", Math.abs(b.checks.check_delta) < 1e-9, String(b.checks.check_delta));
  eq("R et T stockés comme libellés, rattachement sur S", { m: b.rows[0].member_id, r: b.rows[0].id_label, t: b.rows[0].nickname }, { m: "3062825", r: "冲浪者", t: "Carolina" });
  eq("aucun avertissement", b.warnings, []);
  // CONTREFACTUEL : TAX en valeur absolue — la formule fausse doit être VUE échouer.
  const wrong = 0.8 * 256.43 + Math.abs(0.05 * (136.2 - 256.43));
  check("contrefactuel |TAX| ≠ Total du sheet", wrong.toFixed(4) !== "199.1325", wrong.toFixed(4));
}

console.log("\n── 2. Cas d'acceptation 2 — 3 joueurs, signes mixtes ──");
{
  const b = parseXpokerTab(sheet({ rows: CAS2 }), "7/20", OPTS);
  eq4("Σ W/L", b.recompute.total_winloss, -28936.71);
  eq4("Σ rake", b.recompute.total_rake, 10224.32);
  eq4("反水 80 %", b.recompute.rb, 8179.456);
  eq4("TAX positive", b.recompute.tax, 935.6195);
  eq4("Total", b.recompute.total, 9115.0755);
  check("checksum ok", b.checks.checksum_ok);
  const p = Object.fromEntries(b.rows.map(r => [r.member_id, r]));
  eq4("part d'action 4107823 à 10 % (ligne à ligne, + = il doit à l'agence)", actionShareChips(p["4107823"].winloss, 10), 1405.356);
  eq4("part d'action 3062825 à 10 %", actionShareChips(p["3062825"].winloss, 10), -3126.74);
  eq4("part d'action 4136708 à 10 %", actionShareChips(p["4136708"].winloss, 10), -1172.287);
  // CONTREFACTUEL : prorata du total du bloc — vu échouer.
  // (10 % du règlement CLUB, réparti au prorata des W/L — l'interdit du §5.)
  const prorata = 0.10 * b.recompute.total * (p["4107823"].winloss / b.recompute.total_winloss);
  check("contrefactuel prorata du total du bloc ≠ ligne à ligne", prorata.toFixed(4) !== "1405.3560", prorata.toFixed(4));
  eq("nickname par défaut « XP4136708 » n'est PAS l'identité", { m: p["4136708"].member_id, t: p["4136708"].nickname }, { m: "4136708", t: "XP4136708" });
}

console.log("\n── 3. Mapping par libellés : bloc décalé (+4 col, +6 lignes) entre d'autres blocs ──");
{
  const ref = parseXpokerTab(sheet({ rows: CAS2 }), "x", OPTS);
  const b = parseXpokerTab(sheet({ rows: CAS2, dc: 4, dr: 6, otherBlocks: true }), "x", OPTS);
  eq("mêmes lignes", b.rows.map(r => [r.member_id, r.winloss, r.rake]), ref.rows.map(r => [r.member_id, r.winloss, r.rake]));
  eq("même recalcul", b.recompute, ref.recompute);
  eq("même pied", b.footer, ref.footer);
  eq("總交收 du BON bloc (pas celui d'un club voisin à 0)", b.cleared, ref.cleared);
  eq("mêmes contrôles", b.checks, ref.checks);
  eq("aucun avertissement", b.warnings, []);
}

console.log("\n── 4. CSV natif : taux en texte « 80% », onglet « Sheet1 » ──");
{
  const csv = XLSX.utils.sheet_to_csv(sheet({ rows: CAS2, asText: true }));
  const wb = readXpokerWorkbook(Buffer.from("﻿" + csv, "utf8"));
  eq("source", wb.source, "csv");
  eq("sans BOM : même lecture", readXpokerWorkbook(Buffer.from(csv, "utf8")).tabs[0].label, "Sheet1");
  eq("un seul onglet, pas modèle", wb.tabs.map(t => [t.label, t.is_template]), [["Sheet1", false]]);
  const b = parseXpokerTab(wb.tabs[0].ws, wb.tabs[0].label, OPTS);
  eq("taux lus depuis « 80% » / « 5% »", { rb: b.params.rb_pct, tax: b.params.tax_pct }, { rb: 0.8, tax: 0.05 });
  eq4("Total", b.recompute.total, 9115.0755);
  check("checksum ok", b.checks.checksum_ok);
  eq("libellé chinois survit à l'aller-retour UTF-8", b.params.club, "花順");
}

console.log("\n── 5. XLSX complet : onglet modèle repéré, lecture par onglet ──");
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet({ rows: [] }), "公版");
  XLSX.utils.book_append_sheet(wb, sheet({ rows: CAS1 }), "83");
  XLSX.utils.book_append_sheet(wb, sheet({ rows: CAS2 }), "720");
  const r = readXpokerWorkbook(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  eq("source", r.source, "xlsx");
  eq("onglets", r.tabs.map(t => [t.label, t.is_template]), [["公版", true], ["83", false], ["720", false]]);
  throwsParse("le modèle (0 ligne) est refusé, pas importé à vide", () => parseXpokerTab(r.tabs[0].ws, "公版", OPTS), /aucune ligne joueur/);
  eq4("83 → cas 1", parseXpokerTab(r.tabs[1].ws, "83", OPTS).recompute.total, 199.1325);
  eq4("720 → cas 2", parseXpokerTab(r.tabs[2].ws, "720", OPTS).recompute.total, 9115.0755);
}

console.log("\n── 6. Vide ≠ zéro ──");
{
  throwsParse("Win/Lose vide ⇒ refus nommant l'ID", () => parseXpokerTab(sheet({ rows: [{ pid: "3062825", wl: "", rake: 256.43 }] }), "x", OPTS), /3062825.*vide/);
  throwsParse("Rake vide ⇒ refus", () => parseXpokerTab(sheet({ rows: [{ pid: "3062825", wl: -1, rake: "" }] }), "x", OPTS), /3062825.*vide/);
  const b = parseXpokerTab(sheet({ rows: [{ pid: "3062825", wl: 0, rake: 0 }] }), "x", OPTS);
  eq("un vrai 0 saisi est un 0", [b.rows[0].winloss, b.rows[0].rake], [0, 0]);
  eq("parseNum('') = null, parseNum(0) = 0", [parseNum(""), parseNum(0), parseNum("1,234.56")], [null, 0, 1234.56]);
  eq("parsePct", [parsePct("80%"), parsePct("5 %"), parsePct(0.8), parsePct(""), parsePct("0,65")], [0.8, 0.05, 0.8, null, 0.65]);
  eq("isMemberId", [isMemberId(3062825), isMemberId("3062825"), isMemberId("XP4136708"), isMemberId(""), isMemberId(42)], [true, true, false, false, false]);
}

console.log("\n── 7. TAX paramètre ≠ formule de la feuille (onglet 3/23 : D2 = 0) ──");
{
  const b = parseXpokerTab(sheet({ rows: CAS1, taxParam: 0, taxFormula: 0.05 }), "3/23", OPTS);
  eq("tax_pct lu = 0", b.params.tax_pct, 0);
  check("checksum KO", !b.checks.checksum_ok);
  check("rb ok, tax KO — l'écart est localisé", b.checks.rb_ok && !b.checks.tax_ok);
  eq4("écart = la TAX que la feuille a appliquée", b.checks.check_delta, 6.0115);
  check("avertissement explicite sur le taux TAX", b.warnings.some(w => /taux TAX/.test(w)), b.warnings.join(" | "));
}

console.log("\n── 8. Sous-agent (Q4), compte agence (Q5), ligne étrangère ──");
{
  const rows: FixRow[] = [
    ...CAS1,
    { pid: "3999960", nick: "wisdomcomes", agent: "Shangyu", agentId: "3999050", wl: -195.1, rake: 105.32 },
    { pid: "3970004", nick: "LeCercleAdmin2-J", wl: -202, rake: 3.7 },
  ];
  const b = parseXpokerTab(sheet({ rows }), "6/8", OPTS);
  eq("scopes", b.rows.map(r => [r.member_id, r.scope, r.is_agency]), [["3062825", "agent", false], ["3999960", "sub_agent", false], ["3970004", "agent", true]]);
  check("checksum ok AVEC le sous-agent et l'agence (le club les additionne)", b.checks.checksum_ok);
  check("sub_agent_present", b.checks.sub_agent_present);
  check("avertissement sous-agent", b.warnings.some(w => /sous-agent.*3999960/.test(w)));
  // CONTREFACTUEL : le filtre strict « Agent ID = agent » du brief §3 casse le checksum.
  const strict = clubSettlement(b.rows.filter(r => r.agent_id === "3970004"), b.params);
  check("contrefactuel filtre strict ⇒ Total ≠ pied", strict.total.toFixed(4) !== b.footer.total.toFixed(4), strict.total.toFixed(4));

  const f = parseXpokerTab(sheet({ rows: [...CAS1, { pid: "5555555", agent: "Autre", agentId: "1111111", sagentId: "2222222", wl: 10, rake: 1 }] }), "x", OPTS);
  eq("ligne étrangère exclue et listée", [f.rows.length, f.foreign_rows.map(r => r.member_id)], [1, ["5555555"]]);
  check("checksum KO puisque le pied la compte — l'import sera refusé, pas bricolé", !f.checks.checksum_ok);
  check("avertissement hors périmètre", f.warnings.some(w => /hors périmètre.*5555555/.test(w)));
}

console.log("\n── 9. 總交收 ≠ Total (semaines 3/30 → 4/20 : B11 = U21) ──");
{
  const b = parseXpokerTab(sheet({ rows: CAS2, clearedFrom: "rb" }), "4/20", OPTS);
  eq4("Total (pied) inchangé", b.footer.total, 9115.0755);
  eq4("總交收 = 反水 seule", b.cleared!, 8179.456);
  eq("les deux sont rendus, aucun choisi", { cm: b.checks.cleared_matches, ok: b.checks.checksum_ok }, { cm: false, ok: true });
  check("avertissement divergence", b.warnings.some(w => /總交收.*Total/.test(w)));
}

console.log("\n── 10. Refus explicites ──");
{
  throwsParse("club des paramètres inattendu", () => parseXpokerTab(sheet({ rows: CAS1, club: "其他" }), "x", OPTS), /club des paramètres.*其他/);
  throwsParse("club de l'en-tête inattendu", () => parseXpokerTab(sheet({ rows: CAS1, clubHeader: "其他" }), "x", OPTS), /en-tête de grille.*其他/);
  throwsParse("libellé absent ⇒ erreur nommée", () => parseXpokerTab(sheet({ rows: CAS1, dropLabel: "Rake(without MTT)" }), "x", OPTS), /Rake\(without MTT\).*0 occurrence/);
  throwsParse("pied absent ⇒ erreur nommée", () => parseXpokerTab(sheet({ rows: CAS1, dropLabel: "Total Win/Lose" }), "x", OPTS), /Total Win\/Lose/);
  throwsParse("Player ID en double", () => parseXpokerTab(sheet({ rows: [...CAS1, { pid: "3062825", wl: 1, rake: 1 }] }), "x", OPTS), /deux fois/);
  throwsParse("onglet vide", () => parseXpokerTab(XLSX.utils.aoa_to_sheet([[]]), "vide", OPTS), /幣值/);
  const e = (() => { try { parseXpokerTab(sheet({ rows: CAS1, club: "其他" }), "8/3", OPTS); } catch (x) { return x as XpokerParseError; } })();
  eq("l'erreur porte l'onglet", e?.tab, "8/3");
}

console.log("\n── 11. Nom d'onglet ⇒ candidats, jamais d'année (Q7) ──");
{
  eq("8/3", tabDateCandidates("8/3").map(c => c.label), ["8/3"]);
  eq("83 (export XLSX)", tabDateCandidates("83").map(c => c.label), ["8/3"]);
  eq("727", tabDateCandidates("727").map(c => c.label), ["7/27"]);
  eq("111 ambigu", tabDateCandidates("111").map(c => c.label), ["1/11", "11/1"]);
  eq("1125", tabDateCandidates("1125").map(c => c.label), ["11/25"]);
  eq("Sheet1 / 公版 ⇒ rien", [tabDateCandidates("Sheet1"), tabDateCandidates("公版")], [[], []]);
  const w26 = proposeWeek({ month: 3, day: 23, label: "3/23" }, 2026);
  eq("3/23 en 2026 = lundi, semaine précédente", w26, { tab_date: "2026-03-23", tab_day: "lundi", week_start: "2026-03-16", week_end: "2026-03-22", convention: "previous_week", not_a_monday: false });
  const w25 = proposeWeek({ month: 3, day: 23, label: "3/23" }, 2025);
  eq("3/23 en 2025 = dimanche ⇒ signalé", [w25?.tab_day, w25?.not_a_monday], ["dimanche", true]);
  eq("convention « semaine qui commence » disponible", proposeWeek({ month: 8, day: 3, label: "8/3" }, 2026, "starting_week")?.week_start, "2026-08-03");
  eq("date inexistante ⇒ null", proposeWeek({ month: 2, day: 30, label: "2/30" }, 2026), null);
}

console.log("\n── 12. Math pure ──");
{
  eq4("rakeback joueur 20 % sur 2845.38", rakebackChips(2845.38, 20), 569.076);
  eq4("dû net = action − RB (+ = il doit)", weekDueChips(14053.56, 2845.38, 10, 20), 1405.356 - 569.076);
  eq4("équivalent USD à 33 (affichage)", chipsToUsd(9115.0755, 33), 276.2144);
  check("taux invalide ⇒ erreur", (() => { try { chipsToUsd(1, 0); return false; } catch { return true; } })());
  eq("clubSettlement sur 0 ligne = 0 partout", clubSettlement([], { rb_pct: 0.8, tax_pct: 0.05 }), { total_winloss: 0, total_rake: 0, rb: 0, tax: 0, total: 0 });
}

console.log(`\n${passed} ✔  ${failures.length} ✘`);
if (failures.length) { console.log("ÉCHECS :", failures); process.exit(1); }
