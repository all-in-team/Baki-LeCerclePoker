// Suivi multi-comptes « AK multi-Account » — MOTEUR PUR.
//
// Zéro accès DB, zéro horloge : tout entre par les paramètres. Même découpage que
// lib/funnels/nexa/bankroll-engine (pur) vs bankroll (base).
//
// ─────────────────────────────────────────────────────────────────────────────
// CE MODULE NE CONTIENT AUCUNE NOUVELLE MATH D'ARGENT. Le résultat d'une période
// est calculé par computeBankrollWeek, le moteur bankroll NEXAPOKER, parce que
// c'est LA MÊME GRANDEUR :
//
//   résultat = (pool fin + sorties externes) − (pool début + entrées externes)
//            = (BR fin  + cash-outs)         − (BR début  + dépôts)
//
// Un second moteur pour la même grandeur, c'est deux vérités qui dérivent l'une
// de l'autre au premier correctif. On réutilise donc : la formule, l'arrondi au
// centime demi-supérieur en valeur absolue, le refus des saisies à trois
// décimales, le refus des montants négatifs, la convention de signe du repo
// (action_amount > 0 = le joueur doit au Cercle). (Arbitrage Baki, 2026-09-13.)
//
// Ce que ce module AJOUTE, et qui est propre au pool :
//   • la somme des soldes (sumPool) — le pool est une somme, la BR était un chiffre ;
//   • le sens du mouvement de règlement (settlementMovementFor) — cf. l'encadré ;
//   • les signaux de cohérence des soldes : écart d'horodatage, OkPay non nulle ;
//   • le contrôle de chaîne d'un historique OkPay (mode audit).
// ─────────────────────────────────────────────────────────────────────────────
import {
  EPS, round2, isCentExact, computeBankrollWeek, carriedBrOpen,
  type BankrollWeekComputed,
} from "@/lib/funnels/nexa/bankroll-engine";
import { POOL_OBSERVATION_SPREAD_WARN_MIN } from "./schema";

export { EPS, round2, isCentExact };

// ── Le calcul d'une période ───────────────────────────────────────────────────

export type PoolPeriodInput = {
  /** Pool de début — repris de la période précédente, ou saisi pour la première. */
  pool_open: number;
  /** Pool de fin = Σ des soldes de la clôture (cf. sumPool). */
  pool_close: number;
  /** Σ des entrées externes de la période (déclarées + mes versements de règlement). */
  ext_in: number;
  /** Σ des sorties externes (déclarées + ses règlements vers l'agence). */
  ext_out: number;
  /** Part d'action de player_game_deals, figée au lock. */
  action_pct: number;
};

export type PoolPeriodComputed = BankrollWeekComputed;
export type PoolComputeResult =
  | { ok: true; value: PoolPeriodComputed }
  | { ok: false; error: string };

// Les messages du moteur NEXA parlent de BR, de dépôts et de cash-outs. Ce sont
// les mêmes termes du même calcul ; on les renomme pour l'écran, sans toucher au
// moteur. Un libellé « BR de fin » sur un écran de pool ferait douter Baki de la
// grandeur calculée — à raison.
const LABEL_MAP: readonly [RegExp, string][] = [
  [/BR de début/g, "pool de début"],
  [/BR de fin/g, "pool de fin"],
  [/dépôts de la semaine/g, "entrées externes"],
  [/cash-outs de la semaine/g, "sorties externes"],
  [/le règlement BR ne concerne que les joueurs stakés/g, "le règlement pool ne concerne que les joueurs stakés"],
];

/**
 * Calcule une période de pool. DÉLÈGUE à computeBankrollWeek — c'est le point.
 *
 *   pool_open → br_open · pool_close → br_close · ext_in → deposits · ext_out → cashouts
 *
 * Sorties : result (signé), action_amount (signé, > 0 = il me doit),
 * transfer_amount (ce que je verse, toujours ≥ 0), next_br_open (= pool_close,
 * le pool de début de la période suivante, SANS le versement — cf. carriedPoolOpen).
 */
