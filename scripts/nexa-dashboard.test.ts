// Tests de l'agrégation par période du tableau de bord NEXAPOKER (module pur, zéro DB).
// Run: npx tsx scripts/nexa-dashboard.test.ts
// Lives under scripts/ (exclu du tsconfig) : ne touche jamais le build Next.
//
// ┌─ CE QUE CES TESTS PROUVENT ────────────────────────────────────────────────┐
// │ • Que filtrer APRÈS le rejeu complet donne un dû différent — et juste —    │
// │   de celui d'un rejeu tronqué à la période (le makeup serait perdu).       │
// │ • Qu'un joueur rendu deux fois par la source n'est compté qu'une fois.     │
// │ • Qu'un win/loss manquant donne null et jamais 0, joueur ET total.         │
// │ • Que totaux == Σ joueurs == Σ semaines, au même périmètre.                │
// │ • Que les semaines en échec de contrôle sortent des totaux sans           │
// │   disparaître, et que l'ancrage des fenêtres sur le lundi ne laisse ni     │
// │   trou ni recouvrement.                                                    │
// └────────────────────────────────────────────────────────────────────────────┘
// ┌─ CE QU'ILS NE PROUVENT PAS ────────────────────────────────────────────────┐
// │ Rien de la lecture SQL : getNexaDashboardOn (la boucle sur                 │
// │ getNexaPlayersOn) n'est pas exercée ici. Le fan-out du LEFT JOIN qui       │
// │ motive le dédoublonnage est reproduit sur base par l'audit, pas ici.       │
// └────────────────────────────────────────────────────────────────────────────┘
//
// Assertions float-safe (invariant #9 : jamais de === sur des montants).

import {
  aggregateDashboard, mondayOf, weekWindowFromParisDates, weekWindowLabel,
  type PlayerChain, type WeekWindow,
} from "../lib/funnels/nexa/dashboard";
import { computeRakeback, type WeekInput, type EngineConfig } from "../lib/funnels/nexa/rakeback-engine";

let passed = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log("   ✔", label); }
  else { failures.push(label); console.log("   ✘", label, detail); }
}
function approx(a: number, b: number, eps = 1e-9) { return Math.abs(a - b) < eps; }
function near(label: string, got: number | null, want: number | null) {
  const ok = got === null || want === null ? got === want : approx(got, want);
  check(label, ok, ok ? "" : `attendu ${want}, obtenu ${got}`);
}
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(label, g === w, g === w ? "" : `attendu ${w}, obtenu ${g}`);
}

const CFG: EngineConfig = { defaultPct: 0, defaultBasis: "gross_rake" };
const RB50 = [{ pct: 50, basis: "gross_rake" as const, start_week: "2026-01-01", end_week: null, makeup_carry: "carry" as const }];
const ACT50 = [{ pct: 50, start_week: "2026-01-01", end_week: null }];
const ALL: WeekWindow = { from: null, to: null };

function chain(player_id: number, name: string, weeks: WeekInput[], rb = RB50, act = ACT50): PlayerChain {
  return { player_id, name, weeks: computeRakeback(weeks, rb, act, CFG).weeks };
}
const wk = (week_start: string, rake: number, com: number, winloss: number | null = 0, check_ok = true): WeekInput =>
  ({ week_start, gross_rake: rake, affiliate_commission: com, check_ok, winloss });

// ── 1. Ancrage des fenêtres ────────────────────────────────────────────────
console.log("\n1. Fenêtres de semaines");
eq("mondayOf(lundi)", mondayOf("2026-07-13"), "2026-07-13");
eq("mondayOf(mercredi)", mondayOf("2026-07-15"), "2026-07-13");
eq("mondayOf(dimanche)", mondayOf("2026-07-19"), "2026-07-13");
eq("lifetime = pas de borne", weekWindowFromParisDates(undefined, undefined), { from: null, to: null });
eq("bornes ancrées sur le lundi", weekWindowFromParisDates("2026-07-15", "2026-07-29"),
   { from: "2026-07-13", to: "2026-07-27" });
// Ni trou ni recouvrement entre deux semaines consécutives.
const semA = weekWindowFromParisDates("2026-07-20", "2026-07-26");
const semB = weekWindowFromParisDates("2026-07-27", "2026-08-02");
check("semaines consécutives disjointes", semA.to !== semB.from,
      `${JSON.stringify(semA)} vs ${JSON.stringify(semB)}`);
check("et contiguës", mondayOf("2026-07-27") === semB.from);
eq("libellé lifetime", weekWindowLabel(ALL), "toutes les semaines saisies");
eq("libellé une semaine", weekWindowLabel({ from: "2026-07-13", to: "2026-07-13" }), "semaine du 2026-07-13");

// ── 2. LE POINT SENSIBLE : rejeu complet, puis filtrage ────────────────────
console.log("\n2. Rejeu complet vs rejeu tronqué à la période");
// S1 perdante (−200 de rake → makeup), puis S2 +300 et S3 +400. RB 50 %.
const histo = [wk("2026-07-06", -200, -80), wk("2026-07-13", 300, 120), wk("2026-07-20", 400, 160)];
const fenetre: WeekWindow = { from: "2026-07-13", to: "2026-07-20" };

const bon = aggregateDashboard([chain(1, "A", histo)], fenetre);
// S2 = (300 − 200) × 50 % = 50 · S3 = 400 × 50 % = 200 → 250
near("dû sur S2+S3 après rejeu COMPLET", bon.totals.due, 250);

