/**
 * XPoker Twd — FUZZ des deals (né de l'audit money-auditor du 2026-09-21, F2 recalibrée).
 * Run: npx tsx scripts/xpoker-deal-fuzz.test.ts   (graines 1..4, déterministe, tout en :memory:)
 *
 * Après CHAQUE setDealOn / lock aléatoire : une seule période ouverte, aucun chevauchement,
 * end ≥ start, adjacentes identiques fusionnées, chaque semaine RÉGLÉE recalculée par
 * playerWeeksOn au taux et au dû figés (invariants 9/10), refus ⇒ état intact, aperçu ==
 * résultat écrit (semaine par semaine, et rien hors aperçu ne bouge), totaux == Σ live.
 * Couvre ce que les cas nommés n'assèrent pas : split d'une période fermée par le milieu,
 * fusion à gauche, multi-comptes, séquences longues.
 */
import path from "path";
const REPO = path.resolve(__dirname, "..");
const Database = require(path.join(REPO, "node_modules/better-sqlite3"));
import { runXpokerMigrationV1, type XpokerSeed } from "../lib/games/xpoker/schema";
import { XPOKER_GAME_NAME, XPOKER_DEFAULT_ACTION_PCT, XPOKER_SEED_CHIPS_PER_USD, XPOKER_SEED_RATE_EFFECTIVE_FROM, XPOKER_SEED_AGENCY_ACCOUNTS } from "../lib/games/xpoker/config";
import { commitImportOn, linkMemberIdOn, setDealOn, playerWeeksOn, dealForWeekOn } from "../lib/games/xpoker/engine";
import { lockXpokerSettlementOn } from "../lib/games/xpoker/settlement";
import { block, type FixRow } from "./xpoker-fixture";

const SEED: XpokerSeed = { gameName: XPOKER_GAME_NAME, defaultActionPct: XPOKER_DEFAULT_ACTION_PCT, seedChipsPerUsd: XPOKER_SEED_CHIPS_PER_USD, seedRateEffectiveFrom: XPOKER_SEED_RATE_EFFECTIVE_FROM, agencyAccounts: XPOKER_SEED_AGENCY_ACCOUNTS };
const P = 1, A = "4020202", B = "4004977";
function addDays(iso: string, n: number) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const W0 = "2026-06-29";
const WEEKS = Array.from({ length: 8 }, (_, i) => addDays(W0, 7 * i));

let seed = 1;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