export function computePoolPeriod(i: PoolPeriodInput): PoolComputeResult {
  const r = computeBankrollWeek({
    br_open: i.pool_open, br_close: i.pool_close,
    deposits: i.ext_in, cashouts: i.ext_out, action_pct: i.action_pct,
  });
  if (r.ok) return r;
  let error = r.error;
  for (const [re, to] of LABEL_MAP) error = error.replace(re, to);
  return { ok: false, error };
}

/**
 * Pool de début repris de la période précédente : SON pool de fin, rien d'autre.
 *
 * Mon versement n'y est PAS ajouté — il compte comme une entrée externe dans la
 * période de sa date de paiement réelle (pool_external_movements kind='settlement').
 * Même raison qu'en NEXA (encadré de carriedBrOpen) : le reporter reviendrait à
 * supposer qu'il a eu lieu, et fabriquerait une seconde dette pour la même perte
 * s'il traîne.
 *
 * Et il ne dépend PAS de la liste des comptes : ajouter un compte en cours de
 * route ne peut donc pas créer de saut (cas limite n°2).
 */
export function carriedPoolOpen(prev: { pool_close: number }): number {
  return carriedBrOpen({ br_close: prev.pool_close });
}

// ── Le pool : une somme de soldes ─────────────────────────────────────────────

export type WalletKind = "ak" | "okpay" | "main";

export type BalanceReading = {
  /** null ⇔ wallet main. */
  account_id: number | null;
  /** Libellé du compte pour les messages (« Compte 2 ») ; « main » pour la main. */
  label: string;
  wallet_kind: WalletKind;
  balance: number;
  /** ISO-8601 ou « YYYY-MM-DD HH:MM:SS » — comparé lexicalement puis en Date. */
  observed_at: string;
};

export type SumResult = { ok: true; value: number } | { ok: false; error: string };

/**
 * Σ des soldes de la clôture = le pool de fin.
 *
 * Chaque solde est EXIGÉ au centime (il est tapé ou lu sur un historique, trois
 * décimales sont une faute) ; la somme, elle, est arrondie — une somme de
 * flottants cent-exacts dérive, l'arrondi la REND exacte au lieu de la déformer
 * (même raisonnement que deposits/cashouts dans computeBankrollWeek).
 *
 * La MAIN EST OBLIGATOIRE : un pool sans sa main n'est pas un pool, c'est un
 * sous-total qui lirait comme une perte du montant de la main.
 */
export function sumPool(readings: readonly BalanceReading[]): SumResult {
  const mains = readings.filter(r => r.wallet_kind === "main");
  if (mains.length !== 1) {
    return { ok: false, error: mains.length === 0
      ? "Solde de la wallet main manquant — sans lui le pool est un sous-total, pas un pool."
      : `${mains.length} soldes main pour une seule clôture.` };
  }
  let total = 0;
  for (const r of readings) {
    if (!Number.isFinite(r.balance)) return { ok: false, error: `${r.label} ${r.wallet_kind.toUpperCase()} : nombre attendu.` };
    if (r.balance < 0) return { ok: false, error: `${r.label} ${r.wallet_kind.toUpperCase()} : un solde négatif n'a pas de sens ici.` };
    if (!isCentExact(r.balance)) return { ok: false, error: `${r.label} ${r.wallet_kind.toUpperCase()} : deux décimales maximum (reçu ${r.balance}).` };
    total += r.balance;
  }
  return { ok: true, value: round2(total) };
}

// ── Le mouvement de règlement — LE point qui diffère de NEXA ──────────────────

export type SettlementMovement = { direction: "in" | "out"; amount: number };

