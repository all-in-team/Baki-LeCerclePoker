// Tableau de bord NEXAPOKER — ce que la room rapporte sur une PÉRIODE.
//
// ─────────────────────────────────────────────────────────────────────────────
// LE REJEU COUVRE TOUJOURS TOUT L'HISTORIQUE, LA PÉRIODE NE FAIT QUE FILTRER.
//
// C'est le point sensible de ce module. Le makeup se rejoue dans l'ordre des
// week_start depuis la première semaine du joueur (voir rakeback-engine.ts) :
// lancer le moteur sur les seules semaines de la période remettrait le makeup à
// zéro à l'entrée de la fenêtre et gonflerait le dû. On rejoue donc la chaîne
// complète, PUIS on retient les semaines de la période. Un dû affiché sur
// « 30 jours » est ainsi le même que celui de ces mêmes semaines en vue lifetime.
//
// AUCUNE MATH NOUVELLE. Les montants par semaine (commission, dû, part d'action,
// net) sortent tels quels du moteur via getNexaPlayerDetailOn. Ce module somme,
// il ne calcule pas — et il somme au MÊME périmètre que le moteur : les semaines
// `ok` uniquement, ce qui en sort étant exposé à côté et jamais escamoté.
//
// INCOMPLET SE DIT null, PAS 0. Dès qu'une semaine `ok` de la période n'a pas son
// win/loss, la part d'action et le total valent null. Un total amputé qui
// ressemble à un total juste est pire qu'une absence de total.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from "@/lib/db";
import type BetterSqlite3 from "better-sqlite3";
import { getNexaPlayersOn, getNexaPlayerDetailOn } from "./players";
import type { WeekResult } from "./rakeback-engine";

type DB = BetterSqlite3.Database;

/** Fenêtre de semaines, bornes incluses. null = pas de borne (lifetime). */
export type WeekWindow = { from: string | null; to: string | null };

export type NexaDashboardPlayer = {
  player_id: number;
  name: string;
  /** Semaines `ok` de la période. */
  weeks_count: number;
  commission: number;
  /** Rakeback dû au joueur sur la période. */
  due: number;
  /** commission − dû. */
  net_affiliation: number;
  /** null si une semaine `ok` de la période n'a pas son win/loss. */
  action_amount: number | null;
  /** net_affiliation + action. null si action est null. */
  total: number | null;
  weeks_missing_winloss: number;
  blocked_weeks: number;
};

export type NexaDashboard = {
  window: WeekWindow;
  /** Semaines `ok` distinctes présentes dans la période, tous joueurs confondus. */
  weeks_in_period: string[];
  totals: {
    commission: number;
    due: number;
    net_affiliation: number;
    /** null dès qu'un win/loss manque sur la période. */
    action_amount: number | null;
    /** net_affiliation + action. null si action est null. */
    total: number | null;
    /** Nombre de couples joueur×semaine `ok` sans win/loss saisi. */
    weeks_missing_winloss: number;
    /** Joueurs dont la part d'action est incalculable sur la période. */
    players_incomplete: number;
    /** Couples joueur×semaine sortis du calcul (contrôle en échec). */
    blocked_weeks: number;
    /** Commission encaissée SUR ces semaines bloquées — reçue, mais hors totaux. */
    blocked_commission: number;
  };
  players: NexaDashboardPlayer[];
  /** Agrégat par semaine, pour le graph. Même périmètre que les totaux. */
  weeks: {
    week_start: string;
    /** Rake brut des semaines calculées — l'assiette, pas la rentrée. */
    gross_rake: number;
    commission: number;
    due: number;
    net_affiliation: number;
    action_amount: number | null;
    total: number | null;
    /** Couples joueur×semaine bloqués sur cette semaine. */
    blocked: number;
    missing_winloss: number;
    /** Couples joueur×semaine calculés. 0 = semaine uniquement bloquée. */
    ok_lines: number;
  }[];
};

