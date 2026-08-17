// Règlement hebdomadaire sur BANKROLL — branchement du moteur sur la base.
//
// Deux formes par fonction publique, `x()` sur la prod et `xOn(db, …)` sur une
// base explicite, pour que les tests exercent les vraies contraintes SQL. Même
// parti pris que ./players et ./action-settlement.
//
// ─────────────────────────────────────────────────────────────────────────────
// LA BR N'EST PAS UN SECOND RÉSULTAT — ELLE EST LA SOURCE DU WIN/LOSS.
//
// Le verrouillage écrit, DANS UNE SEULE TRANSACTION :
//   1. le mouvement de mon versement (si le joueur a perdu) ;
//   2. la ligne manual_settlements (kind='action') + nexa_action_settlement_weeks ;
//   3. la ligne nexa_player_bankroll_weeks (la provenance figée) ;
//   4. la ligne nexa_player_weekly_winloss — LA table de résultat du repo.
//
// Rien n'est persisté AVANT ce clic : pas de brouillon, pas de statut 'draft'.
// Une ligne brouillon serait une seconde copie mutable des chiffres de la
// semaine, c'est-à-dire exactement le risque que ce chantier existe pour
// éliminer. L'aperçu est calculé à la volée PAR LA MÊME FONCTION que le
// verrouillage (computeBankrollWeek), donc l'écran ne peut pas montrer autre
// chose que ce qui sera écrit.
//
// POURQUOI PASSER PAR nexa_action_settlement_weeks plutôt que par un ancrage à
// moi : son UNIQUE(player_id, week_start) est ce qui rend le double règlement
// impossible AU NIVEAU DU SCHÉMA. Avec deux ancrages, une semaine pourrait être
// réglée une fois par la BR et une fois par le flux d'action de la vue détail —
// donc payée deux fois. Un seul ancrage, une seule fois.
//
// POURQUOI NE PAS PASSER PAR lockNexaActionSettlement : ce chemin-là exige que
// la semaine existe dans nexa_affiliate_weeks (le moteur ne connaît que les
// semaines du report). Or la photo de BR arrive AVANT le report d'affiliation :
// le règlement échouerait systématiquement en « semaine inconnue ». On écrit
// donc les mêmes tables avec nos propres règles d'éligibilité — qui ne
// dépendent pas du rake, puisque le résultat BR n'en dépend pas non plus.
// Quand le report arrive, la semaine entre dans le moteur, se retrouve dans
// settledSet, et sort de action_unsettled : la chaîne se referme d'elle-même.
// ─────────────────────────────────────────────────────────────────────────────
import { getDb } from "@/lib/db";
import type BetterSqlite3 from "better-sqlite3";
import { NEXA_GAME_NAME, isMondayISO } from "./affiliate-ingest";
import {
  EPS, round2, computeBankrollWeek, carriedBrOpen, isCentExact,
  type BankrollWeekComputed,
} from "./bankroll-engine";

type DB = BetterSqlite3.Database;

function gameId(db: DB): number {
  const g = db.prepare(`SELECT id FROM games WHERE name = ?`).get(NEXA_GAME_NAME) as { id: number } | undefined;
  if (!g) throw new Error(`Game ${NEXA_GAME_NAME} absent — la migration add_nexa_affiliate_v1 n'a pas tourné.`);
  return g.id;
}