// Ce que donnerait un rejeu tronqué — l'erreur que le module doit empêcher.
const tronque = aggregateDashboard([chain(1, "A", histo.filter(w => w.week_start >= "2026-07-13"))], fenetre);
near("dû si l'on tronquait AVANT le rejeu (makeup perdu)", tronque.totals.due, 350);
check("l'écart est réel : l'ordre rejeu→filtrage n'est pas cosmétique",
      !approx(bon.totals.due, tronque.totals.due));

// ── 3. Dédoublonnage (faille money-auditor F1) ─────────────────────────────
console.log("\n3. Un joueur rendu deux fois par la source");
const c = chain(7, "Doublon", [wk("2026-07-13", 1000, 400, 200)]);
const une = aggregateDashboard([c], ALL);
const deux = aggregateDashboard([c, { ...c }], ALL);
near("commission comptée une seule fois", deux.totals.commission, une.totals.commission);
near("dû compté une seule fois", deux.totals.due, une.totals.due);
near("part d'action comptée une seule fois", deux.totals.action_amount, une.totals.action_amount);
eq("une seule ligne joueur", deux.players.length, 1);

// ── 4. Incomplet = null, jamais 0 ──────────────────────────────────────────
console.log("\n4. Win/loss manquant");
const inc = aggregateDashboard([chain(1, "A", [wk("2026-07-13", 1000, 400, 100), wk("2026-07-20", 1000, 400, null)])], ALL);
near("action du joueur = null", inc.players[0].action_amount, null);
near("total du joueur = null", inc.players[0].total, null);
near("action totale = null", inc.totals.action_amount, null);
near("total = null", inc.totals.total, null);
near("le net d'affiliation reste chiffrable", inc.totals.net_affiliation, 800 - inc.totals.due);
eq("le manque est compté", inc.totals.weeks_missing_winloss, 1);
// Une saisie À ZÉRO est une saisie, pas une absence.
const zero = aggregateDashboard([chain(1, "A", [wk("2026-07-13", 1000, 400, 0)])], ALL);
near("win/loss saisi à 0 → action 0, pas null", zero.totals.action_amount, 0);

// ── 5. Réconciliation des trois agrégats ───────────────────────────────────
console.log("\n5. totaux == Σ joueurs == Σ semaines");
const multi = aggregateDashboard([
  chain(1, "A", [wk("2026-07-13", 1000, 400, 200), wk("2026-07-20", 800, 320, -100)]),
  chain(2, "B", [wk("2026-07-13", 500, 200, 50), wk("2026-07-20", 600, 240, 0)]),
  chain(3, "C", [wk("2026-07-20", 300, 120, 10)]),
], ALL);
near("Σ joueurs = total (commission)", multi.players.reduce((s, p) => s + p.commission, 0), multi.totals.commission);
near("Σ semaines = total (commission)", multi.weeks.reduce((s, w) => s + w.commission, 0), multi.totals.commission);
near("Σ joueurs = total (dû)", multi.players.reduce((s, p) => s + p.due, 0), multi.totals.due);
near("Σ semaines = total (dû)", multi.weeks.reduce((s, w) => s + w.due, 0), multi.totals.due);
near("Σ joueurs = total (action)", multi.players.reduce((s, p) => s + (p.action_amount ?? 0), 0), multi.totals.action_amount);
near("net = commission − dû", multi.totals.net_affiliation, multi.totals.commission - multi.totals.due);
near("total = net + action", multi.totals.total, multi.totals.net_affiliation + (multi.totals.action_amount ?? 0));

// ── 6. Semaines en échec de contrôle ───────────────────────────────────────
console.log("\n6. Contrôle en échec : exclu des totaux, jamais escamoté");
const ko = aggregateDashboard([chain(1, "A", [
  wk("2026-07-13", 1000, 400, 0),
  wk("2026-07-20", 600, 240, 0, false), // échec
])], ALL);
near("commission = semaines ok seulement", ko.totals.commission, 400);
near("la commission exclue est exposée", ko.totals.blocked_commission, 240);
eq("la semaine bloquée est comptée", ko.totals.blocked_weeks, 1);
eq("elle ne gonfle pas le compte de semaines", ko.weeks_in_period, ["2026-07-13"]);
// Une semaine UNIQUEMENT bloquée ne doit pas produire un total à 0 qui se lirait
// comme « cette semaine n'a rien rapporté ».
const koSeul = aggregateDashboard([chain(1, "A", [wk("2026-07-13", 600, 240, 0, false)])], ALL);
eq("semaine seulement bloquée : hors du compte", koSeul.weeks_in_period, []);
near("et son total vaut null, pas 0", koSeul.weeks[0].total, null);

// ── 7. Joueur hors période ─────────────────────────────────────────────────
console.log("\n7. Joueur sans semaine dans la fenêtre");
const hors = aggregateDashboard([
  chain(1, "Présent", [wk("2026-07-20", 1000, 400, 0)]),
  chain(2, "Absent", [wk("2026-06-01", 900, 360, 0)]),
], { from: "2026-07-20", to: "2026-07-20" });
eq("il n'apparaît pas en ligne à zéro", hors.players.map(p => p.name), ["Présent"]);

console.log(`\n${failures.length === 0 ? "=== TOUS LES TESTS PASSENT ===" : `=== ${failures.length} ÉCHEC(S) ===`}  (${passed} assertions)`);
if (failures.length) { failures.forEach(f => console.log(" -", f)); process.exit(1); }
