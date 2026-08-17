/**
 * Harnais du règlement hebdomadaire sur BANKROLL — NEXAPOKER.
 * Run: npx tsx scripts/nexa-bankroll.test.ts
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────┐
 * │ Le cas réel d'Hugo au centime près (2 000 déposés, BR 377,99, 30 % →     │
 * │ 486,60 à verser, redémarrage à 864,59) ; qu'il n'existe JAMAIS deux      │
 * │ résultats pour une semaine (la grille refuse d'écraser une semaine BR) ; │
 * │ que le versement part dans le bon sens ; que la BR de début se reprend   │
 * │ toute seule ; que le versement est EXCLU des cash-outs de la semaine     │
 * │ suivante ; qu'un mouvement tardif sur semaine figée est refusé ; que les │
 * │ trous de semaines sont refusés ; que le double règlement est impossible  │
 * │ au niveau du SCHÉMA ; que le déverrouillage remonte la chaîne dans       │
 * │ l'ordre et restaure exactement l'état d'avant.                           │
 * │ Base SQLite réelle, DDL de prod extraite de lib/db.ts.                   │
 * └─────────────────────────────────────────────────────────────────────────┘
 * ┌─ CE QU'ILS NE PROUVENT PAS — lire avant de s'y fier ────────────────────┐
 * │ • `markPaid` N'EST JAMAIS APPELÉE ici : elle lit getDb(), donc les tests │
 * │   exercent writeBankrollTransferOnPaid, la fonction d'argent qu'elle     │
 * │   appelle. Ne sont donc PAS couverts : son enveloppe transactionnelle,   │
 * │   le rollback du flip de statut si le versement jette, son garde         │
 * │   `changes !== 1`, et la non-régression des règlements ordinaires.       │
 * │   (Ces quatre points ont été vérifiés à la main par l'audit, pas ici.)   │
 * │ • Le test du délock vaut pour le DDL D'AUJOURD'HUI : la fixture extrait  │
 * │   lib/db.ts. Il ne dit rien de l'état d'une base déjà migrée — c'est le  │
 * │   rôle de add_nexa_bankroll_weeks_fk_v2.                                 │
 * │ • L'encaissement d'une semaine gagnante (le joueur me paie) n'est        │
 * │   couvert nulle part : il ne s'écrit dans aucune table.                  │
 * │ • La transcription de la photo (aucun appel vision — la lecture du       │
 * │   montant, elle, est pure et couverte). L'affichage dans /payments. Le   │
 * │   rendu du panneau. markPaidBulkAction.                                  │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import fs from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lecercle-nexabr-")));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const Database = require(path.join(REPO, "node_modules/better-sqlite3"));

import {
  createNexaPlayerOn, setWeeklyWinlossOn, clearWeeklyWinlossOn,
  addMovementOn, deleteMovementOn, getMovementsOn, getNexaPlayerDetailOn,
} from "../lib/funnels/nexa/players";
import {
  previewBankrollWeekOn, lockBankrollWeekOn, unlockBankrollWeekOn,
  getBankrollWeeksOn, getWeekMovementsOn, weekEnd, nextWeek,
} from "../lib/funnels/nexa/bankroll";
import {
  round2, isCentExact, computeBankrollWeek, carriedBrOpen, parseBankrollAmount,
} from "../lib/funnels/nexa/bankroll-engine";
import { writeBankrollTransferOnPaid } from "../lib/manual-settlement-engine";

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
function approx(label: string, got: number, want: number, eps = 1e-9) {
  check(label, Math.abs(got - want) < eps, `attendu ${want}, obtenu ${got}`);
}

// La VRAIE DDL de prod est extraite de lib/db.ts : les contraintes CHECK et
// UNIQUE sont donc réellement exercées, pas supposées. Même mécanisme que
// scripts/nexa-action-settlement.test.ts.
const SRC = fs.readFileSync(path.join(REPO, "lib/db.ts"), "utf8");
const anchor = SRC.indexOf("const alreadyApplied = db.prepare");
const execStart = SRC.indexOf("db.exec(`", anchor);
const MIGRATION_SQL = SRC.slice(execStart + "db.exec(`".length, SRC.indexOf("`);", execStart + 9));

const SETTLE_START = SRC.indexOf("CREATE TABLE IF NOT EXISTS nexa_action_settlement_weeks");
const SETTLE_SQL = SRC.slice(SETTLE_START, SRC.indexOf("`);", SETTLE_START));

const RB_START = SRC.indexOf("CREATE TABLE IF NOT EXISTS nexa_rakeback_settlement_weeks");
const RB_SQL = SRC.slice(RB_START, SRC.indexOf("`);", RB_START));

// La table de ce chantier, dans sa forme FINALE — celle de la v2, pas de la v1.
//
// La v1 a créé la FK settlement_id en ON DELETE CASCADE (une erreur : le délock de
// /payments détruisait la semaine figée en laissant win/loss et versement derrière).
// add_nexa_bankroll_weeks_fk_v2 reconstruit la table sans cascade. C'est cette forme
// que l'app utilise après boot, donc c'est elle que les tests doivent exercer —
// prendre le DDL de la v1 ferait passer les tests sur un schéma que plus aucune base
// ne porte, et le test du délock ne prouverait rien.
const BR_START = SRC.indexOf("CREATE TABLE nexa_player_bankroll_weeks_new");
if (BR_START < 0) throw new Error("DDL v2 de nexa_player_bankroll_weeks introuvable dans lib/db.ts");
const BR_SQL = SRC
  .slice(BR_START, SRC.indexOf("INSERT INTO nexa_player_bankroll_weeks_new", BR_START))
  .replace("nexa_player_bankroll_weeks_new", "nexa_player_bankroll_weeks")
  + `
    CREATE INDEX IF NOT EXISTS idx_nexa_br_player
      ON nexa_player_bankroll_weeks(player_id, week_start);
    CREATE INDEX IF NOT EXISTS idx_nexa_br_transfer
      ON nexa_player_bankroll_weeks(transfer_movement_id)
      WHERE transfer_movement_id IS NOT NULL;
  `;
// Ceinture : si le DDL extrait portait encore la cascade, le test du délock
// passerait en prouvant l'inverse de ce qu'il annonce.
if (/settlement_id[^,]*ON DELETE CASCADE/i.test(BR_SQL)) {
  throw new Error("Le DDL extrait porte encore ON DELETE CASCADE sur settlement_id — fixture invalide.");
}

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
    CREATE TABLE nexa_lead_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES nexa_leads(id), kind TEXT NOT NULL, stage TEXT,
      payload TEXT, actor TEXT NOT NULL DEFAULT 'bot', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE manual_settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      net_selected_usdt REAL NOT NULL DEFAULT 0, action_pct_applied REAL NOT NULL DEFAULT 0,
      amount_due_usdt REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','paid')),
      tx_hash TEXT, notes TEXT, locked_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_date TEXT, kind TEXT NOT NULL DEFAULT 'action');
    CREATE TABLE player_game_ids (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL, UNIQUE(game_id, external_id));
    CREATE TABLE wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      app_id INTEGER, game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
      type TEXT NOT NULL CHECK(type IN ('deposit','withdrawal')),
      amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USDT', note TEXT,
      tron_tx_hash TEXT, tx_date TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      counterparty_address TEXT, source TEXT DEFAULT 'unknown', tx_datetime TEXT,
      settled INTEGER NOT NULL DEFAULT 0, settlement_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE player_game_deals (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      action_pct REAL NOT NULL DEFAULT 50, rakeback_pct REAL NOT NULL DEFAULT 0,
      start_date TEXT, end_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(player_id, game_id));
  `);
  db.exec(MIGRATION_SQL);
  db.exec(SETTLE_SQL);
  db.exec(RB_SQL);
  db.exec(BR_SQL);
  return db;
}

// Semaines de travail. W1 = 2026-07-13 (un lundi), etc.
const W1 = "2026-07-13", W2 = "2026-07-20", W3 = "2026-07-27";
/** « Aujourd'hui » passé explicitement : le moteur n'a pas d'horloge, les tests non plus. */
const TODAY = "2026-08-17";

