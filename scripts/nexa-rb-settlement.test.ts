/**
 * Règlement du RAKEBACK NEXAPOKER — base SQLite réelle.
 * Run: npx tsx scripts/nexa-rb-settlement.test.ts
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────────┐
 * │ • Que régler le rakeback NE TOUCHE À AUCUN montant des semaines suivantes   │
 * │   — le makeup non récupéré survit au règlement (arbitrage Hugo). L'égalité  │
 * │   avant/après est vérifiée sur une chaîne dont le makeup est NON NUL à la   │
 * │   bascule : sur une chaîne où il vaut déjà 0, le test ne prouverait rien.   │
 * │ • Que le montant est écrit NÉGATIF dans manual_settlements : le rakeback    │
 * │   sort, et cinq agrégats du repo lisent ce signe sans jamais lire `kind`.   │
 * │ • Que la plage s'ARRÊTE avant une semaine en échec de contrôle, ET qu'on    │
 * │   peut en SORTIR — sans quoi le plafond gèle le rakeback d'aval pour        │
 * │   toujours. Deux sorties, testées toutes les deux : corriger le report, ou  │
 * │   acter l'écart à 0. Un motif d'écart n'en est PAS une, et c'est vérifié :  │
 * │   check_ok est généré depuis le seul check_delta.                          │
 * │ • Que « acter à 0 » exige la date de la semaine RETAPÉE, se refuse hors     │
 * │   ordre et hors rejeu, laisse une ligne de règlement relisible (semaine,    │
 * │   écart, motif, auteur) et pèse 0 dans les agrégats.                        │
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
  getOpenRbWeeksOn, getBlockingWeekOn, getBlockingWeekDetailOn, getRbSettlementWarningsOn,
  lockNexaRakebackSettlementOn, ackBlockedRbWeekOn,
} from "../lib/funnels/nexa/rakeback-settlement";
import { getActionSettlementWarningsOn, lockNexaActionSettlementOn } from "../lib/funnels/nexa/action-settlement";
import { getNexaPlayerDetailOn, setWeeklyWinlossOn } from "../lib/funnels/nexa/players";

let passed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log("   ✔", label); }
  else { failures.push(label); console.log("   ✘", label, detail); }
}
function eqArr(label: string, got: string[], want: string[]) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(label, g === w, g === w ? "" : `attendu ${w}, obtenu ${g}`);
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
    -- CONTRAINTES REPRISES DE LA VRAIE TABLE, pas d'un squelette approchant : le
    -- CHECK sur status et les deux ON DELETE CASCADE manquaient, et un test qui
    -- tourne sur un schéma plus permissif que la prod ne prouve rien de la prod.
    -- (Constat du second audit adverse.) La colonne kind est ajoutée par ALTER en prod
    -- (add_nexa_affiliate_v1), il est donc écrit en dur ici — c'est la seule
    -- divergence assumée, et le corollaire est que ce fichier ne peut pas
    -- détecter une régression sur la colonne kind elle-même.
    CREATE TABLE manual_settlements (id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      net_selected_usdt REAL NOT NULL DEFAULT 0, action_pct_applied REAL NOT NULL DEFAULT 0,
      amount_due_usdt REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','paid')),
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

// ── 1. Régler ne touche pas aux semaines suivantes ────────────────────────
console.log("\n1. Le makeup survit au règlement");
{
  const db = freshDb();
  // Chaîne CHOISIE pour que le makeup soit NON NUL à la bascule : sans ça, le
  // test passerait quoi qu'on code — c'est le défaut que l'audit a trouvé dans la
  // version précédente de ce fichier.
  //   W1 +300 → dû 150 · W2 −200 → dû 0, makeup −200 (NON NUL)
  //   W3 +200 → (200−200) = 0 → dû 0 · W4 +200 → dû 100
  const pid = seed(db, [300, -200, 200, 200]);

  const avant = getNexaPlayerDetailOn(db, pid)!;
  near("dû W1", avant.weeks[0].due, 150);
  near("dû W2", avant.weeks[1].due, 0);
  near("makeup sortant de W2 — NON NUL, c'est le point du test", avant.weeks[1].makeup_out, -200);
  near("dû W3 (le makeup est récupéré ici)", avant.weeks[2].due, 0);
  near("dû W4", avant.weeks[3].due, 100);
  const totalAvant = avant.weeks.reduce((s, w) => s + w.due, 0);
  near("total dû avant règlement", totalAvant, 250);

  const lock = lockNexaRakebackSettlementOn(db, { player_id: pid, through_week: W[1] });
  check("règlement W1→W2 verrouillé", lock.ok, JSON.stringify(lock));
  if (lock.ok) {
    near("montant réglé = 150", lock.amount_due_usdt, 150);
    check("deux semaines couvertes, W2 à dû nul comprise", lock.weeks.length === 2,
          `obtenu ${lock.weeks.length}`);
  }

  const apres = getNexaPlayerDetailOn(db, pid)!;
  // LE POINT : rien ne bouge. Avec une remise à zéro, W3 vaudrait 100 et le total
  // grimperait à 350 — 100 de plus, offerts au joueur.
  near("W3 inchangée après règlement", apres.weeks[2].due, 0);
  near("W4 inchangée après règlement", apres.weeks[3].due, 100);
  near("makeup entrant de W3 toujours −200", apres.weeks[2].makeup_in, -200);
  near("total dû inchangé", apres.weeks.reduce((s, w) => s + w.due, 0), 250);
  db.close();
}

// ── 1-bis. Le montant est écrit NÉGATIF ────────────────────────────────────
console.log("\n1-bis. Sens du montant dans manual_settlements");
{
  const db = freshDb();
  const pid = seed(db, [200, 0, 0, 0]);
  const lock = lockNexaRakebackSettlementOn(db, { player_id: pid, through_week: W[0] });
  check("verrouillé", lock.ok, JSON.stringify(lock));
  const ms = db.prepare(`SELECT amount_due_usdt, kind FROM manual_settlements WHERE player_id = ?`)
    .get(pid) as any;
  near("amount_due_usdt NÉGATIF — le rakeback sort", ms.amount_due_usdt, -100);
  check("kind = rakeback", ms.kind === "rakeback", ms.kind);
  if (lock.ok) near("le montant rendu à l'écran reste positif (dû au joueur)", lock.amount_due_usdt, 100);
  // Le snapshot, lui, garde le dû BRUT : c'est le montant calculé, pas la convention
  // de sens de la colonne du hub.
  const snap = db.prepare(`SELECT due FROM nexa_rakeback_settlement_weeks WHERE player_id = ?`).get(pid) as any;
  near("le snapshot garde le dû brut, positif", snap.due, 100);
  db.close();
}

// ── 2. La plage s'arrête avant une semaine en échec ───────────────────────
console.log("\n2. Plafond sur une semaine en échec de contrôle");
{
  const db = freshDb();
  // W2 en échec : la plage ne doit proposer que W1.
  const pid = seed(db, [200, 300, 400, 100], [true, false, true, true]);

  const open = getOpenRbWeeksOn(db, pid);
  eqArr("seule W1 est réglable", open.map(w => w.week_start), [W[0]]);
  check("l'écran sait pourquoi", getBlockingWeekOn(db, pid) === W[1],
        `obtenu ${getBlockingWeekOn(db, pid)}`);

  const trop = lockNexaRakebackSettlementOn(db, { player_id: pid, through_week: W[3] });
  // through_week au-delà du plafond : la plage se réduit d'elle-même à W1.
  check("régler au-delà ne couvre QUE ce qui est réglable", trop.ok, JSON.stringify(trop));
  if (trop.ok) {
    eqArr("W3 et W4 ne sont pas emportées", trop.weeks.map(w => w.week_start), [W[0]]);
  }
  const reste = getOpenRbWeeksOn(db, pid);
  eqArr("et rien ne s'ouvre tant que W2 n'est pas corrigée", reste.map(w => w.week_start), []);
  db.close();
}

// ── 2-bis. LES DEUX SORTIES DU PLAFOND ─────────────────────────────────────
//
// Le premier audit avait accepté le plafond sans vérifier qu'on pouvait en sortir.
// Le second a montré qu'un motif d'écart n'en sort PAS — `check_ok` est généré
// depuis le seul `check_delta` — et que le schéma exige justement un motif sur
// toute ligne hors tolérance. Donc : toute semaine bloquée a déjà un motif, aucune
// ne se débloquait par là, et le rakeback d'aval était gelé sans issue.
console.log("\n2-bis. Sortir du plafond : le motif ne suffit pas, deux sorties existent");
{
  const db = freshDb();
  const pid = seed(db, [200, 300, 400, 100], [true, false, true, true]);
  const bloque = () => getBlockingWeekOn(db, pid);
  const ouvertes = () => getOpenRbWeeksOn(db, pid).map(w => w.week_start);

  // (a) Le motif — déjà présent, et re-saisi — ne rouvre rien.
  db.prepare(`UPDATE nexa_affiliate_weeks SET override_reason = ? WHERE player_id = ? AND week_start = ?`)
    .run("écart assumé, screenshot NEXA incohérent", pid, W[1]);
  eqArr("un motif d'écart NE rouvre PAS la plage", ouvertes(), [W[0]]);
  check("et la semaine plafonne toujours", bloque() === W[1], `obtenu ${bloque()}`);

  // (b) Sortie 1 — corriger le report : check_delta revient dans la tolérance.
  {
    const db2 = freshDb();
    const p2 = seed(db2, [200, 300, 400, 100], [true, false, true, true]);
    db2.prepare(`UPDATE nexa_affiliate_weeks SET check_delta = 0, override_reason = NULL
                 WHERE player_id = ? AND week_start = ?`).run(p2, W[1]);
    eqArr("corriger le report rouvre toute la suite",
          getOpenRbWeeksOn(db2, p2).map(w => w.week_start), [W[0], W[1], W[2], W[3]]);
    check("plus rien ne plafonne", getBlockingWeekOn(db2, p2) === null, `obtenu ${getBlockingWeekOn(db2, p2)}`);
    db2.close();
  }

  // (c) Sortie 2 — acter à 0. La confirmation doit être la date RETAPÉE.
  const detail = getBlockingWeekDetailOn(db, pid);
  check("l'écran reçoit l'écart constaté", detail !== null && Math.abs(detail.check_delta - 5) < 1e-9,
        JSON.stringify(detail));
  check("et le motif saisi", detail?.override_reason === "écart assumé, screenshot NEXA incohérent",
        JSON.stringify(detail));

  const sansConfirm = ackBlockedRbWeekOn(db, { player_id: pid, week_start: W[1], confirm_week: "" });
  check("acter sans retaper la date est REFUSÉ", !sansConfirm.ok, JSON.stringify(sansConfirm));
  const mauvaise = ackBlockedRbWeekOn(db, { player_id: pid, week_start: W[1], confirm_week: W[2] });
  check("acter avec une AUTRE date est refusé", !mauvaise.ok, JSON.stringify(mauvaise));
  const horsOrdre = ackBlockedRbWeekOn(db, { player_id: pid, week_start: W[2], confirm_week: W[2] });
  check("acter une semaine qui ne plafonne pas est refusé", !horsOrdre.ok, JSON.stringify(horsOrdre));
  eqArr("aucun refus n'a rien débloqué au passage", ouvertes(), [W[0]]);

  const acte = ackBlockedRbWeekOn(db, { player_id: pid, week_start: W[1], confirm_week: W[1] });
  check("acté après confirmation exacte", acte.ok, JSON.stringify(acte));
  eqArr("la plage reprend APRÈS la semaine actée", ouvertes(), [W[0], W[2], W[3]]);
  check("plus rien ne plafonne", bloque() === null, `obtenu ${bloque()}`);

  // L'acte est une ligne de règlement relisible, pas un drapeau caché.
  if (acte.ok) {
    const ms = db.prepare(`SELECT kind, amount_due_usdt, status, notes FROM manual_settlements WHERE id = ?`)
      .get(acte.settlement_id) as any;
    check("kind = rakeback_ack", ms.kind === "rakeback_ack", JSON.stringify(ms));
    near("montant 0 — ce n'est pas un paiement", ms.amount_due_usdt, 0);
    check("status = paid : la ligne ne s'installe pas dans les dus", ms.status === "paid", ms.status);
    check("la note porte la semaine", String(ms.notes).includes(W[1]), ms.notes);
    check("la note porte l'écart constaté", String(ms.notes).includes("5.00"), ms.notes);
    check("la note porte le motif", String(ms.notes).includes("screenshot NEXA incohérent"), ms.notes);
    check("la note porte qui a acté", String(ms.notes).includes("acté par"), ms.notes);
    const wk = db.prepare(`SELECT * FROM nexa_rakeback_settlement_weeks WHERE settlement_id = ?`)
      .all(acte.settlement_id) as any[];
    check("une seule semaine figée", wk.length === 1, JSON.stringify(wk));
    near("dû figé à 0", wk[0].due, 0);
    near("makeup sortant 0 — la chaîne ne se propage pas", wk[0].makeup_out, 0);
  }

  // Le prix de l'acte est réel : corriger le report ENSUITE ne ressuscite rien.
  db.prepare(`UPDATE nexa_affiliate_weeks SET check_delta = 0 WHERE player_id = ? AND week_start = ?`)
    .run(pid, W[1]);
  eqArr("corriger après coup ne rouvre PAS la semaine actée", ouvertes(), [W[0], W[2], W[3]]);

  // Et l'acte ne se rejoue pas.
  const rejeu = ackBlockedRbWeekOn(db, { player_id: pid, week_start: W[1], confirm_week: W[1] });
  check("acter deux fois la même semaine est refusé", !rejeu.ok, JSON.stringify(rejeu));
  db.close();
}

// ── 2-ter. Une semaine actée ne fausse aucun agrégat ───────────────────────
console.log("\n2-ter. La ligne d'acte est neutre pour l'argent");
{
  const db = freshDb();
  const pid = seed(db, [200, 300, 400, 100], [false, true, true, true]);
  // W1 bloquée dès la première semaine : c'est le cas où l'écran annonçait
  // « tout ce qui était calculable est réglé » alors que W2..W4 portaient un dû.
  eqArr("rien n'est proposé tant que W1 plafonne", getOpenRbWeeksOn(db, pid).map(w => w.week_start), []);
  check("mais le plafond est nommé", getBlockingWeekOn(db, pid) === W[0], `obtenu ${getBlockingWeekOn(db, pid)}`);

  const acte = ackBlockedRbWeekOn(db, { player_id: pid, week_start: W[0], confirm_week: W[0] });
  check("W1 actée", acte.ok, JSON.stringify(acte));
  eqArr("les 3 semaines gelées redeviennent réglables",
        getOpenRbWeeksOn(db, pid).map(w => w.week_start), [W[1], W[2], W[3]]);

  const r = lockNexaRakebackSettlementOn(db, { player_id: pid, through_week: W[3] });
  check("et elles se règlent", r.ok, JSON.stringify(r));
  // 300 + 400 + 100 = 800, à 50 % → 400. La semaine actée n'apporte rien et ne coûte rien.
  if (r.ok) near("montant = 50 % de (300+400+100)", r.amount_due_usdt, 400);

  const somme = db.prepare(`SELECT COALESCE(SUM(amount_due_usdt),0) AS s FROM manual_settlements WHERE player_id = ?`)
    .get(pid) as any;
  near("Σ des montants = −400 : l'acte pèse 0, le règlement sort 400", somme.s, -400);
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

// ── 4. kind et note du règlement ──────────────────────────────────────────
console.log("\n4. Étiquetage de la ligne de règlement");
{
  const db = freshDb();
  const pid = seed(db, [200, 300, 0, 0]);
  const ok = lockNexaRakebackSettlementOn(db, { player_id: pid, through_week: W[1] });
  check("verrouillé", ok.ok, JSON.stringify(ok));
  const ms = db.prepare(`SELECT kind, notes, action_pct_applied, net_selected_usdt
                         FROM manual_settlements WHERE player_id = ?`).get(pid) as any;
  check("kind = rakeback", ms.kind === "rakeback", ms.kind);
  check("la note porte la plage et le taux", /Rakeback .* → .*taux 50 %/.test(ms.notes ?? ""), ms.notes);
  near("le taux appliqué est reporté", ms.action_pct_applied, 50);
  near("l'assiette totale est reportée", ms.net_selected_usdt, 500);
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