/**
 * Ce que le paiement d'un règlement FAIT AU POOL.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Sa wallet main est DANS le pool. Donc :
 *   • action_amount < 0 (il a perdu) → je lui verse |action_amount| sur sa main :
 *     le pool GROSSIT → mouvement 'in', daté du paiement réel.
 *   • action_amount > 0 (il a gagné) → il me paie depuis sa main : le pool
 *     RÉTRÉCIT → mouvement 'out', daté du paiement réel.
 *
 * Chez NEXA le second cas était 'none' — il payait de sa poche, hors bankroll.
 * Ici sa poche EST le pool. Sans ce mouvement, la période suivante lirait mon
 * versement comme un gain (il me devrait une part de mon propre argent) ou son
 * règlement comme une perte (je paierais ma part de mon propre encaissement).
 * (Arbitrage Baki 2026-09-13 : « le point le plus important du chantier ».)
 *
 * null si la part est nulle : aucun règlement, aucun mouvement.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function settlementMovementFor(action_amount: number): SettlementMovement | null {
  // Une part INDÉTERMINÉE n'est pas une part nulle : « aucun mouvement » serait
  // une invention. On jette — l'appelant est dans la transaction de markPaid,
  // qui doit alors échouer. (Constat money-auditor 2026-09-13, B10.)
  if (!Number.isFinite(action_amount)) throw new Error(`Part d'action indéterminée (${action_amount}) — mouvement de règlement impossible.`);
  // Arrondi AVANT le test : 0.004 arrondi vaut 0, et un mouvement à 0 violerait
  // CHECK(amount > 0) en base au lieu d'être simplement absent.
  const amount = round2(Math.abs(action_amount));
  if (amount <= EPS) return null;
  return action_amount < 0 ? { direction: "in", amount } : { direction: "out", amount };
}

// ── A3 — la DATE du règlement : un jour, contre des bornes à la seconde ───────

/** Format unique de tous les horodatages du pool : « YYYY-MM-DD HH:MM:SS », heure murale OkPay. */
export const POOL_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** closed_at + 1 seconde, dans le format du pool. */
export function oneSecondAfter(ts: string): string {
  if (!isPoolTimestamp(ts)) throw new Error(`Horodatage « ${ts} » hors format YYYY-MM-DD HH:MM:SS ou hors calendrier.`);
  const d = new Date(ts.replace(" ", "T") + "Z");
  d.setUTCSeconds(d.getUTCSeconds() + 1);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Format ET calendrier : « 2026-02-30 12:00:00 » a la bonne forme et n'existe pas.
 * Le GLOB du schéma ne vérifie que la forme ; c'est ici (et dans la couche DB,
 * pour closed_at) que le calendrier se vérifie. (Constat money-auditor, B3.)
 */