function mk() {
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
    INSERT INTO players (name) VALUES ('P');
  `);
  runXpokerMigrationV1(db, SEED);
  linkMemberIdOn(db, { player_id: P, member_id: A });
  linkMemberIdOn(db, { player_id: P, member_id: B });
  WEEKS.forEach((w, i) => {
    if (i === 5) return; // trou : semaine 5 non importée
    const rows: FixRow[] = [{ pid: A, wl: Math.round((rnd() - 0.5) * 20000 * 100) / 100, rake: Math.round(rnd() * 500 * 100) / 100 }];
    if (i % 2 === 0) rows.push({ pid: B, wl: Math.round((rnd() - 0.5) * 20000 * 100) / 100, rake: Math.round(rnd() * 500 * 100) / 100 });
    const r = commitImportOn(db, { block: block({ rows }, `t${i}`), week_start: w, week_end: addDays(w, 6), source: "xlsx" });
    if (!r.ok) throw new Error("import " + JSON.stringify(r));
  });
  return db;
}

type Row = { id: number; action_pct: number; rb_pct: number; start_week: string; end_week: string | null };
const periods = (db: any): Row[] => db.prepare(`SELECT id, action_pct, rb_pct, start_week, end_week FROM xpoker_player_deals WHERE player_id = ? ORDER BY start_week`).all(P);
const frozen = (db: any) => db.prepare(`SELECT week_start, action_pct, rb_pct, action_chips, rb_chips, due_chips FROM xpoker_settlement_weeks WHERE player_id = ?`).all(P) as any[];
const snap = (db: any) => JSON.stringify({ d: periods(db), s: frozen(db) });
const dues = (db: any) => Object.fromEntries(playerWeeksOn(db, P).map(w => [w.week_start, w.due_chips]));

let fails = 0, calls = 0, retro = 0, refused = 0, direct = 0, locks = 0;
function fail(msg: string) { fails++; console.log("✘", msg); }

function checkInvariants(db: any, where: string) {
  const rows = periods(db);
  const open = rows.filter(r => r.end_week === null).length;
  if (rows.length > 0 && open !== 1) fail(`${where}: ${open} périodes ouvertes ${JSON.stringify(rows)}`);
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i], b = rows[i + 1];
    if (a.end_week === null || a.end_week >= b.start_week) fail(`${where}: chevauchement ${JSON.stringify([a, b])}`);
    if (addDays(a.end_week!, 7) === b.start_week && Math.abs(a.action_pct - b.action_pct) < 1e-9 && Math.abs(a.rb_pct - b.rb_pct) < 1e-9) fail(`${where}: adjacentes non fusionnées ${JSON.stringify([a, b])}`);
  }
  for (const r of rows) if (r.end_week !== null && r.end_week < r.start_week) fail(`${where}: end<start ${JSON.stringify(r)}`);
  // Invariant 9/10 : chaque semaine figée recalcule au même taux et au même dû.
  const live = playerWeeksOn(db, P);
  for (const f of frozen(db)) {
    const w = live.find(x => x.week_start === f.week_start);
    if (!w || !w.deal) { fail(`${where}: semaine réglée ${f.week_start} incalculable/absente en live`); continue; }
    if (Math.abs(w.deal.action_pct - f.action_pct) > 1e-9 || Math.abs(w.deal.rb_pct - f.rb_pct) > 1e-9) fail(`${where}: semaine réglée ${f.week_start} taux live ${w.deal.action_pct}/${w.deal.rb_pct} ≠ figé ${f.action_pct}/${f.rb_pct}`);
    if (Math.abs((w.due_chips ?? NaN) - f.due_chips) > 1e-9) fail(`${where}: semaine réglée ${f.week_start} dû live ${w.due_chips} ≠ figé ${f.due_chips}`);
  }
}

const PCTS = [0, 10, 10, 15, 20, 50];
const RBS = [0, 0, 0, 20, 30];
for (let g = 1; g <= 4; g++) for (let run = 0; run < 60; run++) {
  if (run === 0) seed = g;
  const db = mk();
  const candidates = Array.from({ length: 14 }, (_, i) => addDays(W0, 7 * (i - 3)));
  for (let step = 0; step < 25; step++) {
    // De temps en temps, verrouiller une semaine réglable.
    if (rnd() < 0.2) {
      const live = playerWeeksOn(db, P).filter(w => w.deal && !w.import_flagged);
      const fr = new Set(frozen(db).map(f => f.week_start));
      const cand = live.filter(w => !fr.has(w.week_start));
      if (cand.length) {
        const w = pick(cand);
        const r = lockXpokerSettlementOn(db, { player_id: P, week_starts: [w.week_start] });
        if (!r.ok) fail(`lock refusé ${r.error}`); else { locks++; if (rnd() < 0.5) db.prepare(`UPDATE manual_settlements SET status='paid', paid_date='2026-09-21' WHERE id=?`).run(r.settlement_id); }
        checkInvariants(db, `run${run} step${step} after lock`);
      }
      continue;
    }
    const S = pick(candidates), action_pct = pick(PCTS), rb_pct = pick(RBS);
    const before = snap(db), duesBefore = dues(db);
    const confirm = rnd() < 0.85;
    let r: any;
    try { r = setDealOn(db, { player_id: P, action_pct, rb_pct, start_week: S, confirm_retroactive: confirm }); }
    catch (e: any) { fail(`run${run} step${step} EXCEPTION ${e.message} S=${S} ${action_pct}/${rb_pct} périodes=${JSON.stringify(periods(db))}`); continue; }
    calls++;
    const where = `run${run} step${step} S=${S} ${action_pct}/${rb_pct} confirm=${confirm}`;
    checkInvariants(db, where);
    if (!r.ok) {
      refused++;
      if (snap(db) !== before) fail(`${where}: refus mais état modifié`);
      if (r.needs_confirmation && r.settled_weeks?.length) fail(`${where}: needs_confirmation ET settled_weeks`);
      continue;
    }
    const duesAfter = dues(db);
    if (r.retroactive) {
      retro++;
      const pv = r.preview;
      const previewed = new Set(pv.weeks.map((w: any) => w.week_start));
      for (const w of pv.weeks) {
        const got = duesAfter[w.week_start];
        if (got === null || got === undefined || Math.abs(got - w.after.due_chips) > 1e-9) fail(`${where}: aperçu ${w.week_start} dû=${w.after.due_chips} mais live=${got}`);
        const bef = duesBefore[w.week_start];
        if ((w.before === null) !== (bef === null)) fail(`${where}: aperçu before null-ness ≠ live avant`);
        if (w.before && Math.abs(w.before.due_chips - (bef as number)) > 1e-9) fail(`${where}: aperçu before ${w.before.due_chips} ≠ live avant ${bef}`);
      }
      for (const k of Object.keys(duesAfter)) {
        if (previewed.has(k)) continue;
        const a = duesAfter[k], b = duesBefore[k];
        if ((a === null) !== (b === null) || (a !== null && Math.abs(a - (b as number)) > 1e-9)) fail(`${where}: semaine ${k} HORS aperçu a changé ${b} → ${a}`);
      }
      // Totaux : somme des dus (null → 0) doit égaler le total annoncé.
      const tb = Object.values(duesBefore).reduce((s: number, v) => s + (v ?? 0), 0), ta = Object.values(duesAfter).reduce((s: number, v) => s + (v ?? 0), 0);
      if (Math.abs(tb - pv.total_due_before) > 1e-9 || Math.abs(ta - pv.total_due_after) > 1e-9) fail(`${where}: totaux aperçu ${pv.total_due_before}→${pv.total_due_after} vs live ${tb}→${ta}`);
    } else {
      direct++;
      for (const k of Object.keys(duesAfter)) {
        const a = duesAfter[k], b = duesBefore[k];
        const wasFirst = JSON.parse(before).d.length === 0;
        if (wasFirst) continue;
        if ((a === null) !== (b === null) || (a !== null && Math.abs(a - (b as number)) > 1e-9)) fail(`${where}: NON rétroactif mais semaine ${k} a changé ${b} → ${a}`);
      }
    }
  }
}
console.log(`calls=${calls} retro=${retro} direct=${direct} refused=${refused} locks=${locks} fails=${fails}`);
process.exit(fails ? 1 : 0);
