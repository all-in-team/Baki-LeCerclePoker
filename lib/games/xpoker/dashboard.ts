// XPoker Twd — LECTURE pour la page /xpoker : joueurs, semaines agrégées pour le
// graphe, cartes, réconciliation, trésorerie chips. AUCUNE math d'argent nouvelle :
// tout vient de engine.ts (playerWeeksOn, agencyStockOn…) et n'est qu'agrégé ici.
//
// TROIS ÉTATS, PAS DEUX (convention maison) : une somme dont un terme est
// incalculable (semaine sans deal) est `null`, jamais un total partiel qui
// passerait pour un total. Le nombre de semaines manquantes est rendu à côté.
//
// DEUX COMPTEURS : le stock de jetons de l'agence et la position d'un joueur ne
// se rencontrent jamais dans un même nombre.

import type Database from "better-sqlite3";
import {
  xpokerGameIdOn, playerWeeksOn, accountsForPlayerOn, dealHistoryOn, unlinkedMembersOn,
  agencyStockOn, playerMovementsOn, relinkLogOn, rateAtOn,
  type PlayerWeek, type XpokerAccount, type DealHistory, type UnlinkedMember, type AgencyStock, type RelinkLogRow,
} from "./engine";
import { chipsToUsd } from "./club-math";
import { getSettleableWeeksOn, getXpokerSettlementsOn, type SettleableWeek, type BlockedWeek, type XpokerSettlementRow } from "./settlement";

type DB = Database.Database;

export type WeekWindow = { from: string | null; to: string | null };

function inWindow(week: string, w: WeekWindow): boolean {
  if (w.from !== null && week < w.from) return false;
  if (w.to !== null && week > w.to) return false;
  return true;
}

/** Lundi ISO (UTC) de la semaine contenant la date. */
export function mondayOfDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function weekWindowFromParisDates(start: string | undefined, end: string | undefined): WeekWindow {
  return { from: start ? mondayOfDate(start) : null, to: end ? mondayOfDate(end) : null };
}

export function weekWindowLabel(w: WeekWindow): string {
  if (w.from === null && w.to === null) return "toutes les semaines importées";
  if (w.from !== null && w.to !== null) return w.from === w.to ? `semaine du ${w.from}` : `semaines du ${w.from} au ${w.to}`;
  return w.from !== null ? `à partir de la semaine du ${w.from}` : `jusqu'à la semaine du ${w.to}`;
}

/** Somme à trois états : null dès qu'un terme est null. */
function sumOrNull(xs: (number | null)[]): number | null {
  let s = 0;
  for (const x of xs) { if (x === null) return null; s += x; }
  return s;
}

export type XpokerDashboardPlayer = {
  player_id: number;
  name: string;
  telegram_handle: string | null;
  accounts: XpokerAccount[];
  deal: DealHistory;
  /** Semaines de la PÉRIODE, détail par compte inclus. */
  weeks: PlayerWeek[];
  weeks_count: number;
  /** Semaines de la période sans deal (incalculables) ou en écart acté. */
  incalculable_weeks: number;
  flagged_weeks: number;
  winloss_chips: number;
  rake_chips: number;
  action_chips: number | null;
  rb_chips: number | null;
  due_chips: number | null;
  /** Équivalents d'affichage au taux figé de chaque semaine. */
  winloss_usd: number;
  due_usd: number | null;
  movements: { buyin_chips: number; cashout_chips: number; count: number };
  /** Règlement (étape 4) : semaines réglables aujourd'hui, bloquées (avec raison), règlements existants. Toutes périodes, pas seulement la fenêtre. */
  settle: { settleable: SettleableWeek[]; blocked: BlockedWeek[]; settlements: XpokerSettlementRow[] };
};

export type XpokerChartWeek = {
  week_start: string;
  /** Règlement club selon le sheet (U22) et ce qui a été reçu au grand livre (null tant que rien n'est saisi). */
  club_sheet_total: number;
  club_received: number | null;
  club_rb: number;
  club_tax: number;
  /** Σ parts d'action des joueurs rattachés — null si une seule est incalculable. */
  action_chips: number | null;
  rb_players_chips: number | null;
  incalculable: number;
  unlinked_rows: number;
  check_ok: boolean;
  cleared_matches: boolean | null;
  rate_chips_per_usd: number;
  import_id: number;
};

export type XpokerDashboard = {
  window: WeekWindow;
  rate_now: number | null;
  players: XpokerDashboardPlayer[];
  weeks: XpokerChartWeek[];
  totals: {
    club_sheet_total: number;
    club_received: number;
    club_received_count: number;
    imports: number;
    action_chips: number | null;
    rb_players_chips: number | null;
    incalculable_weeks: number;
    unlinked_members: number;
    flagged_imports: number;
  };
  stock: AgencyStock;
  unlinked: UnlinkedMember[];
  relink_log: RelinkLogRow[];
  all_players: { id: number; name: string }[];
};

