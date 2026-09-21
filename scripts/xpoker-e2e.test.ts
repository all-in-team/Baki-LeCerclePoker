/**
 * Harnais de bout en bout XPoker Twd — SUR FIXTURES, sans jamais lire le classeur réel.
 * Run: npx tsx scripts/xpoker-e2e.test.ts
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────┐
 * │ Sur une base SQLite réelle passée par add_xpoker_twd_v1 :                │
 * │ import fictif (semaine confirmée à la main) → lignes écrites, joueurs   │
 * │ résolus par Player ID seulement, ID inconnu orphelin ; refus : semaine  │
 * │ dupliquée, checksum KO sans motif, plage non lundi→dimanche ; écart      │
 * │ acté avec motif = importé mais marqué. Réconciliation : candidat PROPOSÉ │
 * │ par pseudo, jamais appliqué ; rattachement relie les semaines orphelines,│
 * │ refuse un ID agence ou déjà pris, réactive un ID archivé. Deals         │
 * │ versionnés : la semaine passée garde son taux. Parts d'action ligne à   │
 * │ ligne dans les deux sens, RB, dû net, « incalculable » sans deal. Grand  │
 * │ livre : sens imposés, stock agence et position joueur = deux compteurs  │
 * │ distincts. GARDE : le DELETE générique refuse un ID porteur de semaines. │
 * └─────────────────────────────────────────────────────────────────────────┘
 * ┌─ CE QU'ILS NE PROUVENT PAS ─────────────────────────────────────────────┐
 * │ Le règlement joueur (étape 4), la route d'import, l'écran, et le format │
 * │ du classeur qui fait foi (source non confirmée).                         │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import path from "path";

const REPO = path.resolve(__dirname, "..");
const Database = require(path.join(REPO, "node_modules/better-sqlite3"));

import { runXpokerMigrationV1, type XpokerSeed } from "../lib/games/xpoker/schema";
import {
  XPOKER_GAME_NAME, XPOKER_DEFAULT_ACTION_PCT, XPOKER_SEED_CHIPS_PER_USD,
  XPOKER_SEED_RATE_EFFECTIVE_FROM, XPOKER_SEED_AGENCY_ACCOUNTS,
} from "../lib/games/xpoker/config";
import {
  commitImportOn, deleteImportOn, unlinkedMembersOn, linkMemberIdOn, archiveAccountOn, accountsForPlayerOn,
  deleteGameIdRowOn, setDealOn, dealForWeekOn, dealHistoryOn, playerWeeksOn, addLedgerLineOn, agencyStockOn, playerMovementsOn,
  importSettlementStatusOn, rateAtOn, addRateOn, xpokerGameIdOn, relinkMemberIdOn, relinkLogOn, reverseLedgerLineOn,
} from "../lib/games/xpoker/engine";
import { block, CAS1, CAS2, type FixRow } from "./xpoker-fixture";

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
function eq4(label: string, got: number | null, want: number) {
  const g = got === null ? "null" : got.toFixed(4), w = want.toFixed(4);
  check(label, g === w, g === w ? "" : `attendu ${w}, obtenu ${g}`);
}

const SEED: XpokerSeed = {
  gameName: XPOKER_GAME_NAME, defaultActionPct: XPOKER_DEFAULT_ACTION_PCT, seedChipsPerUsd: XPOKER_SEED_CHIPS_PER_USD,
  seedRateEffectiveFrom: XPOKER_SEED_RATE_EFFECTIVE_FROM, agencyAccounts: XPOKER_SEED_AGENCY_ACCOUNTS,
};

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE _applied_fixes (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')), default_action_pct REAL, currency TEXT NOT NULL DEFAULT 'USDT');
    CREATE TABLE player_game_ids (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL, UNIQUE(game_id, external_id));
    CREATE TABLE manual_settlements (id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE, player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      net_selected_usdt REAL NOT NULL DEFAULT 0, action_pct_applied REAL NOT NULL DEFAULT 0, amount_due_usdt REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','paid')), tx_hash TEXT, notes TEXT,
      locked_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_date TEXT, kind TEXT NOT NULL DEFAULT 'action');
    INSERT INTO games (name) VALUES ('KKPOKER');
    INSERT INTO players (name) VALUES ('Alice'), ('jsuisAll-in'), ('Carol');
  `);
  runXpokerMigrationV1(db, SEED);
  return db;
}
const W_713 = { week_start: "2026-07-13", week_end: "2026-07-19" };   // onglet « 7/20 », convention semaine précédente
const W_727 = { week_start: "2026-07-27", week_end: "2026-08-02" };   // onglet « 8/3 »
const ALICE = 1, BOB = 2, CAROL = 3;

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n── 1. Import fictif : résolution par Player ID seulement ──");
const db = freshDb();
{
  eq("taux en vigueur (graine)", rateAtOn(db, "2026-07-19"), 33);
  check("aucun taux avant la graine ⇒ erreur", (() => { try { rateAtOn(db, "2026-03-01"); return false; } catch { return true; } })());
  // Alice possède 3062825 ; « jsuisAll-in » (Bob) n'a PAS encore son ID : le pseudo ne suffit pas.
  eq("lien Alice ↔ 3062825", linkMemberIdOn(db, { player_id: ALICE, member_id: "3062825", nickname: "Carolina" }).ok, true);
  const r = commitImportOn(db, { block: block({ rows: CAS2 }, "7/20"), ...W_713, source: "xlsx", filename: "3970004.xlsx" });
  check("import ok", r.ok, JSON.stringify(r));
  if (r.ok) {
    eq("3 lignes, 2 orphelines (Bob n'est pas rattaché par son pseudo)", { rows: r.rows, unlinked: r.unlinked, agency: r.agency }, { rows: 3, unlinked: ["4136708", "4107823"], agency: [] });
    eq("taux figé sur l'import", r.rate_chips_per_usd, 33);
    const imp = db.prepare(`SELECT week_start, week_end, tab_label, check_ok, cleared_matches, override_reason, sub_agent_present, rows_total FROM xpoker_imports WHERE id = ?`).get(r.import_id);
    eq("provenance figée", imp, { week_start: "2026-07-13", week_end: "2026-07-19", tab_label: "7/20", check_ok: 1, cleared_matches: 1, override_reason: null, sub_agent_present: 0, rows_total: 3 });
    eq("ligne Alice résolue, les autres NULL", db.prepare(`SELECT member_id, player_id FROM xpoker_week_rows ORDER BY member_id`).all(), [
      { member_id: "3062825", player_id: ALICE }, { member_id: "4107823", player_id: null }, { member_id: "4136708", player_id: null }]);
  }
  // Refus
  const dup = commitImportOn(db, { block: block({ rows: CAS2 }), ...W_713, source: "xlsx" });
  check("semaine déjà importée ⇒ refus", !dup.ok && /déjà importée/.test((dup as any).error));
  const badRange = commitImportOn(db, { block: block({ rows: CAS1 }), week_start: "2026-07-14", week_end: "2026-07-20", source: "xlsx" });
  check("plage non lundi→dimanche ⇒ refus", !badRange.ok && /lundi/.test((badRange as any).error));
  const ko = commitImportOn(db, { block: block({ rows: CAS1, taxParam: 0 }, "3/23"), week_start: "2026-03-16", week_end: "2026-03-22", source: "xlsx" });
  check("checksum KO sans motif ⇒ refus, aucune ligne", !ko.ok && /Checksum KO/.test((ko as any).error) && db.prepare(`SELECT COUNT(*) n FROM xpoker_imports`).get().n === 1);
  const acked = commitImportOn(db, { block: block({ rows: CAS1, taxParam: 0 }, "3/23"), week_start: "2026-03-16", week_end: "2026-03-22", source: "xlsx", override_reason: "TAX=0 en D2, formule à 5 % — écart acté" });
  check("écart acté avec motif ⇒ importé", acked.ok, JSON.stringify(acked));
  if (acked.ok) {
    eq("… mais marqué en écart", db.prepare(`SELECT check_ok, override_reason FROM xpoker_imports WHERE id = ?`).get(acked.import_id), { check_ok: 0, override_reason: "TAX=0 en D2, formule à 5 % — écart acté" });
    check("avertissement « écart acté » rendu", acked.warnings.some(w => /Écart acté/.test(w)));
  }
  eq("import_flagged visible côté joueur", playerWeeksOn(db, ALICE).map(w => [w.week_start, w.import_flagged]), [["2026-07-13", false], ["2026-03-16", true]]);
}

console.log("\n── 2. Réconciliation : candidat proposé, jamais appliqué ──");
{
  const u = unlinkedMembersOn(db);
  eq("deux ID orphelins", u.map(x => x.member_id), ["4107823", "4136708"]);
  const bob = u.find(x => x.member_id === "4107823")!;
  eq("candidat PROPOSÉ par pseudo « jsuisAll-in »", bob.candidates, [{ player_id: BOB, name: "jsuisAll-in", reason: "nickname (T) = « jsuisAll-in »" }]);
  eq("« XP4136708 » n'est pas un nom : aucun candidat", u.find(x => x.member_id === "4136708")!.candidates, []);
  eq("toujours orphelin tant que Baki n'a pas validé", db.prepare(`SELECT player_id FROM xpoker_week_rows WHERE member_id = '4107823'`).get(), { player_id: null });
  const l = linkMemberIdOn(db, { player_id: BOB, member_id: "4107823", nickname: "jsuisAll-in" });
  eq("rattachement validé relie la semaine orpheline", l.ok ? l.rows_linked : l, 1);
  eq("ligne résolue", db.prepare(`SELECT player_id FROM xpoker_week_rows WHERE member_id = '4107823'`).get(), { player_id: BOB });
  const again = linkMemberIdOn(db, { player_id: CAROL, member_id: "4107823" });
  check("ID déjà pris par Bob ⇒ refus nommé", !again.ok && /jsuisAll-in/.test((again as any).error));
  const ag = linkMemberIdOn(db, { player_id: CAROL, member_id: "3970004" });
  check("ID agence ⇒ refus", !ag.ok && /compte agence/.test((ag as any).error));
  check("ID mal formé ⇒ refus", !linkMemberIdOn(db, { player_id: CAROL, member_id: "XP4136708" }).ok);
  eq("lien Carol ↔ 4136708", linkMemberIdOn(db, { player_id: CAROL, member_id: "4136708" }).ok, true);
  eq("plus aucun orphelin", unlinkedMembersOn(db), []);
  eq("comptes de Carol", accountsForPlayerOn(db, CAROL).map(a => [a.member_id, a.status, a.weeks_imported]), [["4136708", "active", 1]]);
}

console.log("\n── 3. Deals versionnés, parts d'action dans les deux sens, incalculable ──");
{
  eq("deal Alice 10 % / RB 0 depuis 2026-03-16", setDealOn(db, { player_id: ALICE, action_pct: 10, rb_pct: 0, start_week: "2026-03-16" }), { ok: true });
  eq("deal Bob 10 % / RB 20 depuis 2026-07-13", setDealOn(db, { player_id: BOB, action_pct: 10, rb_pct: 20, start_week: "2026-07-13" }), { ok: true });
  check("start_week non lundi ⇒ refus", !setDealOn(db, { player_id: BOB, action_pct: 10, rb_pct: 0, start_week: "2026-07-14" }).ok);
  const frac = setDealOn(db, { player_id: BOB, action_pct: 10, rb_pct: 0.8, start_week: "2026-07-27" });
  check("deal rb_pct = 0.8 (fraction déguisée) ⇒ refus moteur nommé (R2)", !frac.ok && /fraction/.test(frac.error ?? ""), frac.error);
  const a = playerWeeksOn(db, ALICE).find(w => w.week_start === "2026-07-13")!;
  eq4("Alice perd 31267.4 → action −3126.74 : JE LUI DOIS", a.action_chips, -3126.74);
  eq4("Alice RB 0", a.rb_chips, 0);
  eq4("Alice dû net −3126.74", a.due_chips, -3126.74);
  eq4("équivalent USD au taux figé (affichage)", a.due_usd, -3126.74 / 33);
  const b = playerWeeksOn(db, BOB)[0];
  eq4("Bob gagne 14053.56 → action +1405.356 : IL ME DOIT", b.action_chips, 1405.356);
  eq4("Bob RB 20 % sur 2845.38 = 569.076", b.rb_chips, 569.076);
  eq4("Bob dû net = 1405.356 − 569.076", b.due_chips, 836.28);
  const c = playerWeeksOn(db, CAROL)[0];
  eq("Carol sans deal ⇒ INCALCULABLE (null), pas zéro", { deal: c.deal, action: c.action_chips, due: c.due_chips, wl: c.winloss_chips }, { deal: null, action: null, due: null, wl: -11722.87 });
  eq("PREMIER deal de Carol : peut couvrir la semaine déjà importée (geste normal après import initial)",
     setDealOn(db, { player_id: CAROL, action_pct: 10, rb_pct: 0, start_week: "2026-07-13" }), { ok: true });
  eq4("… et la semaine devient calculable : −1172.287", playerWeeksOn(db, CAROL)[0].action_chips, -1172.287);
  // F2 recalibrée (2026-09-21) : une semaine IMPORTÉE non réglée n'est pas figée — mais la
  // réécrire n'est jamais silencieux : sans confirmation, aperçu et rien d'écrit.
  const again = setDealOn(db, { player_id: CAROL, action_pct: 50, rb_pct: 0, start_week: "2026-07-13" });
  check("un 2ᵉ deal sur cette même semaine importée ⇒ pas appliqué : confirmation demandée (F2)", !again.ok && again.needs_confirmation === true, JSON.stringify(again));
  eq4("… la semaine 7/13 de Carol n'a pas bougé", playerWeeksOn(db, CAROL)[0].action_chips, -1172.287);
  // Versionnement : nouveau taux à partir de la semaine suivante, la semaine passée ne bouge pas.
  eq("deal Bob 15 % depuis 2026-07-27", setDealOn(db, { player_id: BOB, action_pct: 15, rb_pct: 20, start_week: "2026-07-27" }), { ok: true });
  eq("période précédente fermée au 2026-07-20", dealForWeekOn(db, BOB, "2026-07-13")?.end_week, "2026-07-20");
  eq4("semaine 7/13 toujours à 10 %", playerWeeksOn(db, BOB).find(w => w.week_start === "2026-07-13")!.action_chips, 1405.356);
  const back = setDealOn(db, { player_id: BOB, action_pct: 50, rb_pct: 0, start_week: "2026-07-13" });
  check("réécrire un deal sur une semaine importée non réglée ⇒ pas un refus, une confirmation (F2 recalibrée)", !back.ok && back.needs_confirmation === true && /rétroactif/.test(back.error), back.error);
  eq("… l'aperçu nomme la semaine recalculée et la plage écrite (7/13 → 7/20 : la période 7/27 est conservée)",
     !back.ok && back.preview ? { weeks: back.preview.weeks.map(w => [w.week_start, w.before?.action_pct, w.after.action_pct]), range: [back.preview.start_week, back.preview.end_week] } : null,
     { weeks: [["2026-07-13", 10, 50]], range: ["2026-07-13", "2026-07-20"] });
  eq4("… et rien écrit : Bob 7/13 toujours à 10 %", playerWeeksOn(db, BOB).find(w => w.week_start === "2026-07-13")!.action_chips, 1405.356);
  // Remplacer la période OUVERTE sur son propre début alors que RIEN n'y est importé (7/27 pas
  // encore importée) : simple correction, appliquée en place, sans confirmation.
  const sameStart = setDealOn(db, { player_id: BOB, action_pct: 90, rb_pct: 0, start_week: "2026-07-27" });
  check("corriger la période OUVERTE sur son propre début, rien d'importé ⇒ appliqué en place", sameStart.ok && !sameStart.retroactive, JSON.stringify(sameStart));
  eq("… 90 %/0 depuis 7/27, une seule période ouverte, l'ancien taux tracé dans la note",
     { d: dealForWeekOn(db, BOB, "2026-07-27"), n: (db.prepare(`SELECT COUNT(*) n FROM xpoker_player_deals WHERE player_id = ? AND end_week IS NULL`).get(BOB) as any).n, note: /avant : 15 %\/20 %/.test(dealHistoryOn(db, BOB).current?.note ?? "") },
     { d: { action_pct: 90, rb_pct: 0, start_week: "2026-07-27", end_week: null }, n: 1, note: true });
  check("… et on remet 15 %/20 (même geste)", setDealOn(db, { player_id: BOB, action_pct: 15, rb_pct: 20, start_week: "2026-07-27" }).ok);
  eq4("semaine 7/13 toujours à 10 % après tout ça", playerWeeksOn(db, BOB).find(w => w.week_start === "2026-07-13")!.action_chips, 1405.356);
  eq("période en cours (15 % depuis 7/27)", dealForWeekOn(db, BOB, "2026-07-27"), { action_pct: 15, rb_pct: 20, start_week: "2026-07-27", end_week: null });
  // Semaine suivante : Bob seul, 15 %.
  const rows2: FixRow[] = [
    { id: "jsuisAll-in", pid: "4107823", nick: "jsuisAll-in", wl: 26411.41, rake: 4854.14 },
    { pid: "4136708", wl: -9173.66, rake: 4403.97 },   // Carol, période ouverte depuis 7/13
  ];
  const r2 = commitImportOn(db, { block: block({ rows: rows2 }, "8/3"), ...W_727, source: "csv" });
  check("2ᵉ import ok", r2.ok, JSON.stringify(r2));
  eq4("semaine 7/27 à 15 %", playerWeeksOn(db, BOB).find(w => w.week_start === "2026-07-27")!.action_chips, 0.15 * 26411.41);
  // F2 recalibrée : Carol a une période ouverte depuis 7/13 et la semaine 7/27 importée ;
  // un deal à partir du 7/20 est APRÈS le début de la période mais recalculerait 7/27
  // (importée, non réglée) → pas un refus : aperçu, confirmation, motif.
  const mid = setDealOn(db, { player_id: CAROL, action_pct: 50, rb_pct: 0, start_week: "2026-07-20" });
  check("deal entre le début de période et une semaine importée non réglée ⇒ confirmation demandée (F2)", !mid.ok && mid.needs_confirmation === true, mid.error);
  eq("… l'aperçu LISTE les semaines recalculées", !mid.ok ? mid.preview?.weeks.map(w => w.week_start) : null, ["2026-07-27"]);
  // Avant le début de la période (7/06) : rien d'importé au 7/06, mais une période s'insérerait
  // AVANT une période existante → confirmation aussi (jamais d'insertion discrète dans le passé).
  const early = setDealOn(db, { player_id: CAROL, action_pct: 50, rb_pct: 0, start_week: "2026-07-06" });
  eq("depuis 7/06 : insertion avant la période 7/13 ⇒ confirmation, aucune semaine recalculée, plage 7/06 → 7/06",
     !early.ok && early.preview ? { c: early.needs_confirmation, w: early.preview.weeks.length, r: [early.preview.start_week, early.preview.end_week] } : early,
     { c: true, w: 0, r: ["2026-07-06", "2026-07-06"] });
  eq("… rien écrit : Carol a toujours une seule période", (db.prepare(`SELECT COUNT(*) n FROM xpoker_player_deals WHERE player_id = ?`).get(CAROL) as any).n, 1);
  // Historique pour le formulaire : valeur actuelle + depuis quand, périodes précédentes, première
  // semaine d'effet = lendemain de la dernière semaine RÉGLÉE (aucune ici ⇒ aucune limite).
  const h0 = dealHistoryOn(db, CAROL);
  eq("historique Carol : en cours 10 % depuis 7/13, rien avant, aucune semaine réglée ⇒ aucune limite",
     { cur: [h0.current?.action_pct, h0.current?.start_week], prev: h0.previous.length, earliest: h0.earliest_change_week, settled: h0.last_settled_week, last: h0.last_imported_week },
     { cur: [10, "2026-07-13"], prev: 0, earliest: null, settled: null, last: "2026-07-27" });
  eq4("Carol 7/27 toujours à 10 %", playerWeeksOn(db, CAROL).find(w => w.week_start === "2026-07-27")!.action_chips, -917.366);
  eq("deal Carol à partir du 8/03 (après la dernière semaine importée) ⇒ ok", setDealOn(db, { player_id: CAROL, action_pct: 50, rb_pct: 0, start_week: "2026-08-03" }), { ok: true });
  const h1 = dealHistoryOn(db, CAROL);
  eq("historique après changement : 50 % depuis 8/03, 10 % du 7/13 au 7/27 en précédent",
     { cur: [h1.current?.action_pct, h1.current?.start_week], prev: h1.previous.map(p => [p.action_pct, p.start_week, p.end_week]), earliest: h1.earliest_change_week },
     { cur: [50, "2026-08-03"], prev: [[10, "2026-07-13", "2026-07-27"]], earliest: null });
  eq("joueur sans deal : historique vide, n'importe quel lundi", dealHistoryOn(db, 99), { current: null, previous: [], earliest_change_week: null, last_settled_week: null, last_imported_week: null });
  eq("0 % d'action et 0 % de RB : accepté (défaut de la plupart des joueurs)", setDealOn(db, { player_id: CAROL, action_pct: 0, rb_pct: 0, start_week: "2026-08-10" }), { ok: true });
  // Multi-comptes : un 2ᵉ Player ID pour Bob, même semaine ⇒ somme au niveau joueur, détail par compte.
  eq("2ᵉ compte Bob", linkMemberIdOn(db, { player_id: BOB, member_id: "4004977" }).ok, true);
  db.prepare(`INSERT INTO xpoker_week_rows (import_id, week_start, member_id, winloss_chips, rake_chips, player_id) VALUES (?, '2026-07-27', '4004977', -1000, 100, ?)`).run((r2 as any).import_id, BOB);
  const m = playerWeeksOn(db, BOB).find(w => w.week_start === "2026-07-27")!;
  eq("détail par compte conservé", m.accounts.map(x => [x.member_id, x.winloss_chips]), [["4004977", -1000], ["4107823", 26411.41]]);
  eq4("W/L joueur = Σ comptes", m.winloss_chips, 25411.41);
  eq4("action ligne à ligne puis somme", m.action_chips, 0.15 * 26411.41 + 0.15 * -1000);
}

console.log("\n── 4. Grand livre chips : sens imposés, deux compteurs distincts ──");
{
  const impId = db.prepare(`SELECT id FROM xpoker_imports WHERE week_start = '2026-07-13'`).get().id;
  check("règlement club reçu (in)", addLedgerLineOn(db, { occurred_at: "2026-07-20", kind: "club_settlement", direction: "in", chips: 9115.0755, import_id: impId }).ok);
  eq("statut de l'import : reçu = Total du sheet", importSettlementStatusOn(db, impId), { sheet_total: 9115.0755, sheet_cleared: 9115.0755, ledger_chips: 9115.0755, matches_sheet: true });
  check("2ᵉ règlement club sur le même import ⇒ refus (UNIQUE)", !addLedgerLineOn(db, { occurred_at: "2026-07-21", kind: "club_settlement", direction: "in", chips: 1, import_id: impId }).ok);
  const free = addLedgerLineOn(db, { occurred_at: "2026-07-21", kind: "club_settlement", direction: "in", chips: 199.1325 });
  check("règlement club SANS import ⇒ refus moteur (F1)", !free.ok && /import_id requis/.test((free as any).error), JSON.stringify(free));
  check("… et refus SCHÉMA si on contourne le moteur (F1)", (() => { try {
    db.prepare(`INSERT INTO xpoker_chip_ledger (occurred_at, kind, direction, chips, rate_chips_per_usd) VALUES ('2026-07-21','club_settlement','in',199.1325,33)`).run(); return false;
  } catch (e: any) { return /CHECK constraint failed/.test(e.message); } })());
  eq("un seul règlement club au grand livre", db.prepare(`SELECT COUNT(*) n FROM xpoker_chip_ledger WHERE kind = 'club_settlement'`).get().n, 1);
  check("buy-in Bob 5000 (out)", addLedgerLineOn(db, { occurred_at: "2026-07-21", kind: "buyin", direction: "out", chips: 5000, player_id: BOB, member_id: "4107823" }).ok);
  check("cash-out Alice 2000 (in)", addLedgerLineOn(db, { occurred_at: "2026-07-22", kind: "cashout", direction: "in", chips: 2000, player_id: ALICE, member_id: "3062825" }).ok);
  check("buy-in en 'in' ⇒ refus", !addLedgerLineOn(db, { occurred_at: "2026-07-21", kind: "buyin", direction: "in", chips: 10, player_id: BOB, member_id: "4107823" }).ok);
  check("buy-in sur un ID qui n'est pas au joueur ⇒ refus", !addLedgerLineOn(db, { occurred_at: "2026-07-21", kind: "buyin", direction: "out", chips: 10, player_id: BOB, member_id: "3062825" }).ok);
  check("chips ≤ 0 ⇒ refus", !addLedgerLineOn(db, { occurred_at: "2026-07-21", kind: "adjustment", direction: "in", chips: 0 }).ok);
  check("date invalide ⇒ refus", !addLedgerLineOn(db, { occurred_at: "hier", kind: "adjustment", direction: "in", chips: 1, note: "x" }).ok);
  check("ajustement sans motif ⇒ refus moteur", /motif/.test((addLedgerLineOn(db, { occurred_at: "2026-07-21", kind: "adjustment", direction: "in", chips: 1 }) as any).error ?? ""));
  const stock = agencyStockOn(db);
  eq4("stock agence = 9115.0755 + 2000 − 5000", stock.stock_chips, 6115.0755);
  eq("par nature", stock.by_kind, { buyin: { in: 0, out: 5000 }, cashout: { in: 2000, out: 0 }, club_settlement: { in: 9115.0755, out: 0 } });
  const bobMv = playerMovementsOn(db, BOB);
  eq("mouvements Bob : buy-in 5000, cash-out 0", [bobMv.buyin_chips, bobMv.cashout_chips, bobMv.lines.length], [5000, 0, 1]);
  // DEUX COMPTEURS : la position de Bob (Σ dû de ses semaines) et le stock agence ne se combinent pas.
  // DEUX COMPTEURS, pour de vrai : les écritures de l'un ne bougent pas l'autre.
  const bobDueBefore = playerWeeksOn(db, BOB).reduce((s, w) => s + (w.due_chips ?? 0), 0);
  addLedgerLineOn(db, { occurred_at: "2026-07-23", kind: "buyin", direction: "out", chips: 777, player_id: BOB, member_id: "4107823" });
  const bobDueAfterLedger = playerWeeksOn(db, BOB).reduce((s, w) => s + (w.due_chips ?? 0), 0);
  check("un buy-in ne change pas la position (Σ dû) de Bob", bobDueBefore.toFixed(4) === bobDueAfterLedger.toFixed(4), `${bobDueBefore} → ${bobDueAfterLedger}`);
  const stockAfter = agencyStockOn(db).stock_chips;
  eq4("le buy-in a bien baissé le stock agence de 777", stockAfter, stock.stock_chips - 777);
  const stockBeforeDeal = agencyStockOn(db).stock_chips;
  setDealOn(db, { player_id: BOB, action_pct: 20, rb_pct: 20, start_week: "2026-08-03" });   // après la dernière semaine importée (7/27)
  eq4("un changement de deal ne bouge pas le stock agence", agencyStockOn(db).stock_chips, stockBeforeDeal);
  check("les deux nombres sont différents et ne se combinent nulle part", Math.abs(bobDueAfterLedger - stockAfter) > 1);
  // Taux historisé : un nouveau taux ne recalcule rien de figé.
  addRateOn(db, { effective_from: "2026-08-01", chips_per_usd: 30 });
  eq("import 7/13 toujours à 33", db.prepare(`SELECT rate_chips_per_usd r FROM xpoker_imports WHERE week_start = '2026-07-13'`).get().r, 33);
  eq("mouvement du 22/07 toujours à 33", db.prepare(`SELECT rate_chips_per_usd r FROM xpoker_chip_ledger WHERE kind = 'cashout'`).get().r, 33);
  eq("mais un mouvement du 05/08 prend 30", (() => { addLedgerLineOn(db, { occurred_at: "2026-08-05", kind: "adjustment", direction: "in", chips: 1, note: "test" }); return db.prepare(`SELECT rate_chips_per_usd r FROM xpoker_chip_ledger WHERE kind = 'adjustment'`).get().r; })(), 30);
  // Contre-passation (append-only) : la ligne fausse reste, son inverse s'ajoute, une seule fois.
  const wrong = addLedgerLineOn(db, { occurred_at: "2026-07-23", kind: "buyin", direction: "out", chips: 999, player_id: BOB, member_id: "4107823", note: "faute de frappe" });
  const stockBeforeRev = agencyStockOn(db).stock_chips;
  const rev = reverseLedgerLineOn(db, { line_id: (wrong as any).id, occurred_at: "2026-07-24", note: "999 saisi pour 99" });
  check("contre-passation ok", rev.ok, JSON.stringify(rev));
  eq4("le stock revient de +999", agencyStockOn(db).stock_chips, stockBeforeRev + 999);
  eq("la ligne inverse : adjustment, in, 999, même joueur/compte, reverses_id", db.prepare(`SELECT kind, direction, chips, player_id, member_id, reverses_id FROM xpoker_chip_ledger WHERE id = ?`).get((rev as any).id), { kind: "adjustment", direction: "in", chips: 999, player_id: BOB, member_id: "4107823", reverses_id: (wrong as any).id });
  check("la ligne fausse est toujours là (append-only)", db.prepare(`SELECT COUNT(*) n FROM xpoker_chip_ledger WHERE id = ?`).get((wrong as any).id).n === 1);
  check("deuxième contre-passation ⇒ refus", !reverseLedgerLineOn(db, { line_id: (wrong as any).id, occurred_at: "2026-07-24", note: "encore" }).ok);
  check("contre-passer une ligne inexistante ⇒ refus", !reverseLedgerLineOn(db, { line_id: 9999, occurred_at: "2026-07-24", note: "x" }).ok);
  check("supprimer l'import porteur d'un règlement club ⇒ refus", !deleteImportOn(db, impId).ok);
  const impMar = db.prepare(`SELECT id FROM xpoker_imports WHERE week_start = '2026-03-16'`).get().id;
  eq("supprimer l'import de mars (écart acté, sans mouvement) ⇒ ok, lignes en cascade", [deleteImportOn(db, impMar).ok, db.prepare(`SELECT COUNT(*) n FROM xpoker_week_rows WHERE week_start = '2026-03-16'`).get().n], [true, 0]);
}

console.log("\n── 5. GARDE : DELETE générique refusé sur un ID porteur de semaines ──");
{
  const gid = xpokerGameIdOn(db);
  const aliceRow = db.prepare(`SELECT id FROM player_game_ids WHERE game_id = ? AND external_id = '3062825'`).get(gid).id;
  const g = deleteGameIdRowOn(db, aliceRow, ALICE);
  check("refus nommé (ID + nombre de semaines)", !g.ok && /3062825 porte 1 semaine/.test((g as any).error), JSON.stringify(g));
  eq("la ligne est toujours là", db.prepare(`SELECT COUNT(*) n FROM player_game_ids WHERE id = ?`).get(aliceRow).n, 1);
  // Un ID XPoker SANS semaine se supprime encore.
  linkMemberIdOn(db, { player_id: CAROL, member_id: "4015766" });
  const freshRow = db.prepare(`SELECT id FROM player_game_ids WHERE external_id = '4015766'`).get().id;
  eq("ID XPoker sans semaine ⇒ supprimé", deleteGameIdRowOn(db, freshRow, CAROL), { ok: true, deleted: 1 });
  // Les autres games ne changent pas de comportement.
  const kk = db.prepare(`SELECT id FROM games WHERE name = 'KKPOKER'`).get().id;
  const kkRow = Number(db.prepare(`INSERT INTO player_game_ids (player_id, game_id, external_id) VALUES (?, ?, 'kk-1')`).run(ALICE, kk).lastInsertRowid);
  eq("ID KKPOKER ⇒ supprimé comme avant", deleteGameIdRowOn(db, kkRow, ALICE), { ok: true, deleted: 1 });
  eq("mauvais joueur ⇒ rien supprimé, pas d'erreur", deleteGameIdRowOn(db, aliceRow, CAROL), { ok: true, deleted: 0 });
  // CONTREFACTUEL : sans la garde, le DELETE nu passerait — on le vérifie sur une copie de la ligne.
  const naked = db.prepare(`SELECT COUNT(*) n FROM xpoker_week_rows WHERE member_id = '3062825' AND player_id = ?`).get(ALICE).n;
  check("contrefactuel : les semaines gardent player_id, que la garde protège", naked === 1);
  // Archivage : l'historique reste, un import futur repart en réconciliation, la réactivation relie.
  eq("archiver 3062825", archiveAccountOn(db, aliceRow, ALICE), { ok: true });
  eq("statut archivé, semaines conservées", accountsForPlayerOn(db, ALICE).map(a => [a.member_id, a.status, a.weeks_imported]), [["3062825", "archived", 1]]);
  check("archived_at posé", accountsForPlayerOn(db, ALICE)[0].archived_at !== null);
  const r3 = commitImportOn(db, { block: block({ rows: CAS1 }, "8/10"), week_start: "2026-08-03", week_end: "2026-08-09", source: "xlsx" });
  eq("ID archivé ⇒ la nouvelle semaine est orpheline", r3.ok ? r3.unlinked : r3, ["3062825"]);
  eq("la réconciliation signale « archivé chez Alice »", unlinkedMembersOn(db)[0].archived_on, { player_id: ALICE, name: "Alice" });
  const re = linkMemberIdOn(db, { player_id: ALICE, member_id: "3062825" });
  eq("réactivation relie la semaine orpheline, sans doublon de ligne", [re.ok ? re.rows_linked : re, db.prepare(`SELECT COUNT(*) n FROM player_game_ids WHERE external_id = '3062825'`).get().n], [1, 1]);
  eq("statut redevenu actif, archived_at effacé", [accountsForPlayerOn(db, ALICE)[0].status, accountsForPlayerOn(db, ALICE)[0].archived_at], ["active", null]);
  eq("l'import porte club_id et la ligne club du bloc de règlement (B11)", db.prepare(`SELECT club_id, sheet_cleared_club_line FROM xpoker_imports WHERE week_start = '2026-07-13'`).get(), { club_id: "246579", sheet_cleared_club_line: 9115.0755 });
  check("intégrité", db.pragma("integrity_check")[0].integrity_check === "ok" && db.pragma("foreign_key_check").length === 0);
}

console.log("\n── 6. R1 : déplacer un Player ID rattaché à tort — explicite, tracé, refusé si réglé ──");
{
  // 3062825 est chez Alice avec 2 semaines (7/13 et 8/03) et un cash-out ; en fait c'est Carol.
  const aliceBefore = playerWeeksOn(db, ALICE).map(w => w.week_start);
  const carolBefore = playerWeeksOn(db, CAROL).map(w => w.week_start);
  eq("avant : Alice a 7/13 + 8/03, Carol n'a pas 8/03", [aliceBefore, carolBefore.includes("2026-08-03")], [["2026-08-03", "2026-07-13"], false]);
  check("ID inconnu ⇒ refus", !relinkMemberIdOn(db, { member_id: "9999999", to_player_id: CAROL }).ok);
  check("vers le même joueur ⇒ refus", !relinkMemberIdOn(db, { member_id: "3062825", to_player_id: ALICE }).ok);
  check("vers un joueur inexistant ⇒ refus", !relinkMemberIdOn(db, { member_id: "3062825", to_player_id: 99 }).ok);
  // Une semaine réglée chez l'ancien joueur bloque (étape 4 n'existe pas encore : on simule la ligne figée).
  const gid = xpokerGameIdOn(db);
  const sid = Number(db.prepare(`INSERT INTO manual_settlements (game_id, player_id, amount_due_usdt, amount_due_native, native_currency, fx_rate_applied) VALUES (?, ?, -94.75, -3126.74, 'TWD', 33)`).run(gid, ALICE).lastInsertRowid);
  db.prepare(`INSERT INTO xpoker_settlement_weeks (settlement_id, player_id, week_start, winloss_chips, rake_chips, action_pct, rb_pct, action_chips, rb_chips, due_chips, rate_chips_per_usd) VALUES (?, ?, '2026-07-13', -31267.4, 4647.88, 10, 0, -3126.74, 0, -3126.74, 33)`).run(sid, ALICE);
  const blocked = relinkMemberIdOn(db, { member_id: "3062825", to_player_id: CAROL, reason: "erreur de saisie" });
  check("semaine réglée ⇒ refus nommé avec la liste", !blocked.ok && /2026-07-13 \(Alice, règlement #/.test((blocked as any).error), JSON.stringify(blocked));
  eq("… la liste dit qui et quel règlement", (blocked as any).blocking, [{ week_start: "2026-07-13", player_id: ALICE, player_name: "Alice", settlement_id: sid }]);
  eq("rien n'a bougé", playerWeeksOn(db, ALICE).map(w => w.week_start), aliceBefore);
  eq("aucune trace écrite sur un refus", relinkLogOn(db, "3062825"), []);
  db.prepare(`DELETE FROM xpoker_settlement_weeks WHERE settlement_id = ?`).run(sid);
  db.prepare(`DELETE FROM manual_settlements WHERE id = ?`).run(sid);
  const moved = relinkMemberIdOn(db, { member_id: "3062825", to_player_id: CAROL, reason: "erreur de saisie : 冲浪者 = Carol" });
  check("déplacement accepté", moved.ok, JSON.stringify(moved));
  if (moved.ok) {
    eq("2 semaines et 1 mouvement (le cash-out) déplacés", { w: moved.weeks, m: moved.movements, from: moved.from_player_id, to: moved.to_player_id }, { w: ["2026-07-13", "2026-08-03"], m: 1, from: ALICE, to: CAROL });
  }
  eq("Alice n'a plus rien sur cet ID", playerWeeksOn(db, ALICE), []);
  eq("Carol a maintenant 7/13 et 8/03 en plus", playerWeeksOn(db, CAROL).map(w => w.week_start), ["2026-08-03", "2026-07-27", "2026-07-13"]);
  eq4("recalcul côté Carol : 7/13 = ses deux comptes, à SON deal (10 %)", playerWeeksOn(db, CAROL).find(w => w.week_start === "2026-07-13")!.action_chips, 0.10 * (-31267.4 - 11722.87));
  eq("le compte est chez Carol, actif", accountsForPlayerOn(db, CAROL).map(a => [a.member_id, a.status]).sort(), [["3062825", "active"], ["4136708", "active"]]);
  eq("le cash-out a suivi", playerMovementsOn(db, CAROL).cashout_chips, 2000);
  const log = relinkLogOn(db, "3062825");
  eq("trace : de qui vers qui, quelles semaines, combien de mouvements, pourquoi", log.map(l => [l.from_name, l.to_name, l.weeks, l.movements, l.reason, l.actor]), [["Alice", "Carol", ["2026-07-13", "2026-08-03"], 1, "erreur de saisie : 冲浪者 = Carol", "baki"]]);
  check("intégrité après déplacement", db.pragma("integrity_check")[0].integrity_check === "ok" && db.pragma("foreign_key_check").length === 0);
}

console.log(`\n${passed} ✔  ${failures.length} ✘`);
if (failures.length) { console.log("ÉCHECS :", failures); process.exit(1); }
