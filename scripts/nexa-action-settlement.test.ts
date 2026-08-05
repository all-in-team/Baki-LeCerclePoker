/**
 * Harnais du règlement de la part d'action NEXAPOKER.
 * Run: npx tsx scripts/nexa-action-settlement.test.ts
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────┐
 * │ amount_due = Σ action des semaines choisies et RIEN d'autre ; le montant │
 * │ est recalculé par le moteur au lock, pas repris de l'appelant ; une      │
 * │ semaine réglée ne réapparaît JAMAIS comme due ; le double règlement est  │
 * │ refusé explicitement ET structurellement. Base SQLite réelle, vraie DDL. │
 * └─────────────────────────────────────────────────────────────────────────┘
 * ┌─ CE QU'ILS NE PROUVENT PAS ─────────────────────────────────────────────┐
 * │ L'affichage dans /payments (pas d'UI ici), ni markPaid/unlock qui sont   │
 * │ les fonctions existantes de manual-settlement-engine.                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import fs from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lecercle-nexasettle-")));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const Database = require(path.join(REPO, "node_modules/better-sqlite3"));

import { createNexaPlayerOn, setWeeklyWinlossOn, getNexaPlayerDetailOn } from "../lib/funnels/nexa/players";
import {
  getSettleableActionWeeksOn, lockNexaActionSettlementOn, getSettledWeeksOn,
} from "../lib/funnels/nexa/action-settlement";
import { commitWeekOn } from "../lib/funnels/nexa/affiliate-ingest";
import type { RawAffiliateRow } from "../lib/funnels/nexa/affiliate-deal";

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

// Même mécanisme que scripts/nexa-players.test.ts : la VRAIE DDL de prod est extraite
// de lib/db.ts, donc les contraintes CHECK et UNIQUE sont réellement exercées.
const SRC = fs.readFileSync(path.join(REPO, "lib/db.ts"), "utf8");
const anchor = SRC.indexOf("const alreadyApplied = db.prepare");
const execStart = SRC.indexOf("db.exec(`", anchor);
const MIGRATION_SQL = SRC.slice(execStart + "db.exec(`".length, SRC.indexOf("`);", execStart + 9));

// La table de règlement vit dans une migration séparée (add_nexa_action_settlement_v1),
// hors du bloc extrait ci-dessus : on la reprend telle quelle depuis la source.
const SETTLE_START = SRC.indexOf("CREATE TABLE IF NOT EXISTS nexa_action_settlement_weeks");
const SETTLE_SQL = SRC.slice(SETTLE_START, SRC.indexOf("`);", SETTLE_START));

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
    -- Forme PROD de manual_settlements, colonne kind comprise.
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
      settled INTEGER NOT NULL DEFAULT 0, settlement_id INTEGER);
    CREATE TABLE player_game_deals (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      action_pct REAL NOT NULL DEFAULT 50, rakeback_pct REAL NOT NULL DEFAULT 0,
      start_date TEXT, end_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(player_id, game_id));
  `);
  db.exec(MIGRATION_SQL);
  db.exec(SETTLE_SQL);
  return db;
}

const DEAL = "40% NLH and MTT, 45% PLO, 55% Spins";
const W1 = "2026-07-13", W2 = "2026-07-20", W3 = "2026-07-27";
const week = (o: Partial<RawAffiliateRow> & { nickname: string; member_id: string }): RawAffiliateRow => ({
  deal_text: DEAL, nlh: 1000, mtt: 0, plo: 0, spins: 0, affiliate_payment: 400, ...o,
});

/** Joueur avec 3 semaines saines et un win/loss saisi partout. Action 50 %. */
function setup(db: any) {
  const p = createNexaPlayerOn(db, { nickname: "ImLePAD", member_id: "2518550", action_pct: 50, action_start_week: W1 });
  if (!p.ok) throw new Error(p.error);
  for (const w of [W1, W2, W3]) commitWeekOn(db, w, [week({ nickname: "ImLePAD", member_id: "2518550" })]);
  setWeeklyWinlossOn(db, { player_id: p.player_id, week_start: W1, amount: 1000 });   // action +500
  setWeeklyWinlossOn(db, { player_id: p.player_id, week_start: W2, amount: -600 });   // action −300
  setWeeklyWinlossOn(db, { player_id: p.player_id, week_start: W3, amount: 200 });    // action +100
  return p.player_id;
}