/** Lundi (UTC) de la semaine contenant une date YYYY-MM-DD. */
export function mondayOf(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = lundi
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/**
 * Traduit une période du filtre partagé en fenêtre de SEMAINES.
 *
 * Les données NEXA sont hebdomadaires : comparer un week_start à un horodatage
 * à la seconde n'a pas de sens et fait basculer une semaine entière d'un côté ou
 * de l'autre selon le fuseau. On ancre donc les deux bornes sur leur lundi.
 * `parisDates` sont les dates calendaires Paris déjà résolues par
 * computePeriodFilter (via toParisDate) — ce module ne refait pas de fuseau.
 */
export function weekWindowFromParisDates(
  startParisDate: string | undefined, endParisDate: string | undefined,
): WeekWindow {
  return {
    from: startParisDate ? mondayOf(startParisDate) : null,
    to: endParisDate ? mondayOf(endParisDate) : null,
  };
}

/**
 * Libellé de la fenêtre RÉELLEMENT sommée.
 *
 * Le `rangeLabel` du filtre partagé décrit un intervalle à la minute près, alors
 * qu'ici les bornes sont ancrées sur leur lundi : un « custom » du 15 au 16 juillet
 * somme la semaine entière du 13. Afficher le label du filtre ferait annoncer deux
 * jours pour une semaine de chiffres. On décrit donc les semaines, pas l'intervalle
 * demandé.
 */
export function weekWindowLabel(w: WeekWindow): string {
  if (w.from === null && w.to === null) return "toutes les semaines saisies";
  if (w.from !== null && w.to !== null) {
    return w.from === w.to ? `semaine du ${w.from}` : `semaines du ${w.from} au ${w.to}`;
  }
  return w.from !== null ? `à partir de la semaine du ${w.from}` : `jusqu'à la semaine du ${w.to}`;
}

function inWindow(week: string, w: WeekWindow): boolean {
  if (w.from !== null && week < w.from) return false;
  if (w.to !== null && week > w.to) return false;
  return true;
}

/** Chaîne d'un joueur telle que le moteur la rend — l'entrée de l'agrégation. */
export type PlayerChain = { player_id: number; name: string; weeks: WeekResult[] };

/**
 * Agrégation PURE : ni base, ni horloge. C'est ici que vit toute la somme, donc
 * c'est ici que les tests mordent (scripts/nexa-dashboard.test.ts).
 *
 * Les chaînes reçues sont déjà rejouées SUR TOUT L'HISTORIQUE par l'appelant —
 * cette fonction ne fait que retenir les semaines de la fenêtre. Lui passer des
 * chaînes tronquées donnerait un dû surévalué (le makeup repartirait de zéro).
 */
export function aggregateDashboard(chains: PlayerChain[], window: WeekWindow): NexaDashboard {
  const players: NexaDashboardPlayer[] = [];
  const byWeek = new Map<string, {
    gross_rake: number; commission: number; due: number; action: number;
    missing: number; blocked: number;
    /** Lignes joueur×semaine CALCULÉES sur cette semaine. 0 = semaine seulement bloquée. */
    ok_lines: number;
  }>();
  const emptyWeek = () => ({ gross_rake: 0, commission: 0, due: 0, action: 0, missing: 0, blocked: 0, ok_lines: 0 });

  let tCommission = 0, tDue = 0, tAction = 0;
  let anyMissing = false, tMissing = 0, tBlocked = 0, tBlockedCommission = 0;
  /** Couples joueur×semaine CALCULÉS sur la période. 0 = rien de chiffrable. */
  let tOkLines = 0;

  // DÉDUPLICATION OBLIGATOIRE. getNexaPlayersOn fait des LEFT JOIN sur
  // player_game_ids, nexa_nickname_links et nexa_leads sans DISTINCT : un joueur
  // qui porte DEUX pseudos de report (cas nominal — un joueur change de pseudo
  // dans la room) ou deux Member ID sort deux fois. Sans ce garde-fou, sa chaîne
  // serait rejouée deux fois et TOUS ses montants comptés double — commission, dû
  // et action ensemble, donc la réconciliation interne resterait vraie et ne
  // signalerait rien. (Constat money-auditor 2026-08-05, reproduit sur base :
  // 400 de commission devenus 800 après l'ajout d'un second pseudo.)
  const seen = new Set<number>();
  for (const d of chains) {
    if (seen.has(d.player_id)) continue;
    seen.add(d.player_id);

    const scoped = d.weeks.filter(w => inWindow(w.week_start, window));
    const ok = scoped.filter(w => w.status === "ok");
    const blocked = scoped.filter(w => w.status === "blocked");
    // Un joueur sans aucune semaine dans la fenêtre n'est pas une ligne à zéro :
    // il n'a rien à voir avec cette période. L'inclure ferait un « 0,00 » qui se
    // lit comme « il n'a rien rapporté » au lieu de « il n'était pas là ».
    if (ok.length === 0 && blocked.length === 0) continue;

    const commission = ok.reduce((s, w) => s + w.commission, 0);
    const due = ok.reduce((s, w) => s + w.due, 0);
    const missing = ok.filter(w => w.winloss === null).length;
    // Même règle que le moteur : un seul win/loss manquant rend la part d'action
    // du joueur incalculable sur la période. On ne complète pas par un zéro.
    //
    // `ok.length === 0` compte AUSSI comme incalculable : sans aucune semaine
    // calculée, un reduce rendrait 0 — un « 0,00 » vert qui se lit « ce joueur ne
    // m'a rien rapporté » là où la vérité est « rien n'est calculable sur cette
    // période » (toutes ses semaines y sont en échec de contrôle).
    const action = ok.length === 0 || missing > 0
      ? null
      : ok.reduce((s, w) => s + (w.action_amount ?? 0), 0);
    const netAffiliation = commission - due;

    players.push({
      player_id: d.player_id, name: d.name,
      weeks_count: ok.length,
      commission, due, net_affiliation: netAffiliation,
      action_amount: action,
      total: action === null ? null : netAffiliation + action,
      weeks_missing_winloss: missing,
      blocked_weeks: blocked.length,
    });

    tCommission += commission;
    tDue += due;
    tMissing += missing;
    tOkLines += ok.length;
    if (missing > 0) anyMissing = true;
    else tAction += action ?? 0;
    tBlocked += blocked.length;
    tBlockedCommission += blocked.reduce((s, w) => s + w.commission, 0);

    for (const w of ok) {
      const e = byWeek.get(w.week_start) ?? emptyWeek();
      e.ok_lines += 1;
      e.gross_rake += w.gross_rake;
      e.commission += w.commission;
      e.due += w.due;
      if (w.winloss === null) e.missing += 1; else e.action += w.action_amount ?? 0;
      byWeek.set(w.week_start, e);
    }
    for (const w of blocked) {
      const e = byWeek.get(w.week_start) ?? emptyWeek();
      e.blocked += 1;
      byWeek.set(w.week_start, e);
    }
  }

  const tNet = tCommission - tDue;
  // Aucune ligne calculée sur toute la période (fenêtre vide, ou uniquement des
  // semaines en échec) : le total est INCALCULABLE, pas nul. Sans cette garde,
  // choisir une semaine antérieure au premier report afficherait cinq cartes à
  // « 0,00 » en vert — un écran qui affirme « tu n'as rien gagné » alors qu'il
  // n'a rien à dire. (Constat money-auditor, second passage.)
  const tActionOrNull = tOkLines === 0 || anyMissing ? null : tAction;

  const weeks = [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week_start, e]) => {
      const net = e.commission - e.due;
      // Aucune ligne calculée sur la semaine : action null, pas 0. Un 0 se lirait
      // comme « cette semaine n'a rien rapporté » au lieu de « rien n'y est calculé ».
      const action = e.ok_lines === 0 || e.missing > 0 ? null : e.action;
      return {
        week_start,
        gross_rake: e.gross_rake,
        commission: e.commission, due: e.due, net_affiliation: net,
        action_amount: action,
        total: action === null ? null : net + action,
        blocked: e.blocked, missing_winloss: e.missing,
        ok_lines: e.ok_lines,
      };
    });

  return {
    window,
    // Uniquement les semaines qui portent au moins une ligne CALCULÉE. Une semaine
    // seulement bloquée n'est pas une semaine de la période au sens des cartes :
    // la compter ferait annoncer « 3 semaines » pour deux semaines de chiffres.
    weeks_in_period: weeks.filter(w => w.ok_lines > 0).map(w => w.week_start),
    totals: {
      commission: tCommission,
      due: tDue,
      net_affiliation: tNet,
      action_amount: tActionOrNull,
      total: tActionOrNull === null ? null : tNet + tActionOrNull,
      weeks_missing_winloss: tMissing,
      players_incomplete: players.filter(p => p.action_amount === null).length,
      blocked_weeks: tBlocked,
      blocked_commission: tBlockedCommission,
    },
    // Tri sur une SEULE grandeur, le net d'affiliation — toujours chiffrable.
    // Trier sur `total ?? net_affiliation` comparerait des totaux (net + action)
    // à des nets seuls : un joueur incalculable serait classé sur une autre
    // grandeur que ses voisins.
    players: players.sort((a, b) => b.net_affiliation - a.net_affiliation),
    weeks,
  };
}