export function isPoolTimestamp(ts: string): boolean {
  if (!POOL_TS_RE.test(ts)) return false;
  const d = new Date(ts.replace(" ", "T") + "Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 19).replace("T", " ") === ts;
}

export type SettlementDateResult = { ok: true; occurred_at: string } | { ok: false; error: string };

/**
 * À quel INSTANT dater le mouvement de règlement, quand /payments ne donne qu'un JOUR.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE TROU. Période close le 15 à 18:00, ext_in figé. Baki paie le 15 à 20:00 et
 * déclare paid_date = 2026-09-15. Daté « 2026-09-15 » ou « 2026-09-15 00:00:00 »,
 * ce mouvement tombe lexicalement DANS la période close (dont la somme est figée
 * sans lui) et HORS de la suivante ]15 18:00, …] : compté nulle part. La période
 * suivante lit alors mon versement comme un gain → il me doit 13,50 sur mon
 * propre argent. C'est la faille §4, réintroduite par la granularité de la date.
 * (Constat money-auditor 2026-09-13, A3.)
 *
 * LA RÈGLE. Le paiement d'un règlement a lieu APRÈS la clôture qu'il règle — par
 * définition : la part est calculée sur la photo de clôture. Donc :
 *
 *   occurred_at = max( paid_date 00:00:00 , closed_at + 1 s )
 *
 * Le même jour que la clôture → une seconde après elle, dans la période suivante.
 * Un jour ultérieur → ce jour à 00:00:00 (l'heure exacte est inconnue et sans
 * importance : la seule frontière qui compte est la clôture réglée, et la règle
 * d'exploitation ci-dessous garantit qu'aucune autre clôture ne s'est glissée
 * entre). C'est l'analogue des « late transactions belong to the next open week »
 * de weekly_settlements.
 *
 * paid_date ANTÉRIEUR au jour de la clôture → REFUS : payé avant la photo, le
 * montant est déjà DANS pool_close et la part a été calculée dessus. Cette
 * période est fausse, elle se déverrouille, elle ne se paie pas.
 *
 * CE QUI REND LA RÈGLE SUFFISANTE — la règle d'exploitation héritée de NEXA, que
 * la couche DB (phase 2) doit imposer : ON NE CLÔTURE PAS UNE PÉRIODE TANT QUE LE
 * RÈGLEMENT DE LA PRÉCÉDENTE EST 'locked'. Sans elle, une période postérieure
 * pourrait être figée entre la clôture réglée et le paiement, et le mouvement
 * daté ici tomberait dans une somme déjà figée. Avec elle, la période qui suit
 * la clôture réglée est TOUJOURS ouverte au moment du markPaid, et le mouvement
 * y tombe. Ceinture en phase 2 : refuser un occurred_at ≤ closed_at de toute
 * période figée du joueur.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function settlementOccurredAt(paidDate: string, settledClosedAt: string): SettlementDateResult {
  if (!isPoolTimestamp(`${paidDate} 00:00:00`)) return { ok: false, error: `Date de paiement « ${paidDate} » — attendu YYYY-MM-DD, date existante.` };
  if (!isPoolTimestamp(settledClosedAt)) return { ok: false, error: `Clôture « ${settledClosedAt} » hors format YYYY-MM-DD HH:MM:SS ou hors calendrier.` };
  const closedDay = settledClosedAt.slice(0, 10);
  if (paidDate < closedDay) {
    return { ok: false, error: `Date de paiement ${paidDate} antérieure à la clôture réglée (${settledClosedAt}) : payé avant la photo, `
                              + `le montant est déjà dans le pool de fin et la part a été calculée dessus. Déverrouille la période au lieu de la payer.` };
  }
  const dayStart = `${paidDate} 00:00:00`;
  const after = oneSecondAfter(settledClosedAt);
  return { ok: true, occurred_at: dayStart > after ? dayStart : after };
}

// ── Signaux de cohérence des soldes (cas limite n°3 et OkPay ≠ 0) ────────────

export type PoolWarning = {
  code: "observation_spread" | "okpay_nonzero" | "main_stale";
  message: string;
};

/**
 * Horodatage → millisecondes, dans UNE SEULE convention.
 *
 * Les dates OkPay (« YYYY-MM-DD HH:MM:SS ») sont SANS FUSEAU : ce sont des heures
 * murales telles que l'app les affiche. Date.parse les lirait en heure LOCALE DU
 * SERVEUR — Railway (UTC) et le Mac de Baki (Paris) ne donneraient pas le même
 * écart, et un virement en vol passerait ou non selon la machine. On les lit donc
 * comme UTC, systématiquement : tous les observed_at et closed_at du pool sont
 * des heures murales au format OkPay, comparés entre eux dans cette convention.
 * Une ISO explicite (« …Z », « …+02:00 ») est respectée telle quelle — ne pas
 * mélanger les deux sur une même clôture, sauf si le fuseau d'OkPay est UTC.
 */
function toMs(s: string): number {
  const t = s.trim();
  const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t);
  const ms = Date.parse(naive ? t.replace(" ", "T") + "Z" : t);
  return Number.isFinite(ms) ? ms : NaN;
}

export type SpreadResult = {
  spread_min: number;
  oldest: BalanceReading | null;
  newest: BalanceReading | null;
  warning: PoolWarning | null;
};

/**
 * Écart entre le plus ancien et le plus récent des horodatages de la clôture.
 *
 * Tous les soldes d'une clôture doivent être pris AU MÊME INSTANT : un virement
 * en transit entre deux poches du pool est compté deux fois ou pas du tout si
 * les deux poches sont lues à des instants différents. Au-delà du seuil :
 * AVERTISSEMENT, jamais blocker — une main sans activité depuis trois jours a
 * légitimement un observed_at ancien (arbitrage Baki : 30 min, confirmation).
 * Un horodatage illisible est un avertissement à lui seul : il ne peut pas être
 * comparé, donc il ne peut pas rassurer.
 */
