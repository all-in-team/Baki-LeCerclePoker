/**
 * Harnais de la couche DB « AK multi-Account » — phase 2 (lib/pool/periods.ts).
 * Run: npx tsx scripts/pool-periods.test.ts
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────┐
 * │ Sur une base SQLite RÉELLE (DDL de prod importé) : la première période    │
 * │ exige un pool de départ SAISI ; le lock écrit règlement + période + soldes │
 * │ en une transaction, la main lue sur le grand livre à 6 décimales, arrondie │
 * │ au centime à la frontière ; la période suivante est BLOQUÉE tant que le   │
 * │ règlement est locked ; le hook markPaid exige la date, écrit le mouvement  │
 * │ 'in' une seconde après la clôture ; la période suivante le compte et rend  │
 * │ 0 — et SANS lui rend +44,96 (contrefactuel §4 exécuté) ; la ceinture       │
 * │ refuse un paiement tombant dans une période figée ; un compte à solde ≠ 0 │
 * │ ne se clôt pas ; le déverrouillage remonte la chaîne dans l'ordre et       │
 * │ refuse un règlement payé ; les mouvements déclarés ne tombent jamais dans  │
 * │ une somme figée ; l'ingestion déduplique et reconnaît la wallet.           │
 * └─────────────────────────────────────────────────────────────────────────┘
 * ┌─ CE QU'ILS NE PROUVENT PAS ─────────────────────────────────────────────┐
 * │ • markPaid/unlockSettlement (getDb) ne sont PAS appelés : on exerce les   │
 * │   fonctions d'argent qu'ils appellent (writePoolSettlementMovementOnPaid,  │
 * │   poolPeriodForSettlementOn). Leur enveloppe transactionnelle est lue.    │
 * │ • Le hub /payments, le bot, l'écran : phase 3.                            │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
import fs from "fs";
import path from "path";

const REPO = path.resolve(__dirname, "..");
const Database = require(path.join(REPO, "node_modules/better-sqlite3"));

import { POOL_SCHEMA_SQL, POOL_GAME_INSERT_SQL, POOL_GAME_NAME, POOL_AGENCY_OKPAY_TG_ID } from "../lib/pool/schema";
import {
  enrollPoolPlayerOn, getPoolPlayerOn, addAccountOn, closeAccountOn, listAccountsOn,
  ingestOkpayMessageOn, getLedgerOn, addDeclaredMovementOn, deleteDeclaredMovementOn, listMovementsOn,
  previewPoolPeriodOn, lockPoolPeriodOn, unlockPoolPeriodOn, getPeriodsOn, getPeriodBalancesOn,
  writePoolSettlementMovementOnPaid, poolPeriodForSettlementOn, walletOwnerOn, resolveSettlementInstantsOn,
  setSettlementInstantOn, addPoolOpenCorrectionOn, poolOpenEffectiveOn,
} from "../lib/pool/periods";
import { computePoolPeriod, settlementOccurredAt } from "../lib/pool/engine";

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
function throws(fn: () => unknown, re: RegExp): boolean {
  try { fn(); return false; } catch (e: any) { return re.test(e?.message ?? String(e)); }
}
const errOf = (r: any) => (r && r.ok === false ? r.error : "");

const SRC = fs.readFileSync(path.join(REPO, "lib/db.ts"), "utf8");
const MS_START = SRC.indexOf("CREATE TABLE IF NOT EXISTS manual_settlements");
const MS_SQL = SRC.slice(MS_START, SRC.indexOf(");", MS_START) + 2);

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE _applied_fixes (name TEXT PRIMARY KEY);
    CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
      default_action_pct REAL, currency TEXT NOT NULL DEFAULT 'USDT');
    CREATE TABLE player_game_deals (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id), game_id INTEGER NOT NULL REFERENCES games(id),
      action_pct REAL NOT NULL DEFAULT 50, rakeback_pct REAL NOT NULL DEFAULT 0, UNIQUE(player_id, game_id));
    ${MS_SQL}
    ALTER TABLE manual_settlements ADD COLUMN paid_date TEXT;
    ALTER TABLE manual_settlements ADD COLUMN kind TEXT NOT NULL DEFAULT 'action';
  `);
  db.exec(POOL_SCHEMA_SQL);
  db.exec(POOL_GAME_INSERT_SQL);
  db.prepare(`INSERT INTO players (name) VALUES ('Joueur A'), ('Joueur B')`).run();
  const gid = (db.prepare(`SELECT id FROM games WHERE name = ?`).get(POOL_GAME_NAME) as any).id as number;
  db.prepare(`INSERT INTO player_game_deals (player_id, game_id, action_pct) VALUES (1, ?, 30), (2, ?, 20)`).run(gid, gid);
  return { db, gid };
}

/** Message OkPay au format RÉEL (emoji, 6 décimales), pour la main du joueur A. */
function mainMessage(lines: { dir: "➕" | "➖"; from: string; id: string; amount: string; bal: string; date: string }[]): string {
  return ["JoueurA Transaction:600200100", "",
    ...lines.flatMap(l => [
      `Type: ${l.dir}`,
      `Details: ${l.dir === "➕" ? "Transfer From" : "Transfer To"} : ${l.from}【ID ${l.id}】`,
      `Amount: ${l.amount}`, "Currency: USDT", `Changed balance: ${l.bal}`, `date: ${l.date}`, "",
    ]),
  ].join("\n");
}