/** Dimanche de la semaine ouverte par ce lundi. Fenêtre INCLUSIVE des deux côtés. */
export function weekEnd(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

/** Lundi suivant — la semaine que la clôture ouvre. */
export function nextWeek(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

export type BankrollWeekRow = {
  id: number;
  player_id: number;
  week_start: string;
  br_open: number;
  br_open_source: "carry" | "manual";
  br_close: number;
  deposits: number;
  cashouts: number;
  result: number;
  action_pct: number;
  action_amount: number;
  transfer_movement_id: number | null;
  settlement_id: number | null;
  note: string | null;
  locked_at: string;
};

/** Historique des semaines figées d'un joueur, de la plus ancienne à la plus récente. */
export function getBankrollWeeksOn(db: DB, playerId: number): BankrollWeekRow[] {
  return db.prepare(
    `SELECT * FROM nexa_player_bankroll_weeks WHERE player_id = ? ORDER BY week_start`
  ).all(playerId) as BankrollWeekRow[];
}

export function getBankrollWeeks(playerId: number) { return getBankrollWeeksOn(getDb(), playerId); }

/** Dernière semaine figée — c'est elle qui porte la BR de départ de la suivante. */
export function getLastBankrollWeekOn(db: DB, playerId: number): BankrollWeekRow | null {
  return (db.prepare(
    `SELECT * FROM nexa_player_bankroll_weeks WHERE player_id = ? ORDER BY week_start DESC LIMIT 1`
  ).get(playerId) as BankrollWeekRow | undefined) ?? null;
}

/**
 * Cette semaine est-elle pilotée par la bankroll ?
 *
 * C'est la SEULE question qui décide si la grille win/loss peut écrire dessus.
 * Une colonne `source` dupliquée dans nexa_player_weekly_winloss répondrait à la
 * même question depuis un second endroit : deux réponses possibles pour un seul
 * fait, donc une divergence garantie le jour où l'une des deux écritures manque.
 */
export function isBankrollWeekOn(db: DB, playerId: number, weekStart: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM nexa_player_bankroll_weeks WHERE player_id = ? AND week_start = ?`
  ).get(playerId, weekStart);
}

/** Joueurs dont CETTE semaine est pilotée par la BR — pour griser la grille. */
export function getBankrollLockedForWeekOn(db: DB, weekStart: string): Set<number> {
  const rows = db.prepare(
    `SELECT player_id FROM nexa_player_bankroll_weeks WHERE week_start = ?`
  ).all(weekStart) as { player_id: number }[];
  return new Set(rows.map(r => r.player_id));
}

/**
 * La semaine figée qui contient cette date, s'il y en a une.
 *
 * Sert le refus des mouvements tardifs. La règle des règlements hebdomadaires
 * (« une transaction tardive appartient à la semaine ouverte suivante »,
 * invariant #11) NE MARCHE PAS ici : la fenêtre d'une semaine BR est bornée par
 * les dates, donc un mouvement daté dans une semaine close ne serait compté ni
 * dans celle-ci (figée) ni dans la suivante (hors fenêtre). Il disparaîtrait.
 * D'où le refus dur, arbitré par Hugo le 2026-08-17.
 */
export function findBankrollWeekForDateOn(db: DB, playerId: number, txDate: string): BankrollWeekRow | null {
  return (db.prepare(
    `SELECT * FROM nexa_player_bankroll_weeks
      WHERE player_id = ? AND week_start <= ? AND date(week_start, '+6 days') >= ?
      LIMIT 1`
  ).get(playerId, txDate, txDate) as BankrollWeekRow | undefined) ?? null;
}

/** Part d'action en vigueur AU LUNDI de la semaine — même règle que le moteur. */
export function actionPctAtOn(db: DB, playerId: number, weekStart: string): number {
  const r = db.prepare(`
    SELECT pct FROM nexa_player_action_shares
     WHERE player_id = ? AND start_week <= ? AND (end_week IS NULL OR end_week >= ?)
     ORDER BY start_week DESC, id DESC LIMIT 1
  `).get(playerId, weekStart, weekStart) as { pct: number } | undefined;
  return r?.pct ?? 0;
}

export type CountedMovement = {
  id: number;
  /** Sens du grand livre — pas forcément celui de la bankroll, cf. `br_effect`. */
  type: "deposit" | "withdrawal";
  amount: number; tx_date: string; note: string | null;
  /**
   * Effet sur la BANKROLL, qui est la seule chose que le calcul regarde :
   *   'in'   → l'argent entre dans sa bankroll (buy-in, ou mon versement)
   *   'out'  → il en sort (cash-out)
   *   'none' → il ne la touche pas (son règlement d'une semaine gagnante)
   */
  br_effect: "in" | "out" | "none";
};

/**
 * Mouvements de la semaine, et ce que chacun fait à la BANKROLL.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE SENS DU GRAND LIVRE N'EST PAS LE SENS DE LA BANKROLL. C'est le piège de
 * tout ce chantier, et il vit ici.
 *
 *   • buy-in         → 'deposit'    au grand livre · ENTRE dans la bankroll
 *   • cash-out       → 'withdrawal' au grand livre · SORT de la bankroll
 *   • MON VERSEMENT  → 'withdrawal' au grand livre (l'opérateur paie le joueur,
 *     docs/DOMAIN.md) mais l'argent ENTRE dans sa bankroll : il atterrit sur sa
 *     wallet game. Le compter en cash-out le compterait à l'envers, deux fois.
 *   • SON RÈGLEMENT d'une semaine gagnante → 'deposit' au grand livre, mais il
 *     ne TOUCHE PAS sa bankroll : il me paie de sa poche. Hors calcul.
 *
 * Les deux derniers se reconnaissent par `transfer_movement_id`, et leur sens se
 * lit sur le signe de l'`action_amount` FIGÉ de la semaine qui les porte.
 *
 * Le versement est donc compté DANS LA SEMAINE DE SA DATE DE PAIEMENT — pas
 * reporté sur la BR de départ de la semaine suivante. C'est ce qui rend le
 * modèle auto-correcteur : payé tôt ou tard, l'argent est compté une fois et au
 * bon endroit, et clôturer une semaine ne dépend jamais d'un paiement en
 * attente. (Arbitrage Hugo 2026-08-17, sur constat money-auditor.)
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function getWeekMovementsOn(db: DB, playerId: number, weekStart: string): CountedMovement[] {
  const gid = gameId(db);
  const rows = db.prepare(`
    SELECT wt.id, wt.type, wt.amount, wt.tx_date, wt.note,
           br.action_amount AS settle_action
      FROM wallet_transactions wt
      LEFT JOIN nexa_player_bankroll_weeks br ON br.transfer_movement_id = wt.id
     WHERE wt.player_id = ? AND wt.game_id = ? AND wt.source = 'manual'
       AND (wt.status IS NULL OR wt.status = 'active')
       -- invariant #3 : jamais d'agrégat entre devises sans toUsdt().
       AND wt.currency = 'USDT'
       AND wt.tx_date >= ? AND wt.tx_date <= ?
     ORDER BY wt.tx_date, wt.id
  `).all(playerId, gid, weekStart, weekEnd(weekStart)) as
    (Omit<CountedMovement, "br_effect"> & { settle_action: number | null })[];

  return rows.map(({ settle_action, ...m }) => ({
    ...m,
    br_effect: settle_action === null
      ? (m.type === "deposit" ? "in" : "out")   // mouvement de jeu ordinaire
      : settle_action < 0
        ? "in"                                   // mon versement : il entre dans sa BR
        : "none",                                // son règlement : il ne la touche pas
  }));
}

export type BankrollPreview = {
  player_id: number;
  player_name: string;
  week_start: string;
  week_end: string;
  action_pct: number;
  /** null = première semaine du joueur : la BR de départ doit être SAISIE. */
  br_open: number | null;
  br_open_source: "carry" | "manual";
  /** Semaine dont la BR de départ est reprise. null pour une première semaine. */
  carried_from: string | null;
  deposits: number;
  cashouts: number;
  movements: CountedMovement[];
  /** Refus DURS : tant qu'il y en a, le verrouillage est impossible. */
  blockers: string[];
  /** null tant que la BR de fin n'est pas fournie, ou si un blocker existe. */
  computed: BankrollWeekComputed | null;
};

/**
 * Tout ce qu'il faut pour afficher — et pour verrouiller — une semaine.
 *
 * Le verrouillage rappelle cette fonction et recalcule : l'écran envoie une BR
 * de fin, jamais un montant. Ce qu'il affichait a pu être calculé avant l'ajout
 * d'un buy-in. Même doctrine que settle-action (« le corps ne porte QUE des
 * semaines, jamais un montant »).
 */
export function previewBankrollWeekOn(
  db: DB,
  args: { player_id: number; week_start: string; br_close?: number | null; br_open_manual?: number | null; today: string },
): { ok: true; preview: BankrollPreview } | { ok: false; error: string } {
  const { player_id, week_start } = args;

  const p = db.prepare(`SELECT id, name FROM players WHERE id = ?`).get(player_id) as
    { id: number; name: string } | undefined;
  if (!p) return { ok: false, error: `Joueur ${player_id} introuvable.` };
  if (!isMondayISO(week_start)) {
    return { ok: false, error: `Semaine « ${week_start} » invalide — attendu la date d'un LUNDI.` };
  }

  const blockers: string[] = [];

  if (isBankrollWeekOn(db, player_id, week_start)) {
    blockers.push(`Semaine ${week_start} déjà figée. Pour la corriger, déverrouille-la d'abord.`);
  }
  // Semaine déjà réglée par l'AUTRE chemin (le flux d'action de la vue détail).
  // L'UNIQUE de nexa_action_settlement_weeks la rejetterait de toute façon dans la
  // transaction, mais l'écran n'aurait qu'un « UNIQUE constraint failed » brut. On
  // nomme la semaine et le règlement, comme le fait lockNexaActionSettlementOn.
  const dejaReglee = db.prepare(
    `SELECT settlement_id FROM nexa_action_settlement_weeks WHERE player_id = ? AND week_start = ?`
  ).get(player_id, week_start) as { settlement_id: number } | undefined;
  if (dejaReglee) {
    blockers.push(
      `Semaine ${week_start} déjà réglée par le flux d'action (règlement #${dejaReglee.settlement_id}). ` +
      `La régler une seconde fois depuis la bankroll la paierait deux fois.`,
    );
  }
  // LA SEMAINE DOIT ÊTRE STRICTEMENT TERMINÉE. Pas seulement « commencée ».
  //
  // Figer le mercredi verrouille lundi→dimanche, et addMovementOn refuse ensuite
  // TOUT mouvement du jeudi au dimanche — y compris depuis la commande Telegram.
  // Ces buy-ins et cash-outs ne seraient enregistrables nulle part : ni dans la
  // semaine (figée), ni dans la suivante (hors fenêtre). Le résultat de la semaine
  // et la BR de départ de la suivante seraient faux d'autant, en silence.
  //
  // D'où la borne sur la FIN de semaine et non sur son début : on refuse tant que
  // le dimanche n'est pas passé. Clôturer le dimanche soir est donc refusé aussi —
  // c'est le prix, et il est petit face à un mouvement qui disparaît.
  // (Constat money-auditor 2026-08-17.)
  const wEnd = weekEnd(week_start);
  if (wEnd >= args.today) {
    blockers.push(
      `Semaine ${week_start} pas terminée (elle court jusqu'au ${wEnd}, aujourd'hui ${args.today}). ` +
      `La figer maintenant rendrait impossible la saisie de tout mouvement d'ici dimanche.`,
    );
  }

  // RÈGLEMENT BR PRÉCÉDENT NON MARQUÉ PAYÉ : on ne clôture pas par-dessus.
  //
  // Le versement compte comme un dépôt de bankroll À SA DATE. Tant qu'un règlement
  // reste 'locked', le système ne sait pas si l'argent a bougé : s'il a bougé sans
  // être enregistré, la photo de fin de semaine le CONTIENT (sa BR a grossi) mais
  // le calcul l'ignore — le résultat est surévalué du montant du versement, et une
  // part d'action fantôme naît au débit du joueur. Pire, une fois cette semaine
  // figée, le vrai paiement devient inenregistrable : sa date tombe dans une
  // semaine close, et le garde de writeBankrollTransferOnPaid le refuse.
  //
  // Ce n'est PAS le modèle du report (qui SUPPOSAIT le paiement) : ici on l'EXIGE
  // avant de continuer. Le modèle devient total — soit le transfert est enregistré
  // avant la clôture, soit la clôture n'a pas lieu, et aucun chiffre faux n'est
  // possible entre les deux. (Arbitrage Hugo 2026-08-17, sur constat money-auditor.)
  const enAttente = db.prepare(`
    SELECT br.week_start, br.settlement_id, br.action_amount
      FROM nexa_player_bankroll_weeks br
      JOIN manual_settlements ms ON ms.id = br.settlement_id
     WHERE br.player_id = ? AND ms.status = 'locked'
     ORDER BY br.week_start
  `).all(player_id) as { week_start: string; settlement_id: number; action_amount: number }[];
  for (const r of enAttente) {
    const sens = r.action_amount < 0
      ? `tu lui dois ${(-r.action_amount).toFixed(2)}`
      : `il te doit ${r.action_amount.toFixed(2)}`;
    blockers.push(
      `Règlement #${r.settlement_id} de la semaine ${r.week_start} pas encore marqué payé (${sens}). ` +
      `Si l'argent a déjà bougé, marque-le payé À SA DATE RÉELLE dans /payments : il doit entrer ` +
      `dans le calcul de la semaine où il est tombé. Sinon cette semaine sera fausse d'autant.`,
    );
  }

  const actionPct = actionPctAtOn(db, player_id, week_start);
  if (actionPct <= 0) {
    blockers.push(`Aucune part d'action en vigueur au ${week_start} — le règlement BR ne concerne que les joueurs stakés.`);
  }

  // ── BR de début : reprise, ou saisie pour la toute première semaine ──
  const last = getLastBankrollWeekOn(db, player_id);
  let brOpen: number | null = null;
  let brOpenSource: "carry" | "manual" = "manual";
  let carriedFrom: string | null = null;

  if (last) {
    // PAS DE TROU. La BR de départ se reprend de la semaine PRÉCÉDENTE et
    // d'aucune autre : sauter une semaine ferait tomber ses mouvements hors de
    // toute fenêtre de calcul, sans que rien ne le signale. Fermer une semaine
    // creuse est un geste explicite (« BR inchangée »), jamais un défaut.
    // (Arbitrage Hugo, 2026-08-17.)
    const expected = nextWeek(last.week_start);
    if (week_start !== expected && week_start > last.week_start) {
      blockers.push(
        `Trou de semaines : la dernière semaine figée est ${last.week_start}, la suivante à clôturer est ` +
        `${expected}, pas ${week_start}. Clôture les semaines intermédiaires — « BR inchangée » suffit ` +
        `si le joueur n'a pas joué.`,
      );
    }
    if (week_start < last.week_start) {
      blockers.push(
        `Semaine ${week_start} antérieure à la dernière semaine figée (${last.week_start}). ` +
        `La chaîne des BR se remonte dans l'ordre : déverrouille les semaines postérieures d'abord.`,
      );
    }
    brOpen = carriedBrOpen(last);
    brOpenSource = "carry";
    carriedFrom = last.week_start;
  } else if (args.br_open_manual !== null && args.br_open_manual !== undefined) {
    if (!Number.isFinite(args.br_open_manual) || args.br_open_manual < 0 || !isCentExact(args.br_open_manual)) {
      blockers.push(`BR de début « ${args.br_open_manual} » invalide — positive, deux décimales maximum.`);
    }
    brOpen = args.br_open_manual;
    brOpenSource = "manual";
  }
  // brOpen reste null si c'est la première semaine et qu'aucune BR n'est fournie :
  // l'écran doit la DEMANDER. Jamais 0 par défaut — un joueur qui démarre avec
  // 500 déjà en poche et un 0 supposé produirait un résultat faux de 500.

  // Somme sur l'effet BANKROLL, jamais sur le sens du grand livre : mon versement
  // est un 'withdrawal' qui ENTRE dans sa bankroll (cf. getWeekMovementsOn).
  const movements = getWeekMovementsOn(db, player_id, week_start);
  const deposits = movements.filter(m => m.br_effect === "in").reduce((s, m) => s + m.amount, 0);
  const cashouts = movements.filter(m => m.br_effect === "out").reduce((s, m) => s + m.amount, 0);

  let computed: BankrollWeekComputed | null = null;
  const brClose = args.br_close;
  if (blockers.length === 0 && brOpen !== null && brClose !== null && brClose !== undefined) {
    const r = computeBankrollWeek({
      br_open: brOpen, br_close: brClose, deposits, cashouts, action_pct: actionPct,
    });
    if (!r.ok) blockers.push(r.error);
    else computed = r.value;
  }

  return {
    ok: true,
    preview: {
      player_id, player_name: p.name, week_start, week_end: weekEnd(week_start),
      action_pct: actionPct, br_open: brOpen, br_open_source: brOpenSource, carried_from: carriedFrom,
      deposits, cashouts, movements, blockers, computed,
    },
  };
}

export function previewBankrollWeek(args: Parameters<typeof previewBankrollWeekOn>[1]) {
  return previewBankrollWeekOn(getDb(), args);
}

export type LockBankrollResult =
  | {
      ok: true;
      bankroll_week_id: number;
      settlement_id: number | null;
      movement_id: number | null;
      computed: BankrollWeekComputed;
      next_week: string;
    }
  | { ok: false; error: string };

/**
 * Fige la semaine. Une seule transaction, tout ou rien.
 *
 * Le montant n'est JAMAIS repris de l'appelant : il est recalculé ici, sur les
 * mouvements lus dans la transaction. Ce que l'écran affichait a pu être calculé
 * avant l'ajout d'un buy-in.
 */
export function lockBankrollWeekOn(
  db: DB,
  args: {
    // Pas de `transfer_date` : le versement ne s'écrit plus ici. Sa date est
    // celle du paiement réel, déclarée au « marquer payé » de /payments.
    player_id: number; week_start: string; br_close: number;
    br_open_manual?: number | null;
    note?: string | null; today: string;
  },
): LockBankrollResult {
  const pre = previewBankrollWeekOn(db, {
    player_id: args.player_id, week_start: args.week_start,
    br_close: args.br_close, br_open_manual: args.br_open_manual, today: args.today,
  });
  if (!pre.ok) return { ok: false, error: pre.error };
  const p = pre.preview;

  if (p.blockers.length > 0) return { ok: false, error: p.blockers.join(" · ") };
  if (p.br_open === null) {
    return {
      ok: false,
      error: `Première semaine de ${p.player_name} : la BR de début doit être saisie. `
           + `Elle n'est pas supposée à 0 — un joueur qui démarre avec de l'argent déjà en poche `
           + `produirait un résultat faux d'autant.`,
    };
  }
  if (!p.computed) return { ok: false, error: "BR de fin manquante." };

  const c = p.computed;
  const gid = gameId(db);

  try {
    let out: LockBankrollResult = { ok: false, error: "transaction non exécutée" };
    const run = db.transaction(() => {
      // 1. AUCUN MOUVEMENT ICI. Le versement s'écrit au « marquer payé », pas au
      //    verrouillage. (Arbitrage Hugo 2026-08-17, sur constat money-auditor.)
      //
      //    La première version le créait ici, et c'était faux : le règlement reste
      //    en 'locked' — l'argent n'est PAS parti — mais le grand livre affirmait
      //    un transfert. Entre le lock et le markPaid, net_position, my_pnl, /solde
      //    et le total agence étaient tous faux du montant du versement, pendant
      //    que /payments affichait la dette en sens inverse : deux écrans qui se
      //    contredisent du double.
      //
      //    Et la justification écrite alors était fausse elle aussi : le mouvement
      //    était censé « faire baisser ma dette dans net_position ». Cette dette
      //    n'y a jamais été — l'ancrage nexa_action_settlement_weeks est posé dans
      //    CETTE transaction, la semaine est donc réglée dès sa naissance et
      //    n'entre jamais dans action_unsettled. Le mouvement ne compensait rien.
      //
      //    Le versement, quand il partira, entrera dans le calcul comme un DÉPÔT
      //    de bankroll daté de son paiement réel (cf. getWeekMovementsOn et
      //    l'encadré de carriedBrOpen). Il n'est ni reporté sur la BR de départ
      //    suivante, ni exclu du calcul : il compte une fois, là où il tombe.
      const movementId: number | null = null;

      // 2. Le règlement. Aucune ligne si la part d'action est nulle : un règlement
      //    à zéro est du bruit dans /payments — c'est déjà la doctrine du flux
      //    d'action (cf. rakeback-engine.settleableWeeks). La semaine reste figée
      //    par nexa_player_bankroll_weeks, qui suffit à l'anti-double-comptage
      //    puisque getSettleableActionWeeksOn écarte déjà |action| <= EPS.
      let settlementId: number | null = null;
      if (Math.abs(c.action_amount) > EPS) {
        const ins = db.prepare(`
          INSERT INTO manual_settlements
            (game_id, player_id, net_selected_usdt, action_pct_applied, amount_due_usdt, status, notes, locked_at, kind)
          VALUES (@game_id, @player_id, @net, @pct, @due, 'locked', @notes, datetime('now'), 'action')
        `).run({
          game_id: gid, player_id: args.player_id,
          net: c.result, pct: p.action_pct, due: c.action_amount,
          notes: [
            `Bankroll ${args.week_start} : ${p.br_open!.toFixed(2)} → ${args.br_close.toFixed(2)}`,
            `dépôts ${p.deposits.toFixed(2)} · cash-outs ${p.cashouts.toFixed(2)}`,
            // Le versement est ANNONCÉ, pas encore fait : il s'inscrira au grand
            // livre quand ce règlement sera marqué payé.
            c.transfer_amount > EPS ? `à verser ${c.transfer_amount.toFixed(2)} sur sa wallet game` : null,
            args.note,
          ].filter(Boolean).join(" — "),
        });
        settlementId = Number(ins.lastInsertRowid);

        // L'ancrage anti-double-règlement, PARTAGÉ avec le flux d'action de la vue
        // détail. Son UNIQUE(player_id, week_start) est le dernier rempart : si la
        // semaine a déjà été réglée par l'autre chemin, l'INSERT jette et toute la
        // transaction est annulée.
        db.prepare(`
          INSERT INTO nexa_action_settlement_weeks
            (settlement_id, player_id, week_start, winloss, action_pct, action_amount)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(settlementId, args.player_id, args.week_start, c.result, p.action_pct, c.action_amount);
      }

      // 3. La provenance figée.
      const insBr = db.prepare(`
        INSERT INTO nexa_player_bankroll_weeks
          (player_id, week_start, br_open, br_open_source, br_close, deposits, cashouts,
           result, action_pct, action_amount, transfer_movement_id, settlement_id, note)
        VALUES (@player_id, @week_start, @br_open, @br_open_source, @br_close, @deposits, @cashouts,
                @result, @action_pct, @action_amount, @movement_id, @settlement_id, @note)
      `).run({
        player_id: args.player_id, week_start: args.week_start,
        br_open: p.br_open, br_open_source: p.br_open_source, br_close: args.br_close,
        // round2 : le moteur a calculé sur les sommes ARRONDIES (une somme de
        // flottants dérive — 50 × 1234.56 rend 61727.999999999956). Une ligne de
        // provenance doit porter ce qui a SERVI au calcul, pas la valeur brute
        // dont il s'est détourné, sinon elle ne permet plus de le rejouer.
        deposits: round2(p.deposits), cashouts: round2(p.cashouts),
        result: c.result, action_pct: p.action_pct, action_amount: c.action_amount,
        movement_id: movementId, settlement_id: settlementId, note: args.note ?? null,
      });

      // 4. LE RÉSULTAT, dans la seule table de résultat du repo. Écriture directe
      //    et non via setWeeklyWinlossOn : celui-ci refuse désormais d'écrire sur
      //    une semaine BR (la ligne du point 3 existe déjà), et c'est bien lui qui
      //    doit refuser — c'est la garde qui protège la grille. Ici on EST la
      //    source, dans la même transaction.
      db.prepare(`
        INSERT INTO nexa_player_weekly_winloss (player_id, week_start, amount, note)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(player_id, week_start) DO UPDATE SET
          amount = excluded.amount, note = excluded.note, entered_at = datetime('now')
      `).run(args.player_id, args.week_start, c.result, `Calculé depuis la bankroll (BR ${args.br_close.toFixed(2)})`);

      out = {
        ok: true,
        bankroll_week_id: Number(insBr.lastInsertRowid),
        settlement_id: settlementId,
        movement_id: movementId,
        computed: c,
        next_week: nextWeek(args.week_start),
      };
    });
    run();
    return out;
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function lockBankrollWeek(args: Parameters<typeof lockBankrollWeekOn>[1]) {
  return lockBankrollWeekOn(getDb(), args);
}

export type UnlockResult = { ok: true; week_start: string } | { ok: false; error: string };

/**
 * Déverrouille une semaine figée — pour corriger une BR mal saisie.
 *
 * SEULE LA DERNIÈRE SEMAINE FIGÉE EST DÉVERROUILLABLE. La BR de départ de la
 * semaine N+1 est reprise de la N : déverrouiller la N alors que la N+1 existe
 * invaliderait la N+1 sans que rien ne le dise. On remonte la chaîne dans
 * l'ordre, une semaine à la fois.
 *
 * Un règlement PAYÉ bloque le déverrouillage — même règle que unlockSettlement
 * de manual-settlement-engine : de l'argent réellement sorti ne se dé-règle pas.
 */
export function unlockBankrollWeekOn(db: DB, playerId: number, weekStart: string): UnlockResult {
  const row = db.prepare(
    `SELECT * FROM nexa_player_bankroll_weeks WHERE player_id = ? AND week_start = ?`
  ).get(playerId, weekStart) as BankrollWeekRow | undefined;
  if (!row) return { ok: false, error: `Aucune semaine BR figée au ${weekStart} pour le joueur ${playerId}.` };

  const last = getLastBankrollWeekOn(db, playerId)!;
  if (last.week_start !== weekStart) {
    return {
      ok: false,
      error: `Seule la dernière semaine figée est déverrouillable (${last.week_start}). `
           + `La BR de départ des semaines suivantes est reprise de celle-ci : les déverrouiller `
           + `d'abord, dans l'ordre inverse.`,
    };
  }

  if (row.settlement_id !== null) {
    const st = db.prepare(`SELECT status FROM manual_settlements WHERE id = ?`).get(row.settlement_id) as
      { status: string } | undefined;
    if (st?.status === "paid") {
      return {
        ok: false,
        error: `Règlement #${row.settlement_id} déjà marqué payé dans /payments — déverrouillage interdit. `
             + `De l'argent sorti ne se dé-règle pas.`,
      };
    }
  }

  try {
    db.transaction(() => {
      // Ordre imposé par les clés étrangères : la ligne BR référence le mouvement
      // et le règlement, elle part donc avant eux.
      db.prepare(`DELETE FROM nexa_player_weekly_winloss WHERE player_id = ? AND week_start = ?`)
        .run(playerId, weekStart);
      db.prepare(`DELETE FROM nexa_player_bankroll_weeks WHERE id = ?`).run(row.id);
      if (row.settlement_id !== null) {
        // La ligne BR est partie JUSTE AVANT, et c'est ce qui rend ce DELETE possible :
        // sa FK est en NO ACTION, elle bloquerait sinon (cf. le DDL). CASCADE emporte
        // ensuite nexa_action_settlement_weeks — la semaine redevient réglable.
        const del = db.prepare(`DELETE FROM manual_settlements WHERE id = ? AND status = 'locked'`)
          .run(row.settlement_id);
        // Même exigence que unlockSettlement : 0 ligne supprimée veut dire que le
        // règlement a changé d'état entre la lecture et l'écriture (marqué payé
        // entre-temps). On jette, la transaction est annulée, et rien n'est à
        // moitié déverrouillé.
        if (del.changes !== 1) {
          throw new Error(`Règlement #${row.settlement_id} n'est plus verrouillé — déverrouillage annulé.`);
        }
      }
      // CEINTURE, INATTEIGNABLE PAR CONSTRUCTION : un transfert n'existe que si le
      // règlement est payé (writeBankrollTransferOnPaid ne tourne qu'au markPaid),
      // et un règlement payé fait échouer le contrôle ci-dessus. Cette branche ne
      // s'exécute donc jamais. On la garde plutôt que de la retirer : le jour où un
      // chemin poserait un transfert autrement, le déverrouillage ne laisserait pas
      // un mouvement orphelin derrière lui.
      if (row.transfer_movement_id !== null) {
        db.prepare(`DELETE FROM wallet_transactions WHERE id = ? AND source = 'manual'`)
          .run(row.transfer_movement_id);
      }
    })();
    return { ok: true, week_start: weekStart };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function unlockBankrollWeek(playerId: number, weekStart: string) {
  return unlockBankrollWeekOn(getDb(), playerId, weekStart);
}