export function getXpokerDashboardOn(db: DB, window: WeekWindow): XpokerDashboard {
  const gid = xpokerGameIdOn(db);
  const today = new Date().toISOString().slice(0, 10);
  let rate_now: number | null = null;
  try { rate_now = rateAtOn(db, today); } catch { rate_now = null; }

  // Joueurs de la room = ceux qui ont au moins un Player ID (actif ou archivé) — un
  // joueur archivé partout garde son historique visible.
  const ids = db.prepare(`
    SELECT DISTINCT p.id, p.name, p.telegram_handle FROM players p
    JOIN player_game_ids g ON g.player_id = p.id AND g.game_id = ?
    ORDER BY p.name
  `).all(gid) as { id: number; name: string; telegram_handle: string | null }[];

  const players: XpokerDashboardPlayer[] = ids.map(p => {
    const weeksAll = playerWeeksOn(db, p.id);
    const weeks = weeksAll.filter(w => inWindow(w.week_start, window));
    const mv = playerMovementsOn(db, p.id);
    const action = sumOrNull(weeks.map(w => w.action_chips));
    const rb = sumOrNull(weeks.map(w => w.rb_chips));
    const due = sumOrNull(weeks.map(w => w.due_chips));
    return {
      player_id: p.id, name: p.name, telegram_handle: p.telegram_handle,
      accounts: accountsForPlayerOn(db, p.id),
      deal: dealHistoryOn(db, p.id),
      weeks, weeks_count: weeks.length,
      incalculable_weeks: weeks.filter(w => w.deal === null).length,
      flagged_weeks: weeks.filter(w => w.import_flagged).length,
      winloss_chips: weeks.reduce((s, w) => s + w.winloss_chips, 0),
      rake_chips: weeks.reduce((s, w) => s + w.rake_chips, 0),
      action_chips: action, rb_chips: rb, due_chips: due,
      winloss_usd: weeks.reduce((s, w) => s + w.winloss_usd, 0),
      due_usd: sumOrNull(weeks.map(w => w.due_usd)),
      movements: { buyin_chips: mv.buyin_chips, cashout_chips: mv.cashout_chips, count: mv.lines.length },
      settle: { ...getSettleableWeeksOn(db, p.id), settlements: getXpokerSettlementsOn(db, p.id) },
    };
  });

  // Semaines importées de la période, pour le graphe : le club d'un côté, les joueurs de l'autre.
  const imports = db.prepare(`
    SELECT i.id, i.week_start, i.sheet_total, i.recomputed_rb, i.recomputed_tax, i.check_ok, i.cleared_matches, i.rate_chips_per_usd,
           (SELECT COUNT(*) FROM xpoker_week_rows r WHERE r.import_id = i.id AND r.player_id IS NULL AND r.is_agency = 0) AS unlinked_rows,
           (SELECT CASE l.direction WHEN 'in' THEN l.chips ELSE -l.chips END FROM xpoker_chip_ledger l WHERE l.import_id = i.id AND l.kind = 'club_settlement') AS received
    FROM xpoker_imports i ORDER BY i.week_start
  `).all() as { id: number; week_start: string; sheet_total: number; recomputed_rb: number; recomputed_tax: number; check_ok: number; cleared_matches: number | null; rate_chips_per_usd: number; unlinked_rows: number; received: number | null }[];
  const weeks: XpokerChartWeek[] = imports.filter(i => inWindow(i.week_start, window)).map(i => {
    const pw = players.flatMap(p => p.weeks.filter(w => w.week_start === i.week_start));
    return {
      week_start: i.week_start, import_id: i.id,
      club_sheet_total: i.sheet_total, club_received: i.received, club_rb: i.recomputed_rb, club_tax: i.recomputed_tax,
      action_chips: sumOrNull(pw.map(w => w.action_chips)),
      rb_players_chips: sumOrNull(pw.map(w => w.rb_chips)),
      incalculable: pw.filter(w => w.deal === null).length,
      unlinked_rows: i.unlinked_rows,
      check_ok: i.check_ok === 1, cleared_matches: i.cleared_matches === null ? null : i.cleared_matches === 1,
      rate_chips_per_usd: i.rate_chips_per_usd,
    };
  });

  const unlinked = unlinkedMembersOn(db);
  return {
    window, rate_now, players, weeks,
    totals: {
      club_sheet_total: weeks.reduce((s, w) => s + w.club_sheet_total, 0),
      club_received: weeks.reduce((s, w) => s + (w.club_received ?? 0), 0),
      club_received_count: weeks.filter(w => w.club_received !== null).length,
      imports: weeks.length,
      action_chips: sumOrNull(weeks.map(w => w.action_chips)),
      rb_players_chips: sumOrNull(weeks.map(w => w.rb_players_chips)),
      incalculable_weeks: weeks.reduce((s, w) => s + w.incalculable, 0),
      unlinked_members: unlinked.length,
      flagged_imports: weeks.filter(w => !w.check_ok).length,
    },
    stock: agencyStockOn(db),
    unlinked,
    relink_log: relinkLogOn(db),
    all_players: db.prepare(`SELECT id, name FROM players ORDER BY name`).all() as { id: number; name: string }[],
  };
}

/** Équivalent USD d'un montant en chips au taux courant — affichage seulement. */
export function usdNow(chips: number | null, rate: number | null): number | null {
  if (chips === null || rate === null) return null;
  return chipsToUsd(chips, rate);
}