console.log("\n══ Semaines réglables ══");
{
  const db = freshDb();
  const pid = setup(db);
  const s = getSettleableActionWeeksOn(db, pid);
  eq("3 semaines réglables", s.map(w => w.week_start), [W1, W2, W3]);
  eq("montants d'action", s.map(w => w.action_amount), [500, -300, 100]);
  eq("le win/loss est repris tel quel", s.map(w => w.winloss), [1000, -600, 200]);
  db.close();
}

console.log("\n══ Ce qui n'est PAS réglable ══");
{
  const db = freshDb();
  const p = createNexaPlayerOn(db, { nickname: "ImLePAD", member_id: "2518550", action_pct: 50, action_start_week: W1 });
  if (!p.ok) throw new Error(p.error);
  commitWeekOn(db, W1, [week({ nickname: "ImLePAD", member_id: "2518550" })]);
  // W2 : écart accepté avec motif → check_ok = 0, assiette non fiable.
  commitWeekOn(db, W2, [week({ nickname: "ImLePAD", member_id: "2518550", affiliate_payment: 999 })],
    { overrides: { "2518550": "arrondi NEXA" } });
  commitWeekOn(db, W3, [week({ nickname: "ImLePAD", member_id: "2518550" })]);

  eq("aucune semaine sans win/loss n'est réglable", getSettleableActionWeeksOn(db, p.player_id).length, 0);

  setWeeklyWinlossOn(db, { player_id: p.player_id, week_start: W2, amount: 1000 });
  eq("une semaine au contrôle en échec reste exclue", getSettleableActionWeeksOn(db, p.player_id).length, 0);

  // Un win/loss à ZÉRO est bien saisi, mais sa part d'action vaut 0 : un règlement
  // à zéro n'est pas un règlement, c'est du bruit dans le hub.
  setWeeklyWinlossOn(db, { player_id: p.player_id, week_start: W1, amount: 0 });
  eq("part d'action nulle → non réglable", getSettleableActionWeeksOn(db, p.player_id).length, 0);

  setWeeklyWinlossOn(db, { player_id: p.player_id, week_start: W3, amount: 200 });
  eq("seule la semaine saine et saisie est réglable",
     getSettleableActionWeeksOn(db, p.player_id).map(w => w.week_start), [W3]);
  db.close();
}

console.log("\n══ Le montant = Σ action, et RIEN d'autre ══");
{
  const db = freshDb();
  const pid = setup(db);
  // Des mouvements de trésorerie qui ne doivent PAS entrer dans le montant réglé.
  db.prepare(`INSERT INTO wallet_transactions (player_id, game_id, type, amount, currency, tx_date, source)
              VALUES (?, (SELECT id FROM games WHERE name='NEXAPOKER'), 'deposit', 5000, 'USDT', '2026-07-15', 'manual')`).run(pid);

  const r = lockNexaActionSettlementOn(db, { player_id: pid, week_starts: [W1, W2] });
  check("verrouillé", r.ok);
  if (!r.ok) throw new Error(r.error);

  approx("amount_due = 500 + (−300) = 200", r.amount_due_usdt, 200);
  const ms = db.prepare(`SELECT * FROM manual_settlements WHERE id = ?`).get(r.settlement_id) as any;
  approx("écrit en base", ms.amount_due_usdt, 200);
  eq("kind = action", ms.kind, "action");
  eq("statut verrouillé", ms.status, "locked");
  eq("game NEXAPOKER", (db.prepare(`SELECT name FROM games WHERE id = ?`).get(ms.game_id) as any).name, "NEXAPOKER");
  approx("net_selected = Σ win/loss (1000 − 600)", ms.net_selected_usdt, 400);
  eq("pct uniforme reporté", ms.action_pct_applied, 50);

  // Le dépôt de 5000 ne doit apparaître NULLE PART dans le règlement.
  check("le montant ignore la trésorerie", Math.abs(ms.amount_due_usdt) < 1000);
  eq("aucune transaction flaggée settled",
     (db.prepare(`SELECT COUNT(*) c FROM wallet_transactions WHERE settled = 1`).get() as any).c, 0);
  eq("aucune transaction back-linkée",
     (db.prepare(`SELECT COUNT(*) c FROM wallet_transactions WHERE settlement_id IS NOT NULL`).get() as any).c, 0);

  // Le détail figé, semaine par semaine.
  const frozen = db.prepare(`SELECT week_start, winloss, action_pct, action_amount
                             FROM nexa_action_settlement_weeks WHERE settlement_id = ? ORDER BY week_start`)
                   .all(r.settlement_id) as any[];
  eq("2 semaines figées", frozen.map(f => f.week_start), [W1, W2]);
  eq("montants figés", frozen.map(f => f.action_amount), [500, -300]);
  eq("win/loss figé", frozen.map(f => f.winloss), [1000, -600]);
  db.close();
}