function player(db: any, pct: number) {
  const p = createNexaPlayerOn(db, {
    nickname: "ImLePAD", member_id: "2518550", action_pct: pct, action_start_week: W1,
  });
  if (!p.ok) throw new Error(p.error);
  return p.player_id;
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Arrondi : demi-supérieur en valeur absolue, symétrique ══");
{
  approx("round2(486.603) = 486.60", round2(486.603), 486.60);
  approx("round2(-486.603) = -486.60", round2(-486.603), -486.60);
  // Le point qui distingue cette règle de Math.round() : le demi négatif.
  approx("round2(0.005) = 0.01", round2(0.005), 0.01);
  approx("round2(-0.005) = -0.01 (et non -0.00)", round2(-0.005), -0.01);
  eq("pas de -0 à l'affichage", Object.is(round2(-0.001), -0), false);
  check("377.99 est un montant au centime", isCentExact(377.99));
  check("377.999 ne l'est pas", !isCentExact(377.999));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ TEST D'ACCEPTATION — le cas réel d'Hugo ══");
{
  const db = freshDb();
  const pid = player(db, 30);

  // Ses dépôts de la semaine sont déjà connus : buy-ins manuels saisis sur la page.
  const dep = addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 2000, tx_date: "2026-07-14" });
  check("buy-in de 2 000 enregistré", dep.ok, JSON.stringify(dep));

  // Première semaine : la BR de début se SAISIT. Ici 0 — il part de zéro.
  const pre = previewBankrollWeekOn(db, {
    player_id: pid, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY,
  });
  if (!pre.ok) throw new Error(pre.error);
  eq("aucun blocage", pre.preview.blockers, []);
  approx("dépôts repris des mouvements, pas re-saisis", pre.preview.deposits, 2000);
  approx("cash-outs de la semaine", pre.preview.cashouts, 0);
  eq("BR de début saisie (première semaine)", pre.preview.br_open_source, "manual");

  const c = pre.preview.computed!;
  approx("résultat = (377.99 + 0) − (0 + 2000) = −1 622.01", c.result, -1622.01);
  approx("ma part = −1 622.01 × 30 % = −486.60", c.action_amount, -486.60);
  approx("à lui envoyer : 486.60", c.transfer_amount, 486.60);
  // Sa bankroll une fois payé — le « il redémarre à 864,59 » d'Hugo. C'est une
  // DESCRIPTION, affichée ; l'entrée du calcul de la semaine suivante, elle, est
  // la BR de fin, et le versement y entrera comme un dépôt à sa date de paiement.
  approx("sa BR une fois le versement reçu : 864.59", c.br_after_transfer, 864.59);
  approx("mais la semaine suivante repart de la BR de fin : 377.99", c.next_br_open, 377.99);

  // ── Le verrouillage ──
  const lock = lockBankrollWeekOn(db, {
    player_id: pid, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY,
  });
  if (!lock.ok) throw new Error(lock.error);
  approx("montant verrouillé = celui de l'aperçu", lock.computed.action_amount, -486.60);

  // ── UNE SEULE VÉRITÉ : le win/loss de la semaine EST le résultat BR ──
  const wl = db.prepare(`SELECT amount FROM nexa_player_weekly_winloss WHERE player_id = ? AND week_start = ?`)
    .get(pid, W1) as { amount: number };
  approx("win/loss écrit = résultat BR", wl.amount, -1622.01);
  const wlCount = db.prepare(`SELECT COUNT(*) n FROM nexa_player_weekly_winloss WHERE player_id = ?`)
    .get(pid) as { n: number };
  eq("une seule ligne de résultat pour la semaine", wlCount.n, 1);

  // ── AUCUN MOUVEMENT AU VERROUILLAGE ──
  // L'argent n'est pas parti : le règlement est en 'locked'. Écrire un retrait ici
  // affirmerait un transfert qui n'a pas eu lieu, et fausserait net_position,
  // my_pnl, /solde et le total agence jusqu'au paiement.
  eq("aucun mouvement créé au verrouillage", lock.movement_id, null);
  const mvts = getMovementsOn(db, pid);
  eq("l'Historique ne contient que le buy-in du joueur", mvts.length, 1);
  approx("et c'est bien le buy-in de 2 000", mvts[0].amount, 2000);
  const brRow = db.prepare(`SELECT transfer_movement_id FROM nexa_player_bankroll_weeks WHERE player_id = ?`)
    .get(pid) as { transfer_movement_id: number | null };
  eq("aucun versement rattaché à la semaine", brRow.transfer_movement_id, null);

  // ── Le règlement, dans le hub /payments ──
  const st = db.prepare(`SELECT * FROM manual_settlements WHERE id = ?`).get(lock.settlement_id) as any;
  approx("amount_due_usdt = −486.60 (négatif = je lui dois)", st.amount_due_usdt, -486.60);
  eq("statut locked — Hugo marquera payé lui-même dans /payments", st.status, "locked");
  eq("kind = action", st.kind, "action");
  approx("net_selected_usdt = le résultat de la semaine", st.net_selected_usdt, -1622.01);
  approx("taux figé", st.action_pct_applied, 30);

  // ── L'ancrage anti-double-règlement ──
  const anchor = db.prepare(
    `SELECT * FROM nexa_action_settlement_weeks WHERE player_id = ? AND week_start = ?`
  ).get(pid, W1) as any;
  approx("semaine ancrée au montant figé", anchor.action_amount, -486.60);

  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Une semaine BR ne se re-saisit pas à la main ══");
{
  const db = freshDb();
  const pid = player(db, 30);
  addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 2000, tx_date: "2026-07-14" });
  lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY });

  const w = setWeeklyWinlossOn(db, { player_id: pid, week_start: W1, amount: 500 });
  check("la grille refuse d'écraser une semaine BR", !w.ok, JSON.stringify(w));
  const cl = clearWeeklyWinlossOn(db, pid, W1);
  check("et refuse de la dé-saisir", !cl.ok, JSON.stringify(cl));

  const wl = db.prepare(`SELECT amount FROM nexa_player_weekly_winloss WHERE player_id = ? AND week_start = ?`)
    .get(pid, W1) as { amount: number };
  approx("le résultat BR est intact", wl.amount, -1622.01);

  // Une semaine NON pilotée par la BR reste saisissable comme avant : la garde
  // ne doit pas déborder sur le flux existant.
  const other = setWeeklyWinlossOn(db, { player_id: pid, week_start: W2, amount: 500 });
  check("une semaine sans BR reste saisissable à la main", other.ok, JSON.stringify(other));
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Le versement s'écrit au PAIEMENT, jamais au verrouillage ══");
{
  const db = freshDb();
  const pid = player(db, 30);
  addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 2000, tx_date: "2026-07-14" });
  const l = lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY });
  if (!l.ok) throw new Error(l.error);
  eq("rien au verrouillage", getMovementsOn(db, pid).length, 1);

  // Ce que fait markPaid, dans sa transaction : flip du statut, puis le versement.
  // (markPaid lui-même lit getDb() ; on exerce ici la fonction d'argent qu'il appelle.)
  db.prepare(`UPDATE manual_settlements SET status='paid', paid_at=datetime('now'), paid_date=? WHERE id=?`)
    .run("2026-07-20", l.settlement_id);
  writeBankrollTransferOnPaid(db as any, l.settlement_id!, "2026-07-20");

  const mvts = getMovementsOn(db, pid);
  eq("le versement apparaît au paiement", mvts.length, 2);
  const t = mvts.find(m => m.amount === 486.60)!;
  eq("sens : cash-out — l'opérateur paie le joueur", t.type, "withdrawal");
  eq("daté du jour réel de l'envoi", t.tx_date, "2026-07-20");
  check("et il porte la semaine dans sa note", /2026-07-13/.test(t.note ?? ""), t.note ?? "");
  const br = db.prepare(`SELECT transfer_movement_id FROM nexa_player_bankroll_weeks WHERE player_id = ?`)
    .get(pid) as { transfer_movement_id: number | null };
  eq("et il est rattaché à la semaine BR", br.transfer_movement_id, t.id);

  // Idempotence : un second appel ne doit PAS créer un second versement.
  writeBankrollTransferOnPaid(db as any, l.settlement_id!, "2026-07-20");
  eq("un second passage ne double pas le versement", getMovementsOn(db, pid).length, 2);

  // PAIEMENT ANTIDATÉ DANS UNE SEMAINE FIGÉE : refus.
  // Depuis que le versement compte à sa date, une date tombant dans une semaine
  // close le ferait disparaître du calcul — ni dans cette semaine (dépôts figés),
  // ni dans les suivantes (hors fenêtre).
  {
    const dbA = freshDb();
    const pidA = player(dbA, 30);
    addMovementOn(dbA, { player_id: pidA, kind: "buy_in", amount: 2000, tx_date: "2026-07-14" });
    const lA = lockBankrollWeekOn(dbA, { player_id: pidA, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY });
    if (!lA.ok) throw new Error(lA.error);
    dbA.prepare(`UPDATE manual_settlements SET status='paid' WHERE id=?`).run(lA.settlement_id);
    let jete = false, msg = "";
    try { writeBankrollTransferOnPaid(dbA as any, lA.settlement_id!, "2026-07-15"); }
    catch (e: any) { jete = true; msg = e.message; }
    check("paiement daté dans une semaine figée : refusé", jete, msg);
    check("et le message dit quoi faire", /déverrouille cette semaine/.test(msg), msg);
    eq("aucun mouvement créé", getMovementsOn(dbA, pidA).length, 1);
    // Une date hors semaine figée passe.
    writeBankrollTransferOnPaid(dbA as any, lA.settlement_id!, "2026-07-21");
    eq("une date postérieure passe", getMovementsOn(dbA, pidA).length, 2);
    dbA.close();
  }

  // AUCUNE DATE DÉCLARÉE : refus — LE garde qui couvre TOUS les appelants.
  //
  // markPaid a trois appelants : /payments à l'unité, /payments en lot, et
  // l'action `mark_settlement_paid` du bot Telegram, qui n'a jamais passé de date.
  // Les parades d'écran ont été posées une par une et le troisième chemin a été
  // oublié deux fois. Le refus vit maintenant dans le moteur, et c'est ce qui le
  // rend testable ici — les parades d'écran, elles, n'ont aucune assertion.
  {
    const dbN = freshDb();
    const pidN = player(dbN, 30);
    addMovementOn(dbN, { player_id: pidN, kind: "buy_in", amount: 2000, tx_date: "2026-07-14" });
    const lN = lockBankrollWeekOn(dbN, { player_id: pidN, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY });
    if (!lN.ok) throw new Error(lN.error);
    dbN.prepare(`UPDATE manual_settlements SET status='paid' WHERE id=?`).run(lN.settlement_id);
    let jete = false, msg = "";
    try { writeBankrollTransferOnPaid(dbN as any, lN.settlement_id!, null); }
    catch (e: any) { jete = true; msg = e.message; }
    check("aucune date déclarée sur un règlement BR : refusé", jete, msg);
    check("et le message exige la date du virement", /date de \n?paiement est obligatoire|date de paiement est obligatoire/.test(msg.replace(/\s+/g, " ")), msg);
    eq("aucun mouvement créé", getMovementsOn(dbN, pidN).length, 1);
    // Le même appel avec une date passe : le garde ne bloque que l'absence.
    writeBankrollTransferOnPaid(dbN as any, lN.settlement_id!, "2026-07-21");
    eq("avec une date, il passe", getMovementsOn(dbN, pidN).length, 2);
    dbN.close();
  }

  // Un règlement ORDINAIRE (non bankroll) n'est PAS concerné : le garde vit dans
  // la branche BR, après le `if (!br) return`. Les autres rooms gardent leur
  // comportement — date facultative, aucun mouvement écrit.
  {
    const dbO = freshDb();
    const pidO = player(dbO, 30);
    const gid = (dbO.prepare(`SELECT id FROM games WHERE name='NEXAPOKER'`).get() as any).id;
    const s = dbO.prepare(`
      INSERT INTO manual_settlements (game_id, player_id, net_selected_usdt, action_pct_applied, amount_due_usdt, status, kind)
      VALUES (?, ?, 1000, 30, 300, 'paid', 'rakeback')
    `).run(gid, pidO);
    let jete = false;
    try { writeBankrollTransferOnPaid(dbO as any, Number(s.lastInsertRowid), null); }
    catch { jete = true; }
    check("règlement non adossé à une semaine BR : sans date, aucun refus", !jete);
    eq("et aucun mouvement écrit", getMovementsOn(dbO, pidO).length, 0);
    dbO.close();
  }

  // PAIEMENT ANTÉRIEUR À LA SEMAINE RÉGLÉE : refus (borne basse).
  // Le garde des semaines figées ne voyait pas ce cas — aucune semaine figée ne
  // couvre une date d'avant la première. Le mouvement était écrit et n'entrait
  // dans aucun calcul, puisqu'on ne clôture jamais une semaine antérieure.
  {
    const dbB = freshDb();
    const pidB = player(dbB, 30);
    addMovementOn(dbB, { player_id: pidB, kind: "buy_in", amount: 2000, tx_date: "2026-07-14" });
    const lB = lockBankrollWeekOn(dbB, { player_id: pidB, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY });
    if (!lB.ok) throw new Error(lB.error);
    dbB.prepare(`UPDATE manual_settlements SET status='paid' WHERE id=?`).run(lB.settlement_id);
    let jete = false, msg = "";
    try { writeBankrollTransferOnPaid(dbB as any, lB.settlement_id!, "2026-07-01"); }
    catch (e: any) { jete = true; msg = e.message; }
    check("paiement antérieur à la semaine réglée : refusé", jete, msg);
    check("et le message dit pourquoi", /antérieure à la semaine réglée/.test(msg), msg);
    eq("aucun mouvement créé", getMovementsOn(dbB, pidB).length, 1);
    dbB.close();
  }

  // LE SEUL CHEMIN RESTANT VERS UN CHIFFRE FAUX : une date de paiement TARDIVE.
  //
  // L'argent bouge le 22/07 (dans W2), mais Hugo accepte « aujourd'hui » pré-rempli
  // dans /payments. Le versement est alors daté hors de W2 : la semaine se clôture
  // sur un résultat surévalué du montant versé, et une part fantôme naît à son
  // débit. Aucun garde serveur ne peut le détecter — une date est une déclaration.
  // Ce test MESURE le dégât, pour que la parade côté écran (champ date non
  // pré-rempli + avertissement) ne puisse pas être retirée sans que ça se voie.
  {
    const dbC = freshDb();
    const pidC = player(dbC, 30);
    addMovementOn(dbC, { player_id: pidC, kind: "buy_in", amount: 2000, tx_date: "2026-07-14" });
    const lC = lockBankrollWeekOn(dbC, { player_id: pidC, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY });
    if (!lC.ok) throw new Error(lC.error);
    dbC.prepare(`UPDATE manual_settlements SET status='paid' WHERE id=?`).run(lC.settlement_id);

    // Date VRAIE (22/07, dans W2) : la semaine est juste.
    const dbVrai = freshDb();
    const pidV = player(dbVrai, 30);
    addMovementOn(dbVrai, { player_id: pidV, kind: "buy_in", amount: 2000, tx_date: "2026-07-14" });
    const lV = lockBankrollWeekOn(dbVrai, { player_id: pidV, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY });
    if (!lV.ok) throw new Error(lV.error);
    dbVrai.prepare(`UPDATE manual_settlements SET status='paid' WHERE id=?`).run(lV.settlement_id);
    writeBankrollTransferOnPaid(dbVrai as any, lV.settlement_id!, "2026-07-22");
    const juste = previewBankrollWeekOn(dbVrai, { player_id: pidV, week_start: W2, br_close: 864.59, today: TODAY });
    if (!juste.ok) throw new Error(juste.error);
    approx("date VRAIE : W2 est juste (résultat 0)", juste.preview.computed!.result, 0);
    approx("et aucune part fantôme", juste.preview.computed!.action_amount, 0);
    dbVrai.close();

    // Date TARDIVE (bien après W2) : la semaine devient fausse du montant versé.
    writeBankrollTransferOnPaid(dbC as any, lC.settlement_id!, "2026-08-17");
    const faux = previewBankrollWeekOn(dbC, { player_id: pidC, week_start: W2, br_close: 864.59, today: TODAY });
    if (!faux.ok) throw new Error(faux.error);
    approx("date TARDIVE : le versement n'est pas dans W2", faux.preview.deposits, 0);
    approx("→ W2 fausse de +486.60", faux.preview.computed!.result, 486.60);
    approx("→ part fantôme de +145.98 au débit du joueur", faux.preview.computed!.action_amount, 145.98);
    check("aucun garde serveur ne l'attrape — c'est l'écran qui doit l'empêcher",
      faux.preview.blockers.length === 0, JSON.stringify(faux.preview.blockers));
    dbC.close();
  }

  // Semaine GAGNANTE : il me règle ma part. Sens inverse, même traitement.
  //
  // Sans cette écriture, le seul moyen de faire apparaître l'encaissement dans les
  // comptes était de le saisir à la main en buy-in — et le calcul BR l'aurait
  // compté comme un dépôt de bankroll, minorant le résultat de 300 et ma part de
  // 90, en silence. Le second bloc ci-dessous prouve que ce n'est plus le cas.
  const db2 = freshDb();
  const pid2 = player(db2, 30);
  addMovementOn(db2, { player_id: pid2, kind: "buy_in", amount: 1000, tx_date: "2026-07-14" });
  const l2 = lockBankrollWeekOn(db2, { player_id: pid2, week_start: W1, br_close: 2000, br_open_manual: 0, today: TODAY });
  if (!l2.ok) throw new Error(l2.error);
  approx("semaine gagnante : ma part = +300", l2.computed.action_amount, 300);
  eq("rien au verrouillage non plus", getMovementsOn(db2, pid2).length, 1);

  db2.prepare(`UPDATE manual_settlements SET status='paid' WHERE id=?`).run(l2.settlement_id);
  writeBankrollTransferOnPaid(db2 as any, l2.settlement_id!, "2026-07-21");

  const encaisse = getMovementsOn(db2, pid2).find(m => m.amount === 300)!;
  check("l'encaissement apparaît au paiement", encaisse !== undefined, JSON.stringify(getMovementsOn(db2, pid2)));
  eq("sens : deposit — le joueur me règle", encaisse.type, "deposit");

  // ET IL NE FAUSSE PAS LA SEMAINE SUIVANTE : exclu du calcul comme le versement.
  const pre2 = previewBankrollWeekOn(db2, { player_id: pid2, week_start: W2, br_close: 2000, today: TODAY });
  if (!pre2.ok) throw new Error(pre2.error);
  approx("l'encaissement n'est PAS compté dans les dépôts de W2", pre2.preview.deposits, 0);
  approx("donc le résultat de W2 reste juste", pre2.preview.computed!.result, 0);
  db2.close();
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ net_position : le verrouillage ne bouge AUCUN agrégat ══");
{
  // C'EST LE CHIFFRE DONT F2 ÉTAIT LE DÉFAUT, et rien ne le verrouillait.
  // La première version créait le versement au lock : net_position s'améliorait de
  // 486,60 alors que l'argent n'était pas parti, pendant que /payments affichait la
  // dette en sens inverse. Ce test interdit le retour en arrière.
  const db = freshDb();
  const pid = player(db, 30);
  addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 2000, tx_date: "2026-07-14" });

  const avant = getNexaPlayerDetailOn(db, pid)!;
  approx("avant : net_movements = −2 000", avant.net_movements, -2000);
  approx("avant : net_position = −2 000", avant.net_position!, -2000);

  const l = lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY });
  if (!l.ok) throw new Error(l.error);

  const apresLock = getNexaPlayerDetailOn(db, pid)!;
  approx("APRÈS VERROUILLAGE : net_position INCHANGÉ", apresLock.net_position!, -2000);
  approx("net_movements inchangé — rien n'est sorti", apresLock.net_movements, -2000);
  approx("la part réglée est bien enregistrée, elle", apresLock.action_settled, -486.60);

  // Hugo envoie les USDT et marque payé.
  db.prepare(`UPDATE manual_settlements SET status='paid' WHERE id=?`).run(l.settlement_id);
  writeBankrollTransferOnPaid(db as any, l.settlement_id!, "2026-07-20");

  const apresPaiement = getNexaPlayerDetailOn(db, pid)!;
  approx("APRÈS PAIEMENT : net_movements = −1 513.40", apresPaiement.net_movements, -1513.40);
  approx("net_position suit — l'argent est parti", apresPaiement.net_position!, -1513.40);
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Semaine suivante : le versement compte à SA DATE, pas en report ══");
{
  const db = freshDb();
  const pid = player(db, 30);
  addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 2000, tx_date: "2026-07-14" });
  const lock1 = lockBankrollWeekOn(db, {
    player_id: pid, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY,
  });
  if (!lock1.ok) throw new Error(lock1.error);

  // ── ON NE CLÔTURE PAS PAR-DESSUS UN RÈGLEMENT NON PAYÉ ──
  //
  // Le système ne peut pas savoir si l'argent a bougé tant que le règlement est
  // 'locked'. S'il a bougé sans être enregistré, la photo de fin de W2 le contient
  // mais le calcul l'ignore : part fantôme au débit du joueur, et le vrai paiement
  // devient ensuite inenregistrable (sa date tombe dans une semaine figée).
  const nonPaye = previewBankrollWeekOn(db, { player_id: pid, week_start: W2, br_close: 377.99, today: TODAY });
  if (!nonPaye.ok) throw new Error(nonPaye.error);
  check("règlement non payé : la clôture est bloquée", nonPaye.preview.blockers.length > 0,
    JSON.stringify(nonPaye.preview.blockers));
  check("et le message nomme le règlement et la semaine",
    /Règlement #\d+ de la semaine 2026-07-13/.test(nonPaye.preview.blockers[0] ?? ""),
    nonPaye.preview.blockers[0] ?? "");
  check("et il dit dans quel sens", /tu lui dois 486\.60/.test(nonPaye.preview.blockers[0] ?? ""),
    nonPaye.preview.blockers[0] ?? "");
  const lockRefuse = lockBankrollWeekOn(db, { player_id: pid, week_start: W2, br_close: 377.99, today: TODAY });
  check("et le verrouillage est refusé", !lockRefuse.ok, JSON.stringify(lockRefuse));

  // ── Hugo paie : le versement entre comme un DÉPÔT de bankroll, à sa date ──
  db.prepare(`UPDATE manual_settlements SET status='paid' WHERE id=?`).run(lock1.settlement_id);
  writeBankrollTransferOnPaid(db as any, lock1.settlement_id!, "2026-07-20");

  const paye = previewBankrollWeekOn(db, { player_id: pid, week_start: W2, br_close: 864.59, today: TODAY });
  if (!paye.ok) throw new Error(paye.error);
  approx("BR de départ toujours 377.99", paye.preview.br_open!, 377.99);
  approx("le versement compte comme un DÉPÔT de la semaine", paye.preview.deposits, 486.60);
  approx("et jamais comme un cash-out", paye.preview.cashouts, 0);
  eq("il est visible dans les mouvements retenus", paye.preview.movements.length, 1);
  eq("son effet bankroll est bien une entrée", paye.preview.movements[0].br_effect, "in");
  eq("alors que son sens au grand livre est un retrait", paye.preview.movements[0].type, "withdrawal");
  approx("résultat = 864.59 − (377.99 + 486.60) = 0 — il n'a pas joué",
    paye.preview.computed!.result, 0);

  // Il joue et gagne, avec le versement dans la même semaine.
  const gagne = previewBankrollWeekOn(db, { player_id: pid, week_start: W2, br_close: 900, today: TODAY });
  if (!gagne.ok) throw new Error(gagne.error);
  approx("résultat = 900 − (377.99 + 486.60) = 35.41", gagne.preview.computed!.result, 35.41);
  approx("ma part = 35.41 × 30 % = 10.62", gagne.preview.computed!.action_amount, 10.62);
  approx("il a gagné : aucun versement", gagne.preview.computed!.transfer_amount, 0);

  // Un VRAI cash-out du joueur, lui, compte bien en sortie.
  addMovementOn(db, { player_id: pid, kind: "cash_out", amount: 100, tx_date: "2026-07-22" });
  const avecCashout = previewBankrollWeekOn(db, { player_id: pid, week_start: W2, br_close: 800, today: TODAY });
  if (!avecCashout.ok) throw new Error(avecCashout.error);
  approx("un vrai cash-out compte en sortie", avecCashout.preview.cashouts, 100);
  approx("résultat = (800 + 100) − (377.99 + 486.60) = 35.41",
    avecCashout.preview.computed!.result, 35.41);
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Semaine gagnante : il me doit, rien ne sort ══");
{
  const db = freshDb();
  const pid = player(db, 30);
  addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 1000, tx_date: "2026-07-14" });
  const lock = lockBankrollWeekOn(db, {
    player_id: pid, week_start: W1, br_close: 2000, br_open_manual: 0, today: TODAY,
  });
  if (!lock.ok) throw new Error(lock.error);
  approx("résultat = 2000 − 1000 = +1000", lock.computed.result, 1000);
  approx("ma part = +300 (il me doit)", lock.computed.action_amount, 300);
  approx("aucun versement", lock.computed.transfer_amount, 0);
  eq("aucun mouvement créé", lock.movement_id, null);
  approx("sa BR repart de 2000, sans ajout", lock.computed.next_br_open, 2000);

  const st = db.prepare(`SELECT amount_due_usdt, status FROM manual_settlements WHERE id = ?`)
    .get(lock.settlement_id) as any;
  approx("le hub /payments porte +300", st.amount_due_usdt, 300);
  eq("en attente de paiement", st.status, "locked");
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ « BR inchangée » : une semaine à zéro ne pollue pas /payments ══");
{
  const db = freshDb();
  const pid = player(db, 30);
  const lock = lockBankrollWeekOn(db, {
    player_id: pid, week_start: W1, br_close: 500, br_open_manual: 500, today: TODAY,
  });
  if (!lock.ok) throw new Error(lock.error);
  approx("résultat nul", lock.computed.result, 0);
  eq("aucune ligne de règlement — un règlement à zéro est du bruit", lock.settlement_id, null);
  eq("aucun mouvement", lock.movement_id, null);
  // Mais la semaine EST saisie : 0 saisi ≠ non saisi.
  const wl = db.prepare(`SELECT amount FROM nexa_player_weekly_winloss WHERE player_id = ? AND week_start = ?`)
    .get(pid, W1) as { amount: number } | undefined;
  check("le win/loss vaut 0 SAISI (et non « non saisi »)", wl !== undefined && wl.amount === 0, JSON.stringify(wl));
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Semaine sans photo = non saisie, jamais 0 ══");
{
  const db = freshDb();
  const pid = player(db, 30);
  // Aucune clôture : la semaine ne doit exister NULLE PART.
  const n = db.prepare(`SELECT COUNT(*) n FROM nexa_player_weekly_winloss WHERE player_id = ?`).get(pid) as { n: number };
  eq("aucune ligne de win/loss", n.n, 0);
  const br = getBankrollWeeksOn(db, pid);
  eq("aucune semaine BR", br.length, 0);

  // Et la première semaine sans BR de début fournie est REFUSÉE, pas supposée à 0.
  const lock = lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 377.99, today: TODAY });
  check("première semaine sans BR de début : refus explicite", !lock.ok, JSON.stringify(lock));
  check("et le message dit pourquoi", !lock.ok && /BR de début doit être saisie/.test(lock.error), !lock.ok ? lock.error : "");
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Mouvement tardif sur semaine figée : refus dur ══");
{
  const db = freshDb();
  const pid = player(db, 30);
  addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 2000, tx_date: "2026-07-14" });
  lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY });

  const late = addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 300, tx_date: "2026-07-16" });
  check("ajout dans une semaine figée refusé", !late.ok, JSON.stringify(late));
  const lateEdge = addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 300, tx_date: weekEnd(W1) });
  check("le dimanche de la semaine figée est dedans", !lateEdge.ok, JSON.stringify(lateEdge));
  const ok = addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 300, tx_date: W2 });
  check("le lundi suivant passe", ok.ok, JSON.stringify(ok));

  // Symétrie : on ne retire pas non plus un mouvement d'une semaine figée.
  const first = getMovementsOn(db, pid).find(m => m.tx_date === "2026-07-14")!;
  const del = deleteMovementOn(db, first.id);
  check("suppression dans une semaine figée refusée", !del.ok, JSON.stringify(del));
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Trous de semaines : refus ══");
{
  const db = freshDb();
  const pid = player(db, 30);
  lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 500, br_open_manual: 500, today: TODAY });

  const skip = lockBankrollWeekOn(db, { player_id: pid, week_start: W3, br_close: 600, today: TODAY });
  check("sauter W2 est refusé", !skip.ok, JSON.stringify(skip));
  check("et le message dit quoi faire", !skip.ok && /BR inchangée/.test(skip.error), !skip.ok ? skip.error : "");

  const back = lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 600, today: TODAY });
  check("re-clôturer une semaine déjà figée est refusé", !back.ok, JSON.stringify(back));

  // Le chemin nominal reste ouvert.
  const next = lockBankrollWeekOn(db, { player_id: pid, week_start: W2, br_close: 600, today: TODAY });
  check("W2 passe", next.ok, JSON.stringify(next));
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ La semaine doit être TERMINÉE, pas seulement commencée ══");
{
  const db = freshDb();
  const pid = player(db, 30);
  const fut = lockBankrollWeekOn(db, { player_id: pid, week_start: W3, br_close: 100, br_open_manual: 0, today: W1 });
  check("clôturer une semaine pas commencée est refusé", !fut.ok, JSON.stringify(fut));

  // LE CAS QUI CONDAMNAIT LE RESTE DE LA SEMAINE : figer le mercredi verrouillait
  // lundi→dimanche, et tout mouvement du jeudi au dimanche devenait impossible à
  // enregistrer — ni dans la semaine (figée), ni dans la suivante (hors fenêtre).
  const mercredi = "2026-07-15";
  const enCours = lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 100, br_open_manual: 0, today: mercredi });
  check("clôturer une semaine EN COURS est refusé", !enCours.ok, JSON.stringify(enCours));
  check("et le message dit jusqu'à quand elle court",
    !enCours.ok && /jusqu'au 2026-07-19/.test(enCours.error), !enCours.ok ? enCours.error : "");

  const dimanche = "2026-07-19";
  const leDernierJour = lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 100, br_open_manual: 0, today: dimanche });
  check("le dimanche même est encore refusé (la journée n'est pas finie)", !leDernierJour.ok, JSON.stringify(leDernierJour));

  const lundi = "2026-07-20";
  const ok = lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 100, br_open_manual: 0, today: lundi });
  check("le lundi suivant passe — c'est le geste nominal", ok.ok, JSON.stringify(ok));
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Le délock de /payments ne peut pas casser une semaine BR ══");
{
  // FAILLE TROUVÉE PAR L'AUDIT, avant tout commit. NEXAPOKER est dans SETTLE_ROOMS,
  // donc ses règlements portent le bouton « délock » de /payments, qui fait
  // DELETE FROM manual_settlements sans rien savoir de la bankroll. Avec un
  // ON DELETE CASCADE, ce DELETE effaçait la semaine BR figée en laissant DERRIÈRE
  // LUI le win/loss et le versement : résultat orphelin, et versement recompté
  // comme un cash-out ordinaire la semaine suivante (+145,98 d'erreur sur ma part).
  // La FK est en NO ACTION : le schéma refuse le DELETE, la vigilance de
  // l'appelant n'entre pas en jeu.
  const db = freshDb();
  const pid = player(db, 30);
  addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 2000, tx_date: "2026-07-14" });
  const l = lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY });
  if (!l.ok) throw new Error(l.error);

  let threw = false;
  try {
    db.prepare(`DELETE FROM manual_settlements WHERE id = ?`).run(l.settlement_id);
  } catch { threw = true; }
  check("le schéma REFUSE de supprimer un règlement adossé à une semaine BR", threw);

  // Et rien n'a bougé.
  const br = db.prepare(`SELECT COUNT(*) n FROM nexa_player_bankroll_weeks WHERE player_id = ?`).get(pid) as { n: number };
  eq("la semaine BR est intacte", br.n, 1);
  const wl = db.prepare(`SELECT COUNT(*) n FROM nexa_player_weekly_winloss WHERE player_id = ?`).get(pid) as { n: number };
  eq("le win/loss est intact", wl.n, 1);
  eq("les mouvements sont intacts", getMovementsOn(db, pid).length, 1);

  // Le chemin CORRECT, lui, marche — parce qu'il retire la ligne BR en premier.
  const u = unlockBankrollWeekOn(db, pid, W1);
  check("le déverrouillage BR, lui, passe", u.ok, JSON.stringify(u));
  const after = db.prepare(`SELECT COUNT(*) n FROM manual_settlements WHERE player_id = ?`).get(pid) as { n: number };
  eq("et le règlement est bien parti", after.n, 0);
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Semaine déjà réglée par l'autre chemin : refus nommé ══");
{
  const db = freshDb();
  const pid = player(db, 30);
  // On simule un règlement du flux d'action classique sur W1.
  const gid = (db.prepare(`SELECT id FROM games WHERE name='NEXAPOKER'`).get() as any).id;
  const s = db.prepare(`
    INSERT INTO manual_settlements (game_id, player_id, net_selected_usdt, action_pct_applied, amount_due_usdt, status, kind)
    VALUES (?, ?, -1000, 30, -300, 'locked', 'action')
  `).run(gid, pid);
  db.prepare(`
    INSERT INTO nexa_action_settlement_weeks (settlement_id, player_id, week_start, winloss, action_pct, action_amount)
    VALUES (?, ?, ?, -1000, 30, -300)
  `).run(Number(s.lastInsertRowid), pid, W1);

  const r = lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 100, br_open_manual: 0, today: TODAY });
  check("refus", !r.ok, JSON.stringify(r));
  check("et le message nomme le règlement, pas « UNIQUE constraint failed »",
    !r.ok && /déjà réglée par le flux d'action/.test(r.error), !r.ok ? r.error : "");
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Joueur non staké : hors périmètre ══");
{
  const db = freshDb();
  const pid = player(db, 30);
  // Plus aucune part d'action en vigueur. On SUPPRIME la période plutôt que de la
  // clore avant son début : le CHECK (end_week >= start_week) l'interdit, et il a
  // raison — une période qui finit avant de commencer n'existe pas.
  db.prepare(`DELETE FROM nexa_player_action_shares WHERE player_id = ?`).run(pid);
  const r = lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 100, br_open_manual: 0, today: TODAY });
  check("part d'action nulle : refus", !r.ok, JSON.stringify(r));
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Double règlement : impossible au niveau du schéma ══");
{
  const db = freshDb();
  const pid = player(db, 30);
  addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 2000, tx_date: "2026-07-14" });
  const l1 = lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY });
  if (!l1.ok) throw new Error(l1.error);

  // On simule le second chemin : le flux d'action de la vue détail, qui écrit la
  // même table d'ancrage. L'UNIQUE(player_id, week_start) doit le refuser.
  let threw = false;
  try {
    db.prepare(`
      INSERT INTO nexa_action_settlement_weeks (settlement_id, player_id, week_start, winloss, action_pct, action_amount)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(l1.settlement_id, pid, W1, -1622.01, 30, -486.60);
  } catch { threw = true; }
  check("un second règlement de la même semaine est rejeté par le schéma", threw);

  const n = db.prepare(`SELECT COUNT(*) n FROM nexa_action_settlement_weeks WHERE player_id = ?`).get(pid) as { n: number };
  eq("une seule semaine ancrée", n.n, 1);
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Déverrouillage : dernière semaine seulement, et restauration nette ══");
{
  const db = freshDb();
  const pid = player(db, 30);
  addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 2000, tx_date: "2026-07-14" });
  // W1 « BR inchangée » : action nulle, donc AUCUN règlement — c'est la seule
  // façon d'enchaîner deux semaines figées sans passer par un paiement, puisque
  // clôturer par-dessus un règlement non payé est désormais refusé.
  const l1 = lockBankrollWeekOn(db, {
    player_id: pid, week_start: W1, br_close: 2000, br_open_manual: 0, today: TODAY,
  });
  if (!l1.ok) throw new Error(l1.error);
  eq("W1 sans règlement (action nulle)", l1.settlement_id, null);
  // W2 perd : elle, elle porte un règlement.
  const l2 = lockBankrollWeekOn(db, { player_id: pid, week_start: W2, br_close: 1800, today: TODAY });
  if (!l2.ok) throw new Error(l2.error);
  approx("W2 : résultat −200", l2.computed.result, -200);
  approx("ma part : −60", l2.computed.action_amount, -60);

  const tooEarly = unlockBankrollWeekOn(db, pid, W1);
  check("déverrouiller W1 alors que W2 existe est refusé", !tooEarly.ok, JSON.stringify(tooEarly));
  check("le message explique la chaîne", !tooEarly.ok && /dernière semaine figée/.test(tooEarly.error), "");

  const u2 = unlockBankrollWeekOn(db, pid, W2);
  check("W2 se déverrouille", u2.ok, JSON.stringify(u2));

  const u1 = unlockBankrollWeekOn(db, pid, W1);
  check("puis W1", u1.ok, JSON.stringify(u1));

  // Restauration NETTE : plus de win/loss, plus de règlement, plus de versement.
  const wl = db.prepare(`SELECT COUNT(*) n FROM nexa_player_weekly_winloss WHERE player_id = ?`).get(pid) as { n: number };
  eq("le win/loss est retiré", wl.n, 0);
  const st = db.prepare(`SELECT COUNT(*) n FROM manual_settlements WHERE player_id = ?`).get(pid) as { n: number };
  eq("le règlement est retiré", st.n, 0);
  const anch = db.prepare(`SELECT COUNT(*) n FROM nexa_action_settlement_weeks WHERE player_id = ?`).get(pid) as { n: number };
  eq("l'ancrage est libéré par CASCADE", anch.n, 0);
  // Aucun versement à retirer : il n'est écrit qu'au paiement, et un règlement payé
  // n'est pas déverrouillable. Le déverrouillage ne peut donc jamais effacer la
  // trace d'un paiement réel — la réserve que l'audit avait posée là tombe d'elle-même.
  const mv = getMovementsOn(db, pid);
  eq("le buy-in du joueur est intact", mv.length, 1);
  approx("et c'est bien le buy-in", mv[0].amount, 2000);

  // La semaine redevient saisissable à la main, et re-clôturable.
  const w = setWeeklyWinlossOn(db, { player_id: pid, week_start: W1, amount: -1000 });
  check("la grille reprend la main", w.ok, JSON.stringify(w));
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Déverrouillage refusé sur un règlement PAYÉ ══");
{
  const db = freshDb();
  const pid = player(db, 30);
  addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 2000, tx_date: "2026-07-14" });
  const l = lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY });
  if (!l.ok) throw new Error(l.error);
  db.prepare(`UPDATE manual_settlements SET status = 'paid', paid_at = datetime('now') WHERE id = ?`).run(l.settlement_id);

  const u = unlockBankrollWeekOn(db, pid, W1);
  check("de l'argent sorti ne se dé-règle pas", !u.ok, JSON.stringify(u));
  const still = db.prepare(`SELECT COUNT(*) n FROM nexa_player_bankroll_weeks WHERE player_id = ?`).get(pid) as { n: number };
  eq("la semaine reste figée", still.n, 1);
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Le montant est recalculé au lock, pas repris de l'écran ══");
{
  const db = freshDb();
  const pid = player(db, 30);
  addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 2000, tx_date: "2026-07-14" });

  const pre = previewBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY });
  if (!pre.ok) throw new Error(pre.error);
  approx("l'écran affiche −486.60", pre.preview.computed!.action_amount, -486.60);

  // Un buy-in arrive APRÈS l'affichage — l'écran ne le connaît pas.
  addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 500, tx_date: "2026-07-17" });

  const lock = lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 377.99, br_open_manual: 0, today: TODAY });
  if (!lock.ok) throw new Error(lock.error);
  approx("mais le lock compte 2 500 de dépôts", lock.computed.result, -2122.01);
  approx("et règle −636.60, pas −486.60", lock.computed.action_amount, -636.60);
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Lecture d'un montant de bankroll (module pur) ══");
{
  const ok = (raw: string, want: number) => {
    const r = parseBankrollAmount(raw);
    check(`« ${raw} » → ${want}`, r.ok && Math.abs(r.value - want) < 1e-9, JSON.stringify(r));
  };
  const ko = (raw: string) => {
    const r = parseBankrollAmount(raw);
    check(`« ${raw} » → refus`, !r.ok, JSON.stringify(r));
  };
  ok("377.99", 377.99);
  ok("377,99", 377.99);          // le piège : parseAmount du report en ferait 37 799
  ok("$864.59", 864.59);
  ok("1,234.56", 1234.56);
  ok("1.234,56", 1234.56);
  ok("2000", 2000);
  ok("-61.46", -61.46);
  ko("1,234");                    // milliers ou décimales ? on ne devine pas
  ko("377.999");                  // trois décimales
  ko("");
  ko("abc");
  const nul = parseBankrollAmount(null);
  check("null (illisible) → refus, jamais 0", !nul.ok, JSON.stringify(nul));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Volume : une somme de mouvements ne bloque pas la clôture ══");
{
  // LE CONTRÔLE AU CENTIME NE PORTE QUE SUR LES MONTANTS SAISIS.
  //
  // deposits et cashouts sont des sommes de flottants : 50 buy-ins de 1234.56
  // donnent 61727.999999999956. Leur appliquer le contrôle « deux décimales »
  // prévu pour les saisies rendait la semaine IMPOSSIBLE à clôturer, avec un
  // message accusant une saisie à trois décimales qui n'existait pas.
  // (Constat money-auditor, passe 3.)
  const brut = Array.from({ length: 50 }, () => 1234.56).reduce((s, x) => s + x, 0);
  check("la somme brute dérive bien hors tolérance", !isCentExact(brut), String(brut));

  const c = computeBankrollWeek({
    br_open: 0, br_close: 61728, deposits: brut, cashouts: 0, action_pct: 30,
  });
  check("le moteur l'accepte quand même", c.ok, JSON.stringify(c));
  if (c.ok) approx("et le résultat est juste", c.value.result, 0);

  // Et de bout en bout, sur la base.
  const db = freshDb();
  const pid = player(db, 30);
  for (let i = 0; i < 50; i++) {
    const r = addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 1234.56, tx_date: "2026-07-14" });
    if (!r.ok) throw new Error(r.error);
  }
  const pre = previewBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 61728, br_open_manual: 0, today: TODAY });
  if (!pre.ok) throw new Error(pre.error);
  eq("aucun blocage sur 50 mouvements", pre.preview.blockers, []);
  const lock = lockBankrollWeekOn(db, { player_id: pid, week_start: W1, br_close: 61728, br_open_manual: 0, today: TODAY });
  check("et la semaine se clôture", lock.ok, JSON.stringify(lock));
  if (lock.ok) approx("résultat juste au centime", lock.computed.result, 0);

  // Une VRAIE saisie à trois décimales reste refusée : la garde n'a pas disparu.
  const trop = computeBankrollWeek({ br_open: 0, br_close: 377.999, deposits: 0, cashouts: 0, action_pct: 30 });
  check("une BR à trois décimales est toujours refusée", !trop.ok, JSON.stringify(trop));
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ Garde-fous du moteur pur ══");
{
  const bad = computeBankrollWeek({ br_open: 0, br_close: 377.999, deposits: 0, cashouts: 0, action_pct: 30 });
  check("BR à trois décimales refusée", !bad.ok, JSON.stringify(bad));
  const neg = computeBankrollWeek({ br_open: -10, br_close: 100, deposits: 0, cashouts: 0, action_pct: 30 });
  check("BR négative refusée", !neg.ok, JSON.stringify(neg));
  const pct = computeBankrollWeek({ br_open: 0, br_close: 100, deposits: 0, cashouts: 0, action_pct: 0 });
  check("part d'action nulle refusée", !pct.ok, JSON.stringify(pct));
  // carriedBrOpen NE REPORTE RIEN : ni sur une semaine perdante, ni sur une
  // gagnante. Reporter le versement supposerait qu'il a été payé — et c'est
  // exactement ce qui fabriquait une seconde dette quand il traînait. Il compte
  // comme un dépôt à sa date de paiement, dans getWeekMovementsOn.
  approx("carriedBrOpen ne reporte pas le versement d'une semaine perdante",
    carriedBrOpen({ br_close: 377.99 }), 377.99);
  approx("ni quoi que ce soit sur une semaine gagnante",
    carriedBrOpen({ br_close: 2000 }), 2000);
  eq("weekEnd(lundi) = dimanche", weekEnd(W1), "2026-07-19");
  eq("nextWeek(lundi) = lundi suivant", nextWeek(W1), W2);
}

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} passés, ${failures.length} échoués`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
if (failures.length) { failures.forEach(f => console.log("   ✘", f)); process.exit(1); }