export function observationSpread(
  readings: readonly BalanceReading[],
  thresholdMin: number = POOL_OBSERVATION_SPREAD_WARN_MIN,
): SpreadResult {
  const bad = readings.find(r => Number.isNaN(toMs(r.observed_at)));
  if (bad) {
    return { spread_min: NaN, oldest: null, newest: null, warning: {
      code: "observation_spread",
      message: `Horodatage illisible sur ${bad.label} ${bad.wallet_kind.toUpperCase()} (« ${bad.observed_at} ») — impossible de vérifier que les soldes sont pris au même instant.`,
    } };
  }
  if (readings.length < 2) return { spread_min: 0, oldest: readings[0] ?? null, newest: readings[0] ?? null, warning: null };
  let oldest = readings[0], newest = readings[0];
  for (const r of readings) {
    if (toMs(r.observed_at) < toMs(oldest.observed_at)) oldest = r;
    if (toMs(r.observed_at) > toMs(newest.observed_at)) newest = r;
  }
  const spread = (toMs(newest.observed_at) - toMs(oldest.observed_at)) / 60000;
  const warning: PoolWarning | null = spread > thresholdMin ? {
    code: "observation_spread",
    message: `Soldes pris à ${Math.round(spread)} min d'écart (${oldest.label} ${oldest.wallet_kind.toUpperCase()} à ${oldest.observed_at}, `
           + `${newest.label} ${newest.wallet_kind.toUpperCase()} à ${newest.observed_at}) — un virement en transit entre les deux `
           + `serait compté deux fois ou pas du tout. Confirme que rien n'a bougé entre-temps.`,
  } : null;
  return { spread_min: spread, oldest, newest, warning };
}

/**
 * Les OkPay de compte sont du TRANSIT : normalement à 0. Une OkPay non nulle veut
 * dire qu'un virement est resté en route — l'argent est bien dans le pool (donc
 * compté juste), mais Baki doit le savoir. Signal, pas erreur.
 * Garder de l'argent sur AK, lui, est normal et voulu : aucun signal.
 */
export function nonZeroOkpayWarnings(readings: readonly BalanceReading[]): PoolWarning[] {
  return readings
    .filter(r => r.wallet_kind === "okpay" && r.balance > EPS)
    .map(r => ({
      code: "okpay_nonzero" as const,
      message: `${r.label} : OkPay à ${r.balance.toFixed(2)} au lieu de 0 — un virement est resté en route ?`,
    }));
}

// ── Historique OkPay : solde à un instant, et contrôle de chaîne ─────────────

export type LedgerLine = {
  id?: number;
  direction: "+" | "-";
  amount: number;
  balance_after: number;
  /** « YYYY-MM-DD HH:MM:SS » tel que porté par le message OkPay. */
  occurred_at: string;
  counterparty_tg_id?: string | null;
};

/** Le solde attendu après `cur` si elle suit une ligne dont le solde était `prevBalance`. */
function expectedAfter(prevBalance: number, cur: LedgerLine): number {
  return round2(prevBalance + (cur.direction === "+" ? cur.amount : -cur.amount));
}

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

/** Au-delà, on ne permute plus (720 ordres) : l'id fait foi, et checkLedgerChain le dira. */
const MAX_SAME_SECOND_PERMUTE = 6;

export type LedgerAmbiguity = {
  occurred_at: string;
  /** Les soldes finaux possibles selon l'ordre — s'ils diffèrent, balanceAt à cet instant n'est pas déterminable. */
  possible_final_balances: number[];
};

export type SortedLedger<T> = { sorted: T[]; ambiguities: LedgerAmbiguity[] };

