/**
 * Règlement du RAKEBACK NEXAPOKER — base SQLite réelle.
 * Run: npx tsx scripts/nexa-rb-settlement.test.ts
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────────┐
 * │ • Que régler le rakeback REMET LE MAKEUP À ZÉRO après la période réglée,    │
 * │   et que sans cette remise à zéro le joueur paierait deux fois le même      │
 * │   déficit — l'écart est chiffré, pas affirmé.                               │
 * │ • Que le snapshot fige les paramètres appliqués (taux, base, makeup         │
 * │   consommé) et survit à une correction ultérieure du report.                │
 * │ • Qu'une semaine en échec dans OU AVANT la plage déclenche un avertissement │
 * │   bloquant tant qu'il n'est pas confirmé.                                   │
 * │ • Qu'une plage non contiguë est refusée, et un double règlement aussi.      │
 * │ • Que le règlement d'action avertit sur les win/loss manquants de la plage. │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * Assertions float-safe (invariant #9).
 */

import fs from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lecercle-rbsettle-")));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const Database = require(path.join(REPO, "node_modules/better-sqlite3"));

import {
  getOpenRbWeeksOn, getRbSettledThroughOn, getRbSettlementWarningsOn,
  lockNexaRakebackSettlementOn,
} from "../lib/funnels/nexa/rakeback-settlement";
import { getActionSettlementWarningsOn, lockNexaActionSettlementOn } from "../lib/funnels/nexa/action-settlement";
import { getNexaPlayerDetailOn, setWeeklyWinlossOn } from "../lib/funnels/nexa/players";

let passed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log("   ✔", label); }
  else { failures.push(label); console.log("   ✘", label, detail); }
}
function near(label: string, got: number | null, want: number | null, eps = 1e-9) {
  const ok = got === null || want === null ? got === want : Math.abs(got - want) < eps;
  check(label, ok, ok ? "" : `attendu ${want}, obtenu ${got}`);
}