console.log("\n══ Le moteur recalcule au lock — l'écran ne dicte pas le montant ══");
{
  const db = freshDb();
  const pid = setup(db);
  // Le report est corrigé APRÈS que l'écran a affiché : le win/loss de W1 change.
  setWeeklyWinlossOn(db, { player_id: pid, week_start: W1, amount: 2000 });
  const r = lockNexaActionSettlementOn(db, { player_id: pid, week_starts: [W1] });
  check("verrouillé", r.ok);
  if (!r.ok) throw new Error(r.error);
  // 2000 × 50 % = 1000, et non les 500 que l'écran montrait avant correction.
  approx("montant recalculé (2000 × 50 %)", r.amount_due_usdt, 1000);
  check("≠ le montant d'avant correction", Math.abs(r.amount_due_usdt - 500) > 1);
  db.close();
}

console.log("\n══ Une semaine réglée ne réapparaît JAMAIS comme due ══");
{
  const db = freshDb();
  const pid = setup(db);
  lockNexaActionSettlementOn(db, { player_id: pid, week_starts: [W1, W2] });

  eq("les semaines réglées sortent du réglable",
     getSettleableActionWeeksOn(db, pid).map(w => w.week_start), [W3]);
  eq("elles sont marquées dans le détail",
     Object.keys(getNexaPlayerDetailOn(db, pid)!.settled_weeks).sort(), [W1, W2]);

  // Le REJEU reste complet : le moteur ignore les règlements, il recalcule tout.
  // C'est voulu — le figement vit dans la table, pas dans le moteur.
  const d = getNexaPlayerDetailOn(db, pid)!;
  eq("le moteur rejoue toujours les 3 semaines", d.weeks.length, 3);
  approx("et W1 garde sa part d'action au rejeu", d.weeks[0].action_amount!, 500);

  // Corriger une semaine RÉGLÉE ne doit pas changer le montant déjà figé.
  setWeeklyWinlossOn(db, { player_id: pid, week_start: W1, amount: 9999 });
  const frozen = db.prepare(`SELECT action_amount FROM nexa_action_settlement_weeks
                             WHERE player_id = ? AND week_start = ?`).get(pid, W1) as any;
  approx("le montant réglé reste figé malgré la correction", frozen.action_amount, 500);
  eq("et la semaine n'est toujours pas réglable",
     getSettleableActionWeeksOn(db, pid).map(w => w.week_start), [W3]);
  db.close();
}