/**
 * Ordre chronologique — et, À LA MÊME SECONDE, l'ordre où la chaîne tient.
 *
 * L'id n'est PAS un ordre fiable : il reflète l'ordre d'insertion, donc l'ordre
 * du message OkPay, qui va du plus récent au plus ancien. Deux opérations à la
 * même seconde insérées dans cet ordre se retrouvaient inversées : balanceAt
 * rendait l'avant-dernier solde (pool surévalué → part fantôme) et
 * checkLedgerChain signalait des ruptures qui n'existaient pas. (Constat
 * money-auditor 2026-09-13, A2.)
 *
 * Pour chaque groupe de lignes à la même seconde :
 *   1. on garde les ordres où chaque balance_after découle du précédent, en
 *      partant du solde de la ligne qui PRÉCÈDE le groupe ;
 *   2. s'il y a une ligne APRÈS le groupe, on préfère les ordres dont le dernier
 *      solde chaîne vers elle (look-ahead) ;
 *   3. pour un groupe EN TÊTE (aucun prédécesseur), seules les transitions
 *      internes sont vérifiables : sans ligne suivante pour trancher, deux
 *      ordres cohérents peuvent finir sur des soldes DIFFÉRENTS (+100→100 puis
 *      −100→0, ou l'inverse). On ne tranche pas par id : on le SIGNALE dans
 *      `ambiguities`, et balanceAt le remonte. (Constat money-auditor, B1.)
 *   4. aucun ordre cohérent → vraie rupture dans la seconde : l'id départage
 *      et checkLedgerChain la signalera.
 *
 * LIMITE CONNUE (money-auditor, B2) : une ligne MANQUANTE dans un groupe peut
 * être absorbée par une paire compensante (+30 / −30) — la permutation trouve
 * alors un ordre cohérent qui ne l'est que par accident, et le solde retenu est
 * celui d'une autre ligne. Elle est rattrapée par la ligne suivante quand il y
 * en a une (la rupture se déplace), pas quand le groupe clôt la page. Inhérent
 * à une chaîne dont l'ordre intra-seconde n'est pas porté par la source.
 * Avec un prédécesseur, deux ordres cohérents complets finissent toujours sur le
 * même solde (prev + Σ) : l'ambiguïté ne porte alors que sur l'identité de la
 * ligne retenue, jamais sur le montant.
 */
export function sortLedgerDetailed<T extends LedgerLine>(lines: readonly T[]): SortedLedger<T> {
  const byTime = [...lines].sort((a, b) =>
    a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : (a.id ?? 0) - (b.id ?? 0));

  const sorted: T[] = [];
  const ambiguities: LedgerAmbiguity[] = [];
  let i = 0;
  while (i < byTime.length) {
    let j = i;
    while (j < byTime.length && byTime[j].occurred_at === byTime[i].occurred_at) j++;
    const group = byTime.slice(i, j);
    const next = byTime[j] ?? null;
    if (group.length === 1 || group.length > MAX_SAME_SECOND_PERMUTE) { sorted.push(...group); i = j; continue; }

    const prev = sorted.length > 0 ? sorted[sorted.length - 1] : null;
    const coherent = (order: T[]): boolean => {
      let bal = prev ? prev.balance_after : order[0].balance_after;
      for (let k = prev ? 0 : 1; k < order.length; k++) {
        if (Math.abs(expectedAfter(bal, order[k]) - order[k].balance_after) > EPS) return false;
        bal = order[k].balance_after;
      }
      return true;
    };
    const chainsToNext = (order: T[]): boolean =>
      next !== null && Math.abs(expectedAfter(order[order.length - 1].balance_after, next) - next.balance_after) <= EPS;

    const candidates = permutations(group).filter(coherent);
    let chosen: T[];
    if (candidates.length === 0) {
      chosen = group;                                   // vraie rupture : l'id, et la chaîne le dira
    } else {
      const lookahead = candidates.filter(chainsToNext);
      const pool = lookahead.length > 0 ? lookahead : candidates;
      chosen = pool[0];
      const finals = [...new Set(pool.map(o => o[o.length - 1].balance_after))];
      if (finals.length > 1) ambiguities.push({ occurred_at: group[0].occurred_at, possible_final_balances: finals.sort((a, b) => a - b) });
    }
    sorted.push(...chosen);
    i = j;
  }
  return { sorted, ambiguities };
}

/** L'ordre seul — pour les appelants qui ne regardent pas l'ambiguïté (checkLedgerChain). */
export function sortLedger<T extends LedgerLine>(lines: readonly T[]): T[] {
  return sortLedgerDetailed(lines).sorted;
}