/**
 * Lecture base + agrégation. Le rejeu de chaque chaîne couvre TOUT l'historique
 * du joueur (getNexaPlayerDetailOn n'accepte aucune borne), la fenêtre n'agissant
 * qu'ensuite dans aggregateDashboard.
 */
export function getNexaDashboardOn(db: DB, window: WeekWindow): NexaDashboard {
  // Dédoublonnage AVANT l'appel au moteur : getNexaPlayersOn peut rendre deux fois
  // le même joueur (LEFT JOIN sans DISTINCT, cf. aggregateDashboard). Ici c'est
  // pour ne pas rejouer sa chaîne deux fois ; la garantie de non-double-comptage,
  // elle, est portée par aggregateDashboard et testée là-bas.
  const chains: PlayerChain[] = [];
  const seen = new Set<number>();
  for (const p of getNexaPlayersOn(db)) {
    if (seen.has(p.player_id)) continue;
    seen.add(p.player_id);
    const d = getNexaPlayerDetailOn(db, p.player_id);
    if (d) chains.push({ player_id: d.player_id, name: d.name, weeks: d.weeks });
  }
  return aggregateDashboard(chains, window);
}

export function getNexaDashboard(window: WeekWindow): NexaDashboard {
  return getNexaDashboardOn(getDb(), window);
}