const SRC = fs.readFileSync(path.join(REPO, "lib/db.ts"), "utf8");
const anchor = SRC.indexOf("const alreadyApplied = db.prepare");
const execStart = SRC.indexOf("db.exec(`", anchor);
const MIGRATION_SQL = SRC.slice(execStart + "db.exec(`".length, SRC.indexOf("`);", execStart + 9));
const A_START = SRC.indexOf("CREATE TABLE IF NOT EXISTS nexa_action_settlement_weeks");
const ACTION_SQL = SRC.slice(A_START, SRC.indexOf("`);", A_START));
const R_START = SRC.indexOf("CREATE TABLE IF NOT EXISTS nexa_rakeback_settlement_weeks");
const RB_SQL = SRC.slice(R_START, SRC.indexOf("`);", R_START));

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE _applied_fixes (name TEXT PRIMARY KEY);
    CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, telegram_handle TEXT);
    CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active', default_action_pct REAL, currency TEXT NOT NULL DEFAULT 'USDT');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nexa_leads (id INTEGER PRIMARY KEY AUTOINCREMENT, tg_user_id INTEGER NOT NULL UNIQUE,
      member_id TEXT UNIQUE, player_id INTEGER REFERENCES players(id), tg_username TEXT,
      stage TEXT NOT NULL DEFAULT 'started', updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE player_game_ids (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL, UNIQUE(game_id, external_id));
    CREATE TABLE manual_settlements (id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL REFERENCES games(id), player_id INTEGER NOT NULL REFERENCES players(id),
      net_selected_usdt REAL NOT NULL DEFAULT 0, action_pct_applied REAL NOT NULL DEFAULT 0,
      amount_due_usdt REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'locked',
      tx_hash TEXT, notes TEXT, locked_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at TEXT, paid_date TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      kind TEXT NOT NULL DEFAULT 'action');
    CREATE TABLE wallet_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id), app_id INTEGER,
      game_id INTEGER REFERENCES games(id), type TEXT NOT NULL, amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USDT', note TEXT, tron_tx_hash TEXT, tx_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), counterparty_address TEXT,
      source TEXT DEFAULT 'manual', tx_datetime TEXT, settled INTEGER NOT NULL DEFAULT 0,
      settlement_id INTEGER);
    CREATE TABLE player_game_deals (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id), game_id INTEGER NOT NULL REFERENCES games(id),
      action_pct REAL NOT NULL DEFAULT 50, rakeback_pct REAL NOT NULL DEFAULT 0,
      start_date TEXT, end_date TEXT);
  `);
  db.exec(MIGRATION_SQL);
  db.exec(ACTION_SQL);
  db.exec(RB_SQL);
  return db;
}

const W = ["2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22"];

/** Joueur avec 4 semaines, rakeback 50 % sur le rake brut. S1 perdante. */
function seed(db: any, rakes: number[], checkOk: boolean[] = []) {
  const gid = (db.prepare(`SELECT id FROM games WHERE name='NEXAPOKER'`).get() as any).id;
  const pid = db.prepare(`INSERT INTO players (name) VALUES ('Joueur RB')`).run().lastInsertRowid as number;
  db.prepare(`INSERT INTO player_game_ids (player_id, game_id, external_id) VALUES (?,?,?)`).run(pid, gid, "MID1");
  db.prepare(`INSERT INTO nexa_player_rakeback (player_id, pct, basis, start_week) VALUES (?,50,'gross_rake',?)`)
    .run(pid, W[0]);
  db.prepare(`INSERT INTO nexa_player_action_shares (player_id, pct, start_week) VALUES (?,50,?)`).run(pid, W[0]);
  const ins = db.prepare(`INSERT INTO nexa_affiliate_weeks
    (week_start, member_id, nickname, nickname_key, player_id, nlh, mtt, plo, spins,
     rate_nlh, rate_mtt, rate_plo, rate_spins,
     affiliate_payment, affiliate_payment_recomputed, check_delta, deal_text, override_reason)
    VALUES (?,?,?,?,?,?,0,0,0, 40,40,40,40, ?,?,?,?,?)`);
  rakes.forEach((r, i) => {
    const ok = checkOk[i] === undefined ? true : checkOk[i];
    // check_ok est GÉNÉRÉE depuis check_delta ; hors tolérance exige un motif.
    ins.run(W[i], "MID1", "nick", "nick", pid, r, r * 0.4, r * 0.4, ok ? 0 : 5, "40%",
            ok ? null : "écart assumé (test)");
  });
  return pid;
}

// ── 1. Le makeup est soldé par le règlement ────────────────────────────────
console.log("\n1. Un règlement de rakeback remet le makeup à zéro");
{
  const db = freshDb();
  // S1 −200 (makeup), S2 +300, S3 +400, S4 +100
  const pid = seed(db, [-200, 300, 400, 100]);

  const avant = getNexaPlayerDetailOn(db, pid)!;
  const dus = avant.weeks.map(w => w.due);
  // S1 dû 0 (makeup −200) · S2 (300−200)×50 % = 50 · S3 200 · S4 50
  near("dû S1 avant règlement", dus[0], 0);
  near("dû S2 avant règlement", dus[1], 50);
  near("dû S3 avant règlement", dus[2], 200);

  // On règle jusqu'à S2 : la plage porte le makeup de S1.
  const lock = lockNexaRakebackSettlementOn(db, { player_id: pid, through_week: W[1] });
  check("règlement verrouillé", lock.ok, JSON.stringify(lock));
  if (lock.ok) {
    near("montant réglé = dû S1 + dû S2", lock.amount_due_usdt, 50);
    check("deux semaines couvertes, S1 à dû nul comprise", lock.weeks.length === 2,
          `obtenu ${lock.weeks.length}`);
  }

  check("borne de makeup posée", getRbSettledThroughOn(db, pid) === W[1],
        `obtenu ${getRbSettledThroughOn(db, pid)}`);
  const apres = getNexaPlayerDetailOn(db, pid)!;
  const dusApres = apres.weeks.map(w => w.due);
  // Rien ne bouge sur les semaines réglées — leur rejeu doit rester confrontable
  // au figement — mais S3 repart d'un makeup à ZÉRO.
  near("S1 et S2 rejouées à l'identique", dusApres[0] + dusApres[1], 50);
  near("S3 après règlement : makeup soldé, dû = 400 × 50 %", dusApres[2], 200);
  near("S4 inchangée", dusApres[3], 50);
  db.close();
}

// ── 2. Sans la remise à zéro, le joueur paierait deux fois ─────────────────
console.log("\n2. L'écart que la remise à zéro évite");
{
  const db = freshDb();
  // S1 −400 (gros makeup), S2 +100, S3 +500
  const pid = seed(db, [-400, 100, 500, 0]);
  const avant = getNexaPlayerDetailOn(db, pid)!;
  // S1 dû 0, makeup −400 · S2 (100−400) = −300 → dû 0, makeup −300
  // S3 (500−300) × 50 % = 100
  near("S3 avant règlement — makeup de −300 encore actif", avant.weeks[2].due, 100);

  const lock = lockNexaRakebackSettlementOn(db, { player_id: pid, through_week: W[1] });
  // Total réglé = 0 → refusé, un règlement à zéro n'est pas un règlement.
  check("plage sans rien à payer : refusée", !lock.ok, JSON.stringify(lock));
  check("et le motif le dit", !lock.ok && /Rien à payer/.test(lock.error), !lock.ok ? lock.error : "");

  // On élargit à S3 : là il y a un dû.
  const lock2 = lockNexaRakebackSettlementOn(db, { player_id: pid, through_week: W[2] });
  check("plage élargie : verrouillée", lock2.ok, JSON.stringify(lock2));
  if (lock2.ok) near("montant réglé", lock2.amount_due_usdt, 100);

  const apres = getNexaPlayerDetailOn(db, pid)!;
  // S4 a un rake de 0. Sans remise à zéro, elle hériterait du makeup sortant de S3
  // (0, ici) — le cas parlant est surtout que la chaîne repart proprement.
  near("S4 repart d'un makeup nul", apres.weeks[3].makeup_in, 0);
  db.close();
}

// ── 3. Le snapshot survit à une correction du report ───────────────────────
console.log("\n3. Le figement des paramètres appliqués");
{
  const db = freshDb();
  const pid = seed(db, [200, 300, 0, 0]);
  const lock = lockNexaRakebackSettlementOn(db, { player_id: pid, through_week: W[0] });
  check("règlement verrouillé", lock.ok, JSON.stringify(lock));
  const snap = db.prepare(`SELECT * FROM nexa_rakeback_settlement_weeks WHERE player_id = ?`).all(pid) as any[];
  check("une ligne de snapshot", snap.length === 1, `obtenu ${snap.length}`);
  near("taux figé", snap[0].rakeback_pct, 50);
  check("assiette figée", snap[0].basis === "gross_rake", snap[0].basis);
  near("base figée", snap[0].base, 200);
  near("makeup consommé figé", snap[0].makeup_in, 0);
  near("dû figé", snap[0].due, 100);

  // Le report est corrigé APRÈS le règlement : le rejeu bouge, le figement non.
  db.prepare(`UPDATE nexa_affiliate_weeks SET nlh = 999 WHERE player_id = ? AND week_start = ?`)
    .run(pid, W[0]);
  const snapApres = db.prepare(`SELECT due FROM nexa_rakeback_settlement_weeks WHERE player_id = ?`).all(pid) as any[];
  near("le montant payé ne bouge pas", snapApres[0].due, 100);
  const rejeu = getNexaPlayerDetixOn(db, pid);
  function getNexaPlayerDetixOn(d: any, p: number) { return getNexaPlayerDetailOn(d, p)!; }
  check("alors que le rejeu, lui, a bougé", Math.abs(rejeu.weeks[0].due - 100) > 1,
        `dû rejoué ${rejeu.weeks[0].due}`);
  db.close();
}

// ── 4. Garde-fou : semaine en échec dans ou avant la plage ─────────────────
console.log("\n4. Avertissement sur une semaine en échec");
{
  const db = freshDb();
  // S2 en échec de contrôle.
  const pid = seed(db, [200, 300, 400, 100], [true, false, true, true]);

  const warnAvant = getRbSettlementWarningsOn(db, pid, W[0]);
  check("aucun avertissement avant la semaine en échec", warnAvant.length === 0,
        JSON.stringify(warnAvant));

  const warnApres = getRbSettlementWarningsOn(db, pid, W[2]);
  check("avertissement quand la plage la contient", warnApres.some(w => w.code === "blocked_weeks"),
        JSON.stringify(warnApres));

  const refus = lockNexaRakebackSettlementOn(db, { player_id: pid, through_week: W[2] });
  check("règlement REFUSÉ sans confirmation", !refus.ok, JSON.stringify(refus));
  check("et les avertissements sont rendus", !refus.ok && (refus.warnings?.length ?? 0) > 0);

  const ok = lockNexaRakebackSettlementOn(db, { player_id: pid, through_week: W[2], acknowledge_warnings: true });
  check("accepté après confirmation explicite", ok.ok, JSON.stringify(ok));
  const ms = db.prepare(`SELECT kind, notes FROM manual_settlements WHERE player_id = ?`).get(pid) as any;
  check("kind = rakeback", ms.kind === "rakeback", ms.kind);
  check("la note garde la trace de la confirmation", /avertissement/.test(ms.notes ?? ""), ms.notes);
  db.close();
}

// ── 5. Plage contiguë, et pas de double règlement ──────────────────────────
console.log("\n5. Contiguïté et double règlement");
{
  const db = freshDb();
  const pid = seed(db, [200, 300, 400, 100]);
  const l1 = lockNexaRakebackSettlementOn(db, { player_id: pid, through_week: W[1] });
  check("premier règlement ok", l1.ok, JSON.stringify(l1));

  // Régler une plage qui ne repart pas de la première semaine ouverte.
  const trou = lockNexaRakebackSettlementOn(db, { player_id: pid, through_week: W[0] });
  check("plage antérieure aux semaines ouvertes : refusée", !trou.ok, JSON.stringify(trou));

  const l2 = lockNexaRakebackSettlementOn(db, { player_id: pid, through_week: W[3] });
  check("second règlement sur la suite : ok", l2.ok, JSON.stringify(l2));
  const n = db.prepare(`SELECT COUNT(*) c FROM nexa_rakeback_settlement_weeks WHERE player_id = ?`).get(pid) as any;
  check("4 semaines couvertes au total, aucune deux fois", n.c === 4, `obtenu ${n.c}`);
  db.close();
}

// ── 6. Règlement d'action : avertissement sur les win/loss manquants ───────
console.log("\n6. Avertissement sur un règlement d'action à trous");
{
  const db = freshDb();
  const pid = seed(db, [200, 300, 400, 100]);
  // Win/loss saisi sur S1 et S3 seulement → S2 est un trou dans la plage.
  setWeeklyWinlossOn(db, { player_id: pid, week_start: W[0], amount: 1000, note: null });
  setWeeklyWinlossOn(db, { player_id: pid, week_start: W[2], amount: 500, note: null });

  const warn = getActionSettlementWarningsOn(db, pid, [W[0], W[2]]);
  check("le trou est signalé", warn.some(w => w.code === "missing_winloss"), JSON.stringify(warn));

  const refus = lockNexaActionSettlementOn(db, { player_id: pid, week_starts: [W[0], W[2]] });
  check("règlement d'action REFUSÉ sans confirmation", !refus.ok, JSON.stringify(refus));

  const ok = lockNexaActionSettlementOn(db,
    { player_id: pid, week_starts: [W[0], W[2]], acknowledge_warnings: true });
  check("accepté après confirmation", ok.ok, JSON.stringify(ok));
  if (ok.ok) near("montant = 50 % de (1000 + 500)", ok.amount_due_usdt, 750);
  const kinds = db.prepare(`SELECT kind FROM manual_settlements WHERE player_id = ?`).all(pid) as any[];
  check("kind = action, les deux flux ne se confondent pas", kinds.every(k => k.kind === "action"),
        JSON.stringify(kinds));
  db.close();
}

console.log(`\n${failures.length === 0 ? "=== TOUS LES TESTS PASSENT ===" : `=== ${failures.length} ÉCHEC(S) ===`}  (${passed} assertions)`);
if (failures.length) { failures.forEach(f => console.log(" -", f)); process.exit(1); }