/**
 * Solde de la wallet À L'INSTANT `at` : le balance_after de la dernière ligne
 * ≤ at. Les lignes postérieures sont IGNORÉES (elles appartiennent à la période
 * suivante). null si aucune ligne n'est antérieure : le solde est inconnu, il se
 * demande, il ne se suppose pas à 0.
 */
export function balanceAt(lines: readonly LedgerLine[], at: string):
  { line: LedgerLine; balance: number; ambiguity: LedgerAmbiguity | null } | null {
  const { sorted, ambiguities } = sortLedgerDetailed(lines);
  const upTo = sorted.filter(l => l.occurred_at <= at);
  if (upTo.length === 0) return null;
  const line = upTo[upTo.length - 1];
  // Le solde retenu n'est certain que si l'ordre de SA seconde ne l'est pas moins :
  // une ambiguïté sur une seconde antérieure est déjà résorbée (prev + Σ), seule
  // celle de la dernière seconde retenue rend ce solde indéterminable.
  const ambiguity = ambiguities.find(a => a.occurred_at === line.occurred_at) ?? null;
  return { line, balance: line.balance_after, ambiguity };
}

export type ChainBreak = {
  /** Dernière ligne cohérente avant la rupture. */
  before: LedgerLine;
  /** Première ligne après la rupture : son balance_after ne découle pas de `before`. */
  after: LedgerLine;
  expected_after: number;
  /** Ce qui manque entre les deux : Σ des lignes absentes, signée (positive = entrées manquantes). */
  missing_delta: number;
};

/**
 * MODE AUDIT — la chaîne d'un historique tient-elle ?
 *
 *   balance_after[n] = balance_after[n−1] + amount[n]   (direction '+')
 *   balance_after[n] = balance_after[n−1] − amount[n]   (direction '-')
 *
 * Si l'égalité casse entre n−1 et n, il manque des lignes entre occurred_at[n−1]
 * et occurred_at[n] : Baki réclame la page. missing_delta dit combien d'argent
 * net a bougé dans le trou. Comparaison au centime via round2, JAMAIS avec == :
 * les balance_after sont lus dans du texte, les amounts aussi, et 0.1 + 0.2 ≠ 0.3.
 *
 * Une chaîne d'une ligne ou vide ne casse pas — elle ne prouve rien non plus.
 */
export function checkLedgerChain(lines: readonly LedgerLine[]): ChainBreak[] {
  const sorted = sortLedger(lines);
  const breaks: ChainBreak[] = [];
  for (let n = 1; n < sorted.length; n++) {
    const prev = sorted[n - 1], cur = sorted[n];
    const expected = expectedAfter(prev.balance_after, cur);
    if (Math.abs(expected - cur.balance_after) > EPS) {
      breaks.push({ before: prev, after: cur, expected_after: expected,
                    missing_delta: round2(cur.balance_after - expected) });
    }
  }
  return breaks;
}

/**
 * MODE AUDIT — flux externes NON DÉCLARÉS, vus depuis l'historique de la main.
 *
 * Une ligne de la main dont la contrepartie n'est ni un compte du joueur ni
 * l'agence est un mouvement externe : entrée ('+') ou sortie ('-'). Ce que
 * Baki a déclaré à la clôture doit couvrir Σ de ces lignes ; l'écart est ce
 * qu'il ne savait pas. Les lignes vers/depuis l'agence sont des règlements —
 * rapprochées séparément (settlement).
 */
export function classifyMainLines(
  lines: readonly LedgerLine[],
  accountOkpayIds: ReadonlySet<string>,
  agencyId: string,
): { internal: LedgerLine[]; settlement: LedgerLine[]; external: LedgerLine[] } {
  const internal: LedgerLine[] = [], settlement: LedgerLine[] = [], external: LedgerLine[] = [];
  for (const l of lines) {
    const cp = l.counterparty_tg_id ?? null;
    if (cp !== null && accountOkpayIds.has(cp)) internal.push(l);
    else if (cp === agencyId) settlement.push(l);
    else external.push(l);
  }
  return { internal, settlement, external };
}