const NOW = "2026-09-21 12:00:00";

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n■ 1. Inscription, comptes, grand livre");
const { db, gid } = freshDb();
{
  eq("inscription du joueur A avec sa main", enrollPoolPlayerOn(db, 1, "600200100").ok, true);
  check("ID main invalide → refus", !enrollPoolPlayerOn(db, 2, "abc").ok);
  eq("réinscription idempotente", enrollPoolPlayerOn(db, 1).ok, true);
  const pp = getPoolPlayerOn(db, 1)!;
  eq("part d'action lue dans player_game_deals", pp.action_pct, 30);

  const a1 = addAccountOn(db, { player_id: 1, okpay_tg_id: "777001" });
  const a2 = addAccountOn(db, { player_id: 1, okpay_tg_id: "777002" });
  check("deux comptes créés, libellés par défaut", a1.ok && a2.ok && a1.label === "Compte 1" && a2.label === "Compte 2");
  check("compte pour un joueur non inscrit → refus", !addAccountOn(db, { player_id: 2 }).ok);
  eq("walletOwner : main → joueur A", walletOwnerOn(db, "600200100"), { kind: "main", player_id: 1, player_name: "Joueur A" });
  eq("walletOwner : OkPay de compte → Compte 2", walletOwnerOn(db, "777002"), { kind: "account", player_id: 1, player_name: "Joueur A", account_id: 2, label: "Compte 2" });
  eq("walletOwner : agence", walletOwnerOn(db, POOL_AGENCY_OKPAY_TG_ID), { kind: "agency" });
  eq("walletOwner : inconnue", walletOwnerOn(db, "999"), { kind: "unknown" });

  // La main reçoit 1000.123456 le 10, envoie 600 à Compte 1 le 12 → 400.123456.
  const msg = mainMessage([
    { dir: "➖", from: "Compte1", id: "777001", amount: "600", bal: "400.123456", date: "2026-09-12 10:00:00" },
    { dir: "➕", from: "Exchange", id: "555000111", amount: "1000.123456", bal: "1000.123456", date: "2026-09-10 09:00:00" },
  ]);
  const ing = ingestOkpayMessageOn(db, msg, "telegram_forward");
  check("ingestion : 2 lignes insérées, wallet reconnue comme main du joueur A", ing.ok && ing.inserted === 2 && ing.ignored === 0 && ing.owner.kind === "main", JSON.stringify(ing));
  const again = ingestOkpayMessageOn(db, msg, "telegram_forward");
  check("même message transféré deux fois → 0 insérée, 2 ignorées", again.ok && again.inserted === 0 && again.ignored === 2, JSON.stringify(again));
  eq("grand livre : 2 lignes, 6 décimales conservées", getLedgerOn(db, "600200100").map(l => l.balance_after), [1000.123456, 400.123456]);
  check("message illisible → refus, rien inséré", !ingestOkpayMessageOn(db, "n'importe quoi", "paste").ok);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n■ 2. Première période : pool de départ SAISI, main lue sur le grand livre");
let period1 = 0, settlement1 = 0;
{
  const T1 = "2026-09-13 18:00:00";
  const bal = (extra: any[] = []) => [
    { account_id: 1, wallet_kind: "ak" as const, balance: 300, observed_at: "2026-09-13 17:59:00" },
    { account_id: 1, wallet_kind: "okpay" as const, balance: 0, observed_at: "2026-09-13 17:59:10" },
    { account_id: 2, wallet_kind: "ak" as const, balance: 150, observed_at: "2026-09-13 17:59:30" },
    { account_id: 2, wallet_kind: "okpay" as const, balance: 0, observed_at: "2026-09-13 17:59:40" },
    ...extra,
  ];

  const noOpen = previewPoolPeriodOn(db, { player_id: 1, closed_at: T1, balances: bal(), now: NOW });
  check("sans pool de départ : preview ok, pool_open null, is_first", noOpen.ok && noOpen.preview.is_first && noOpen.preview.pool_open === null);
  const lockNoOpen = lockPoolPeriodOn(db, { player_id: 1, closed_at: T1, balances: bal(), now: NOW });
  check("lock sans pool de départ → refus « doit être SAISI », jamais 0 par défaut", !lockNoOpen.ok && /SAISI/.test(errOf(lockNoOpen)) && /AKS/.test(errOf(lockNoOpen)), errOf(lockNoOpen));

  const missing = previewPoolPeriodOn(db, { player_id: 1, closed_at: T1, balances: bal().slice(0, 3), pool_open_manual: 1000, now: NOW });
  check("solde OkPay de Compte 2 manquant → blocker nommé", missing.ok && missing.preview.blockers.some(b => /Compte 2 : solde OKPAY manquant/.test(b)), JSON.stringify(missing.ok && missing.preview.blockers));
  const future = previewPoolPeriodOn(db, { player_id: 1, closed_at: "2026-09-22 18:00:00", balances: bal(), pool_open_manual: 1000, now: NOW });
  check("clôture dans le futur → blocker", future.ok && future.preview.blockers.some(b => /futur/.test(b)));
  const other = previewPoolPeriodOn(db, { player_id: 1, closed_at: T1, balances: bal([{ account_id: 99, wallet_kind: "ak", balance: 1, observed_at: T1 }]), pool_open_manual: 1000, now: NOW });
  check("solde d'un compte inconnu / d'un autre joueur → blocker", other.ok && other.preview.blockers.some(b => /Compte 99 inconnu/.test(b)));
  const threeDec = previewPoolPeriodOn(db, { player_id: 1, closed_at: T1, balances: bal().map(b => b.account_id === 1 && b.wallet_kind === "ak" ? { ...b, balance: 300.001 } : b), pool_open_manual: 1000, now: NOW });
  check("solde à 3 décimales → blocker (sumPool)", threeDec.ok && threeDec.preview.blockers.some(b => /Compte 1 AK/.test(b)));

  const pre = previewPoolPeriodOn(db, { player_id: 1, closed_at: T1, balances: bal(), pool_open_manual: 1000, now: NOW });
  check("preview complète sans blocker", pre.ok && pre.preview.blockers.length === 0, JSON.stringify(pre.ok && pre.preview.blockers));
  if (pre.ok) {
    const p = pre.preview;
    const main = p.readings.find(r => r.wallet_kind === "main")!;
    eq("main lue sur le grand livre : 400.123456 → 400.12 au centime, source okpay_ledger, ligne référencée, observed_at = date de la ligne",
       [main.balance, main.source, main.okpay_line_id !== null, main.observed_at], [400.12, "okpay_ledger", true, "2026-09-12 10:00:00"]);
    approx("pool de fin = 300 + 0 + 150 + 0 + 400.12 = 850.12", p.pool_close!, 850.12);
    approx("résultat = 850.12 − 1000 = −149.88", p.computed!.result, -149.88);
    approx("ma part = −149.88 × 30 % = −44.964 → −44.96", p.computed!.action_amount, -44.96);
    check("écart d'horodatage (main du 12 vs soldes du 13) → AVERTISSEMENT, pas blocker", p.warnings.some(w => w.code === "observation_spread") && p.blockers.length === 0);
    eq("période 1 : opened_at = closed_at (intervalle vide), source manual", [p.opened_at, p.pool_open_source], [T1, "manual"]);
  }

  const lock = lockPoolPeriodOn(db, { player_id: 1, closed_at: T1, balances: bal(), pool_open_manual: 1000, note: "P1", now: NOW });
  check("lock ok", lock.ok, errOf(lock));
  if (lock.ok) {
    period1 = lock.period_id; settlement1 = lock.settlement_id!;
    const ms = db.prepare(`SELECT * FROM manual_settlements WHERE id = ?`).get(settlement1) as any;
    eq("règlement : kind action, game pool, locked, dû −44.96, pct 30, net −149.88", [ms.kind, ms.game_id, ms.status, ms.amount_due_usdt, ms.action_pct_applied, ms.net_selected_usdt], ["action", gid, "locked", -44.96, 30, -149.88]);
    const per = getPeriodsOn(db, 1);
    eq("période figée : 1 ligne, provenance complète", [per.length, per[0].pool_open, per[0].pool_close, per[0].result, per[0].action_amount, per[0].settlement_id, per[0].settlement_status],
       [1, 1000, 850.12, -149.88, -44.96, settlement1, "locked"]);
    const bals = getPeriodBalancesOn(db, period1);
    eq("5 soldes figés, 1 main depuis le grand livre", [bals.length, bals.filter(b => b.source === "okpay_ledger").length, bals.find(b => b.wallet_kind === "main")!.balance], [5, 1, 400.12]);
  }
  const twice = lockPoolPeriodOn(db, { player_id: 1, closed_at: T1, balances: bal(), pool_open_manual: 1000, now: NOW });
  check("re-lock au même instant → refus (chaîne)", !twice.ok && /antérieure ou égale/.test(errOf(twice)));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n■ 3. §4 en base : blocker tant que locked, hook markPaid, période suivante");
{
  const T2 = "2026-09-20 18:00:00";
  const bal2 = (main: number) => [
    { account_id: 1, wallet_kind: "ak" as const, balance: 300, observed_at: "2026-09-20 17:59:00" },
    { account_id: 1, wallet_kind: "okpay" as const, balance: 0, observed_at: "2026-09-20 17:59:00" },
    { account_id: 2, wallet_kind: "ak" as const, balance: 150, observed_at: "2026-09-20 17:59:00" },
    { account_id: 2, wallet_kind: "okpay" as const, balance: 0, observed_at: "2026-09-20 17:59:00" },
    { account_id: null, wallet_kind: "main" as const, balance: main, observed_at: "2026-09-20 17:59:00" },
  ];
  const blocked = previewPoolPeriodOn(db, { player_id: 1, closed_at: T2, balances: bal2(445.08), now: NOW });
  check("période 2 BLOQUÉE : règlement #1 locked, message nomme le règlement et le sens", blocked.ok && blocked.preview.blockers.some(b => new RegExp(`Règlement #${settlement1}`).test(b) && /tu lui dois 44.96/.test(b)), JSON.stringify(blocked.ok && blocked.preview.blockers));
  eq("pool de départ P2 = 850.12, repris (carry), SANS le versement", blocked.ok && [blocked.preview.pool_open, blocked.preview.pool_open_source, blocked.preview.carried_from], [850.12, "carry", "2026-09-13 18:00:00"]);

  // Le hook, comme markPaid l'appelle : dans une transaction, avec le flip de statut.
  check("hook sans date → JETTE (date réelle obligatoire)", throws(() => writePoolSettlementMovementOnPaid(db, settlement1, null), /date de paiement réelle est obligatoire/));
  check("hook payé 2 jours AVANT la clôture → JETTE (la veille est tolérée : fuseau)", throws(() => writePoolSettlementMovementOnPaid(db, settlement1, "2026-09-11"), /antérieure à la clôture/));
  eq("rien écrit par les refus", listMovementsOn(db, 1).length, 0);
  db.transaction(() => {
    db.prepare(`UPDATE manual_settlements SET status = 'paid', paid_at = datetime('now'), paid_date = ? WHERE id = ? AND status = 'locked'`).run("2026-09-13", settlement1);
    writePoolSettlementMovementOnPaid(db, settlement1, "2026-09-13");
  })();
  const mv = listMovementsOn(db, 1);
  eq("mouvement de règlement : 'in' 44.96, daté 1 s après la clôture (payé le jour même), kind settlement, précision JOUR", mv.map(m => [m.direction, m.amount, m.occurred_at, m.kind, m.settlement_id, m.occurred_precision]), [["in", 44.96, "2026-09-13 18:00:01", "settlement", settlement1, "day"]]);
  check("second appel du hook → refus par l'index unique (un règlement, un mouvement)", throws(() => writePoolSettlementMovementOnPaid(db, settlement1, "2026-09-13"), /UNIQUE/));

  // Période 2 : il n'a pas joué, sa main a reçu mes 44.96 → 445.08.
  const p2 = previewPoolPeriodOn(db, { player_id: 1, closed_at: T2, balances: bal2(445.08), now: NOW });
  check("période 2 débloquée", p2.ok && p2.preview.blockers.length === 0, JSON.stringify(p2.ok && p2.preview.blockers));
  if (p2.ok) {
    eq("ext_in = 44.96 (le versement, dans ]13 18:00, 20 18:00])", p2.preview.ext_in, 44.96);
    approx("résultat P2 = (895.08 + 0) − (850.12 + 44.96) = 0", p2.preview.computed!.result, 0);
  }
  // CONTREFACTUEL §4, EN BASE : on retire le mouvement → gain fictif de 44.96 → il me devrait 13.49.
  db.prepare(`DELETE FROM pool_external_movements WHERE settlement_id = ?`).run(settlement1);
  const noMv = previewPoolPeriodOn(db, { player_id: 1, closed_at: T2, balances: bal2(445.08), now: NOW });
  approx("contrefactuel : SANS le mouvement, résultat P2 = +44.96 (gain fictif)", noMv.ok ? noMv.preview.computed!.result : NaN, 44.96);
  approx("contrefactuel : il me devrait 13.49 sur mon propre versement", noMv.ok ? noMv.preview.computed!.action_amount : NaN, 13.49);
  // On le remet (comme markPaid l'aurait écrit) et on fige P2.
  writePoolSettlementMovementOnPaid(db, settlement1, "2026-09-13");
  const lock2 = lockPoolPeriodOn(db, { player_id: 1, closed_at: T2, balances: bal2(445.08), now: NOW });
  check("lock P2 ok", lock2.ok, errOf(lock2));
  if (lock2.ok) {
    eq("part nulle → AUCUN règlement (pas de bruit dans /payments), période figée quand même", [lock2.settlement_id, getPeriodsOn(db, 1).length], [null, 2]);
    const per2 = getPeriodsOn(db, 1)[1];
    eq("provenance P2 : opened_at = closed_at P1, ext_in figé 44.96, result 0", [per2.opened_at, per2.ext_in, per2.result, per2.pool_open_source], ["2026-09-13 18:00:00", 44.96, 0, "carry"]);
  }

  // Clôture rétroactive : mercredi 16 saisi le 21 — refusée ici parce que P2 (20) est déjà figée, comme il se doit.
  const retro = previewPoolPeriodOn(db, { player_id: 1, closed_at: "2026-09-16 12:00:00", balances: bal2(445.08), now: NOW });
  check("clôture antérieure à la dernière période figée → blocker (déverrouiller d'abord)", retro.ok && retro.preview.blockers.some(b => /antérieure ou égale/.test(b)));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n■ 4. Mouvements déclarés, comptes, déverrouillage, ceinture");
{
  const inFrozen = addDeclaredMovementOn(db, { player_id: 1, direction: "out", amount: 50, occurred_at: "2026-09-15 10:00:00" });
  check("mouvement déclaré dans une période figée → refus", !inFrozen.ok && /figée/.test(errOf(inFrozen)));
  const okMv = addDeclaredMovementOn(db, { player_id: 1, direction: "out", amount: 50, occurred_at: "2026-09-21 10:00:00", note: "retrait perso" });
  check("mouvement déclaré après la dernière clôture → ok", okMv.ok);
  check("montant 3 décimales → refus", !addDeclaredMovementOn(db, { player_id: 1, direction: "in", amount: 1.005, occurred_at: "2026-09-21 10:00:00" }).ok);
  check("montant négatif → refus (le sens est porté par in/out)", !addDeclaredMovementOn(db, { player_id: 1, direction: "in", amount: -5, occurred_at: "2026-09-21 10:00:00" }).ok);
  check("date hors calendrier → refus", !addDeclaredMovementOn(db, { player_id: 1, direction: "in", amount: 5, occurred_at: "2026-02-30 10:00:00" }).ok);
  if (okMv.ok) {
    check("suppression d'un mouvement déclaré non figé → ok", deleteDeclaredMovementOn(db, okMv.id).ok);
  }
  const settleMv = listMovementsOn(db, 1).find(m => m.kind === "settlement")!;
  check("suppression d'un mouvement de règlement → refus (se gère depuis /payments)", !deleteDeclaredMovementOn(db, settleMv.id).ok);

  // Comptes.
  const closeFull = closeAccountOn(db, 2);
  check("clore Compte 2 (AK 150 à la dernière clôture) → REFUS nommant le montant", !closeFull.ok && /AK 150.00/.test(errOf(closeFull)), errOf(closeFull));
  const a3 = addAccountOn(db, { player_id: 1 });
  check("Compte 3 créé (label suit les clos et ouverts)", a3.ok && a3.label === "Compte 3");
  const closeNew = closeAccountOn(db, (a3 as any).id);
  check("clore un compte jamais figé → ok, sans période", closeNew.ok && (closeNew as any).closed_in_period_id === null);
  eq("comptes ouverts : 1 et 2 ; Compte 3 clos mais toujours en base", [listAccountsOn(db, 1).map(a => a.id), listAccountsOn(db, 1, true).length], [[1, 2], 3]);
  check("re-clore → refus", !closeAccountOn(db, (a3 as any).id).ok);

  // Déverrouillage : l'ordre.
  const periods = getPeriodsOn(db, 1);
  const unlockOld = unlockPoolPeriodOn(db, 1, periods[0].id);
  check("déverrouiller P1 sous P2 → refus (seule la dernière)", !unlockOld.ok && /dernière période/.test(errOf(unlockOld)));
  const unlock2 = unlockPoolPeriodOn(db, 1, periods[1].id);
  check("déverrouiller P2 → ok", unlock2.ok, errOf(unlock2));
  eq("il reste P1, ses soldes intacts", [getPeriodsOn(db, 1).length, getPeriodBalancesOn(db, period1).length], [1, 5]);
  const unlockPaid = unlockPoolPeriodOn(db, 1, period1);
  check("déverrouiller P1 (règlement PAYÉ) → refus", !unlockPaid.ok && /payé/.test(errOf(unlockPaid)));
  eq("le mouvement de règlement de P1 est toujours là (il compte dans la période ouverte)", listMovementsOn(db, 1).filter(m => m.kind === "settlement").length, 1);

  // Le délock générique de /payments : nommé, et de toute façon refusé par la FK.
  eq("poolPeriodForSettlementOn → la période", poolPeriodForSettlementOn(db, settlement1)?.closed_at, "2026-09-13 18:00:00");
  check("DELETE FROM manual_settlements adossé → refus FK", throws(() => db.prepare(`DELETE FROM manual_settlements WHERE id = ?`).run(settlement1), /FOREIGN KEY/));

  // Ceinture du hook : une période postérieure figée par un AUTRE chemin (INSERT direct,
  // le blocker de preview contourné) — le paiement daté dans sa fenêtre est refusé.
  const ms2 = db.prepare(`INSERT INTO manual_settlements (game_id, player_id, net_selected_usdt, action_pct_applied, amount_due_usdt, status) VALUES (?, 1, 100, 30, 30, 'locked')`).run(gid);
  const sid2 = Number(ms2.lastInsertRowid);
  db.prepare(`INSERT INTO pool_periods (player_id, game_id, opened_at, closed_at, pool_open, pool_open_source, pool_close, ext_in, ext_out, result, action_pct, action_amount, settlement_id)
              VALUES (1, ?, '2026-09-13 18:00:00', '2026-09-20 18:00:00', 850.12, 'carry', 950.12, 0, 0, 100, 30, 30, ?)`).run(gid, sid2);
  db.prepare(`INSERT INTO pool_periods (player_id, game_id, opened_at, closed_at, pool_open, pool_open_source, pool_close, ext_in, ext_out, result, action_pct, action_amount)
              VALUES (1, ?, '2026-09-20 18:00:00', '2026-09-27 18:00:00', 950.12, 'carry', 950.12, 0, 0, 0, 30, 0)`).run(gid);
  check("ceinture : payé le 22 alors que la période close le 27 est figée → JETTE", throws(() => writePoolSettlementMovementOnPaid(db, sid2, "2026-09-22"), /déjà figée close le 2026-09-27/));
  check("payé le 28 (après la dernière période figée) → mouvement 'out' 30 (il me règle : le pool rétrécit)", (() => {
    writePoolSettlementMovementOnPaid(db, sid2, "2026-09-28");
    const m = listMovementsOn(db, 1).find(x => x.settlement_id === sid2)!;
    return m.direction === "out" && m.amount === 30 && m.occurred_at === "2026-09-28 00:00:00";
  })());
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n■ 5. Main ambiguë sur le grand livre → blocker, jamais figée par défaut");
{
  const { db: d2 } = freshDb();
  enrollPoolPlayerOn(d2, 1, "600200100");
  addAccountOn(d2, { player_id: 1 });
  // Transit : +100 puis −100 la même seconde, ordre indéterminable sans ligne suivante.
  ingestOkpayMessageOn(d2, mainMessage([
    { dir: "➖", from: "C1", id: "777001", amount: "100", bal: "0", date: "2026-09-13 17:00:00" },
    { dir: "➕", from: "X", id: "555000111", amount: "100", bal: "100", date: "2026-09-13 17:00:00" },
  ]), "telegram_forward");
  const pre = previewPoolPeriodOn(d2, { player_id: 1, closed_at: "2026-09-13 18:00:00", pool_open_manual: 0,
    balances: [{ account_id: 1, wallet_kind: "ak", balance: 0, observed_at: "2026-09-13 18:00:00" }, { account_id: 1, wallet_kind: "okpay", balance: 0, observed_at: "2026-09-13 18:00:00" }], now: NOW });
  check("main indéterminable → blocker nommant les deux soldes possibles", pre.ok && pre.preview.blockers.some(b => /indéterminable/.test(b) && /0.000000 \/ 100.000000/.test(b)), JSON.stringify(pre.ok && pre.preview.blockers));
  const noLedger = (() => { const { db: d3 } = freshDb(); enrollPoolPlayerOn(d3, 1, "600200100"); return previewPoolPeriodOn(d3, { player_id: 1, closed_at: "2026-09-13 18:00:00", pool_open_manual: 0, balances: [], now: NOW }); })();
  check("aucune ligne de la main → blocker « solde inconnu » (jamais 0)", noLedger.ok && noLedger.preview.blockers.some(b => /inconnu/.test(b)));
  const noMain = (() => { const { db: d4 } = freshDb(); enrollPoolPlayerOn(d4, 1); return previewPoolPeriodOn(d4, { player_id: 1, closed_at: "2026-09-13 18:00:00", pool_open_manual: 0, balances: [], now: NOW }); })();
  check("pas de main rattachée ni saisie → blocker", noMain.ok && noMain.preview.blockers.some(b => /aucune wallet main/.test(b)));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n■ 6. Audit phase 2 — (A) paiement le jour de la clôture N+1, (B) unicité des wallets, survivants");
{
  const NOW6 = "2026-09-28 12:00:00"; // les clôtures de cette section vont jusqu'au 27
  const { db: d } = freshDb();
  enrollPoolPlayerOn(d, 1, "600200100");
  addAccountOn(d, { player_id: 1, okpay_tg_id: "777001" });
  const T1 = "2026-09-13 18:00:00", T2 = "2026-09-20 18:00:00", T3 = "2026-09-27 18:00:00";
  const bal = (main: number, obs: string) => [
    { account_id: 1, wallet_kind: "ak" as const, balance: 450, observed_at: obs },
    { account_id: 1, wallet_kind: "okpay" as const, balance: 0, observed_at: obs },
    { account_id: null, wallet_kind: "main" as const, balance: main, observed_at: obs },
  ];
  // P1 : 1000 → 850 (main 400), part −45.
  const l1 = lockPoolPeriodOn(d, { player_id: 1, closed_at: T1, balances: bal(400, "2026-09-13 17:59:00"), pool_open_manual: 1000, now: NOW6 });
  check("(A) P1 figée, part −45", l1.ok && l1.computed.action_amount === -45, errOf(l1));
  const sid = (l1 as any).settlement_id as number;

  // Réel : photo N+1 le 20 à 17:59 (main 400, il n'a pas joué) ; Baki vire 45 à 19:00 ; le soir, il marque payé (paid_date 20) puis clôture.
  d.transaction(() => {
    d.prepare(`UPDATE manual_settlements SET status='paid', paid_at=datetime('now'), paid_date='2026-09-20' WHERE id = ?`).run(sid);
    writePoolSettlementMovementOnPaid(d, sid, "2026-09-20");
  })();
  const mvA = listMovementsOn(d, 1)[0];
  eq("(A) mouvement daté au jour : 2026-09-20 00:00:00, précision 'day'", [mvA.occurred_at, mvA.occurred_precision], ["2026-09-20 00:00:00", "day"]);
  const preBlocked = previewPoolPeriodOn(d, { player_id: 1, closed_at: T2, balances: bal(400, "2026-09-20 17:59:00"), now: NOW6 });
  check("(A) clôture N+1 le même jour → BLOCKER nommant le règlement et la marche à suivre", preBlocked.ok && preBlocked.preview.blockers.some(b => /heure inconnue/.test(b) && /page OkPay de la main/.test(b)), JSON.stringify(preBlocked.ok && preBlocked.preview.blockers));
  // CONTREFACTUEL : sans le blocker, le mouvement (dans ]13 18:00, 20 18:00]) aurait été compté contre une photo qui ne le contient pas.
  const phantom = computePoolPeriod({ pool_open: 850, pool_close: 850, ext_in: 45, ext_out: 0, action_pct: 30 });
  approx("(A) contrefactuel : sans blocker, résultat −45 → part fantôme −13.50", phantom.ok ? phantom.value.action_amount : NaN, -13.5);

  // La page de la main arrive : la ligne agence porte la seconde (19:00:00).
  const page = mainMessage([
    { dir: "➕", from: "HugoRoine", id: POOL_AGENCY_OKPAY_TG_ID, amount: "45", bal: "445", date: "2026-09-20 19:00:00" },
    { dir: "➖", from: "C1", id: "777001", amount: "600", bal: "400", date: "2026-09-12 10:00:00" },
    { dir: "➕", from: "X", id: "555000111", amount: "1000", bal: "1000", date: "2026-09-10 09:00:00" },
  ]);
  const ing = ingestOkpayMessageOn(d, page, "telegram_forward");
  check("(A) ingestion de la main → 1 règlement résolu", ing.ok && ing.resolved_settlements === 1, JSON.stringify(ing));
  eq("(A) mouvement re-daté à la seconde réelle 19:00:00, précision 'second'", [listMovementsOn(d, 1)[0].occurred_at, listMovementsOn(d, 1)[0].occurred_precision], ["2026-09-20 19:00:00", "second"]);
  const pre2 = previewPoolPeriodOn(d, { player_id: 1, closed_at: T2, balances: bal(400, "2026-09-20 17:59:00"), now: NOW6 });
  check("(A) N+1 débloquée : le versement (19:00) est HORS de ]13 18:00, 20 18:00] → ext_in 0, résultat 0", pre2.ok && pre2.preview.blockers.length === 0 && pre2.preview.ext_in === 0 && pre2.preview.computed!.result === 0, JSON.stringify(pre2.ok && [pre2.preview.blockers, pre2.preview.ext_in]));
  const l2 = lockPoolPeriodOn(d, { player_id: 1, closed_at: T2, balances: bal(400, "2026-09-20 17:59:00"), now: NOW6 });
  check("(A) P2 figée", l2.ok, errOf(l2));
  const pre3 = previewPoolPeriodOn(d, { player_id: 1, closed_at: T3, balances: bal(445, "2026-09-27 17:59:00"), now: NOW6 });
  check("(A) N+2 : le versement compte ici (ext_in 45), main 445 → résultat 0. Compté UNE fois, au bon endroit", pre3.ok && pre3.preview.ext_in === 45 && pre3.preview.computed!.result === 0, JSON.stringify(pre3.ok && [pre3.preview.blockers, pre3.preview.ext_in, pre3.preview.computed]));

  // Résolution : deux lignes agence candidates le même jour → on ne tranche pas.
  {
    const { db: d2 } = freshDb();
    enrollPoolPlayerOn(d2, 1, "600200100"); addAccountOn(d2, { player_id: 1 });
    const l = lockPoolPeriodOn(d2, { player_id: 1, closed_at: T1, balances: bal(400, "2026-09-13 17:59:00"), pool_open_manual: 1000, now: NOW6 });
    const s2 = (l as any).settlement_id as number;
    d2.prepare(`UPDATE manual_settlements SET status='paid', paid_date='2026-09-20' WHERE id = ?`).run(s2);
    writePoolSettlementMovementOnPaid(d2, s2, "2026-09-20");
    ingestOkpayMessageOn(d2, mainMessage([
      { dir: "➕", from: "HugoRoine", id: POOL_AGENCY_OKPAY_TG_ID, amount: "45", bal: "490", date: "2026-09-20 21:00:00" },
      { dir: "➕", from: "HugoRoine", id: POOL_AGENCY_OKPAY_TG_ID, amount: "45", bal: "445", date: "2026-09-20 19:00:00" },
    ]), "telegram_forward");
    eq("(A) deux lignes agence candidates → non résolu, reste 'day'", listMovementsOn(d2, 1)[0].occurred_precision, "day");
    // Ligne agence AVANT la clôture réglée → jamais retenue (payé avant la photo n'entre pas par cette porte).
    const { db: d3 } = freshDb();
    enrollPoolPlayerOn(d3, 1, "600200100"); addAccountOn(d3, { player_id: 1 });
    const l3 = lockPoolPeriodOn(d3, { player_id: 1, closed_at: T1, balances: bal(400, "2026-09-13 17:59:00"), pool_open_manual: 1000, now: NOW6 });
    const s3 = (l3 as any).settlement_id as number;
    d3.prepare(`UPDATE manual_settlements SET status='paid', paid_date='2026-09-13' WHERE id = ?`).run(s3);
    writePoolSettlementMovementOnPaid(d3, s3, "2026-09-13");
    ingestOkpayMessageOn(d3, mainMessage([{ dir: "➕", from: "HugoRoine", id: POOL_AGENCY_OKPAY_TG_ID, amount: "45", bal: "445", date: "2026-09-13 12:00:00" }]), "telegram_forward");
    eq("(A) ligne agence antérieure à la clôture → ignorée, reste 'day' à 18:00:01", [listMovementsOn(d3, 1)[0].occurred_at, listMovementsOn(d3, 1)[0].occurred_precision], ["2026-09-13 18:00:01", "day"]);
    eq("(A) resolveSettlementInstantsOn sans main rattachée → 0", (() => { const { db: d4 } = freshDb(); enrollPoolPlayerOn(d4, 1); return resolveSettlementInstantsOn(d4, 1); })(), 0);
  }

  // (B) Unicité des wallets.
  const dupMain = enrollPoolPlayerOn(d, 2, "600200100");
  check("(B) joueur B déclare la main de A → refus nommé", !dupMain.ok && /main de Joueur A/.test(errOf(dupMain)), errOf(dupMain));
  check("(B) compte de A avec l'ID de sa propre main → refus", !addAccountOn(d, { player_id: 1, okpay_tg_id: "600200100" }).ok);
  enrollPoolPlayerOn(d, 2, "600200200");
  const dupAcc = addAccountOn(d, { player_id: 2, okpay_tg_id: "777001" });
  check("(B) compte de B avec l'OkPay du Compte 1 de A → refus nommé", !dupAcc.ok && /Compte 1 de Joueur A/.test(errOf(dupAcc)), errOf(dupAcc));
  check("(B) wallet de l'agence comme compte → refus", !addAccountOn(d, { player_id: 2, okpay_tg_id: POOL_AGENCY_OKPAY_TG_ID }).ok);
  check("(B) main = agence → refus", !enrollPoolPlayerOn(d, 2, POOL_AGENCY_OKPAY_TG_ID).ok);
  check("(B) réinscrire A avec SA main → ok (pas de conflit avec soi-même)", enrollPoolPlayerOn(d, 1, "600200100").ok);
  // Le schéma seul : INSERT direct d'une seconde main identique → UNIQUE.
  check("(B) schéma : deux mains identiques → refus UNIQUE (index partiel)", throws(() => d.prepare(`UPDATE pool_players SET main_okpay_tg_id = '600200100' WHERE player_id = 2`).run(), /UNIQUE/));
  // Un compte CLOS libère sa wallet.
  const accB = addAccountOn(d, { player_id: 2, okpay_tg_id: "777009" });
  closeAccountOn(d, (accB as any).id);
  check("(B) wallet d'un compte clos réutilisable", addAccountOn(d, { player_id: 2, okpay_tg_id: "777009" }).ok);

  // Survivants du mutant-test de l'audit.
  const accB2 = addAccountOn(d, { player_id: 2 });
  const cross = previewPoolPeriodOn(d, { player_id: 1, closed_at: T3, balances: [...bal(445, "2026-09-27 17:59:00"), { account_id: (accB2 as any).id, wallet_kind: "ak", balance: 1, observed_at: "2026-09-27 17:59:00" }], now: NOW6 });
  check("(M10) solde d'un compte RÉEL d'un autre joueur → blocker", cross.ok && cross.preview.blockers.some(b => /d'un autre joueur/.test(b)));
  const dup = previewPoolPeriodOn(d, { player_id: 1, closed_at: T3, balances: [...bal(445, "2026-09-27 17:59:00"), { account_id: 1, wallet_kind: "ak", balance: 450, observed_at: "2026-09-27 17:59:00" }], now: NOW6 });
  check("(M7) solde en double → blocker (pas compté deux fois en silence)", dup.ok && dup.preview.blockers.some(b => /Solde en double/.test(b)));
  const mainAcc = previewPoolPeriodOn(d, { player_id: 1, closed_at: T3, balances: bal(445, "2026-09-27 17:59:00").map(b => b.wallet_kind === "main" ? { ...b, account_id: 1 } : b), now: NOW6 });
  check("(M8) main avec account_id → blocker", mainAcc.ok && mainAcc.preview.blockers.some(b => /n'appartient à aucun compte/.test(b)));
  const ignored = previewPoolPeriodOn(d, { player_id: 1, closed_at: T3, balances: bal(445, "2026-09-27 17:59:00"), pool_open_manual: 5, now: NOW6 });
  eq("(M9) pool_open_manual fourni sous carry → IGNORÉ, pool_open = 850 repris", ignored.ok && [ignored.preview.pool_open, ignored.preview.pool_open_source], [850, "carry"]);
  const badCal = previewPoolPeriodOn(d, { player_id: 1, closed_at: "2026-02-30 18:00:00", balances: bal(445, "2026-02-30 17:59:00"), now: NOW6 });
  check("(M4) closed_at hors calendrier → refus", !badCal.ok);
  // (M18) bornes ]opened_at, closed_at] : pile sur closed_at compté, pile sur opened_at non.
  addDeclaredMovementOn(d, { player_id: 1, direction: "out", amount: 10, occurred_at: T3 });                 // = closed_at → compté
  const atOpen = addDeclaredMovementOn(d, { player_id: 1, direction: "out", amount: 20, occurred_at: T2 }); // = opened_at (= dernier closed_at) → refusé à la saisie
  check("(M18) mouvement daté exactement au dernier closed_at → refusé (figé)", !atOpen.ok);
  const bounds = previewPoolPeriodOn(d, { player_id: 1, closed_at: T3, balances: bal(435, "2026-09-27 17:59:00"), now: NOW6 });
  check("(M18) mouvement daté exactement closed_at → compté (ext_out 10), résultat 0", bounds.ok && bounds.preview.ext_out === 10 && bounds.preview.computed!.result === 0, JSON.stringify(bounds.ok && [bounds.preview.ext_out, bounds.preview.computed]));
  // Double déclaration du versement → warning.
  const dbl = addDeclaredMovementOn(d, { player_id: 1, direction: "in", amount: 45, occurred_at: "2026-09-21 09:00:00" });
  const dblPre = previewPoolPeriodOn(d, { player_id: 1, closed_at: T3, balances: bal(435, "2026-09-27 17:59:00"), now: NOW6 });
  check("(S14) versement déclaré à la main en plus du règlement → warning doublon", dblPre.ok && dblPre.preview.warnings.some(w => w.code === "double_declared"));
  deleteDeclaredMovementOn(d, (dbl as any).id);
  // Main saisie ≠ grand livre → warning.
  const conflict = previewPoolPeriodOn(d, { player_id: 1, closed_at: T3, balances: bal(9999, "2026-09-27 17:59:00"), now: NOW6 });
  check("(S6) main saisie 9999 mais grand livre 445 → warning main_conflict, la saisie l'emporte", conflict.ok && conflict.preview.warnings.some(w => w.code === "main_conflict") && conflict.preview.pool_close === 9999 + 450);
  // (M23) compte clos dans la période → réouvert par l'unlock.
  {
    const { db: d5 } = freshDb();
    enrollPoolPlayerOn(d5, 1, "600200100"); addAccountOn(d5, { player_id: 1 }); addAccountOn(d5, { player_id: 1 });
    const bal5 = (c2: number) => [
      { account_id: 1, wallet_kind: "ak" as const, balance: 450, observed_at: T1 }, { account_id: 1, wallet_kind: "okpay" as const, balance: 0, observed_at: T1 },
      { account_id: 2, wallet_kind: "ak" as const, balance: c2, observed_at: T1 }, { account_id: 2, wallet_kind: "okpay" as const, balance: 0, observed_at: T1 },
      { account_id: null, wallet_kind: "main" as const, balance: 400, observed_at: T1 },
    ];
    const lk = lockPoolPeriodOn(d5, { player_id: 1, closed_at: T1, balances: bal5(0), pool_open_manual: 850, now: NOW6 });
    check("(M23) P1 figée, Compte 2 à 0", lk.ok, errOf(lk));
    const cl = closeAccountOn(d5, 2);
    eq("(M23) Compte 2 clos, rattaché à P1", cl.ok && (cl as any).closed_in_period_id, (lk as any).period_id);
    unlockPoolPeriodOn(d5, 1, (lk as any).period_id);
    eq("(M23) unlock P1 → Compte 2 RÉOUVERT", listAccountsOn(d5, 1).map(a => a.id), [1, 2]);
    // Mouvement déclaré avant toute clôture → refus (sinon jamais compté, puis insupprimable).
    check("(S10) mouvement déclaré sans aucune période → refus", !addDeclaredMovementOn(d5, { player_id: 1, direction: "in", amount: 5, occurred_at: "2026-09-01 10:00:00" }).ok);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n■ 7. Contre-audit phase 2 — (A') jour UTC ≠ jour OkPay, filtres de résolution, (B1/B4)");
{
  const NOW7 = "2026-09-30 12:00:00";
  const T1 = "2026-09-13 18:00:00";
  const bal = (main: number, obs: string) => [
    { account_id: 1, wallet_kind: "ak" as const, balance: 450, observed_at: obs },
    { account_id: 1, wallet_kind: "okpay" as const, balance: 0, observed_at: obs },
    { account_id: null, wallet_kind: "main" as const, balance: main, observed_at: obs },
  ];
  /** Base avec P1 figée (1000 → 850, part −45) et son règlement marqué payé à `paidDate`. */
  const setup = (paidDate: string) => {
    const { db: d } = freshDb();
    enrollPoolPlayerOn(d, 1, "600200100"); addAccountOn(d, { player_id: 1, okpay_tg_id: "777001" });
    const l = lockPoolPeriodOn(d, { player_id: 1, closed_at: T1, balances: bal(400, "2026-09-13 17:59:00"), pool_open_manual: 1000, now: NOW7 });
    const sid = (l as any).settlement_id as number;
    d.transaction(() => {
      d.prepare(`UPDATE manual_settlements SET status='paid', paid_at=datetime('now'), paid_date=? WHERE id = ?`).run(paidDate, sid);
      writePoolSettlementMovementOnPaid(d, sid, paidDate);
    })();
    return { d, sid };
  };
  const agencyLine = (amount: string, bal: string, date: string, dir: "➕" | "➖" = "➕", id = POOL_AGENCY_OKPAY_TG_ID) =>
    ({ dir, from: "HugoRoine", id, amount, bal, date });

  // A4bis — paid_date 20 (UTC), ligne OkPay le 21 11:00, photo N+1 le 21 à 10:00 (les 45 n'y sont PAS).
  {
    const { d } = setup("2026-09-20");
    const pre = previewPoolPeriodOn(d, { player_id: 1, closed_at: "2026-09-21 10:00:00", balances: bal(400, "2026-09-21 09:59:00"), now: NOW7 });
    check("(A') paid_date 20, clôture le 21 → BLOQUÉE (±1 jour), plus de part fantôme silencieuse", pre.ok && pre.preview.blockers.some(b => /jour ± 1/.test(b)), JSON.stringify(pre.ok && pre.preview.blockers));
    approx("(A') contrefactuel : sans le blocker, le mouvement 20 00:00:00 tombait dans ]13 18:00, 21 10:00] contre une photo sans les 45 → −13.50",
           (computePoolPeriod({ pool_open: 850, pool_close: 850, ext_in: 45, ext_out: 0, action_pct: 30 }) as any).value.action_amount, -13.5);
    const ing = ingestOkpayMessageOn(d, mainMessage([agencyLine("45", "445", "2026-09-21 11:00:00")]), "telegram_forward");
    check("(A') page : ligne agence du 21 (jour+1) → résolue", ing.ok && ing.resolved_settlements === 1, JSON.stringify(ing));
    const after = previewPoolPeriodOn(d, { player_id: 1, closed_at: "2026-09-21 10:00:00", balances: bal(400, "2026-09-21 09:59:00"), now: NOW7 });
    check("(A') N+1 (21 10:00) débloquée : versement à 11:00 hors intervalle → ext_in 0, résultat 0", after.ok && after.preview.blockers.length === 0 && after.preview.ext_in === 0 && after.preview.computed!.result === 0, JSON.stringify(after.ok && [after.preview.blockers, after.preview.ext_in]));
  }
  // A5 — paid_date 21 (UTC), ligne OkPay le 20 23:30, photo N+1 le 20 à 23:45 (les 45 y SONT).
  {
    const { d } = setup("2026-09-21");
    const pre = previewPoolPeriodOn(d, { player_id: 1, closed_at: "2026-09-20 23:45:00", balances: bal(445, "2026-09-20 23:44:00"), now: NOW7 });
    check("(A') paid_date 21, clôture le 20 23:45 → BLOQUÉE (mouvement hors intervalle mais à ±1 jour)", pre.ok && pre.preview.blockers.some(b => /jour ± 1/.test(b)));
    approx("(A') contrefactuel : sans le blocker, 45 dans la photo et 0 en ext_in → +45 → +13.50",
           (computePoolPeriod({ pool_open: 850, pool_close: 895, ext_in: 0, ext_out: 0, action_pct: 30 }) as any).value.action_amount, 13.5);
    ingestOkpayMessageOn(d, mainMessage([agencyLine("45", "445", "2026-09-20 23:30:00")]), "telegram_forward");
    const mv = listMovementsOn(d, 1)[0];
    eq("(A') résolu sur la ligne du 20 (jour−1), précision second, ligne mémorisée", [mv.occurred_at, mv.occurred_precision, mv.okpay_line_id !== null], ["2026-09-20 23:30:00", "second", true]);
    const after = previewPoolPeriodOn(d, { player_id: 1, closed_at: "2026-09-20 23:45:00", balances: bal(445, "2026-09-20 23:44:00"), now: NOW7 });
    check("(A') N+1 (20 23:45) : versement 23:30 dans l'intervalle, main 445 → ext_in 45, résultat 0", after.ok && after.preview.blockers.length === 0 && after.preview.ext_in === 45 && after.preview.computed!.result === 0, JSON.stringify(after.ok && [after.preview.blockers, after.preview.ext_in, after.preview.computed]));
  }
  // À 2 jours ou plus : l'instant réel est du même côté de la clôture quel que soit le fuseau → pas de blocage.
  {
    const { d } = setup("2026-09-20");
    const pre = previewPoolPeriodOn(d, { player_id: 1, closed_at: "2026-09-22 10:00:00", balances: bal(445, "2026-09-22 09:59:00"), now: NOW7 });
    check("(A') paid_date 20 non résolu, clôture le 22 → pas de blocker, ext_in 45, main 445 → résultat 0", pre.ok && pre.preview.blockers.length === 0 && pre.preview.ext_in === 45 && pre.preview.computed!.result === 0, JSON.stringify(pre.ok && [pre.preview.blockers, pre.preview.ext_in, pre.preview.computed]));
    const pre19 = previewPoolPeriodOn(d, { player_id: 1, closed_at: "2026-09-19 10:00:00", balances: bal(400, "2026-09-19 09:59:00"), now: NOW7 });
    check("(A') clôture le 19 (jour−1) → bloquée aussi (le paiement OkPay a pu tomber le 19)", pre19.ok && pre19.preview.blockers.some(b => /jour ± 1/.test(b)));
  }
  // Les cinq filtres de la résolution (mutants M28–M31, M42 de l'audit) : chacun, seul, empêche la résolution.
  {
    const cases: [string, ReturnType<typeof agencyLine>][] = [
      ["(M29) ligne agence à jour+2 → hors fenêtre, non résolu", agencyLine("45", "445", "2026-09-22 11:00:00")],
      ["(M30) ligne de 45 d'une AUTRE contrepartie le bon jour → non résolu", agencyLine("45", "445", "2026-09-20 11:00:00", "➕", "555000111")],
      ["(M28) ligne agence de 45 dans l'autre sens (➖) → non résolu", agencyLine("45", "355", "2026-09-20 11:00:00", "➖")],
      ["(M31) ligne agence de 20 → montant différent, non résolu", agencyLine("20", "420", "2026-09-20 11:00:00")],
    ];
    for (const [label, line] of cases) {
      const { d } = setup("2026-09-20");
      const ing = ingestOkpayMessageOn(d, mainMessage([line]), "telegram_forward");
      check(label, ing.ok && ing.resolved_settlements === 0 && listMovementsOn(d, 1)[0].occurred_precision === "day", JSON.stringify(ing));
    }
    // M42 : un mouvement déjà 'second' n'est jamais re-daté ; une 2e candidate → warning, pas de déplacement.
    const { d } = setup("2026-09-20");
    ingestOkpayMessageOn(d, mainMessage([agencyLine("45", "445", "2026-09-20 19:00:00")]), "telegram_forward");
    eq("(M42) résolu à 19:00", listMovementsOn(d, 1)[0].occurred_at, "2026-09-20 19:00:00");
    const ing2 = ingestOkpayMessageOn(d, mainMessage([agencyLine("45", "490", "2026-09-20 22:00:00")]), "telegram_forward");
    check("(M42) 2e ligne identique ensuite → 0 résolu, l'instant ne bouge PAS", ing2.ok && ing2.resolved_settlements === 0 && listMovementsOn(d, 1)[0].occurred_at === "2026-09-20 19:00:00");
    const pre = previewPoolPeriodOn(d, { player_id: 1, closed_at: "2026-09-27 10:00:00", balances: bal(490, "2026-09-27 09:59:00"), now: NOW7 });
    check("(A1) → warning resolution_ambiguous nommant les deux lignes", pre.ok && pre.preview.warnings.some(w => w.code === "resolution_ambiguous" && /19:00:00/.test(w.message) && /22:00:00/.test(w.message)), JSON.stringify(pre.ok && pre.preview.warnings));
    // Payé AVANT la photo : ligne agence identique ≤ clôture réglée → warning fort.
    const { d: d2 } = setup("2026-09-13");
    ingestOkpayMessageOn(d2, mainMessage([agencyLine("45", "445", "2026-09-13 12:00:00")]), "telegram_forward");
    const pre2 = previewPoolPeriodOn(d2, { player_id: 1, closed_at: "2026-09-27 10:00:00", balances: bal(445, "2026-09-27 09:59:00"), now: NOW7 });
    check("(c) ligne agence AVANT la clôture réglée → reste 'day' ET warning paid_before_close", pre2.ok && listMovementsOn(d2, 1)[0].occurred_precision === "day" && pre2.preview.warnings.some(w => w.code === "paid_before_close"), JSON.stringify(pre2.ok && pre2.preview.warnings));
  }

  // B1 — compte clos à 0 dans P1, sa wallet reprise comme main de B, puis unlock de P1 → refus nommé.
  {
    const { db: d } = freshDb();
    enrollPoolPlayerOn(d, 1, "600200100"); addAccountOn(d, { player_id: 1 }); addAccountOn(d, { player_id: 1, okpay_tg_id: "777009" });
    const lk = lockPoolPeriodOn(d, { player_id: 1, closed_at: T1, pool_open_manual: 850, now: NOW7, balances: [
      { account_id: 1, wallet_kind: "ak", balance: 450, observed_at: T1 }, { account_id: 1, wallet_kind: "okpay", balance: 0, observed_at: T1 },
      { account_id: 2, wallet_kind: "ak", balance: 0, observed_at: T1 }, { account_id: 2, wallet_kind: "okpay", balance: 0, observed_at: T1 },
      { account_id: null, wallet_kind: "main", balance: 400, observed_at: T1 }] });
    check("(B1) P1 figée", lk.ok, errOf(lk));
    check("(B1) Compte 2 (0/0) clos", closeAccountOn(d, 2).ok);
    check("(B1) B prend 777009 comme main (le compte est clos : libre)", enrollPoolPlayerOn(d, 2, "777009").ok);
    const un = unlockPoolPeriodOn(d, 1, (lk as any).period_id);
    check("(B1) unlock P1 → REFUS nommé (réouvrir Compte 2 doublerait la main de B)", !un.ok && /main de Joueur B/.test(errOf(un)), errOf(un));
    eq("(B1) rien n'a bougé : P1 toujours là, Compte 2 toujours clos", [getPeriodsOn(d, 1).length, listAccountsOn(d, 1).map(a => a.id)], [1, [1]]);
  }
  // B4 — changer de main avec un solde main figé ≠ 0 → refus ; à 0 → ok.
  {
    const { db: d } = freshDb();
    enrollPoolPlayerOn(d, 1, "600200100"); addAccountOn(d, { player_id: 1 });
    lockPoolPeriodOn(d, { player_id: 1, closed_at: T1, balances: bal(400, "2026-09-13 17:59:00"), pool_open_manual: 850, now: NOW7 });
    const ch = enrollPoolPlayerOn(d, 1, "600200999");
    check("(B4) changer de main avec 400 figés sur l'ancienne → REFUS nommé", !ch.ok && /400.00/.test(errOf(ch)), errOf(ch));
    eq("(B4) la main n'a pas changé", getPoolPlayerOn(d, 1)!.main_okpay_tg_id, "600200100");
    // Il vide sa main vers Compte 1 (450 → 850), clôture à main 0, puis change.
    lockPoolPeriodOn(d, { player_id: 1, closed_at: "2026-09-20 18:00:00", balances: [
      { account_id: 1, wallet_kind: "ak", balance: 850, observed_at: "2026-09-20 17:59:00" }, { account_id: 1, wallet_kind: "okpay", balance: 0, observed_at: "2026-09-20 17:59:00" },
      { account_id: null, wallet_kind: "main", balance: 0, observed_at: "2026-09-20 17:59:00" }], now: NOW7 });
    check("(B4) main figée à 0 → changement accepté", enrollPoolPlayerOn(d, 1, "600200999").ok);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n■ 8. Réserves 3e passe — (R1) une ligne agence ne date qu'un règlement, (R4) veille tolérée");
{
  const NOW8 = "2026-09-30 12:00:00";
  const { db: d } = freshDb();
  enrollPoolPlayerOn(d, 1, "600200100"); addAccountOn(d, { player_id: 1, okpay_tg_id: "777001" });
  const bal = (main: number, obs: string) => [
    { account_id: 1, wallet_kind: "ak" as const, balance: 450, observed_at: obs },
    { account_id: 1, wallet_kind: "okpay" as const, balance: 0, observed_at: obs },
    { account_id: null, wallet_kind: "main" as const, balance: main, observed_at: obs },
  ];
  const agency = (amount: string, bal: string, date: string) => ({ dir: "➕" as const, from: "HugoRoine", id: POOL_AGENCY_OKPAY_TG_ID, amount, bal, date });
  // N : 1000 → 850 (perte 150, −45). Payé le 20 à 19:00 (ligne L1).
  const n1 = lockPoolPeriodOn(d, { player_id: 1, closed_at: "2026-09-13 18:00:00", balances: bal(400, "2026-09-13 17:59:00"), pool_open_manual: 1000, now: NOW8 });
  const s1 = (n1 as any).settlement_id as number;
  d.prepare(`UPDATE manual_settlements SET status='paid', paid_date='2026-09-20' WHERE id = ?`).run(s1);
  writePoolSettlementMovementOnPaid(d, s1, "2026-09-20");
  ingestOkpayMessageOn(d, mainMessage([agency("45", "445", "2026-09-20 19:00:00")]), "telegram_forward");
  eq("(R1) règlement N résolu sur L1 (19:00)", [listMovementsOn(d, 1)[0].occurred_at, listMovementsOn(d, 1)[0].occurred_precision], ["2026-09-20 19:00:00", "second"]);
  // N+1 : photo le 20 à 18:00 (avant le virement) : 850 → 700 (main 250), perte 150, −45 AUSSI. Payé le 21.
  const n2 = lockPoolPeriodOn(d, { player_id: 1, closed_at: "2026-09-20 18:00:00", balances: bal(250, "2026-09-20 17:59:00"), now: NOW8 });
  check("(R1) N+1 figée (le 'day' de N était résolu, pas de blocker)", n2.ok && n2.computed.action_amount === -45, errOf(n2));
  const s2 = (n2 as any).settlement_id as number;
  d.prepare(`UPDATE manual_settlements SET status='paid', paid_date='2026-09-21' WHERE id = ?`).run(s2);
  writePoolSettlementMovementOnPaid(d, s2, "2026-09-21");
  const m2 = listMovementsOn(d, 1).find(m => m.settlement_id === s2)!;
  eq("(R1) le 2e règlement (même montant, fenêtre [20, 22]) NE prend PAS L1 déjà portée : reste 'day' 21 00:00:00", [m2.occurred_at, m2.occurred_precision, m2.okpay_line_id], ["2026-09-21 00:00:00", "day", null]);
  const pre = previewPoolPeriodOn(d, { player_id: 1, closed_at: "2026-09-21 10:00:00", balances: bal(295, "2026-09-21 09:59:00"), now: NOW8 });
  check("(R1) clôture N+2 le 21 → bloquée tant que le 2e n'est pas résolu (et non ext_in 90 → −13.50)", pre.ok && pre.preview.blockers.some(b => /jour ± 1/.test(b)));
  ingestOkpayMessageOn(d, mainMessage([agency("45", "340", "2026-09-21 15:00:00")]), "telegram_forward");
  const m2b = listMovementsOn(d, 1).find(m => m.settlement_id === s2)!;
  eq("(R1) la vraie ligne du 21 arrive → résolu sur elle", [m2b.occurred_at, m2b.occurred_precision], ["2026-09-21 15:00:00", "second"]);
  eq("(R1) deux lignes distinctes portées, aucune partagée", new Set(listMovementsOn(d, 1).map(m => m.okpay_line_id)).size, 2);
  const pre2 = previewPoolPeriodOn(d, { player_id: 1, closed_at: "2026-09-21 10:00:00", balances: bal(295, "2026-09-21 09:59:00"), now: NOW8 });
  check("(R1) N+2 (21 10:00) : ext_in 45 (L1 seulement), main 295 = 250 + 45 → résultat 0", pre2.ok && pre2.preview.blockers.length === 0 && pre2.preview.ext_in === 45 && pre2.preview.computed!.result === 0, JSON.stringify(pre2.ok && [pre2.preview.blockers, pre2.preview.ext_in, pre2.preview.computed]));
  check("(R1) schéma : deux mouvements sur la même ligne → refus UNIQUE", throws(() => d.prepare(`UPDATE pool_external_movements SET okpay_line_id = ? WHERE settlement_id = ?`).run(listMovementsOn(d, 1)[0].okpay_line_id, s2), /UNIQUE/));

  // (R4) veille tolérée : paid_date = jour de clôture − 1 → clôture + 1 s, 'day' ; − 2 → refus.
  eq("(R4) paid_date = veille de la clôture → +1 s, précision jour", settlementOccurredAt("2026-09-12", "2026-09-13 00:30:00"), { ok: true, occurred_at: "2026-09-13 00:30:01", precision: "day" });
  check("(R4) paid_date = avant-veille → refus « avant la photo »", !settlementOccurredAt("2026-09-11", "2026-09-13 00:30:00").ok);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n■ 9. Retours Baki 2026-09-15 — heure déclarée d'un règlement, correction tracée du pool de départ");
{
  const NOW9 = "2026-09-20 12:00:00";
  const T1 = "2026-09-14 06:57:29";
  const bal = (c1: number, c2: number, main: number, obs: string) => [
    { account_id: 1, wallet_kind: "ak" as const, balance: c1, observed_at: obs }, { account_id: 1, wallet_kind: "okpay" as const, balance: 0, observed_at: obs },
    { account_id: 2, wallet_kind: "ak" as const, balance: c2, observed_at: obs }, { account_id: 2, wallet_kind: "okpay" as const, balance: 0, observed_at: obs },
    { account_id: null, wallet_kind: "main" as const, balance: main, observed_at: obs },
  ];
  // Le scénario de la capture : 1000 → 2700 (+1700, 50 % → il me doit 850), payé le 15, clôture voulue le 15.
  const { db: d } = freshDb();
  enrollPoolPlayerOn(d, 2, "7076908900"); addAccountOn(d, { player_id: 2 }); addAccountOn(d, { player_id: 2 });
  d.prepare(`UPDATE player_game_deals SET action_pct = 50 WHERE player_id = 2`).run();
  const l1 = lockPoolPeriodOn(d, { player_id: 2, closed_at: T1, balances: bal(1200, 500, 1000, "2026-09-14 06:57:00"), pool_open_manual: 1000, now: NOW9 });
  check("P1 figée : +1700, il me doit 850", l1.ok && l1.computed.action_amount === 850, errOf(l1));
  const sid = (l1 as any).settlement_id as number;
  d.prepare(`UPDATE manual_settlements SET status='paid', paid_date='2026-09-15' WHERE id = ?`).run(sid);
  writePoolSettlementMovementOnPaid(d, sid, "2026-09-15");
  const mv = listMovementsOn(d, 2)[0];
  eq("règlement 'out' 850 daté 15 00:00:00 (jour)", [mv.direction, mv.amount, mv.occurred_at, mv.occurred_precision], ["out", 850, "2026-09-15 00:00:00", "day"]);
  const blocked = previewPoolPeriodOn(d, { player_id: 2, closed_at: "2026-09-15 07:00:41", balances: bal(1000, 400, 450, "2026-09-15 07:00:00"), now: NOW9 });
  check("clôture le 15 → bloquée (±1 jour) — c'est ce que Baki a vu", blocked.ok && blocked.preview.blockers.some(b => /jour ± 1/.test(b)));
  eq("le règlement est déjà compté en sortie : ext_out 850, pool de départ 2700 inchangé", blocked.ok && [blocked.preview.ext_out, blocked.preview.pool_open], [850, 2700]);

  // Heure déclarée : refus hors fenêtre, avant la clôture réglée, sur un mouvement déjà 'second' ; ok sinon.
  check("heure hors fenêtre (17) → refus", !setSettlementInstantOn(d, mv.id, "2026-09-17 10:00:00").ok);
  check("heure ≤ clôture réglée (14 06:00) → refus « payé avant la photo »", !setSettlementInstantOn(d, mv.id, "2026-09-14 06:00:00").ok && /avant la photo/.test(errOf(setSettlementInstantOn(d, mv.id, "2026-09-14 06:00:00"))));
  check("heure hors calendrier → refus", !setSettlementInstantOn(d, mv.id, "2026-09-15 25:00:00").ok);
  const ok = setSettlementInstantOn(d, mv.id, "2026-09-15 06:30:00");
  check("heure déclarée 15 06:30 → ok", ok.ok, errOf(ok));
  eq("mouvement re-daté à la seconde, sans ligne OkPay (déclaré)", [listMovementsOn(d, 2)[0].occurred_at, listMovementsOn(d, 2)[0].occurred_precision, listMovementsOn(d, 2)[0].okpay_line_id], ["2026-09-15 06:30:00", "second", null]);
  check("re-déclarer → refus (déjà à la seconde)", !setSettlementInstantOn(d, mv.id, "2026-09-15 06:31:00").ok);
  const after = previewPoolPeriodOn(d, { player_id: 2, closed_at: "2026-09-15 07:00:41", balances: bal(1000, 400, 450, "2026-09-15 07:00:00"), now: NOW9 });
  check("clôture le 15 07:00 débloquée : 06:30 dans l'intervalle → ext_out 850, résultat = (1850 + 850) − 2700 = 0", after.ok && after.preview.blockers.length === 0 && after.preview.ext_out === 850 && after.preview.computed!.result === 0, JSON.stringify(after.ok && [after.preview.blockers, after.preview.computed]));
  // Si la page arrive ensuite avec une autre seconde → warning, la ligne fait foi.
  ingestOkpayMessageOn(d, ["Iacopo Transaction:7076908900", "", "Type: ➖", "Details: Transfer To : HugoRoine【ID " + POOL_AGENCY_OKPAY_TG_ID + "】", "Amount: 850", "Currency: USDT", "Changed balance: 450", "date: 2026-09-15 06:45:12"].join("\n"), "telegram_forward");
  const mismatch = previewPoolPeriodOn(d, { player_id: 2, closed_at: "2026-09-15 07:00:41", balances: bal(1000, 400, 450, "2026-09-15 07:00:00"), now: NOW9 });
  check("page OkPay avec la ligne agence à 06:45:12 ≠ 06:30 déclaré → warning declared_time_mismatch", mismatch.ok && mismatch.preview.warnings.some(w => w.code === "declared_time_mismatch" && /06:45:12/.test(w.message)), JSON.stringify(mismatch.ok && mismatch.preview.warnings));
  check("la ligne OkPay n'a PAS re-daté le mouvement déclaré (jamais un 'second')", listMovementsOn(d, 2)[0].occurred_at === "2026-09-15 06:30:00");
  // Un mouvement déclaré (pas un règlement) ne se re-date pas par ce chemin.
  const decl = addDeclaredMovementOn(d, { player_id: 2, direction: "out", amount: 10, occurred_at: "2026-09-16 10:00:00" });
  check("PATCH sur un mouvement déclaré → refus", !setSettlementInstantOn(d, (decl as any).id, "2026-09-16 11:00:00").ok);
  deleteDeclaredMovementOn(d, (decl as any).id);
  // Ceinture : heure dans une période figée postérieure → refus.
  {
    const { db: d2 } = freshDb();
    enrollPoolPlayerOn(d2, 1, "600200100"); addAccountOn(d2, { player_id: 1 });
    const b2 = (m: number, obs: string) => [{ account_id: 1, wallet_kind: "ak" as const, balance: 450, observed_at: obs }, { account_id: 1, wallet_kind: "okpay" as const, balance: 0, observed_at: obs }, { account_id: null, wallet_kind: "main" as const, balance: m, observed_at: obs }];
    const a = lockPoolPeriodOn(d2, { player_id: 1, closed_at: "2026-09-13 18:00:00", balances: b2(400, "2026-09-13 17:59:00"), pool_open_manual: 1000, now: NOW9 });
    const s2 = (a as any).settlement_id as number;
    d2.prepare(`UPDATE manual_settlements SET status='paid', paid_date='2026-09-13' WHERE id = ?`).run(s2);
    writePoolSettlementMovementOnPaid(d2, s2, "2026-09-13");
    lockPoolPeriodOn(d2, { player_id: 1, closed_at: "2026-09-16 18:00:00", balances: b2(445, "2026-09-16 17:59:00"), now: NOW9 });
    const m2 = listMovementsOn(d2, 1)[0];
    check("ceinture : heure déclarée dans la période figée close le 16 → refus", !setSettlementInstantOn(d2, m2.id, "2026-09-14 10:00:00").ok && /figée/.test(errOf(setSettlementInstantOn(d2, m2.id, "2026-09-14 10:00:00"))));
  }

  // Correction tracée du pool de départ.
  check("sans période → refus (la première se saisit)", !addPoolOpenCorrectionOn(freshDb().db, { player_id: 1, new_pool_open: 500, note: "x" }).ok);
  check("sans motif → refus", !addPoolOpenCorrectionOn(d, { player_id: 2, new_pool_open: 2600, note: "" }).ok);
  check("même valeur → refus", !addPoolOpenCorrectionOn(d, { player_id: 2, new_pool_open: 2700, note: "rien" }).ok);
  check("3 décimales → refus", !addPoolOpenCorrectionOn(d, { player_id: 2, new_pool_open: 2600.001, note: "typo" }).ok);
  const c = addPoolOpenCorrectionOn(d, { player_id: 2, new_pool_open: 2600, note: "100 comptés en trop sur Compte 2 le 14" });
  check("2700 → 2600 : mouvement 'out' 100 daté clôture + 1 s, motif conservé", c.ok && c.delta === -100, errOf(c));
  const cm = listMovementsOn(d, 2).find(m => m.id === (c as any).id)!;
  eq("le mouvement de correction", [cm.direction, cm.amount, cm.occurred_at, cm.kind], ["out", 100, "2026-09-14 06:57:30", "declared"]);
  check("motif tracé", /Correction du pool de départ : 2700.00 → 2600.00 — 100 comptés/.test(cm.note ?? ""));
  const pv = previewPoolPeriodOn(d, { player_id: 2, closed_at: "2026-09-15 07:00:41", balances: bal(1000, 400, 350, "2026-09-15 07:00:00"), now: NOW9 });
  check("effet : partir de 2600 ≡ pool fin 1750 + sorties 950 − 2700 = 0 — le pool de départ AFFICHÉ reste 2700 (la clôture figée ne ment pas)", pv.ok && pv.preview.pool_open === 2700 && pv.preview.ext_out === 950 && pv.preview.computed!.result === 0, JSON.stringify(pv.ok && [pv.preview.pool_open, pv.preview.ext_out, pv.preview.computed]));
  // F1 — corrections successives : le delta se calcule contre le départ EFFECTIF.
  const c2 = addPoolOpenCorrectionOn(d, { player_id: 2, new_pool_open: 2650, note: "je remonte de 50" });
  check("(F1) 2600 → 2650 : delta +50 → mouvement 'in' 50 (et non 'out' 50)", c2.ok && c2.delta === 50, errOf(c2));
  approx("(F1) départ effectif = 2700 − 100 + 50 = 2650", poolOpenEffectiveOn(d, 2, getPeriodsOn(d, 2)[0]), 2650);
  const pv2 = previewPoolPeriodOn(d, { player_id: 2, closed_at: "2026-09-15 07:00:41", balances: bal(1000, 400, 400, "2026-09-15 07:00:00"), now: NOW9 });
  check("(F1) pool fin 1800 + out 950 − (2700 + in 50) = 0", pv2.ok && pv2.preview.computed!.result === 0, JSON.stringify(pv2.ok && pv2.preview.computed));
  const same = addPoolOpenCorrectionOn(d, { player_id: 2, new_pool_open: 2650, note: "double clic" });
  check("(F1) même valeur effective → refus nommant reprise + corrections", !same.ok && /effectif est déjà 2650.00/.test(errOf(same)), errOf(same));
  // F2 — unlock refusé tant qu'une correction est posée sur la clôture.
  const un = unlockPoolPeriodOn(d, 2, getPeriodsOn(d, 2)[0].id);
  check("(F2) unlock d'une période PAYÉE → refus (règle antérieure, prioritaire)", !un.ok && /payé/.test(errOf(un)), errOf(un));
  check("la correction se retire comme tout mouvement déclaré", deleteDeclaredMovementOn(d, cm.id).ok && deleteDeclaredMovementOn(d, (c2 as any).id).ok);
  // N3 — les corrections d'une clôture PASSÉE n'entrent pas dans l'effectif de la suivante.
  {
    const c3 = addPoolOpenCorrectionOn(d, { player_id: 2, new_pool_open: 2600, note: "corr P1" });
    check("(N3) correction P1 posée (−100)", c3.ok && c3.delta === -100, errOf(c3));
    setSettlementInstantOn(d, listMovementsOn(d, 2).find(m => m.kind === "settlement")!.id, "2026-09-15 06:30:00", NOW9); // déjà 'second' → refus silencieux, sans effet
    const l2 = lockPoolPeriodOn(d, { player_id: 2, closed_at: "2026-09-16 12:00:00", balances: bal(1000, 400, 350, "2026-09-16 11:59:00"), now: NOW9 });
    check("(N3) P2 figée : fin 1750 + sorties 950 − 2700 = 0", l2.ok && l2.computed.result === 0, errOf(l2));
    const lastP = getPeriodsOn(d, 2)[1];
    approx("(N3) effectif P3 = pool_close P2 = 1750, la correction de P1 n'y entre PAS", poolOpenEffectiveOn(d, 2, lastP), 1750);
    const c4 = addPoolOpenCorrectionOn(d, { player_id: 2, new_pool_open: 1700, note: "corr P3" });
    check("(N3) correction P3 : delta −50 (contre 1750, pas 1650)", c4.ok && c4.delta === -50 && listMovementsOn(d, 2).find(m => m.id === (c4 as any).id)!.occurred_at === "2026-09-16 12:00:01", errOf(c4));
    deleteDeclaredMovementOn(d, (c4 as any).id);
    unlockPoolPeriodOn(d, 2, lastP.id);
    deleteDeclaredMovementOn(d, (c3 as any).id);
  }
  // F2 bis — première période avec des mouvements antérieurs → blocker.
  {
    const { db: d3 } = freshDb();
    enrollPoolPlayerOn(d3, 1, "600200100"); addAccountOn(d3, { player_id: 1 });
    const b3 = (m: number, obs: string) => [{ account_id: 1, wallet_kind: "ak" as const, balance: 450, observed_at: obs }, { account_id: 1, wallet_kind: "okpay" as const, balance: 0, observed_at: obs }, { account_id: null, wallet_kind: "main" as const, balance: m, observed_at: obs }];
    const a = lockPoolPeriodOn(d3, { player_id: 1, closed_at: "2026-09-13 18:00:00", balances: b3(400, "2026-09-13 17:59:00"), pool_open_manual: 1000, now: NOW9 });
    const corr3 = addPoolOpenCorrectionOn(d3, { player_id: 1, new_pool_open: 900, note: "test" });
    const un3 = unlockPoolPeriodOn(d3, 1, (a as any).period_id);
    check("(F2) unlock (non payé) avec une correction posée → refus nommé", !un3.ok && /correction du pool de départ/.test(errOf(un3)), errOf(un3));
    deleteDeclaredMovementOn(d3, (corr3 as any).id);
    addDeclaredMovementOn(d3, { player_id: 1, direction: "out", amount: 50, occurred_at: "2026-09-13 20:00:00" });
    check("(F2) unlock sans correction → ok", unlockPoolPeriodOn(d3, 1, (a as any).period_id).ok);
    const relock = previewPoolPeriodOn(d3, { player_id: 1, closed_at: "2026-09-13 21:00:00", balances: b3(400, "2026-09-13 20:59:00"), pool_open_manual: 1000, now: NOW9 });
    check("(F2) re-lock plus tard avec un mouvement déclaré antérieur → blocker « ne compterait nulle part »", relock.ok && relock.preview.blockers.some(b => /nulle part/.test(b)), JSON.stringify(relock.ok && relock.preview.blockers));
    const relockOk = previewPoolPeriodOn(d3, { player_id: 1, closed_at: "2026-09-13 19:00:00", balances: b3(400, "2026-09-13 18:59:00"), pool_open_manual: 1000, now: NOW9 });
    check("(F2) re-lock AVANT le mouvement → pas de blocker", relockOk.ok && !relockOk.preview.blockers.some(b => /nulle part/.test(b)));
  }
  // R1/R3/R6 — heure future, période réglée absente, bornes exactes.
  {
    const { db: d4 } = freshDb();
    enrollPoolPlayerOn(d4, 1, "600200100"); addAccountOn(d4, { player_id: 1 });
    const b4 = (m: number, obs: string) => [{ account_id: 1, wallet_kind: "ak" as const, balance: 450, observed_at: obs }, { account_id: 1, wallet_kind: "okpay" as const, balance: 0, observed_at: obs }, { account_id: null, wallet_kind: "main" as const, balance: m, observed_at: obs }];
    const a = lockPoolPeriodOn(d4, { player_id: 1, closed_at: "2026-09-13 18:00:00", balances: b4(400, "2026-09-13 17:59:00"), pool_open_manual: 1000, now: NOW9 });
    const s4 = (a as any).settlement_id as number;
    d4.prepare(`UPDATE manual_settlements SET status='paid', paid_date='2026-09-13' WHERE id = ?`).run(s4);
    writePoolSettlementMovementOnPaid(d4, s4, "2026-09-13");
    const m4 = listMovementsOn(d4, 1)[0];
    check("(R1) heure dans le futur → refus", !setSettlementInstantOn(d4, m4.id, "2026-09-14 10:00:00", "2026-09-14 09:00:00").ok);
    check("(R6) heure == clôture réglée → refus (borne stricte)", !setSettlementInstantOn(d4, m4.id, "2026-09-13 18:00:00", NOW9).ok);
    lockPoolPeriodOn(d4, { player_id: 1, closed_at: "2026-09-16 18:00:00", balances: b4(445, "2026-09-16 17:59:00"), now: NOW9 });
    check("(R6) heure dans une période figée postérieure (14 18:00 ∈ ]13 18:00, 16 18:00]) → refus", !setSettlementInstantOn(d4, m4.id, "2026-09-14 18:00:00", NOW9).ok);
    // Borne exacte == closed_at d'une autre période figée : INATTEIGNABLE (le blocker ±1 jour empêche de figer une période dans la fenêtre d'un 'day'). Non testée, documentée.
    d4.pragma("foreign_keys = OFF");
    d4.prepare(`UPDATE pool_periods SET settlement_id = NULL WHERE settlement_id = ?`).run(s4);
    check("(R3) période réglée introuvable → refus (pas de garde sautée)", !setSettlementInstantOn(d4, m4.id, "2026-09-13 19:00:00", NOW9).ok && /incohérent/.test(errOf(setSettlementInstantOn(d4, m4.id, "2026-09-13 19:00:00", NOW9))));
  }
  // M19/M20 — le warning declared_time_mismatch : exact = pas de warning ; mouvement résolu = pas ce warning ; ligne revendiquée par un autre → warning quand même (R2).
  {
    const { db: d5 } = freshDb();
    enrollPoolPlayerOn(d5, 1, "600200100"); addAccountOn(d5, { player_id: 1 });
    const b5 = (m: number, obs: string) => [{ account_id: 1, wallet_kind: "ak" as const, balance: 450, observed_at: obs }, { account_id: 1, wallet_kind: "okpay" as const, balance: 0, observed_at: obs }, { account_id: null, wallet_kind: "main" as const, balance: m, observed_at: obs }];
    const a = lockPoolPeriodOn(d5, { player_id: 1, closed_at: "2026-09-13 18:00:00", balances: b5(400, "2026-09-13 17:59:00"), pool_open_manual: 1000, now: NOW9 });
    const s5 = (a as any).settlement_id as number;
    d5.prepare(`UPDATE manual_settlements SET status='paid', paid_date='2026-09-13' WHERE id = ?`).run(s5);
    writePoolSettlementMovementOnPaid(d5, s5, "2026-09-13");
    setSettlementInstantOn(d5, listMovementsOn(d5, 1)[0].id, "2026-09-13 19:00:00", NOW9);
    const line = (bal: string, date: string) => ["JoueurA Transaction:600200100", "", "Type: ➕", "Details: Transfer From : HugoRoine【ID " + POOL_AGENCY_OKPAY_TG_ID + "】", "Amount: 45", "Currency: USDT", `Changed balance: ${bal}`, `date: ${date}`].join("\n");
    ingestOkpayMessageOn(d5, line("445", "2026-09-13 19:00:00"), "telegram_forward");
    const p5 = previewPoolPeriodOn(d5, { player_id: 1, closed_at: "2026-09-20 18:00:00", balances: b5(445, "2026-09-20 17:59:00"), now: NOW9 });
    check("(M19) heure déclarée = ligne OkPay exacte → pas de warning", p5.ok && !p5.preview.warnings.some(w => w.code === "declared_time_mismatch"), JSON.stringify(p5.ok && p5.preview.warnings));
    // (R2) deux règlements égaux : la ligne du 1er (déclaré 19:00 mais vraie ligne 20:30) est revendiquée par le 2e → le mismatch doit quand même sortir.
    const l2 = lockPoolPeriodOn(d5, { player_id: 1, closed_at: "2026-09-20 18:00:00", balances: b5(295, "2026-09-20 17:59:00"), now: NOW9 }); // 850+45 → 745 : perte 150 → −45 aussi
    const s6 = (l2 as any).settlement_id as number;
    d5.prepare(`UPDATE manual_settlements SET status='paid', paid_date='2026-09-20' WHERE id = ?`).run(s6);
    writePoolSettlementMovementOnPaid(d5, s6, "2026-09-20");
    ingestOkpayMessageOn(d5, line("490", "2026-09-20 20:30:00"), "telegram_forward");
    const p6 = previewPoolPeriodOn(d5, { player_id: 1, closed_at: "2026-09-27 18:00:00", balances: b5(490, "2026-09-27 17:59:00"), now: NOW9 });
    check("(M20) règlement résolu sur sa ligne → pas de declared_time_mismatch pour lui", p6.ok && !p6.preview.warnings.some(w => w.code === "declared_time_mismatch" && new RegExp(`#${s6} `).test(w.message)));
    // (N9 / R2) le 1er règlement (déclaré 19:00 le 13) : sa vraie ligne est le 13 19:00 → pas de mismatch. On rejoue R2 :
    // un 1er règlement déclaré à une heure FAUSSE, dont la vraie ligne est ensuite revendiquée par le 2e → le mismatch doit sortir quand même.
    const { db: d6 } = freshDb();
    enrollPoolPlayerOn(d6, 1, "600200100"); addAccountOn(d6, { player_id: 1 });
    const a6 = lockPoolPeriodOn(d6, { player_id: 1, closed_at: "2026-09-13 18:00:00", balances: b5(400, "2026-09-13 17:59:00"), pool_open_manual: 1000, now: NOW9 });
    const sA = (a6 as any).settlement_id as number;
    d6.prepare(`UPDATE manual_settlements SET status='paid', paid_date='2026-09-13' WHERE id = ?`).run(sA);
    writePoolSettlementMovementOnPaid(d6, sA, "2026-09-13");
    setSettlementInstantOn(d6, listMovementsOn(d6, 1)[0].id, "2026-09-13 19:00:00", NOW9);          // déclaré 19:00 — FAUX : vraie ligne 13 22:00
    // 2e période close le 13 à 21:00, payée le 13. (L'heure déclarée 19:00 met les 45 en ext_in de P2 :
    // main 295 → pool 745 → 745 − (850 + 45) = −150 → −45 aussi.)
    const b6 = lockPoolPeriodOn(d6, { player_id: 1, closed_at: "2026-09-13 21:00:00", balances: b5(295, "2026-09-13 20:59:00"), now: NOW9 });
    const sB = (b6 as any).settlement_id as number;
    check("(N9) 2e règlement −45 figé", b6.ok && b6.computed.action_amount === -45, b6.ok ? JSON.stringify(b6.computed) : errOf(b6));
    d6.prepare(`UPDATE manual_settlements SET status='paid', paid_date='2026-09-13' WHERE id = ?`).run(sB);
    writePoolSettlementMovementOnPaid(d6, sB, "2026-09-13");
    const ing6 = ingestOkpayMessageOn(d6, line("295", "2026-09-13 22:00:00"), "telegram_forward");      // la ligne du 1er (22:00), > 21:00 → candidate du 2e → revendiquée par lui
    check("(N9) la ligne 13 22:00 est revendiquée par le 2e règlement (résolution)", ing6.ok && ing6.resolved_settlements === 1, JSON.stringify(ing6));
    const p7 = previewPoolPeriodOn(d6, { player_id: 1, closed_at: "2026-09-21 18:00:00", balances: b5(295, "2026-09-21 17:59:00"), now: NOW9 });
    check("(N9) mismatch sur le 1er règlement (déclaré 19:00, ligne 22:00 revendiquée par un autre) → le warning sort malgré la revendication", p7.ok && p7.preview.warnings.some(w => w.code === "declared_time_mismatch" && new RegExp(`#${sA} `).test(w.message) && /22:00:00/.test(w.message)), JSON.stringify(p7.ok && p7.preview.warnings));
  }
}

console.log(`\n${passed} ✔ · ${failures.length} ✘`);
if (failures.length > 0) { console.log("Échecs :\n - " + failures.join("\n - ")); process.exit(1); }
