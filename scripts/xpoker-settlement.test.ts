/**
 * Harnais du règlement joueur XPoker Twd (étape 4).
 * Run: npx tsx scripts/xpoker-settlement.test.ts
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────┐
 * │ A. Base minimale + vraie DDL : le lock recalcule et FIGE (chips, deal,   │
 * │    taux) ; sens dans les deux directions ; refus nommés sur semaine      │
 * │    incalculable, en écart (acté ou non), déjà réglée, inconnue, vide ;   │
 * │    double règlement impossible (schéma) ; F2 sur semaine réglée ; R1     │
 * │    bloqué par une semaine réglée ; un nouveau taux ne bouge rien de figé ;│
 * │    manual_settlements en natif chips, USD = équivalent ; le grand livre  │
 * │    s'écrit au markPaid seulement (action_paid in/out, rb_paid out), date │
 * │    réelle obligatoire, une seule fois (schéma) ; délock = semaines       │
 * │    libérées ; un règlement payé ne se supprime pas (NO ACTION).          │
 * │ B. Copie de la base locale, VRAIES fonctions du moteur commun : markPaid │
 * │    refuse sans date, écrit les mouvements avec, refuse le double-paiement,│
 * │    unlockSettlement libère / refuse un payé ; le hub liste la ligne en    │
 * │    natif et l'EXCLUT du net par joueur et des totaux ; settlementDetail.  │
 * └─────────────────────────────────────────────────────────────────────────┘
 * ┌─ CE QU'ILS NE PROUVENT PAS ─────────────────────────────────────────────┐
 * │ L'écran /payments et /xpoker (pas d'UI ici) ; la prod.                   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import fs from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..");
const Database = require(path.join(REPO, "node_modules/better-sqlite3"));

import { runXpokerMigrationV1, type XpokerSeed } from "../lib/games/xpoker/schema";
import { XPOKER_GAME_NAME, XPOKER_DEFAULT_ACTION_PCT, XPOKER_SEED_CHIPS_PER_USD, XPOKER_SEED_RATE_EFFECTIVE_FROM, XPOKER_SEED_AGENCY_ACCOUNTS } from "../lib/games/xpoker/config";
import { commitImportOn, linkMemberIdOn, setDealOn, playerWeeksOn, addRateOn, agencyStockOn, relinkMemberIdOn, addLedgerLineOn } from "../lib/games/xpoker/engine";
import { getSettleableWeeksOn, lockXpokerSettlementOn, writeXpokerLedgerOnPaidOn, getXpokerSettlementsOn, getSettledWeeksOn } from "../lib/games/xpoker/settlement";
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
function eq4(label: string, got: number | null | undefined, want: number) {
  const g = got == null ? "null" : got.toFixed(4), w = want.toFixed(4);
  check(label, g === w, g === w ? "" : `attendu ${w}, obtenu ${g}`);
}

const SEED: XpokerSeed = { gameName: XPOKER_GAME_NAME, defaultActionPct: XPOKER_DEFAULT_ACTION_PCT, seedChipsPerUsd: XPOKER_SEED_CHIPS_PER_USD, seedRateEffectiveFrom: XPOKER_SEED_RATE_EFFECTIVE_FROM, agencyAccounts: XPOKER_SEED_AGENCY_ACCOUNTS };

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE _applied_fixes (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')), default_action_pct REAL, currency TEXT NOT NULL DEFAULT 'USDT');
    CREATE TABLE player_game_ids (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE, game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL, UNIQUE(game_id, external_id));
    CREATE TABLE manual_settlements (id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE, player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      net_selected_usdt REAL NOT NULL DEFAULT 0, action_pct_applied REAL NOT NULL DEFAULT 0, amount_due_usdt REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','paid')), tx_hash TEXT, notes TEXT,
      locked_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_date TEXT, kind TEXT NOT NULL DEFAULT 'action');
    INSERT INTO players (name) VALUES ('Alice'), ('Bob'), ('Toxiss');
  `);
  runXpokerMigrationV1(db, SEED);
  return db;
}
const ALICE = 1, BOB = 2, TOX = 3;

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n── A1. Mise en place : 2 semaines, Alice perdante, Bob gagnant, Toxiss sans deal ──");
const db = freshDb();
{
  linkMemberIdOn(db, { player_id: ALICE, member_id: "3062825" });
  linkMemberIdOn(db, { player_id: BOB, member_id: "4107823" });
  linkMemberIdOn(db, { player_id: TOX, member_id: "4136708" });
  setDealOn(db, { player_id: ALICE, action_pct: 10, rb_pct: 20, start_week: "2026-07-06" });
  setDealOn(db, { player_id: BOB, action_pct: 10, rb_pct: 0, start_week: "2026-07-06" });
  const r1 = commitImportOn(db, { block: block({ rows: CAS2 }, "7/20"), week_start: "2026-07-13", week_end: "2026-07-19", source: "xlsx" });
  const rows2: FixRow[] = [{ pid: "3062825", wl: -136.2, rake: 256.43 }, { pid: "4107823", wl: 26411.41, rake: 4854.14 }];
  const r2 = commitImportOn(db, { block: block({ rows: rows2 }, "8/3"), week_start: "2026-07-27", week_end: "2026-08-02", source: "xlsx" });
  // Une semaine en écart ACTÉ pour Alice (3/23 : TAX=0)
  const r3 = commitImportOn(db, { block: block({ rows: CAS1, taxParam: 0 }, "3/23"), week_start: "2026-07-06", week_end: "2026-07-12", source: "xlsx", override_reason: "TAX=0 en D2" });
  check("3 imports", r1.ok && r2.ok && r3.ok, JSON.stringify([r1, r2, r3]));

  const a = getSettleableWeeksOn(db, ALICE);
  eq("Alice : réglables 7/13 et 7/27, bloquée 7/06 (écart acté)", { s: a.settleable.map(w => w.week_start), b: a.blocked }, { s: ["2026-07-27", "2026-07-13"], b: [{ week_start: "2026-07-06", reason: "flagged" }] });
  eq4("Alice 7/13 : action −3126.74, RB 929.576 → dû −4056.316 (je lui dois)", a.settleable[1].due_chips, -3126.74 - 929.576);
  const b = getSettleableWeeksOn(db, BOB);
  eq4("Bob 7/13 : +1405.356 (il me doit)", b.settleable.find(w => w.week_start === "2026-07-13")!.due_chips, 1405.356);
  const t = getSettleableWeeksOn(db, TOX);
  eq("Toxiss sans deal : rien de réglable, semaine bloquée « no_deal »", { s: t.settleable.length, b: t.blocked }, { s: 0, b: [{ week_start: "2026-07-13", reason: "no_deal" }] });
}

console.log("\n── A2. Refus nommés ──");
{
  check("aucune semaine ⇒ refus", !lockXpokerSettlementOn(db, { player_id: ALICE, week_starts: [] }).ok);
  check("joueur inconnu ⇒ refus", !lockXpokerSettlementOn(db, { player_id: 99, week_starts: ["2026-07-13"] }).ok);
  const nd = lockXpokerSettlementOn(db, { player_id: TOX, week_starts: ["2026-07-13"] });
  check("semaine incalculable (sans deal) ⇒ refus nommé", !nd.ok && /incalculable/.test((nd as any).error), (nd as any).error);
  const fl = lockXpokerSettlementOn(db, { player_id: ALICE, week_starts: ["2026-07-06"] });
  check("import en écart acté ⇒ refus nommé « jamais réglable en un clic »", !fl.ok && /écart/.test((fl as any).error), (fl as any).error);
  const unk = lockXpokerSettlementOn(db, { player_id: ALICE, week_starts: ["2026-09-07"] });
  check("semaine inconnue ⇒ refus nommé", !unk.ok && /inconnue/.test((unk as any).error));
  const mixed = lockXpokerSettlementOn(db, { player_id: ALICE, week_starts: ["2026-07-13", "2026-07-06"] });
  check("une bonne + une bloquée ⇒ refus global, rien d'écrit", !mixed.ok && db.prepare(`SELECT COUNT(*) n FROM manual_settlements`).get().n === 0);
}

console.log("\n── A3. Lock : recalcul par le moteur, natif chips, tout figé ──");
let aliceSid = 0, bobSid = 0;
{
  const r = lockXpokerSettlementOn(db, { player_id: ALICE, week_starts: ["2026-07-13", "2026-07-27"], notes: "semaines de juillet" });
  check("lock Alice ok", r.ok, JSON.stringify(r));
  if (r.ok) {
    aliceSid = r.settlement_id;
    const dueA = (-3126.74 - 929.576) + (-13.62 - 51.286);
    eq4("dû net Alice = Σ(action − RB) des deux semaines", r.due_chips, dueA);
    eq4("équivalent USD = Σ chips / 33", r.due_usd, dueA / 33);
    const ms = db.prepare(`SELECT game_id, player_id, kind, amount_due_native, native_currency, fx_rate_applied, amount_due_usdt, action_pct_applied, status, notes FROM manual_settlements WHERE id = ?`).get(aliceSid);
    eq("manual_settlements : natif chips, TWD, taux figé 33, kind xpoker, locked", { ...ms, amount_due_native: +ms.amount_due_native.toFixed(4), amount_due_usdt: +ms.amount_due_usdt.toFixed(4) },
       { game_id: db.prepare(`SELECT id FROM games WHERE name='XPOKER_TWD'`).get().id, player_id: ALICE, kind: "xpoker", amount_due_native: +dueA.toFixed(4), native_currency: "TWD", fx_rate_applied: 33, amount_due_usdt: +(dueA / 33).toFixed(4), action_pct_applied: 10, status: "locked", notes: "semaines de juillet" });
    eq("chaque semaine figée porte l'import d'origine", db.prepare(`SELECT COUNT(*) n FROM xpoker_settlement_weeks sw JOIN xpoker_imports i ON i.id = sw.import_id AND i.week_start = sw.week_start WHERE settlement_id = ?`).get(aliceSid).n, 2);
    // Le règlement club se contre-passe ? Non : une ligne née d'un règlement JOUEUR ne se nie pas.
    const sw = db.prepare(`SELECT week_start, winloss_chips, rake_chips, action_pct, rb_pct, action_chips, rb_chips, due_chips, rate_chips_per_usd FROM xpoker_settlement_weeks WHERE settlement_id = ? ORDER BY week_start`).all(aliceSid);
    eq("semaines figées : chips, deal, taux", sw.map((w: any) => [w.week_start, w.winloss_chips, w.action_pct, w.rb_pct, +w.due_chips.toFixed(4), w.rate_chips_per_usd]),
       [["2026-07-13", -31267.4, 10, 20, +(-3126.74 - 929.576).toFixed(4), 33], ["2026-07-27", -136.2, 10, 20, +(-13.62 - 51.286).toFixed(4), 33]]);
  }
  const rb = lockXpokerSettlementOn(db, { player_id: BOB, week_starts: ["2026-07-13"] });
  check("lock Bob ok", rb.ok);
  if (rb.ok) { bobSid = rb.settlement_id; eq4("Bob : +1405.356, il me doit", rb.due_chips, 1405.356); }
  // Sens des deux côtés, sur le même schéma, la même semaine.
  const signs = db.prepare(`SELECT player_id, amount_due_native FROM manual_settlements ORDER BY player_id`).all();
  check("Alice < 0 (je lui dois), Bob > 0 (il me doit) — symétrique", signs[0].amount_due_native < 0 && signs[1].amount_due_native > 0);
  eq("semaines réglées d'Alice", [...getSettledWeeksOn(db, ALICE).keys()], ["2026-07-13", "2026-07-27"]);
  const again = lockXpokerSettlementOn(db, { player_id: ALICE, week_starts: ["2026-07-13"] });
  check("re-régler une semaine ⇒ refus nommé « déjà réglée (#id) »", !again.ok && new RegExp(`déjà réglée \\(règlement #${aliceSid}\\)`).test((again as any).error), (again as any).error);
  check("… et le schéma le refuse aussi si on contourne le moteur", (() => { try {
    db.prepare(`INSERT INTO xpoker_settlement_weeks (settlement_id, player_id, week_start, winloss_chips, rake_chips, action_pct, rb_pct, action_chips, rb_chips, due_chips, rate_chips_per_usd) VALUES (?, ?, '2026-07-13', 0, 0, 10, 0, 0, 0, 0, 33)`).run(bobSid, ALICE); return false;
  } catch (e: any) { return /UNIQUE/.test(e.message); } })());
  eq("Alice : plus rien de réglable, 7/13 et 7/27 « settled », 7/06 « flagged »", getSettleableWeeksOn(db, ALICE).blocked.map(b => [b.week_start, b.reason]), [["2026-07-27", "settled"], ["2026-07-13", "settled"], ["2026-07-06", "flagged"]]);
}

console.log("\n── A4. Ce qui ne bouge plus : deal (F2), joueur (R1), taux ──");
{
  const f2 = setDealOn(db, { player_id: ALICE, action_pct: 50, rb_pct: 0, start_week: "2026-07-13" });
  check("changer le deal sur une semaine réglée ⇒ refus (F2)", !f2.ok, f2.error);
  const r1 = relinkMemberIdOn(db, { member_id: "3062825", to_player_id: BOB, reason: "test" });
  check("déplacer l'ID d'une semaine réglée ⇒ refus (R1) nommant le règlement", !r1.ok && new RegExp(`règlement #${aliceSid}`).test((r1 as any).error), (r1 as any).error);
  addRateOn(db, { effective_from: "2026-08-01", chips_per_usd: 30 });
  eq("un nouveau taux ne réécrit ni le règlement ni ses semaines", db.prepare(`SELECT fx_rate_applied f, (SELECT MIN(rate_chips_per_usd) FROM xpoker_settlement_weeks WHERE settlement_id = ms.id) w FROM manual_settlements ms WHERE id = ?`).get(aliceSid), { f: 33, w: 33 });
  eq4("… et playerWeeksOn rend toujours la semaine au taux figé de son import", playerWeeksOn(db, ALICE).find(w => w.week_start === "2026-07-27")!.rate_chips_per_usd, 33);
  // Au lock, RIEN au grand livre.
  eq("aucun mouvement au grand livre au lock", db.prepare(`SELECT COUNT(*) n FROM xpoker_chip_ledger`).get().n, 0);
}

console.log("\n── A5. Grand livre au markPaid : date réelle obligatoire, action_paid + rb_paid, une seule fois ──");
{
  check("sans date ⇒ jette (le règlement ne passera pas payé)", (() => { try { writeXpokerLedgerOnPaidOn(db, aliceSid, null); return false; } catch (e: any) { return /date RÉELLE/.test(e.message); } })());
  eq("rien d'écrit après le refus", db.prepare(`SELECT COUNT(*) n FROM xpoker_chip_ledger`).get().n, 0);
  eq("règlement non XPoker ⇒ no-op", writeXpokerLedgerOnPaidOn(db, 9999, "2026-08-03"), { written: 0 });
  const w = writeXpokerLedgerOnPaidOn(db, aliceSid, "2026-08-03");
  eq("Alice : 2 lignes (action out, rb out)", w, { written: 2 });
  const lines = db.prepare(`SELECT kind, direction, chips, occurred_at, player_id, settlement_id, rate_chips_per_usd FROM xpoker_chip_ledger WHERE settlement_id = ? ORDER BY kind`).all(aliceSid);
  eq("action_paid OUT |−3140.36| ; rb_paid OUT 980.862 ; datés du transfert ; taux figé du règlement", lines.map((l: any) => [l.kind, l.direction, +l.chips.toFixed(4), l.occurred_at, l.player_id, l.rate_chips_per_usd]),
     [["action_paid", "out", +(3126.74 + 13.62).toFixed(4), "2026-08-03", ALICE, 33], ["rb_paid", "out", +(929.576 + 51.286).toFixed(4), "2026-08-03", ALICE, 33]]);
  eq4("stock agence = −(3140.36 + 980.862)", agencyStockOn(db).stock_chips, -(3126.74 + 13.62 + 929.576 + 51.286));
  check("second markPaid ⇒ refusé par le SCHÉMA (UNIQUE settlement_id, kind)", (() => { try { writeXpokerLedgerOnPaidOn(db, aliceSid, "2026-08-04"); return false; } catch (e: any) { return /UNIQUE/.test(e.message); } })());
  eq("toujours 2 lignes", db.prepare(`SELECT COUNT(*) n FROM xpoker_chip_ledger WHERE settlement_id = ?`).get(aliceSid).n, 2);
  const paidLine = db.prepare(`SELECT id FROM xpoker_chip_ledger WHERE settlement_id = ? AND kind = 'action_paid'`).get(aliceSid).id;
  const rv = (require("../lib/games/xpoker/engine") as typeof import("../lib/games/xpoker/engine")).reverseLedgerLineOn(db, { line_id: paidLine, occurred_at: "2026-08-04", note: "tentative" });
  check("une ligne de règlement ne se contre-passe pas (on déverrouille le règlement)", !rv.ok && /règlement #/.test((rv as any).error), JSON.stringify(rv));
  const wb = writeXpokerLedgerOnPaidOn(db, bobSid, "2026-08-03");
  eq("Bob : 1 ligne (action IN, pas de RB)", wb, { written: 1 });
  eq("action_paid IN 1405.356 : il me règle", db.prepare(`SELECT kind, direction, chips FROM xpoker_chip_ledger WHERE settlement_id = ?`).all(bobSid).map((l: any) => [l.kind, l.direction, +l.chips.toFixed(4)]), [["action_paid", "in", 1405.356]]);
  // Le buy-in n'est pas dans le règlement, et le règlement n'est pas dans les mouvements joueur « trésorerie ».
  check("buy-in indépendant du règlement", addLedgerLineOn(db, { occurred_at: "2026-08-04", kind: "buyin", direction: "out", chips: 500, player_id: BOB, member_id: "4107823" }).ok);
  eq("règlements de Bob : 1, payé côté grand livre mais statut géré par le moteur commun", getXpokerSettlementsOn(db, BOB).map(s => [s.id, s.status, +s.due_chips.toFixed(4), s.weeks.map(w => w.week_start)]), [[bobSid, "locked", 1405.356, ["2026-07-13"]]]);
}

console.log("\n── A4bis. F1 : rattacher un compte orphelin sur une semaine déjà réglée ⇒ refus nommé ──");
{
  // 4136708 est orphelin sur 7/13 (import CAS2) ; Alice a 7/13 RÉGLÉE (#aliceSid). Le
  // rattacher à Alice rendrait sa part (−1172.287) irrécouvrable sans signal.
  db.prepare(`DELETE FROM player_game_ids WHERE external_id = '4136708'`).run();
  db.prepare(`UPDATE xpoker_week_rows SET player_id = NULL WHERE member_id = '4136708'`).run();
  const before = playerWeeksOn(db, ALICE).find(w => w.week_start === "2026-07-13")!.due_chips;
  const l = linkMemberIdOn(db, { player_id: ALICE, member_id: "4136708" });
  check("refus nommé (semaine + règlement)", !l.ok && new RegExp(`2026-07-13 \\(règlement #${aliceSid}\\)`).test((l as any).error), JSON.stringify(l));
  eq("rien n'a bougé : compte non créé, lignes toujours orphelines, dû d'Alice inchangé",
     [db.prepare(`SELECT COUNT(*) n FROM player_game_ids WHERE external_id = '4136708'`).get().n, db.prepare(`SELECT player_id FROM xpoker_week_rows WHERE member_id = '4136708'`).get().player_id, playerWeeksOn(db, ALICE).find(w => w.week_start === "2026-07-13")!.due_chips],
     [0, null, before]);
  // Chez Bob la semaine 7/13 est aussi réglée → même refus ; chez Toxiss (rien de réglé) → ok.
  check("chez Bob (7/13 réglée) ⇒ refus", !linkMemberIdOn(db, { player_id: BOB, member_id: "4136708" }).ok);
  const t = linkMemberIdOn(db, { player_id: TOX, member_id: "4136708" });
  eq("chez Toxiss (rien de réglé) ⇒ ok, 1 ligne reliée", t.ok ? t.rows_linked : t, 1);
  // Et un import dont une semaine est réglée ne se supprime plus.
  const impId = db.prepare(`SELECT id FROM xpoker_imports WHERE week_start = '2026-07-13'`).get().id;
  const del = (require("../lib/games/xpoker/engine") as typeof import("../lib/games/xpoker/engine")).deleteImportOn(db, impId);
  check("supprimer un import porteur de semaines réglées ⇒ refus", !del.ok && /réglée/.test(del.error ?? ""), del.error);
}

console.log("\n── A6. Délock et suppression ──");
{
  // Un règlement PAYÉ (avec mouvements) ne se supprime pas : NO ACTION sur xpoker_chip_ledger.
  check("DELETE d'un règlement porteur de mouvements ⇒ refusé par le schéma", (() => { try { db.prepare(`DELETE FROM manual_settlements WHERE id = ?`).run(bobSid); return false; } catch (e: any) { return /FOREIGN KEY/.test(e.message); } })());
  // Un règlement sans mouvement (délock légitime) libère ses semaines par cascade.
  const r = lockXpokerSettlementOn(db, { player_id: BOB, week_starts: ["2026-07-27"] });
  const sid = (r as any).settlement_id;
  db.prepare(`DELETE FROM manual_settlements WHERE id = ?`).run(sid);
  eq("délock : semaine libérée (cascade)", getSettleableWeeksOn(db, BOB).settleable.map(w => w.week_start), ["2026-07-27"]);
  check("intégrité", db.pragma("integrity_check")[0].integrity_check === "ok" && db.pragma("foreign_key_check").length === 0);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n── B. Moteur commun réel (markPaid / unlockSettlement / hub) sur une COPIE de la base locale ──");
{
  const candidates = [process.env.LECERCLE_DB_SRC, path.join(REPO, "data", "lecercle.db"), path.join(REPO, "..", "..", "..", "data", "lecercle.db")].filter((p): p is string => !!p);
  const src = candidates.find(p => fs.existsSync(p));
  if (!src) { console.log("   (data/lecercle.db absent — bloc B sauté)"); }
  else {
    const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lecercle-xpsettle-")));
    fs.mkdirSync(path.join(TMP, "data")); fs.copyFileSync(src, path.join(TMP, "data", "lecercle.db"));
    process.chdir(TMP);
    const ol = console.log, oe = console.error; console.log = () => {}; console.error = () => {};
    const { getDb } = require(path.join(REPO, "lib/db.ts"));
    const { markPaid, unlockSettlement, getPendingSettlements, groupPendingByPlayer, getPaymentsTotals, settlementDetail, getPaidSettlements } = require(path.join(REPO, "lib/manual-settlement-engine.ts"));
    const d = getDb();
    console.log = ol; console.error = oe;

    const pid = Number(d.prepare(`INSERT INTO players (name) VALUES ('XP Test')`).run().lastInsertRowid);
    linkMemberIdOn(d, { player_id: pid, member_id: "4107823" });
    setDealOn(d, { player_id: pid, action_pct: 10, rb_pct: 0, start_week: "2026-07-06" });
    const imp = commitImportOn(d, { block: block({ rows: CAS2 }, "7/20"), week_start: "2026-07-13", week_end: "2026-07-19", source: "xlsx" });
    check("import sur la copie", imp.ok, JSON.stringify(imp));
    const lock = lockXpokerSettlementOn(d, { player_id: pid, week_starts: ["2026-07-13"] });
    check("lock sur la copie", lock.ok, JSON.stringify(lock));
    const sid = (lock as any).settlement_id;

    const pending = getPendingSettlements().filter((s: any) => s.id === sid);
    eq("le hub liste la ligne : room XPOKER, natif chips, équivalent USD, période = la semaine", pending.map((s: any) => [s.room_label, s.kind, +s.amount_due_native.toFixed(4), s.native_currency, s.fx_rate_applied, +s.amount_due_usdt.toFixed(4), s.period_start, s.period_end]),
       [["XPOKER", "xpoker", 1405.356, "TWD", 33, +(1405.356 / 33).toFixed(4), "2026-07-13", "2026-07-13"]]);
    const g = groupPendingByPlayer(getPendingSettlements()).find((x: any) => x.player_id === pid);
    eq("net par joueur : EXCLU de la compensation (net 0, native_count 1, room native)", [g.net_usdt, g.incoming_usdt, g.native_count, g.rooms.map((r: any) => [r.label, r.native, r.net_usdt])], [0, 0, 1, [["XPOKER", true, 0]]]);
    const allPending = getPendingSettlements();
    const totals = getPaymentsTotals(allPending);
    const expectedIn = allPending.filter((s: any) => !s.native_currency && s.amount_due_usdt > 0).reduce((a: number, s: any) => a + s.amount_due_usdt, 0);
    const expectedOut = allPending.filter((s: any) => !s.native_currency && s.amount_due_usdt < 0).reduce((a: number, s: any) => a - s.amount_due_usdt, 0);
    eq("totaux : incoming/outgoing = Σ des seules lignes USDT ; la ligne chips comptée à part", [+totals.incoming_usdt.toFixed(6), +totals.outgoing_usdt.toFixed(6), totals.native_pending_count], [+expectedIn.toFixed(6), +expectedOut.toFixed(6), 1]);
    check("settlementDetail : chips, pas de « × % » sur l'USD", /chips/.test(settlementDetail(pending[0], (n: number) => n.toFixed(2))) && !/×/.test(settlementDetail(pending[0], (n: number) => n.toFixed(2))));

    const noDate = markPaid(sid);
    check("markPaid SANS date ⇒ refusé, statut inchangé, aucun mouvement", !noDate.ok && /date RÉELLE/.test(noDate.error ?? "") && d.prepare(`SELECT status FROM manual_settlements WHERE id = ?`).get(sid).status === "locked" && d.prepare(`SELECT COUNT(*) n FROM xpoker_chip_ledger WHERE settlement_id = ?`).get(sid).n === 0, JSON.stringify(noDate));
    const paid = markPaid(sid, undefined, "2026-07-21");
    check("markPaid avec date ⇒ ok", paid.ok, JSON.stringify(paid));
    eq("statut payé, paid_date = date réelle", d.prepare(`SELECT status, paid_date FROM manual_settlements WHERE id = ?`).get(sid), { status: "paid", paid_date: "2026-07-21" });
    eq("mouvement action_paid IN 1405.356 daté 2026-07-21", d.prepare(`SELECT kind, direction, chips, occurred_at FROM xpoker_chip_ledger WHERE settlement_id = ?`).all(sid).map((l: any) => [l.kind, l.direction, +l.chips.toFixed(4), l.occurred_at]), [["action_paid", "in", 1405.356, "2026-07-21"]]);
    check("double paiement ⇒ refusé", !markPaid(sid, undefined, "2026-07-22").ok);
    check("unlock d'un règlement payé ⇒ refusé", !unlockSettlement(sid).ok);
    eq("historique payé : la ligne est là, en natif", getPaidSettlements().filter((s: any) => s.id === sid).map((s: any) => [s.status, +s.amount_due_native.toFixed(4), s.paid_on]), [["paid", 1405.356, "2026-07-21"]]);
    eq("côté page : règlement payé le 2026-07-21", getXpokerSettlementsOn(d, pid).map(s => [s.id, s.status, s.paid_date]), [[sid, "paid", "2026-07-21"]]);

    // Délock légitime d'un règlement locké : semaines libérées.
    const rows2: FixRow[] = [{ pid: "4107823", wl: 26411.41, rake: 4854.14 }];
    commitImportOn(d, { block: block({ rows: rows2 }, "8/3"), week_start: "2026-07-27", week_end: "2026-08-02", source: "xlsx" });
    const lock2 = lockXpokerSettlementOn(d, { player_id: pid, week_starts: ["2026-07-27"] });
    const un = unlockSettlement((lock2 as any).settlement_id);
    check("unlock d'un règlement locké ⇒ ok", un.ok, JSON.stringify(un));
    eq("semaine libérée", getSettleableWeeksOn(d, pid).settleable.map(w => w.week_start), ["2026-07-27"]);
    check("intégrité copie", d.pragma("integrity_check")[0].integrity_check === "ok" && d.pragma("foreign_key_check").length === 0);
    d.close(); process.chdir(REPO); fs.rmSync(TMP, { recursive: true, force: true });
  }
}

console.log(`\n${passed} ✔  ${failures.length} ✘`);
if (failures.length) { console.log("ÉCHECS :", failures); process.exit(1); }