console.log("\n══ Un joueur soldé affiche une position soldée ══");
{
  const db = freshDb();
  const pid = setup(db);   // W1 +500, W2 −300, W3 +100, aucun mouvement

  const before = getNexaPlayerDetailOn(db, pid)!;
  approx("avant règlement : rien de réglé", before.action_settled, 0);
  approx("tout est à régler", before.action_unsettled!, 300);
  approx("position nette = 300", before.net_position!, 300);

  lockNexaActionSettlementOn(db, { player_id: pid, week_starts: [W1, W2, W3] });

  const after = getNexaPlayerDetailOn(db, pid)!;
  // LE POINT DU CAS : une fois tout réglé, le joueur ne doit plus rien au titre de
  // l'action. Sommer toutes les semaines afficherait « il te doit 300 » à vie.
  approx("après règlement : déjà réglé = 300", after.action_settled, 300);
  approx("plus rien à régler", after.action_unsettled!, 0);
  approx("POSITION SOLDÉE", after.net_position!, 0);
  // Le total brut du moteur, lui, ne bouge pas : il rejoue toute la chaîne. C'est
  // voulu — c'est la position, pas le rejeu, qui doit tenir compte du règlement.
  approx("le rejeu du moteur reste complet", after.totals.action_amount!, 300);

  // Un mouvement continue de peser sur la position même quand l'action est soldée.
  db.prepare(`INSERT INTO wallet_transactions (player_id, game_id, type, amount, currency, tx_date, source)
              VALUES (?, (SELECT id FROM games WHERE name='NEXAPOKER'), 'withdrawal', 250, 'USDT', '2026-08-03', 'manual')`).run(pid);
  approx("position = mouvements seuls une fois l'action soldée",
         getNexaPlayerDetailOn(db, pid)!.net_position!, 250);
  db.close();
}

console.log("\n══ Règlement partiel : seul le non réglé porte la position ══");
{
  const db = freshDb();
  const pid = setup(db);
  lockNexaActionSettlementOn(db, { player_id: pid, week_starts: [W1] });   // +500 réglé
  const d = getNexaPlayerDetailOn(db, pid)!;
  approx("déjà réglé", d.action_settled, 500);
  approx("reste à régler (−300 + 100)", d.action_unsettled!, -200);
  approx("position = le non réglé", d.net_position!, -200);

  // Corriger une semaine RÉGLÉE ne renfloue pas la position : le montant est figé.
  setWeeklyWinlossOn(db, { player_id: pid, week_start: W1, amount: 9999 });
  approx("le réglé reste figé", getNexaPlayerDetailOn(db, pid)!.action_settled, 500);
  approx("la position ne bouge pas", getNexaPlayerDetailOn(db, pid)!.net_position!, -200);
  db.close();
}

console.log("\n══ Un win/loss manquant ne rend incalculable que le NON réglé ══");
{
  const db = freshDb();
  const pid = setup(db);
  lockNexaActionSettlementOn(db, { player_id: pid, week_starts: [W1] });
  // On dé-saisit une semaine NON réglée : le reste à régler devient incalculable,
  // mais ce qui est déjà réglé reste un chiffre — il est sorti des comptes.
  const { clearWeeklyWinlossOn } = require("../lib/funnels/nexa/players");
  clearWeeklyWinlossOn(db, pid, W3);
  const d = getNexaPlayerDetailOn(db, pid)!;
  approx("le réglé reste chiffré", d.action_settled, 500);
  eq("le non réglé devient null", d.action_unsettled, null);
  eq("donc la position aussi", d.net_position, null);
  db.close();
}

console.log("\n══ Double règlement — refusé explicitement ET structurellement ══");
{
  const db = freshDb();
  const pid = setup(db);
  const first = lockNexaActionSettlementOn(db, { player_id: pid, week_starts: [W1, W2] });
  check("1er règlement OK", first.ok);

  const dup = lockNexaActionSettlementOn(db, { player_id: pid, week_starts: [W1] });
  check("2e règlement de la même semaine refusé", !dup.ok);
  if (!dup.ok) check("message explicite", /Déjà réglé/.test(dup.error), dup.error);

  // Sélection mixte : une semaine déjà réglée + une libre → tout est refusé.
  // Régler la moitié en silence serait pire que refuser.
  const mixed = lockNexaActionSettlementOn(db, { player_id: pid, week_starts: [W2, W3] });
  check("sélection mixte refusée en bloc", !mixed.ok);
  eq("aucun règlement supplémentaire créé",
     (db.prepare(`SELECT COUNT(*) c FROM manual_settlements`).get() as any).c, 1);
  eq("W3 est toujours réglable", getSettleableActionWeeksOn(db, pid).map(w => w.week_start), [W3]);

  // Dernier rempart : la contrainte UNIQUE, si le code était contourné.
  let sqlBlocked = false;
  try {
    db.prepare(`INSERT INTO nexa_action_settlement_weeks
                (settlement_id, player_id, week_start, winloss, action_pct, action_amount)
                VALUES (?, ?, ?, 0, 0, 0)`).run(first.ok ? first.settlement_id : 0, pid, W1);
  } catch { sqlBlocked = true; }
  check("UNIQUE(player_id, week_start) bloque au niveau du schéma", sqlBlocked);
  db.close();
}

