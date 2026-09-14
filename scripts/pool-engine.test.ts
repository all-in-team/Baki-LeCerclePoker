/**
 * Harnais du suivi multi-comptes « AK multi-Account » — phase 1 :
 * schéma + moteur pur + parseur OkPay.
 * Run: npx tsx scripts/pool-engine.test.ts
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────┐
 * │ Le calcul d'une période est CELUI du moteur bankroll NEXA (identité au    │
 * │ centime sur les mêmes entrées) ; le mouvement de règlement part dans le   │
 * │ bon sens ET son absence fabrique une part fantôme (contrefactuel exécuté  │
 * │ dans les deux sens) ; ajouter un compte ne crée pas de saut ; la somme   │
 * │ du pool refuse une main absente et une saisie à trois décimales ; l'écart │
 * │ d'horodatage et l'OkPay non nulle sont signalés ; la chaîne d'un         │
 * │ historique casse exactement là où une ligne manque, et pas ailleurs ; le │
 * │ parseur lit le format décrit, refuse un bloc illisible, saute une autre  │
 * │ devise, et produit une clé de dédup stable ; le schéma RÉEL interdit le  │
 * │ doublon de ligne OkPay, la période sans main unique, le double mouvement │
 * │ de règlement, et le DELETE d'un règlement encore adossé à une période.   │
 * │ Chaque garde de schéma a son CONTREFACTUEL : le même test sur un DDL     │
 * │ muté (UNIQUE retiré, CASCADE remis) doit passer à l'inverse — sinon le   │
 * │ test ne prouve rien.                                                     │
 * └─────────────────────────────────────────────────────────────────────────┘
 * ┌─ CE QU'ILS NE PROUVENT PAS ─────────────────────────────────────────────┐
 * │ • Le parseur n'est validé que contre UN vrai message (agence, 5 lignes,  │
 * │   Transfer To/From + 轉賬給). La forme chinoise de l'entrant et tout      │
 * │   autre libellé sont REFUSÉS jusqu'à échantillon — sûr, pas prouvé.     │
 * │ • Les contrefactuels A1/A2/A3 de l'audit du 2026-09-13 sont intégrés :    │
 * │   deux en-têtes collés, même seconde en ordre inverse, paid_date = jour   │
 * │   de clôture — chacun montre le chiffre faux que le bug produisait.       │
 * │ • La couche DB (lib/pool/periods.ts) n'existe pas encore : preview, lock, │
 * │   unlock, soft-close, hook markPaid — phase 2.                           │
 * │ • Le handler bot, l'écran, le hub /payments.                             │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import path from "path";

const REPO = path.resolve(__dirname, "..");
const Database = require(path.join(REPO, "node_modules/better-sqlite3"));

import {
  POOL_SCHEMA_SQL, POOL_GAME_INSERT_SQL, POOL_GAME_NAME, POOL_AGENCY_OKPAY_TG_ID,
} from "../lib/pool/schema";
import {
  computePoolPeriod, carriedPoolOpen, sumPool, settlementMovementFor,
  observationSpread, nonZeroOkpayWarnings, balanceAt, checkLedgerChain, classifyMainLines,
  sortLedger, settlementOccurredAt, oneSecondAfter,
  type BalanceReading, type LedgerLine,
} from "../lib/pool/engine";
import { computeBankrollWeek } from "../lib/funnels/nexa/bankroll-engine";
import { parseOkpayMessage, parseCounterparty, okpayDedupKey, parseOkpayNumber } from "../lib/pool/okpay-parse";

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

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n■ 1. Le moteur : même grandeur, même moteur que la bankroll NEXA");
{
  // Le cas de la maquette : 2 comptes, main 400, pool de départ 1 000, 30 %.
  const readings: BalanceReading[] = [
    { account_id: 1, label: "Compte 1", wallet_kind: "ak",    balance: 300, observed_at: "2026-09-13 18:00:00" },
    { account_id: 1, label: "Compte 1", wallet_kind: "okpay", balance: 0,   observed_at: "2026-09-13 18:00:30" },
    { account_id: 2, label: "Compte 2", wallet_kind: "ak",    balance: 150, observed_at: "2026-09-13 18:01:00" },
    { account_id: 2, label: "Compte 2", wallet_kind: "okpay", balance: 0,   observed_at: "2026-09-13 18:01:20" },
    { account_id: null, label: "main",  wallet_kind: "main",  balance: 400, observed_at: "2026-09-13 17:58:00" },
  ];
  const pool = sumPool(readings);
  check("sumPool ok", pool.ok);
  if (pool.ok) {
    approx("pool de fin = 300 + 0 + 150 + 0 + 400 = 850", pool.value, 850);
    const r = computePoolPeriod({ pool_open: 1000, pool_close: pool.value, ext_in: 0, ext_out: 0, action_pct: 30 });
    check("calcul ok", r.ok);
    if (r.ok) {
      approx("résultat = 850 − 1000 = −150", r.value.result, -150);
      approx("ma part = −150 × 30 % = −45 (négatif : je lui dois)", r.value.action_amount, -45);
      approx("à verser = 45", r.value.transfer_amount, 45);
      approx("pool de début suivant = 850, SANS le versement", r.value.next_br_open, 850);
    }
  }

  // IDENTITÉ avec computeBankrollWeek sur les mêmes entrées — la preuve que ce
  // module ne recalcule rien. Entrées choisies pour que l'arrondi travaille.
  const cases = [
    { o: 1234.56, c: 987.65, i: 100.10, out: 250.25, p: 30 },
    { o: 0, c: 1500, i: 1500, out: 0, p: 45 },
    { o: 5000, c: 5000.01, i: 0, out: 0, p: 33 },      // 0.0033 → 0.00 arrondi
    { o: 5000, c: 4999.99, i: 0, out: 0, p: 50 },      // −0.005 → −0.01 demi-sup. en valeur absolue
  ];
  for (const k of cases) {
    const a = computePoolPeriod({ pool_open: k.o, pool_close: k.c, ext_in: k.i, ext_out: k.out, action_pct: k.p });
    const b = computeBankrollWeek({ br_open: k.o, br_close: k.c, deposits: k.i, cashouts: k.out, action_pct: k.p });
    eq(`identité moteur NEXA (${k.o}→${k.c}, +${k.i} −${k.out}, ${k.p} %)`, a, b);
  }
  const s = computePoolPeriod({ pool_open: 5000, pool_close: 4999.99, ext_in: 0, ext_out: 0, action_pct: 50 });
  if (s.ok) approx("−0.005 s'arrondit à −0.01 (symétrique de +0.005 → +0.01)", s.value.action_amount, -0.01);

  // Les refus portent le vocabulaire du pool, pas celui de la BR.
  const bad = computePoolPeriod({ pool_open: 1000.123, pool_close: 850, ext_in: 0, ext_out: 0, action_pct: 30 });
  check("3 décimales sur le pool de début → refus nommé « pool de début »", !bad.ok && /pool de début/.test((bad as any).error), JSON.stringify(bad));
  const neg = computePoolPeriod({ pool_open: 1000, pool_close: 850, ext_in: -5, ext_out: 0, action_pct: 30 });
  check("entrée externe négative → refus nommé « entrées externes »", !neg.ok && /entrées externes/.test((neg as any).error), JSON.stringify(neg));
  const zero = computePoolPeriod({ pool_open: 1000, pool_close: 850, ext_in: 0, ext_out: 0, action_pct: 0 });
  check("part d'action 0 → refus (joueur non staké)", !zero.ok);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n■ 2. §4 — le règlement TRAVERSE le pool (contrefactuel dans les deux sens)");
{
  // Période 1 : il perd 150 → je lui dois 45, versés sur sa main le 2026-09-15.
  const p1 = computePoolPeriod({ pool_open: 1000, pool_close: 850, ext_in: 0, ext_out: 0, action_pct: 30 });
  if (!p1.ok) throw new Error(p1.error);
  const mv1 = settlementMovementFor(p1.value.action_amount);
  eq("je lui dois 45 → mouvement 'in' de 45 (l'argent ENTRE dans le pool)", mv1, { direction: "in", amount: 45 });

  // Période 2 : il ne joue pas. Sa main a reçu mes 45 : pool de fin = 895.
  const open2 = carriedPoolOpen({ pool_close: p1.value.result + 1000 });
  approx("pool de début P2 = pool de fin P1 = 850 (le versement n'y est PAS reporté)", open2, 850);
  const withMv = computePoolPeriod({ pool_open: open2, pool_close: 895, ext_in: mv1!.amount, ext_out: 0, action_pct: 30 });
  const withoutMv = computePoolPeriod({ pool_open: open2, pool_close: 895, ext_in: 0, ext_out: 0, action_pct: 30 });
  if (withMv.ok && withoutMv.ok) {
    approx("AVEC le mouvement : résultat P2 = 0 (il n'a pas joué)", withMv.value.result, 0);
    approx("SANS le mouvement (bug remis) : résultat P2 = +45 — gain fictif", withoutMv.value.result, 45);
    approx("SANS le mouvement : il me devrait 13,50 sur MON PROPRE versement", withoutMv.value.action_amount, 13.5);
    check("le test discrimine : avec ≠ sans", Math.abs(withMv.value.result - withoutMv.value.result) > 1);
  } else check("P2 calculée", false);

  // Sens inverse : il gagne 200 → il me doit 60, payés depuis sa main.
  const w1 = computePoolPeriod({ pool_open: 1000, pool_close: 1200, ext_in: 0, ext_out: 0, action_pct: 30 });
  if (!w1.ok) throw new Error(w1.error);
  const mvW = settlementMovementFor(w1.value.action_amount);
  eq("il me doit 60 → mouvement 'out' de 60 (l'argent SORT du pool)", mvW, { direction: "out", amount: 60 });
  approx("aucun versement de ma part quand il gagne", w1.value.transfer_amount, 0);
  const w2with = computePoolPeriod({ pool_open: 1200, pool_close: 1140, ext_in: 0, ext_out: 60, action_pct: 30 });
  const w2without = computePoolPeriod({ pool_open: 1200, pool_close: 1140, ext_in: 0, ext_out: 0, action_pct: 30 });
  if (w2with.ok && w2without.ok) {
    approx("AVEC : résultat 0", w2with.value.result, 0);
    approx("SANS (bug remis) : −60, perte fictive → je paierais 18 sur MON PROPRE encaissement", w2without.value.action_amount, -18);
  } else check("P2 gagnante calculée", false);

  eq("part nulle → aucun mouvement", settlementMovementFor(0), null);
  eq("part sous EPS → aucun mouvement", settlementMovementFor(1e-9), null);
  eq("montant arrondi au centime", settlementMovementFor(-12.345000000001), { direction: "in", amount: 12.35 });
  eq("0.004 → arrondi 0 → aucun mouvement (et pas un mouvement à 0 qui violerait CHECK(amount > 0))", settlementMovementFor(0.004), null);
  check("part NaN → JETTE (indéterminé ≠ nul)", throws(() => settlementMovementFor(NaN), /indéterminée/));

  // A3 — dater le mouvement quand /payments ne donne qu'un jour.
  eq("payé le jour de la clôture (15 à 18:00) → 1 s après la clôture, dans la période suivante",
     settlementOccurredAt("2026-09-15", "2026-09-15 18:00:00"), { ok: true, occurred_at: "2026-09-15 18:00:01", precision: "day" });
  eq("payé un jour plus tard → ce jour à 00:00:00, précision JOUR (à résoudre depuis le grand livre)", settlementOccurredAt("2026-09-17", "2026-09-15 18:00:00"), { ok: true, occurred_at: "2026-09-17 00:00:00", precision: "day" });
  const before = settlementOccurredAt("2026-09-13", "2026-09-15 18:00:00");
  check("payé 2 jours AVANT la clôture → refus (déjà dans la photo, part calculée dessus)", !before.ok && /antérieure/.test((before as any).error));
  eq("payé la VEILLE (fuseau : peut être après la photo) → toléré, clôture + 1 s, précision jour", settlementOccurredAt("2026-09-14", "2026-09-15 18:00:00"), { ok: true, occurred_at: "2026-09-15 18:00:01", precision: "day" });
  check("paid_date mal formée → refus", !settlementOccurredAt("15/09/2026", "2026-09-15 18:00:00").ok);
  eq("+1 s passe minuit", oneSecondAfter("2026-09-30 23:59:59"), "2026-10-01 00:00:00");
  // CONTREFACTUEL A3 (illustration, pas assertion : « 2026-09-15 00:00:00 » ≤ « 2026-09-15 18:00:00 »
  // lexicalement — daté ainsi, le mouvement tombait dans la somme figée, compté nulle part).
  const closed = "2026-09-15 18:00:00";
  const fixed = settlementOccurredAt("2026-09-15", closed);
  check("avec la règle : strictement après closed_at → dans la période ouverte", fixed.ok && fixed.occurred_at > closed);
  check("B3 : clôture « 2026-02-30 12:00:00 » (forme ok, calendrier non) → refus", !settlementOccurredAt("2026-03-01", "2026-02-30 12:00:00").ok);
  check("B3 : paid_date 2026-13-45 → refus", !settlementOccurredAt("2026-13-45", closed).ok);
  check("B3 : oneSecondAfter jette hors calendrier", throws(() => oneSecondAfter("2026-02-30 12:00:00"), /calendrier/));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n■ 3. Cas limites : compte ajouté (n°2), main manquante, saisies");
{
  // Il ouvre un Compte 3 et y vire 100 depuis sa main : pool inchangé.
  const readings: BalanceReading[] = [
    { account_id: 1, label: "Compte 1", wallet_kind: "ak", balance: 300, observed_at: "2026-09-20T18:00:00Z" },
    { account_id: 1, label: "Compte 1", wallet_kind: "okpay", balance: 0, observed_at: "2026-09-20T18:00:00Z" },
    { account_id: 2, label: "Compte 2", wallet_kind: "ak", balance: 150, observed_at: "2026-09-20T18:00:00Z" },
    { account_id: 2, label: "Compte 2", wallet_kind: "okpay", balance: 0, observed_at: "2026-09-20T18:00:00Z" },
    { account_id: 3, label: "Compte 3", wallet_kind: "ak", balance: 100, observed_at: "2026-09-20T18:00:00Z" },
    { account_id: 3, label: "Compte 3", wallet_kind: "okpay", balance: 0, observed_at: "2026-09-20T18:00:00Z" },
    { account_id: null, label: "main", wallet_kind: "main", balance: 300, observed_at: "2026-09-20T18:00:00Z" },
  ];
  const pool = sumPool(readings);
  if (pool.ok) {
    approx("compte ajouté, alimenté depuis la main : pool = 850, inchangé", pool.value, 850);
    const r = computePoolPeriod({ pool_open: carriedPoolOpen({ pool_close: 850 }), pool_close: pool.value, ext_in: 0, ext_out: 0, action_pct: 30 });
    if (r.ok) approx("résultat 0 : neutre, pas de saut", r.value.result, 0);
  } else check("sumPool ok", false, pool.error);

  const noMain = sumPool(readings.filter(r => r.wallet_kind !== "main"));
  check("main absente → refus (sous-total, pas pool)", !noMain.ok && /main manquant/.test((noMain as any).error));
  const twoMain = sumPool([...readings, { account_id: null, label: "main", wallet_kind: "main", balance: 1, observed_at: "2026-09-20T18:00:00Z" }]);
  check("deux mains → refus", !twoMain.ok);
  const threeDec = sumPool(readings.map(r => r.label === "Compte 2" && r.wallet_kind === "ak" ? { ...r, balance: 150.001 } : r));
  check("solde à 3 décimales → refus nommé sur le compte", !threeDec.ok && /Compte 2 AK/.test((threeDec as any).error), JSON.stringify(threeDec));
  const negative = sumPool(readings.map(r => r.wallet_kind === "main" ? { ...r, balance: -1 } : r));
  check("solde négatif → refus", !negative.ok);

  // Dérive flottante : 50 soldes de 1234.56 → la somme brute vaut 61727.999999999956.
  const many: BalanceReading[] = Array.from({ length: 49 }, (_, i) => ({
    account_id: i + 1, label: `C${i + 1}`, wallet_kind: "ak" as const, balance: 1234.56, observed_at: "2026-09-20T18:00:00Z",
  }));
  many.push({ account_id: null, label: "main", wallet_kind: "main", balance: 1234.56, observed_at: "2026-09-20T18:00:00Z" });
  const big = sumPool(many);
  check("50 × 1234.56 → 61728.00 exact (arrondi de la somme)", big.ok && big.value === 61728, JSON.stringify(big));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n■ 4. Argent en vol (n°3) et OkPay non nulle");
{
  const base: BalanceReading[] = [
    { account_id: 1, label: "Compte 1", wallet_kind: "ak", balance: 300, observed_at: "2026-09-13 18:00:00" },
    { account_id: 1, label: "Compte 1", wallet_kind: "okpay", balance: 0, observed_at: "2026-09-13 18:02:00" },
    { account_id: null, label: "main", wallet_kind: "main", balance: 400, observed_at: "2026-09-13 17:45:00" },
  ];
  const s1 = observationSpread(base);
  approx("écart 17 min", s1.spread_min, 17);
  eq("17 min < 30 → pas d'avertissement", s1.warning, null);
  const s2 = observationSpread(base.map(r => r.wallet_kind === "main" ? { ...r, observed_at: "2026-09-13 17:29:00" } : r));
  check("31 min → avertissement nommant les deux soldes", s2.warning?.code === "observation_spread" && /main MAIN/.test(s2.warning.message) && /Compte 1 OKPAY/.test(s2.warning.message), s2.warning?.message);
  const s3 = observationSpread(base.map(r => r.wallet_kind === "main" ? { ...r, observed_at: "2026-09-13 17:29:00" } : r), 60);
  eq("seuil paramétrable : 31 min < 60 → rien", s3.warning, null);
  const s4 = observationSpread(base.map(r => r.wallet_kind === "main" ? { ...r, observed_at: "hier soir" } : r));
  check("horodatage illisible → avertissement (il ne peut pas rassurer)", s4.warning !== null && /illisible/.test(s4.warning.message));
  // Les dates OkPay sont sans fuseau : lues comme UTC, JAMAIS en heure locale du
  // serveur (Railway ≠ Mac de Baki). Ce test échouait à 470 min avant la règle.
  const s5 = observationSpread([
    { account_id: 1, label: "C1", wallet_kind: "ak", balance: 1, observed_at: "2026-09-13T18:00:00Z" },
    { account_id: null, label: "main", wallet_kind: "main", balance: 1, observed_at: "2026-09-13 18:10:00" },
  ]);
  approx("« YYYY-MM-DD HH:MM:SS » lu comme UTC : 10 min, quel que soit le fuseau du serveur", s5.spread_min, 10);
  const s6 = observationSpread([
    { account_id: 1, label: "C1", wallet_kind: "ak", balance: 1, observed_at: "2026-09-13 18:00:00" },
    { account_id: null, label: "main", wallet_kind: "main", balance: 1, observed_at: "2026-09-13T20:10:00+02:00" },
  ]);
  approx("ISO avec décalage explicite respectée : 20:10+02:00 = 18:10 → 10 min", s6.spread_min, 10);

  const w = nonZeroOkpayWarnings([
    ...base,
    { account_id: 2, label: "Compte 2", wallet_kind: "okpay", balance: 12.5, observed_at: "2026-09-13 18:00:00" },
    { account_id: 2, label: "Compte 2", wallet_kind: "ak", balance: 999, observed_at: "2026-09-13 18:00:00" },
  ]);
  eq("une OkPay à 12,50 → un signal, l'AK à 999 n'en produit aucun", w.map(x => x.message), ["Compte 2 : OkPay à 12.50 au lieu de 0 — un virement est resté en route ?"]);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n■ 5. Historique OkPay : solde à un instant, chaîne, classification");
{
  const lines: LedgerLine[] = [
    { id: 1, direction: "+", amount: 1000,   balance_after: 1000,   occurred_at: "2026-09-08 10:00:00", counterparty_tg_id: "555000111" },
    { id: 2, direction: "-", amount: 300,    balance_after: 700,    occurred_at: "2026-09-09 11:00:00", counterparty_tg_id: "777001" },
    { id: 3, direction: "-", amount: 150.10, balance_after: 549.90, occurred_at: "2026-09-10 12:00:00", counterparty_tg_id: "777002" },
    { id: 4, direction: "+", amount: 0.20,   balance_after: 550.10, occurred_at: "2026-09-11 13:00:00", counterparty_tg_id: "777001" },
    { id: 5, direction: "+", amount: 45,     balance_after: 595.10, occurred_at: "2026-09-15 09:00:00", counterparty_tg_id: POOL_AGENCY_OKPAY_TG_ID },
  ];
  eq("chaîne cohérente → aucune rupture (549.90 + 0.20 = 550.10 sans faux positif flottant)", checkLedgerChain(lines), []);
  const shuffled = [lines[3], lines[0], lines[4], lines[2], lines[1]];
  eq("l'ordre du message n'importe pas : trié par date", checkLedgerChain(shuffled), []);

  // CONTREFACTUEL : on retire la ligne 3 → la chaîne casse entre le 09 et le 11.
  const holed = lines.filter(l => l.id !== 3);
  const breaks = checkLedgerChain(holed);
  eq("une ligne manquante → exactement une rupture", breaks.length, 1);
  if (breaks.length === 1) {
    eq("rupture située entre la ligne du 09 et celle du 11", [breaks[0].before.occurred_at, breaks[0].after.occurred_at], ["2026-09-09 11:00:00", "2026-09-11 13:00:00"]);
    approx("solde attendu après le +0,20 : 700,20", breaks[0].expected_after, 700.2);
    approx("il manque −150,10 net entre les deux", breaks[0].missing_delta, -150.1);
  }
  eq("chaîne d'une ligne : rien à dire", checkLedgerChain([lines[0]]), []);

  // A2 — deux opérations à la MÊME SECONDE, ids dans l'ordre du message (récent → ancien).
  // Chaîne réelle : 50 → (+100) 150 → (+50) 200. Insérées en ordre inverse : id 11 = la
  // dernière (200), id 12 = celle du milieu (150).
  const sameSec: LedgerLine[] = [
    { id: 10, direction: "+", amount: 50,  balance_after: 50,  occurred_at: "2026-09-13 17:00:00" },
    { id: 11, direction: "+", amount: 50,  balance_after: 200, occurred_at: "2026-09-13 18:00:00" },
    { id: 12, direction: "+", amount: 100, balance_after: 150, occurred_at: "2026-09-13 18:00:00" },
    { id: 13, direction: "-", amount: 20,  balance_after: 180, occurred_at: "2026-09-13 19:00:00" },
  ];
  eq("même seconde : l'ordre où la chaîne tient l'emporte sur l'id", sortLedger(sameSec).map(l => l.id), [10, 12, 11, 13]);
  eq("→ aucune fausse rupture", checkLedgerChain(sameSec), []);
  approx("→ balanceAt 18:00:00 = 200 (le VRAI dernier solde), pas 150", balanceAt(sameSec, "2026-09-13 18:00:00")?.balance ?? NaN, 200);
  // CONTREFACTUEL : l'ancien tri (date puis id) mis à plat ici, avec la même
  // vérification de chaîne — checkLedgerChain retrie lui-même, on ne peut pas lui
  // passer un ordre bugué de l'extérieur.
  const byIdOnly = [...sameSec].sort((a, b) => a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.id! - b.id!);
  let oldBreaks = 0;
  for (let n = 1; n < byIdOnly.length; n++) {
    const exp = byIdOnly[n - 1].balance_after + (byIdOnly[n].direction === "+" ? byIdOnly[n].amount : -byIdOnly[n].amount);
    if (Math.abs(exp - byIdOnly[n].balance_after) > 1e-7) oldBreaks++;
  }
  eq("contrefactuel : tri par id seul → 3 fausses ruptures sur 3 transitions (le bug)", oldBreaks, 3);
  approx("contrefactuel : dernier solde par id seul à 18:00:00 = 150 (faux) — le pool aurait été sous-évalué de 50",
         byIdOnly.filter(l => l.occurred_at <= "2026-09-13 18:00:00").slice(-1)[0].balance_after, 150);
  // Premier groupe sans prédécesseur : les transitions internes suffisent.
  const firstGroup: LedgerLine[] = [
    { id: 2, direction: "-", amount: 30, balance_after: 70,  occurred_at: "2026-09-13 18:00:00" },
    { id: 1, direction: "+", amount: 100, balance_after: 100, occurred_at: "2026-09-13 18:00:00" },
  ];
  eq("groupe en tête : ordre interne cohérent retrouvé", sortLedger(firstGroup).map(l => l.id), [1, 2]);
  eq("groupe en tête, un seul ordre cohérent : pas d'ambiguïté", balanceAt(firstGroup, "2026-09-13 18:00:00")?.ambiguity, null);

  // B1 — OkPay de transit : +100→100 et −100→0 la même seconde, page récent→ancien.
  // Deux ordres cohérents en interne, soldes finaux DIFFÉRENTS (0 ou 100).
  const transit: LedgerLine[] = [
    { id: 1, direction: "-", amount: 100, balance_after: 0,   occurred_at: "2026-09-13 18:00:00" },
    { id: 2, direction: "+", amount: 100, balance_after: 100, occurred_at: "2026-09-13 18:00:00" },
  ];
  const tAt = balanceAt(transit, "2026-09-13 18:00:00");
  eq("B1 sans ligne suivante : AMBIGU, signalé avec les deux soldes possibles", tAt?.ambiguity, { occurred_at: "2026-09-13 18:00:00", possible_final_balances: [0, 100] });
  // Avec une ligne suivante (+200 → 200), le look-ahead tranche : le vrai ordre finit à 0.
  const transitNext = [...transit, { id: 3, direction: "+" as const, amount: 200, balance_after: 200, occurred_at: "2026-09-13 19:00:00" }];
  eq("B1 avec look-ahead : ordre [2,1], solde 0, chaîne intacte", [sortLedger(transitNext).map(l => l.id), checkLedgerChain(transitNext).length], [[2, 1, 3], 0]);
  approx("B1 avec look-ahead : balanceAt 18:00 = 0 (vrai), pas 100", balanceAt(transitNext, "2026-09-13 18:00:00")?.balance ?? NaN, 0);
  eq("B1 avec look-ahead : plus d'ambiguïté", balanceAt(transitNext, "2026-09-13 18:00:00")?.ambiguity, null);
  // Avec un prédécesseur, deux ordres cohérents finissent toujours au même solde : pas d'ambiguïté.
  const cycle: LedgerLine[] = [
    { id: 0, direction: "+", amount: 100, balance_after: 100, occurred_at: "2026-09-13 17:00:00" },
    { id: 1, direction: "+", amount: 50, balance_after: 150, occurred_at: "2026-09-13 18:00:00" },
    { id: 2, direction: "-", amount: 50, balance_after: 100, occurred_at: "2026-09-13 18:00:00" },
    { id: 3, direction: "+", amount: 20, balance_after: 120, occurred_at: "2026-09-13 18:00:00" },
    { id: 4, direction: "-", amount: 20, balance_after: 100, occurred_at: "2026-09-13 18:00:00" },
  ];
  eq("prédécesseur présent, plusieurs ordres cohérents : même solde final, aucune ambiguïté", [balanceAt(cycle, "2026-09-13 18:00:00")?.balance, balanceAt(cycle, "2026-09-13 18:00:00")?.ambiguity, checkLedgerChain(cycle).length], [100, null, 0]);
  // Vraie rupture dans la seconde : aucun ordre ne tient → l'id départage, et la chaîne le dit.
  const broken: LedgerLine[] = [
    { id: 1, direction: "+", amount: 50, balance_after: 50, occurred_at: "2026-09-13 17:00:00" },
    { id: 2, direction: "+", amount: 10, balance_after: 999, occurred_at: "2026-09-13 18:00:00" },
    { id: 3, direction: "+", amount: 10, balance_after: 70, occurred_at: "2026-09-13 18:00:00" },
  ];
  check("vraie rupture dans la seconde → signalée, pas masquée", checkLedgerChain(broken).length >= 1);

  const at = balanceAt(lines, "2026-09-13 23:59:59");
  approx("solde main au 13/09 23:59:59 = 550,10 (la ligne du 15 est ignorée)", at?.balance ?? NaN, 550.1);
  eq("aucune ligne avant l'instant → null (inconnu, pas 0)", balanceAt(lines, "2026-09-01 00:00:00"), null);
  approx("solde à l'instant exact d'une ligne : inclus", balanceAt(lines, "2026-09-09 11:00:00")?.balance ?? NaN, 700);

  const c = classifyMainLines(lines, new Set(["777001", "777002"]), POOL_AGENCY_OKPAY_TG_ID);
  eq("main ↔ comptes : 3 lignes internes", c.internal.map(l => l.id), [2, 3, 4]);
  eq("agence : 1 ligne de règlement", c.settlement.map(l => l.id), [5]);
  eq("le reste est externe (non déclaré tant que Baki ne le déclare pas)", c.external.map(l => l.id), [1]);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n■ 6. Parseur OkPay — fixture : VRAI message transféré (Baki, 2026-09-13)");
{
  // Tel que reçu, brut. Wallet agence (1486389037), 5 opérations, chaîne parfaite à 6 décimales.
  const REAL = [
    "HugoRoine Transaction:1486389037",
    "",
    "Type: ➖",
    "Details: Transfer To : 火焰骑士团【ID 6105025057】",
    "Amount: 550",
    "Currency: USDT",
    "Changed balance: 1467.817733",
    "date: 2026-09-13 13:28:55",
    "",
    "Type: ➕",
    "Details: Transfer From : 冷静不偷【ID 6646842987】",
    "Amount: 478",
    "Currency: USDT",
    "Changed balance: 2017.817733",
    "date: 2026-09-13 11:22:33",
    "",
    "Type: ➕",
    "Details: Transfer From : 赢500下桌【ID 7308983551】",
    "Amount: 728.9",
    "Currency: USDT",
    "Changed balance: 1539.817733",
    "date: 2026-09-13 11:21:10",
    "",
    "Type: ➖",
    "Details: 轉賬給 : X1【ID 2082550914】",
    "Amount: 500",
    "Currency: USDT",
    "Changed balance: 810.917733",
    "date: 2026-09-12 15:21:35",
    "",
    "Type: ➖",
    "Details: 轉賬給 : 赢500下桌【ID 7308983551】",
    "Amount: 500",
    "Currency: USDT",
    "Changed balance: 1310.917733",
    "date: 2026-09-12 15:18:10",
  ].join("\n");

  const r = parseOkpayMessage(REAL);
  check("message réel parsé", r.ok, JSON.stringify(r));
  if (r.ok) {
    eq("wallet = l'agence, label = pseudo", [r.wallet_tg_id, r.wallet_label], [POOL_AGENCY_OKPAY_TG_ID, "HugoRoine"]);
    eq("5 lignes, 0 sautée", [r.lines.length, r.skipped.length], [5, 0]);
    eq("ligne 1 : ➖ (U+2796) → sortant, « Transfer To » anglais, 6 décimales conservées",
       [r.lines[0].direction, r.lines[0].amount, r.lines[0].balance_after, r.lines[0].counterparty_tg_id, r.lines[0].counterparty_name],
       ["-", 550, 1467.817733, "6105025057", "火焰骑士团"]);
    eq("ligne 3 : ➕ (U+2795) → entrant, « 728.9 » lu tel quel",
       [r.lines[2].direction, r.lines[2].amount, r.lines[2].balance_after, r.lines[2].occurred_at],
       ["+", 728.9, 1539.817733, "2026-09-13 11:21:10"]);
    eq("ligne 4 : « 轉賬給 » chinois → sortant, dans le MÊME message que l'anglais",
       [r.lines[3].direction, r.lines[3].counterparty_tg_id, r.lines[3].counterparty_name], ["-", "2082550914", "X1"]);

    // La chaîne réelle tient AU MILLIONIÈME : 1310.917733 −500 → 810.917733 +728.9 → 1539.817733 +478 → 2017.817733 −550 → 1467.817733.
    eq("chaîne parfaite → 0 rupture (au millionième)", checkLedgerChain(r.lines), []);
    eq("ordre du message récent→ancien remis en chronologie", sortLedger(r.lines).map(l => l.balance_after), [1310.917733, 810.917733, 1539.817733, 2017.817733, 1467.817733]);
    // CONTREFACTUEL : au centime, 810.917733 + 0.004 = 810.921733 passerait (|Δ| < 0.005). Au millionième, non.
    const tampered = r.lines.map(l => l.balance_after === 810.917733 ? { ...l, balance_after: 810.921733 } : l);
    eq("solde faussé de 0.004 → détecté au millionième (1 rupture à la ligne suivante, 1 à celle-ci = 2)", checkLedgerChain(tampered).length, 2);
    check("contrefactuel : au centime (|Δ| ≤ 0.005) cette falsification passait", Math.abs(810.921733 - 810.917733) < 0.005);

    const at = balanceAt(r.lines, "2026-09-13 12:00:00");
    approx("solde à 12:00 le 13 = 2017.817733 (fait, 6 décimales)", at?.balance ?? NaN, 2017.817733);
    approx("→ pool_balance = 2017.82 (arrondi au centime, à la frontière seulement)", at?.pool_balance ?? NaN, 2017.82);
    approx("solde en fin de journée du 13 = 1467.817733", balanceAt(r.lines, "2026-09-13 23:59:59")?.balance ?? NaN, 1467.817733);
    eq("aucune ambiguïté (secondes toutes distinctes)", at?.ambiguity, null);

    // Dédup : même message → mêmes clés ; 5 clés distinctes ; la clé porte 6 décimales.
    const again = parseOkpayMessage(REAL);
    eq("même message transféré deux fois → mêmes dedup_key", again.ok ? again.lines.map(l => l.dedup_key) : null, r.lines.map(l => l.dedup_key));
    eq("5 clés distinctes", new Set(r.lines.map(l => l.dedup_key)).size, 5);
    check("la clé distingue deux soldes différant au millionième", okpayDedupKey("1", r.lines[0]) !== okpayDedupKey("1", { ...r.lines[0], balance_after: 1467.817734 }));
    check("la clé dépend de la wallet", okpayDedupKey("111", r.lines[0]) !== okpayDedupKey("222", r.lines[0]));
  }

  // Robustesse de forme (variantes d'encodage, pas de format).
  eq("CRLF accepté", (() => { const x = parseOkpayMessage(REAL.replace(/\n/g, "\r\n")); return x.ok && x.lines.length; })(), 5);
  eq("➖ suivi du sélecteur U+FE0F accepté", (() => { const x = parseOkpayMessage(REAL.replace("Type: ➖", "Type: ➖\uFE0F")); return x.ok && x.lines.length; })(), 5);
  eq("deux-points pleine largeur acceptés", (() => { const x = parseOkpayMessage(REAL.replace("Transaction:1486389037", "Transaction：1486389037")); return x.ok && x.lines.length; })(), 5);

  // « NE DEVINE PAS » : tout ce qui n'a pas été vu est refusé en nommant le bloc.
  const asciiMinus = parseOkpayMessage(REAL.replace("Type: ➖", "Type: -"));
  check("Type « - » ASCII (jamais vu) → refus nommant le bloc", !asciiMinus.ok && /bloc 1/.test((asciiMinus as any).error) && /➕ ou ➖/.test((asciiMinus as any).error), JSON.stringify(asciiMinus));
  const unknownIn = parseOkpayMessage(REAL.replace("Details: Transfer From : 冷静不偷", "Details: 來自 : 冷静不偷"));
  check("mention chinoise entrante (pas encore vue) → refus « mention inconnue », bloc 2", !unknownIn.ok && /bloc 2/.test((unknownIn as any).error) && /mention inconnue/.test((unknownIn as any).error), JSON.stringify(unknownIn));
  const noId = parseOkpayMessage(REAL.replace("Details: Transfer To : 火焰骑士团【ID 6105025057】", "Details: Transfer To : 火焰骑士团"));
  check("mention connue sans 【ID】 → refus (forme inconnue)", !noId.ok && /【ID/.test((noId as any).error), JSON.stringify(noId));
  const thousands = parseOkpayMessage(REAL.replace("Amount: 550", "Amount: 1,550"));
  check("« 1,550 » (séparateur jamais vu) → refus", !thousands.ok && /séparateur/.test((thousands as any).error), JSON.stringify(thousands));
  const sevenDec = parseOkpayMessage(REAL.replace("Changed balance: 1467.817733", "Changed balance: 1467.8177331"));
  check("7 décimales → refus", !sevenDec.ok);
  const contra = parseOkpayMessage(REAL.replace("Type: ➖\nDetails: Transfer To", "Type: ➕\nDetails: Transfer To"));
  check("➕ avec « Transfer To » → refus (sens contradictoire)", !contra.ok && /contradictoire/.test((contra as any).error), JSON.stringify(contra));
  const contra2 = parseOkpayMessage(REAL.replace("Type: ➕\nDetails: Transfer From : 冷静不偷", "Type: ➖\nDetails: Transfer From : 冷静不偷"));
  check("➖ avec « Transfer From » → refus", !contra2.ok && /contradictoire/.test((contra2 as any).error));

  // A1 — deux historiques collés : refus, jamais « tout à la première wallet ».
  const SECOND = ["X1 Transaction:2082550914", "Type: ➕", "Details: Transfer From : HugoRoine【ID 1486389037】", "Amount: 500", "Currency: USDT", "Changed balance: 0", "date: 2026-09-12 15:21:35"].join("\n");
  const glued = parseOkpayMessage(REAL + "\n\n" + SECOND);
  check("deux en-têtes → refus nommant les deux wallets", !glued.ok && /2 en-têtes/.test((glued as any).error) && /1486389037/.test((glued as any).error) && /2082550914/.test((glued as any).error), JSON.stringify(glued));
  const noHeader = parseOkpayMessage(REAL.split("\n").slice(1).join("\n"));
  check("sans en-tête → refus", !noHeader.ok && /En-tête/.test((noHeader as any).error));
  const inDetails = parseOkpayMessage(REAL.split("\n").slice(1).join("\n").replace("Details: 轉賬給 : X1【ID 2082550914】", "Details: Transaction: 999999999"));
  check("« Transaction: » dans un bloc, sans vrai en-tête → refus", !inDetails.ok);

  // Refus nommés sur champs.
  const noBalance = parseOkpayMessage(REAL.replace("Changed balance: 2017.817733\n", ""));
  check("« Changed balance » manquant → refus nommant le bloc 2", !noBalance.ok && /bloc 2/.test((noBalance as any).error) && /Changed balance/.test((noBalance as any).error), JSON.stringify(noBalance));
  const dupKey = parseOkpayMessage(REAL.replace("Amount: 478\n", "Amount: 478\nAmount: 4780\n"));
  check("deux « Amount: » dans un bloc → refus", !dupKey.ok && /deux fois/.test((dupKey as any).error));
  const badDate = parseOkpayMessage(REAL.replace("2026-09-13 11:22:33", "2026-13-45 11:22:33"));
  check("date 2026-13-45 → refus", !badDate.ok && /n'existe pas/.test((badDate as any).error));
  // Autre devise : sautée et signalée ; le tout-ou-rien ne joue pas sur elle.
  const otherCcy = parseOkpayMessage(REAL.replace("Currency: USDT\nChanged balance: 2017.817733", "Currency: TRX\nChanged balance: 2017.817733"));
  check("bloc TRX sauté, 4 lignes USDT gardées", otherCcy.ok && otherCcy.lines.length === 4 && otherCcy.skipped.length === 1 && /TRX/.test(otherCcy.skipped[0].reason), JSON.stringify(otherCcy));
  check("que des blocs TRX → refus (aucune ligne USDT)", !parseOkpayMessage(REAL.replace(/Currency: USDT/g, "Currency: TRX")).ok);
  check("un bloc illisible → 0 ligne, pas 4 (tout-ou-rien)", !parseOkpayMessage(REAL.replace("Amount: 478", "Amount: abc")).ok);

  eq("parseCounterparty avec ID: et espaces", parseCounterparty("Transfer From : X Y 【 ID : 12345678 】"), { id: "12345678", name: "X Y" });
  eq("parseOkpayNumber : 6 décimales ok, 7 refusées, virgule refusée",
     [parseOkpayNumber("1539.817733").ok, parseOkpayNumber("1.1234567").ok, parseOkpayNumber("728,9").ok, parseOkpayNumber("550").ok], [true, false, false, true]);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n■ 7. Le schéma RÉEL — gardes et leurs contrefactuels sur DDL muté");

// manual_settlements : DDL de prod extraite de lib/db.ts, pas recopiée.
import fs from "fs";
const SRC = fs.readFileSync(path.join(REPO, "lib/db.ts"), "utf8");
const MS_START = SRC.indexOf("CREATE TABLE IF NOT EXISTS manual_settlements");
const MS_SQL = SRC.slice(MS_START, SRC.indexOf(");", MS_START) + 2);
if (!/manual_settlements/.test(MS_SQL) || !/status/.test(MS_SQL)) throw new Error("DDL manual_settlements introuvable dans lib/db.ts");

function freshDb(schemaSql: string = POOL_SCHEMA_SQL) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE _applied_fixes (name TEXT PRIMARY KEY);
    CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
      default_action_pct REAL, currency TEXT NOT NULL DEFAULT 'USDT');
    ${MS_SQL}
  `);
  db.exec(schemaSql);
  db.exec(POOL_GAME_INSERT_SQL);
  db.prepare(`INSERT INTO players (name) VALUES ('Joueur A')`).run();
  return db;
}
const gid = (db: any) => (db.prepare(`SELECT id FROM games WHERE name = ?`).get(POOL_GAME_NAME) as any).id as number;

{
  const db = freshDb();
  eq("la game « AK multi-Account » existe, active, USDT", db.prepare(`SELECT status, currency FROM games WHERE name = ?`).get(POOL_GAME_NAME), { status: "active", currency: "USDT" });
  db.exec(POOL_GAME_INSERT_SQL);
  eq("réappliquer l'INSERT OR IGNORE ne duplique pas la game", db.prepare(`SELECT COUNT(*) n FROM games WHERE name = ?`).get(POOL_GAME_NAME), { n: 1 });
  check("le DDL est idempotent (rejeu sans erreur)", !throws(() => db.exec(POOL_SCHEMA_SQL), /./));

  // Dédup ligne OkPay au niveau du schéma.
  const insLine = db.prepare(`
    INSERT OR IGNORE INTO okpay_ledger_lines
      (wallet_tg_id, direction, amount, currency, balance_after, occurred_at, raw_text, dedup_key, ingest_source)
    VALUES ('600200100', '+', 45, 'USDT', 595.10, '2026-09-15 09:00:00', 'raw', 'k1', 'telegram_forward')`);
  eq("1re insertion : 1 ligne", insLine.run().changes, 1);
  eq("même message transféré deux fois : 0 ligne (INSERT OR IGNORE sur dedup_key UNIQUE)", insLine.run().changes, 0);
  check("devise ≠ USDT refusée par CHECK", throws(() => db.prepare(`
    INSERT INTO okpay_ledger_lines (wallet_tg_id, direction, amount, currency, balance_after, occurred_at, raw_text, dedup_key, ingest_source)
    VALUES ('1', '+', 1, 'TRX', 1, '2026-09-15 09:00:00', 'raw', 'k2', 'paste')`).run(), /CHECK/));
  check("direction hors {+,-} refusée", throws(() => db.prepare(`
    INSERT INTO okpay_ledger_lines (wallet_tg_id, direction, amount, currency, balance_after, occurred_at, raw_text, dedup_key, ingest_source)
    VALUES ('1', 'in', 1, 'USDT', 1, '2026-09-15 09:00:00', 'raw', 'k3', 'paste')`).run(), /CHECK/));

  // CONTREFACTUEL dédup : sans UNIQUE, le second INSERT passe → le test ci-dessus
  // ne prouverait rien s'il passait aussi sur ce DDL-là.
  const mutated = freshDb(POOL_SCHEMA_SQL.replace("dedup_key          TEXT NOT NULL UNIQUE", "dedup_key          TEXT NOT NULL"));
  const insM = mutated.prepare(`INSERT OR IGNORE INTO okpay_ledger_lines
      (wallet_tg_id, direction, amount, currency, balance_after, occurred_at, raw_text, dedup_key, ingest_source)
    VALUES ('600200100', '+', 45, 'USDT', 595.10, '2026-09-15 09:00:00', 'raw', 'k1', 'telegram_forward')`);
  insM.run();
  eq("contrefactuel : UNIQUE retiré → le doublon PASSE (le test est discriminant)", insM.run().changes, 1);
}

{
  const db = freshDb();
  const g = gid(db);
  db.prepare(`INSERT INTO pool_players (player_id, game_id, main_okpay_tg_id) VALUES (1, ?, '600200100')`).run(g);
  check("deux inscriptions du même joueur à la même game → refus", throws(() =>
    db.prepare(`INSERT INTO pool_players (player_id, game_id) VALUES (1, ?)`).run(g), /UNIQUE/));
  db.prepare(`INSERT INTO pool_accounts (player_id, game_id, label, okpay_tg_id) VALUES (1, ?, 'Compte 1', '777001')`).run(g);
  db.prepare(`INSERT INTO pool_accounts (player_id, game_id, label, okpay_tg_id) VALUES (1, ?, 'Compte 2', '777002')`).run(g);

  // Un règlement, et une période qui s'y adosse.
  const ms = db.prepare(`INSERT INTO manual_settlements (game_id, player_id, net_selected_usdt, action_pct_applied, amount_due_usdt, status)
                         VALUES (?, 1, -150, 30, -45, 'locked')`).run(g);
  const sid = Number(ms.lastInsertRowid);
  const per = db.prepare(`
    INSERT INTO pool_periods (player_id, game_id, opened_at, closed_at, pool_open, pool_open_source, pool_close, ext_in, ext_out, result, action_pct, action_amount, settlement_id)
    VALUES (1, ?, '2026-09-06 18:00:00', '2026-09-13 18:00:00', 1000, 'manual', 850, 0, 0, -150, 30, -45, ?)`).run(g, sid);
  const pid = Number(per.lastInsertRowid);

  // ⚠️ LA GARDE : le délock de /payments (DELETE FROM manual_settlements) doit
  // ÉCHOUER tant que la période existe — FK en NO ACTION.
  check("DELETE du règlement adossé à une période → refus FK (NO ACTION)", throws(() =>
    db.prepare(`DELETE FROM manual_settlements WHERE id = ?`).run(sid), /FOREIGN KEY/));
  eq("la période est toujours là", db.prepare(`SELECT COUNT(*) n FROM pool_periods WHERE id = ?`).get(pid), { n: 1 });

  // CONTREFACTUEL : le même DDL avec ON DELETE CASCADE laisserait passer le DELETE
  // et emporterait la période — exactement le bug de add_nexa_bankroll_weeks_v1.
  const cascaded = freshDb(POOL_SCHEMA_SQL.replace(
    "settlement_id    INTEGER REFERENCES manual_settlements(id),",
    "settlement_id    INTEGER REFERENCES manual_settlements(id) ON DELETE CASCADE,"));
  const gc = gid(cascaded);
  const msC = cascaded.prepare(`INSERT INTO manual_settlements (game_id, player_id, status) VALUES (?, 1, 'locked')`).run(gc);
  cascaded.prepare(`INSERT INTO pool_periods (player_id, game_id, opened_at, closed_at, pool_open, pool_open_source, pool_close, ext_in, ext_out, result, action_pct, action_amount, settlement_id)
    VALUES (1, ?, '2026-09-06 18:00:00', '2026-09-13 18:00:00', 1000, 'manual', 850, 0, 0, -150, 30, -45, ?)`).run(gc, Number(msC.lastInsertRowid));
  check("contrefactuel : avec CASCADE le DELETE passe…", !throws(() => cascaded.prepare(`DELETE FROM manual_settlements WHERE id = ?`).run(Number(msC.lastInsertRowid)), /./));
  eq("…et la période figée DISPARAÎT — c'est ce que NO ACTION empêche", cascaded.prepare(`SELECT COUNT(*) n FROM pool_periods`).get(), { n: 0 });

  // Soldes : main ⇔ account_id NULL, et une seule main par période.
  const insBal = (acc: number | null, kind: string, bal = 100) => db.prepare(`
    INSERT INTO pool_period_balances (period_id, account_id, wallet_kind, balance, observed_at, source)
    VALUES (?, ?, ?, ?, '2026-09-13 18:00:00', 'manual')`).run(pid, acc, kind, bal);
  insBal(1, "ak", 300); insBal(1, "okpay", 0); insBal(2, "ak", 150); insBal(2, "okpay", 0); insBal(null, "main", 400);
  check("main avec un account_id → refus CHECK", throws(() => insBal(1, "main"), /CHECK/));
  check("AK sans account_id → refus CHECK", throws(() => insBal(null, "ak"), /CHECK/));
  check("second solde main pour la même période → refus (index partiel)", throws(() => insBal(null, "main", 1), /UNIQUE/));
  check("second solde AK du même compte → refus UNIQUE", throws(() => insBal(1, "ak", 1), /UNIQUE/));
  // Sur un slot LIBRE (compte 3 n'a pas encore de solde) : c'est bien le CHECK qui refuse, pas UNIQUE.
  db.prepare(`INSERT INTO pool_accounts (player_id, game_id, label) VALUES (1, ?, 'Compte 3')`).run(g);
  check("solde négatif → refus CHECK (slot libre)", throws(() => insBal(3, "okpay", -1), /CHECK/));
  check("source 'okpay_ledger' sans okpay_line_id → refus CHECK", throws(() => db.prepare(`
    INSERT INTO pool_period_balances (period_id, account_id, wallet_kind, balance, observed_at, source)
    VALUES (?, 3, 'okpay', 0, '2026-09-13 18:00:00', 'okpay_ledger')`).run(pid), /CHECK/));
  check("observed_at en ISO « T » → refus CHECK (un seul format)", throws(() => db.prepare(`
    INSERT INTO pool_period_balances (period_id, account_id, wallet_kind, balance, observed_at, source)
    VALUES (?, 3, 'okpay', 0, '2026-09-13T18:00:00', 'manual')`).run(pid), /CHECK/));
  // CONTREFACTUEL : sans l'index partiel, UNIQUE(period_id, account_id, wallet_kind)
  // laisse passer deux mains (NULL ≠ NULL en SQL).
  const noIdx = freshDb(POOL_SCHEMA_SQL.replace(/CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_balances_one_main[^;]*;/, ""));
  const gn = gid(noIdx);
  const pn = noIdx.prepare(`INSERT INTO pool_periods (player_id, game_id, opened_at, closed_at, pool_open, pool_open_source, pool_close, ext_in, ext_out, result, action_pct, action_amount)
    VALUES (1, ?, '2026-09-06 18:00:00', '2026-09-13 18:00:00', 1000, 'manual', 850, 0, 0, -150, 30, -45)`).run(gn);
  const insN = () => noIdx.prepare(`INSERT INTO pool_period_balances (period_id, account_id, wallet_kind, balance, observed_at, source)
    VALUES (?, NULL, 'main', 1, '2026-09-13 18:00:00', 'manual')`).run(Number(pn.lastInsertRowid));
  insN();
  check("contrefactuel : sans l'index partiel, deux mains PASSENT (UNIQUE ne couvre pas NULL)", !throws(insN, /./));

  // Mouvement de règlement : un seul par règlement, sens et montant contraints.
  const insMv = (dir: string, amt: number, kind: string, s: number | null) => db.prepare(`
    INSERT INTO pool_external_movements (player_id, game_id, direction, amount, occurred_at, kind, settlement_id)
    VALUES (1, ?, ?, ?, '2026-09-15 09:00:00', ?, ?)`).run(g, dir, amt, kind, s);
  insMv("in", 45, "settlement", sid);
  check("second mouvement pour le même règlement → refus (index unique partiel)", throws(() => insMv("in", 45, "settlement", sid), /UNIQUE/));
  check("montant 0 → refus CHECK", throws(() => insMv("in", 0, "declared", null), /CHECK/));
  check("direction « none » → refus CHECK (ici, les deux sens comptent)", throws(() => insMv("none", 1, "declared", null), /CHECK/));
  insMv("out", 20, "declared", null); insMv("out", 30, "declared", null);
  eq("plusieurs mouvements déclarés sans settlement_id : ok (NULL hors index)", db.prepare(`SELECT COUNT(*) n FROM pool_external_movements`).get(), { n: 3 });
  // Sur un règlement ENCORE LIBRE dans l'index : c'est bien le CHECK qui refuse, pas UNIQUE.
  const sid2 = Number(db.prepare(`INSERT INTO manual_settlements (game_id, player_id, status) VALUES (?, 1, 'locked')`).run(g).lastInsertRowid);
  check("'declared' AVEC settlement_id → refus CHECK (n'occupe pas l'index du vrai mouvement)", throws(() => insMv("out", 1, "declared", sid2), /CHECK/));
  check("'settlement' SANS settlement_id → refus CHECK (pas répétable)", throws(() => insMv("in", 1, "settlement", null), /CHECK/));
  check("montant 0.004 → refus CHECK (cent-exact)", throws(() => insMv("in", 0.004, "declared", null), /CHECK/));
  check("occurred_at « 2026-09-15 » (jour seul) → refus CHECK", throws(() => db.prepare(`
    INSERT INTO pool_external_movements (player_id, game_id, direction, amount, occurred_at, kind) VALUES (1, ?, 'in', 1, '2026-09-15', 'declared')`).run(g), /CHECK/));

  // Périodes : bornes.
  const insPer = (o: string, c: string, pct = 30, src = "carry") => db.prepare(`
    INSERT INTO pool_periods (player_id, game_id, opened_at, closed_at, pool_open, pool_open_source, pool_close, ext_in, ext_out, result, action_pct, action_amount)
    VALUES (1, ?, ?, ?, 850, ?, 850, 0, 0, 0, ?, 0)`).run(g, o, c, src, pct);
  check("closed_at < opened_at → refus CHECK", throws(() => insPer("2026-09-20 18:00:00", "2026-09-13 18:00:00"), /CHECK/));
  check("même closed_at pour le même joueur/game → refus UNIQUE", throws(() => insPer("2026-09-06 18:00:00", "2026-09-13 18:00:00"), /UNIQUE/));
  check("action_pct 0 → refus CHECK", throws(() => insPer("2026-09-13 18:00:00", "2026-09-16 12:00:00", 0), /CHECK/));
  check("pool_open_source « guess » → refus CHECK", throws(() => insPer("2026-09-13 18:00:00", "2026-09-16 12:00:00", 30, "guess"), /CHECK/));
  check("clôture en milieu de semaine (mercredi midi) : acceptée", !throws(() => insPer("2026-09-13 18:00:00", "2026-09-16 12:00:00"), /./));
  check("même opened_at, autre closed_at → refus UNIQUE (deux résultats sur le même départ)", throws(() => insPer("2026-09-13 18:00:00", "2026-09-17 12:00:00"), /UNIQUE/));
  check("closed_at en ISO « T » → refus CHECK", throws(() => insPer("2026-09-16 12:00:00", "2026-09-18T12:00:00"), /CHECK/));
  // Provenance auto-certifiante : un résultat qui ne découle pas de ses entrées est refusé par le schéma.
  const insBad = (result: number, action: number) => db.prepare(`
    INSERT INTO pool_periods (player_id, game_id, opened_at, closed_at, pool_open, pool_open_source, pool_close, ext_in, ext_out, result, action_pct, action_amount)
    VALUES (1, ?, '2026-09-16 12:00:00', '2026-09-18 12:00:00', 1000, 'carry', 850, 0, 0, ?, 30, ?)`).run(g, result, action);
  check("result = +999 pour 1000 → 850 → refus CHECK (S4 de l'audit)", throws(() => insBad(999, 299.7), /CHECK/));
  check("action_amount incohérent avec result × pct → refus CHECK", throws(() => insBad(-150, -40), /CHECK/));
  check("action_amount −44.9985 (sub-centime) → refus CHECK cent-exact (B4)", throws(() => insBad(-150, -44.9985), /CHECK/));
  check("result −150, action −45 : cohérents, acceptés", !throws(() => insBad(-150, -45), /./));
  check("solde 100.001 → refus CHECK cent-exact", throws(() => insBal(3, "ak", 100.001), /CHECK/));
  check("second période sur le même règlement → refus (index unique)", throws(() => db.prepare(`
    INSERT INTO pool_periods (player_id, game_id, opened_at, closed_at, pool_open, pool_open_source, pool_close, ext_in, ext_out, result, action_pct, action_amount, settlement_id)
    VALUES (1, ?, '2026-09-18 12:00:00', '2026-09-19 12:00:00', 850, 'carry', 850, 0, 0, 0, 30, 0, ?)`).run(g, sid), /UNIQUE/));

  // Soft-close d'un compte : la ligne reste, closed_in_period_id référence une période réelle.
  check("closed_in_period_id vers une période inexistante → refus FK", throws(() =>
    db.prepare(`UPDATE pool_accounts SET closed_at = datetime('now'), closed_in_period_id = 999 WHERE id = 2`).run(), /FOREIGN KEY/));
  db.prepare(`UPDATE pool_accounts SET closed_at = datetime('now'), closed_in_period_id = ? WHERE id = 2`).run(pid);
  eq("compte clos : toujours en base, ses soldes passés lisibles",
     db.prepare(`SELECT COUNT(*) n FROM pool_period_balances b JOIN pool_accounts a ON a.id = b.account_id WHERE a.closed_at IS NOT NULL`).get(), { n: 2 });
  check("supprimer un compte référencé par des soldes → refus FK (on ne supprime jamais)", throws(() =>
    db.prepare(`DELETE FROM pool_accounts WHERE id = 2`).run(), /FOREIGN KEY/));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} ✔ · ${failures.length} ✘`);
if (failures.length > 0) { console.log("Échecs :\n - " + failures.join("\n - ")); process.exit(1); }