console.log("\n══ Refus divers ══");
{
  const db = freshDb();
  const pid = setup(db);
  check("aucune semaine → refus", !lockNexaActionSettlementOn(db, { player_id: pid, week_starts: [] }).ok);
  check("joueur inconnu → refus", !lockNexaActionSettlementOn(db, { player_id: 9999, week_starts: [W1] }).ok);
  const ghost = lockNexaActionSettlementOn(db, { player_id: pid, week_starts: ["2026-01-05"] });
  check("semaine inexistante → refus", !ghost.ok);
  if (!ghost.ok) check("message explicite", /Non réglable/.test(ghost.error), ghost.error);
  eq("aucun règlement créé par un refus",
     (db.prepare(`SELECT COUNT(*) c FROM manual_settlements`).get() as any).c, 0);
  db.close();
}

console.log("\n══ Déverrouiller libère les semaines ══");
{
  const db = freshDb();
  const pid = setup(db);
  const r = lockNexaActionSettlementOn(db, { player_id: pid, week_starts: [W1, W2] });
  if (!r.ok) throw new Error(r.error);
  eq("2 semaines figées", getSettledWeeksOn(db, pid).size, 2);

  // unlockSettlement supprime la ligne manual_settlements ; le CASCADE doit emporter
  // le détail, sinon les semaines resteraient bloquées pour toujours.
  db.prepare(`DELETE FROM manual_settlements WHERE id = ?`).run(r.settlement_id);
  eq("le détail est parti avec (CASCADE)", getSettledWeeksOn(db, pid).size, 0);
  eq("les 3 semaines redeviennent réglables", getSettleableActionWeeksOn(db, pid).length, 3);
  db.close();
}

console.log("\n══ Taux d'action différents sur la sélection ══");
{
  const db = freshDb();
  const pid = setup(db);
  // Nouvelle période d'action à 30 % à partir de W3 : la sélection couvre deux taux.
  db.prepare(`UPDATE nexa_player_action_shares SET end_week = ? WHERE player_id = ?`).run(W2, pid);
  db.prepare(`INSERT INTO nexa_player_action_shares (player_id, pct, start_week) VALUES (?, 30, ?)`).run(pid, W3);

  const s = getSettleableActionWeeksOn(db, pid);
  eq("W3 passe à 30 %", s.find(w => w.week_start === W3)!.action_pct, 30);
  approx("action W3 = 200 × 30 %", s.find(w => w.week_start === W3)!.action_amount, 60);

  const r = lockNexaActionSettlementOn(db, { player_id: pid, week_starts: [W1, W3] });
  if (!r.ok) throw new Error(r.error);
  approx("montant = 500 + 60", r.amount_due_usdt, 560);
  const ms = db.prepare(`SELECT action_pct_applied, notes FROM manual_settlements WHERE id = ?`)
               .get(r.settlement_id) as any;
  // Une colonne unique ne peut pas porter deux taux : on ne prétend pas le contraire.
  eq("pct non uniforme → 0 plutôt qu'un taux inventé", ms.action_pct_applied, 0);
  check("et la note le dit", /multiples/.test(ms.notes ?? ""), ms.notes);
  db.close();
}

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} passés, ${failures.length} échoués`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
if (failures.length) { failures.forEach(f => console.log("   ✘", f)); process.exit(1); }
