// Commission AGENT par (filleul, game, semaine) — le moteur. Toutes les fonctions
// prennent la base en paramètre (`…On(db, …)`) : la prod passe getDb(), le test une
// base en mémoire, et c'est le même code qui tourne.
//
// ─────────────────────────────────────────────────────────────────────────────
// LA FORMULE (Baki, 2026-09-26 — l'ordre est la règle) :
//   part_agence(f, g, s) = résultat cash du filleul f sur la game g la semaine s
//                          × action PERÇUE (cascade inchangée, voir resolveDealOn)
//   commission(f, g, s)  = part_agence(f, g, s) × taux_agent(f, g, s) / 100   SIGNÉE
//   earned               = max(0, Σ commission)       ← taux AVANT compensation
//   dû                   = max(0, earned − Σ payé)
// Le makeup croisé et le report des pertes sont ceux d'avant : la somme est
// cumulée depuis l'origine, un seul plancher au niveau de l'agent. Avec un taux
// unique de 50 %, earned vaut exactement l'ancien max(0, cumul) × 0.50 (linéarité).
//
// UN FILLEUL À 0 % ne compte NI en gain NI en perte : sa commission est nulle
// semaine par semaine, avant toute compensation.
//
// SEMAINES : lundis UTC. Une transaction tombe dans la semaine du lundi ≤ sa date
// UTC (tx_datetime, sinon tx_date). Un changement de taux prend effet un lundi,
// jamais en cours de semaine : pas de prorata.
//
// GEL : un paiement agent est un montant global (makeup croisé), rattaché à aucune
// semaine. Il GÈLE donc toutes les semaines ≤ lundi de sa date de paiement, pour
// tous les filleuls de l'agent (décision Baki : gel à la date de paiement). Un
// changement qui modifierait le taux d'une semaine gelée est REFUSÉ, nommément.
//
// TAUX MANQUANT : une semaine où le filleul a une part agence non nulle sans taux
// défini BLOQUE l'agent (earned/dû = null, paiement refusé). Jamais de repli
// silencieux sur un taux par défaut (décision Baki : blocage avec alerte).
// ─────────────────────────────────────────────────────────────────────────────

import type Database from "better-sqlite3";
import { LEGACY_AGENT_PCT, legacyIsEligible } from "./agent-rates-schema";

type DB = Database.Database;

/** Seuil sous lequel une part agence est considérée nulle (USDT). Affichage/blocage uniquement, jamais dans un agrégat. */
const EPS = 0.005;

// ── Dates ────────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && ISO_DATE.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
}
export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
export function isMonday(iso: string): boolean { return new Date(iso + "T00:00:00Z").getUTCDay() === 1; }
/** Lundi (UTC) de la semaine qui contient cette date — accepte 'YYYY-MM-DD…'. */
export function mondayOf(isoLike: string): string {
  const d = new Date(isoLike.slice(0, 10) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function todayIso(): string { return new Date().toISOString().slice(0, 10); }

// ── Taux ─────────────────────────────────────────────────────────────────────

export type RateKind = "migration" | "hors_fenetre" | "manual" | "default";
export interface RatePeriod {
  id?: number;
  relationship_id: number;
  game_id: number;
  agent_pct: number;          // POURCENT de la part agence
  start_week: string | null;  // null = depuis l'origine
  end_week: string | null;    // null = en cours
  kind: RateKind;
  note: string | null;
  created_at?: string;
}

/** POURCENT dans {0} ∪ [1, 100]. ]0, 1[ refusé : ce serait une fraction déguisée. */
export function assertAgentPct(v: unknown): asserts v is number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100)
    throw new Error(`taux agent : pourcent attendu dans [0, 100], reçu ${String(v)}`);
  if (v > 0 && v < 1)
    throw new Error(`taux agent : ${v} ressemble à une fraction (${v * 100} %) — le taux est en POURCENT de la part agence (25 = 25 %)`);
}

const startLE = (a: string | null, s: string | null) => a === null || (s !== null && a <= s);
const endGE = (e: string | null, s: string | null) => e === null || s === null || e >= s;
const byStart = (a: RatePeriod, b: RatePeriod) =>
  a.start_week === b.start_week ? 0 : a.start_week === null ? -1 : b.start_week === null ? 1 : a.start_week < b.start_week ? -1 : 1;

/** La période qui couvre la semaine `week` (un lundi), ou null. */
export function periodAt(periods: RatePeriod[], week: string): RatePeriod | null {
  return periods.find(p => (p.start_week === null || p.start_week <= week) && (p.end_week === null || p.end_week >= week)) ?? null;
}

export function ratePeriodsOn(db: DB, relationshipId: number, gameId: number): RatePeriod[] {
  return (db.prepare(`
    SELECT id, relationship_id, game_id, agent_pct, start_week, end_week, kind, note, created_at
    FROM affiliate_agent_rates WHERE relationship_id = ? AND game_id = ?
  `).all(relationshipId, gameId) as RatePeriod[]).sort(byStart);
}

const pctLabel = (p: number | null) => p === null ? "∅" : `${p} %`;

/** Tout ce qui se versionne par lundis : bornes, note, identité en base. */
export interface WeekPeriod { id?: number; start_week: string | null; end_week: string | null; note: string | null; created_at?: string }
const byStartP = <T extends WeekPeriod>(a: T, b: T) =>
  a.start_week === b.start_week ? 0 : a.start_week === null ? -1 : b.start_week === null ? 1 : a.start_week < b.start_week ? -1 : 1;
export function periodAtP<T extends WeekPeriod>(periods: T[], week: string): T | null {
  return periods.find(p => (p.start_week === null || p.start_week <= week) && (p.end_week === null || p.end_week >= week)) ?? null;
}

/**
 * Le changement, calculé À PART de l'écriture — la même fonction sert l'aperçu et
 * l'écriture, ils ne peuvent pas diverger. PLAGE ÉCRITE : [S, fin] où la fin est
 * celle de la période qui contient S, sinon la veille de la période suivante,
 * sinon ouverte. Une période plus récente n'est jamais réécrite par une valeur posée
 * avant elle. Les périodes adjacentes de même valeur (`same`) sont fusionnées.
 * Même début : la période change en place, l'ancienne note est GARDÉE, suivie de
 * `label(ancienne)` et du nouveau motif (l'historique n'est jamais écrasé).
 */
export function applyPeriodChange<T extends WeekPeriod>(
  rows: T[], fresh: T, same: (a: T, b: T) => boolean, label: (r: T) => string,
): { rows: T[]; containing: T | null; next: T | null; end_week: string | null } {
  const S = fresh.start_week;
  const sorted = rows.map(r => ({ ...r })).sort(byStartP);
  const containing = sorted.find(r => startLE(r.start_week, S) && endGE(r.end_week, S)) ?? null;
  const next = sorted.find(r => r !== containing && r.start_week !== null && (S === null || r.start_week > S)) ?? null;
  const end_week = containing ? containing.end_week : next ? addDays(next.start_week!, -7) : null;

  let out: T[];
  if (containing && containing.start_week === S) {
    out = sorted.map(r => r === containing
      ? { ...fresh, id: containing.id, created_at: containing.created_at, start_week: S, end_week: containing.end_week,
          note: [containing.note, `avant : ${label(containing)}`, fresh.note].filter(Boolean).join(" · ") }
      : r);
  } else {
    out = sorted.map(r => r === containing ? { ...r, end_week: addDays(S!, -7) } : r);
    out.push({ ...fresh, id: undefined, end_week });
  }
  out.sort(byStartP);
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i], b = out[i + 1];
    if (a.end_week !== null && b.start_week !== null && addDays(a.end_week, 7) === b.start_week && same(a, b)) {
      out[i] = { ...a, end_week: b.end_week, note: [a.note, b.note].filter(Boolean).join(" · ") || null };
      out.splice(i + 1, 1); i--;
    }
  }
  return { rows: out, containing, next, end_week };
}

/** Taux agent : même taux ET même nature pour fusionner. */
export function applyRateChange(
  rows: RatePeriod[],
  c: { relationship_id: number; game_id: number; agent_pct: number; start_week: string | null; kind: RateKind; note: string | null },
): { rows: RatePeriod[]; containing: RatePeriod | null; next: RatePeriod | null; end_week: string | null } {
  return applyPeriodChange<RatePeriod>(rows,
    { relationship_id: c.relationship_id, game_id: c.game_id, agent_pct: c.agent_pct, start_week: c.start_week, end_week: null, kind: c.kind, note: c.note },
    (a, b) => Math.abs(a.agent_pct - b.agent_pct) < 1e-9 && a.kind === b.kind,
    r => `${pctLabel(r.agent_pct)} (${r.kind})`);
}

// ── Deal perçu versionné (game_perceived_deals) ──────────────────────────────

export interface PerceivedPeriod extends WeekPeriod {
  game_id: number;
  action_pct: number | null;       // POURCENTS ; null = non défini à ce niveau (la cascade descend)
  rakeback_pct: number | null;
  insurance_pct: number | null;
}
export function perceivedPeriodsOn(db: DB, gameId: number): PerceivedPeriod[] {
  return (db.prepare(`
    SELECT id, game_id, action_pct, rakeback_pct, insurance_pct, start_week, end_week, note, created_at
    FROM game_perceived_deals WHERE game_id = ?
  `).all(gameId) as PerceivedPeriod[]).sort(byStartP);
}
export type PerceivedOverride = { game_id: number; periods: PerceivedPeriod[] };
export const samePerceived = (a: { action_pct: number | null; rakeback_pct: number | null; insurance_pct: number | null }, b: typeof a) =>
  a.action_pct === b.action_pct && a.rakeback_pct === b.rakeback_pct && a.insurance_pct === b.insurance_pct;
export const perceivedLabel = (p: { action_pct: number | null; rakeback_pct: number | null; insurance_pct: number | null }) =>
  `action ${pctLabel(p.action_pct)} / RB ${pctLabel(p.rakeback_pct)} / ass. ${pctLabel(p.insurance_pct)}`;

// ── Part agence (base perçue — cascade INCHANGÉE) ────────────────────────────

interface RelRow {
  id: number; affiliate_player_id: number; referred_player_id: number; start_date: string; status: string;
  disclosed_action_pct: number | null; disclosed_rakeback_pct: number | null; disclosed_insurance_pct: number | null;
}
type Trio = { a: number | null; r: number | null; i: number | null };
interface ResolvedDeal {
  game_name: string; start_date: string | null; end_date: string | null;
  perGame: Trio; rel: Trio; deal: { a: number; r: number; i: number };
  perceived: PerceivedPeriod[];
}
/** Taux perçus effectifs d'une semaine : relation×game → perçu DE CETTE SEMAINE → relation → deal réel. */
function effAt(d: ResolvedDeal, week: string | null, curWeek: string): { effAction: number; effRb: number; effIns: number } {
  const p = periodAtP(d.perceived, week ?? curWeek);
  return {
    effAction: d.perGame.a ?? p?.action_pct ?? d.rel.a ?? d.deal.a,
    effRb: d.perGame.r ?? p?.rakeback_pct ?? d.rel.r ?? d.deal.r,
    effIns: d.perGame.i ?? p?.insurance_pct ?? d.rel.i ?? d.deal.i,
  };
}

/**
 * Deal et taux PERÇUS d'un (filleul, game) — même cascade qu'avant ce chantier :
 * relation×game → game (perçu, désormais VERSIONNÉ par semaine) → relation → deal
 * réel. null = pas de deal, game exclu, ou game inconnue : la part agence vaut
 * alors 0, comme avant.
 */
function resolveDealOn(db: DB, rel: RelRow, gameId: number, perceivedOverride?: PerceivedOverride): ResolvedDeal | null {
  const deal = db.prepare(
    `SELECT action_pct, rakeback_pct, COALESCE(insurance_pct, 0) AS insurance_pct, start_date, end_date
     FROM player_game_deals WHERE player_id = ? AND game_id = ?`
  ).get(rel.referred_player_id, gameId) as { action_pct: number; rakeback_pct: number; insurance_pct: number; start_date: string | null; end_date: string | null } | undefined;
  if (!deal) return null;
  const perGame = db.prepare(
    `SELECT disclosed_action_pct, disclosed_rakeback_pct, disclosed_insurance_pct, excluded
     FROM affiliate_relationship_games WHERE relationship_id = ? AND game_id = ?`
  ).get(rel.id, gameId) as { disclosed_action_pct: number | null; disclosed_rakeback_pct: number | null; disclosed_insurance_pct: number | null; excluded: number } | undefined;
  if (perGame?.excluded) return null;
  const game = db.prepare(`SELECT name FROM games WHERE id = ?`).get(gameId) as { name: string } | undefined;
  if (!game) return null;
  return {
    game_name: game.name, start_date: deal.start_date, end_date: deal.end_date,
    perGame: { a: perGame?.disclosed_action_pct ?? null, r: perGame?.disclosed_rakeback_pct ?? null, i: perGame?.disclosed_insurance_pct ?? null },
    rel: { a: rel.disclosed_action_pct, r: rel.disclosed_rakeback_pct, i: rel.disclosed_insurance_pct },
    deal: { a: deal.action_pct, r: deal.rakeback_pct, i: deal.insurance_pct },
    perceived: perceivedOverride && perceivedOverride.game_id === gameId ? [...perceivedOverride.periods].sort(byStartP) : perceivedPeriodsOn(db, gameId),
  };
}

/** Taux CNY→USDT — même lecture que getExchangeRate('CNY') (0 = non saisi). */
function cnyRateOn(db: DB): number {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'exchange_rate_cny_usdt'`).get() as { value: string } | undefined;
  return row ? (parseFloat(row.value) || 0) : 0;
}
const cnyToUsdt = (cny: number, rate: number) => rate === 0 ? 0 : cny * rate;

export interface AgencyWeek {
  week: string | null;        // null = date illisible (anomalie, bloque l'agent)
  eff_action: number;         // action perçue appliquée CETTE semaine
  agency_usdt: number;
  agency_native: number;
  player_net: number | null;  // null pour Wepoker (formule composite)
}
export interface AgencyDetail {
  game_name: string;
  effective_action_pct: number;
  currency: "USDT" | "CNY";
  is_composite: boolean;
  cny_rate_missing: boolean;
  weeks: AgencyWeek[];
}

// Wallet : même périmètre que l'ancien getAgencyPnLDisclosed (source ≠ unknown,
// statut actif, bornes du deal sur tx_datetime), groupé par lundi UTC.
const WALLET_WEEK = `date(substr(COALESCE(wt.tx_datetime, wt.tx_date), 1, 10), '-6 days', 'weekday 1')`;
const WEPOKER_WEEK = `date(COALESCE(rr.report_date, substr(rr.created_at, 1, 10)), '-6 days', 'weekday 1')`;

export function agencyWeeksOn(db: DB, rel: RelRow, gameId: number, ctx: { cnyRate: number; curWeek: string; perceived?: PerceivedOverride }): AgencyDetail | null {
  const d = resolveDealOn(db, rel, gameId, ctx.perceived);
  if (!d) return null;
  const cnyRate = ctx.cnyRate;
  const cur = effAt(d, ctx.curWeek, ctx.curWeek);

  if (d.game_name === "Wepoker") {
    const rows = db.prepare(`
      SELECT ${WEPOKER_WEEK} AS week,
        COALESCE(SUM(re.winnings_amount), 0) AS winnings,
        COALESCE(SUM(re.amount), 0) AS rake,
        COALESCE(SUM(re.insurance_amount), 0) AS insurance
      FROM rakeback_entries re
      JOIN rakeback_reports rr ON rr.id = re.report_id
      LEFT JOIN player_game_deals pgd ON pgd.player_id = re.player_id AND pgd.game_id = rr.game_id
      WHERE re.player_id = ? AND rr.game_id = ?
        AND (pgd.start_date IS NULL OR COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) >= pgd.start_date)
      GROUP BY week ORDER BY week
    `).all(rel.referred_player_id, gameId) as { week: string | null; winnings: number; rake: number; insurance: number }[];
    return {
      game_name: d.game_name, effective_action_pct: cur.effAction, currency: "CNY", is_composite: true,
      cny_rate_missing: cnyRate === 0,
      weeks: rows.map(r => {
        const e = effAt(d, r.week, ctx.curWeek);
        const cny = r.winnings * e.effAction / 100 + r.rake * e.effRb / 100 + r.insurance * e.effIns / 100;
        return { week: r.week, eff_action: e.effAction, agency_usdt: cnyToUsdt(cny, cnyRate), agency_native: cny, player_net: null };
      }),
    };
  }

  const cond: string[] = [`wt.player_id = ?`, `wt.game_id = ?`,
    `(wt.source IS NULL OR wt.source != 'unknown')`, `(wt.status IS NULL OR wt.status = 'active')`];
  const params: unknown[] = [rel.referred_player_id, gameId];
  if (d.start_date) { cond.push(`wt.tx_datetime >= ?`); params.push(d.start_date); }
  if (d.end_date) { cond.push(`wt.tx_datetime <= ?`); params.push(d.end_date); }
  const rows = db.prepare(`
    SELECT ${WALLET_WEEK} AS week,
      COALESCE(SUM(CASE WHEN wt.type = 'withdrawal' THEN wt.amount ELSE -wt.amount END), 0) AS net
    FROM wallet_transactions wt WHERE ${cond.join(" AND ")}
    GROUP BY week ORDER BY week
  `).all(...params) as { week: string | null; net: number }[];
  return {
    game_name: d.game_name, effective_action_pct: cur.effAction, currency: "USDT", is_composite: false, cny_rate_missing: false,
    weeks: rows.map(r => {
      const e = effAt(d, r.week, ctx.curWeek);
      const a = r.net * e.effAction / 100;
      return { week: r.week, eff_action: e.effAction, agency_usdt: a, agency_native: a, player_net: r.net };
    }),
  };
}

// ── Commission ───────────────────────────────────────────────────────────────

export interface WeekLine {
  week: string | null;
  part: number;               // part agence USDT (signée)
  eff_action: number;         // action perçue de la semaine (base)
  pct: number | null;         // taux agent de la semaine (null = aucun taux)
  commission: number | null;  // part × pct / 100 (null = incalculable)
}
export interface GameLine {
  relationship_id: number;
  referred: { id: number; name: string };
  game_id: number;
  game_name: string;
  effective_action_pct: number;
  currency: string;
  is_composite: boolean;
  cny_rate_missing: boolean;
  player_pnl: number | null;     // Σ résultat cash (null = Wepoker)
  agency_native: number;         // Σ part agence en devise native
  part_agence: number;           // Σ part agence USDT, toutes semaines
  counted_part: number;          // Σ part agence des semaines à taux > 0
  commission: number;            // Σ commission signée des semaines à taux défini
  unrated_part: number;          // Σ part agence des semaines SANS taux (≠ 0 ⇒ blocage)
  unrated_weeks: (string | null)[];
  current_pct: number | null;    // taux de la semaine en cours
  periods: RatePeriod[];
  weeks: WeekLine[];
}
export interface BlockReason {
  relationship_id: number; referred_name: string; game_id: number; game_name: string;
  weeks: (string | null)[]; part: number; reason: "taux_manquant" | "date_illisible";
}
export interface AgentCommissionDetail {
  affiliate_player_id: number;
  lines: GameLine[];                 // filleuls ACTIFS × games avec deal
  commission_signed: number;         // Σ commission signée (avant le plancher)
  cumul_agence_eligible: number;     // Σ part agence des semaines comptées (taux > 0)
  earned: number | null;             // max(0, commission_signed) — null si bloqué
  paid: number;
  due_now: number | null;            // max(0, earned − paid) — null si bloqué
  blocked: BlockReason[];
  frozen_through: string | null;     // dernier lundi gelé par un paiement (null = aucun paiement)
}
export type RateOverride = { relationship_id: number; game_id: number; periods: RatePeriod[] };
export type CalcOpts = { today?: string; override?: RateOverride; perceived?: PerceivedOverride };

function relRowOn(db: DB, relationshipId: number): (RelRow & { referred_name: string }) | undefined {
  return db.prepare(`
    SELECT ar.id, ar.affiliate_player_id, ar.referred_player_id, ar.start_date, ar.status,
      ar.disclosed_action_pct, ar.disclosed_rakeback_pct, ar.disclosed_insurance_pct, p.name AS referred_name
    FROM affiliate_relationships ar JOIN players p ON p.id = ar.referred_player_id WHERE ar.id = ?
  `).get(relationshipId) as (RelRow & { referred_name: string }) | undefined;
}

/** Lignes (game par game) d'UNE relation. `override` remplace les périodes d'un couple (aperçu). */
export function relationLinesOn(db: DB, relationshipId: number, opts: CalcOpts = {}): GameLine[] {
  const rel = relRowOn(db, relationshipId);
  if (!rel) return [];
  const curWeek = mondayOf(opts.today ?? todayIso());
  const cnyRate = cnyRateOn(db);
  const games = db.prepare(
    `SELECT DISTINCT pgd.game_id, g.name AS game_name FROM player_game_deals pgd JOIN games g ON g.id = pgd.game_id
     WHERE pgd.player_id = ? ORDER BY pgd.game_id`
  ).all(rel.referred_player_id) as { game_id: number; game_name: string }[];

  return games.map(g => {
    const periods = opts.override && opts.override.relationship_id === rel.id && opts.override.game_id === g.game_id
      ? [...opts.override.periods].sort(byStart)
      : ratePeriodsOn(db, rel.id, g.game_id);
    const ag = agencyWeeksOn(db, rel, g.game_id, { cnyRate, curWeek, perceived: opts.perceived });
    const weeks: WeekLine[] = (ag?.weeks ?? []).map(w => {
      const p = w.week === null ? null : periodAt(periods, w.week);
      const pct = p ? p.agent_pct : null;
      return { week: w.week, part: w.agency_usdt, eff_action: w.eff_action, pct, commission: pct === null ? null : w.agency_usdt * pct / 100 };
    });
    const unrated = weeks.filter(w => w.commission === null);
    const cur = periodAt(periods, curWeek);
    return {
      relationship_id: rel.id,
      referred: { id: rel.referred_player_id, name: rel.referred_name },
      game_id: g.game_id,
      game_name: g.game_name,
      effective_action_pct: ag?.effective_action_pct ?? 0,
      currency: ag?.currency ?? "USDT",
      is_composite: ag?.is_composite ?? false,
      cny_rate_missing: ag?.cny_rate_missing ?? false,
      player_pnl: ag ? (ag.is_composite ? null : (ag.weeks.reduce((s, w) => s + (w.player_net ?? 0), 0))) : 0,
      agency_native: (ag?.weeks ?? []).reduce((s, w) => s + w.agency_native, 0),
      part_agence: weeks.reduce((s, w) => s + w.part, 0),
      counted_part: weeks.reduce((s, w) => s + ((w.pct ?? 0) > 0 ? w.part : 0), 0),
      commission: weeks.reduce((s, w) => s + (w.commission ?? 0), 0),
      unrated_part: unrated.reduce((s, w) => s + w.part, 0),
      unrated_weeks: unrated.filter(w => Math.abs(w.part) > EPS).map(w => w.week),
      current_pct: cur ? cur.agent_pct : null,
      periods,
      weeks,
    };
  });
}

/** Dernier lundi gelé par un paiement de l'agent (toutes relations, tout statut), ou null. */
export function frozenThroughOn(db: DB, affiliatePlayerId: number): string | null {
  const r = db.prepare(`
    SELECT MAX(ap.paid_at) AS last FROM affiliate_payments ap
    JOIN affiliate_relationships ar ON ar.id = ap.relationship_id WHERE ar.affiliate_player_id = ?
  `).get(affiliatePlayerId) as { last: string | null };
  return r.last ? mondayOf(r.last) : null;
}

export function agentPaymentsOn(db: DB, affiliatePlayerId: number): { id: number; paid_at: string; amount_usdt: number }[] {
  return db.prepare(`
    SELECT ap.id, ap.paid_at, ap.amount_usdt FROM affiliate_payments ap
    JOIN affiliate_relationships ar ON ar.id = ap.relationship_id
    WHERE ar.affiliate_player_id = ? ORDER BY ap.paid_at
  `).all(affiliatePlayerId) as { id: number; paid_at: string; amount_usdt: number }[];
}

export function computeAgentCommissionOn(db: DB, affiliatePlayerId: number, opts: CalcOpts = {}): AgentCommissionDetail {
  const rels = db.prepare(
    `SELECT id FROM affiliate_relationships WHERE affiliate_player_id = ? AND status = 'active' ORDER BY id`
  ).all(affiliatePlayerId) as { id: number }[];
  const lines = rels.flatMap(r => relationLinesOn(db, r.id, opts));

  const blocked: BlockReason[] = [];
  for (const l of lines) {
    const undated = l.weeks.filter(w => w.week === null && Math.abs(w.part) > EPS);
    if (undated.length) blocked.push({ relationship_id: l.relationship_id, referred_name: l.referred.name, game_id: l.game_id, game_name: l.game_name, weeks: [null], part: undated.reduce((s, w) => s + w.part, 0), reason: "date_illisible" });
    const missing = l.weeks.filter(w => w.week !== null && w.commission === null && Math.abs(w.part) > EPS);
    if (missing.length) blocked.push({ relationship_id: l.relationship_id, referred_name: l.referred.name, game_id: l.game_id, game_name: l.game_name, weeks: missing.map(w => w.week), part: missing.reduce((s, w) => s + w.part, 0), reason: "taux_manquant" });
  }

  // paid = tous les paiements jamais faits sur les relations de l'agent, tout statut (inchangé).
  const paid = (db.prepare(`
    SELECT COALESCE(SUM(amount_usdt), 0) AS paid FROM affiliate_payments
    WHERE relationship_id IN (SELECT id FROM affiliate_relationships WHERE affiliate_player_id = ?)
  `).get(affiliatePlayerId) as { paid: number }).paid;

  const commission_signed = lines.reduce((s, l) => s + l.commission, 0);
  const earned = blocked.length ? null : Math.max(0, commission_signed);
  return {
    affiliate_player_id: affiliatePlayerId,
    lines,
    commission_signed,
    cumul_agence_eligible: lines.reduce((s, l) => s + l.counted_part, 0),
    earned,
    paid,
    due_now: earned === null ? null : Math.max(0, earned - paid),
    blocked,
    frozen_through: frozenThroughOn(db, affiliatePlayerId),
  };
}

/** Message de refus d'un paiement, ou null si l'agent est payable. */
export function paymentBlockOn(detail: { blocked: BlockReason[] }): string | null {
  if (!detail.blocked.length) return null;
  return "Paiement impossible — commission incalculable : " + detail.blocked.map(b =>
    b.reason === "taux_manquant"
      ? `${b.referred_name} / ${b.game_name} sans taux agent sur ${b.weeks.join(", ")} (part agence ${b.part.toFixed(2)})`
      : `${b.referred_name} / ${b.game_name} : transaction à date illisible (part agence ${b.part.toFixed(2)})`
  ).join(" ; ");
}

// ── Changement de taux ───────────────────────────────────────────────────────

export interface RateChangeWeek {
  week: string;
  part: number;
  old_pct: number | null;
  new_pct: number;
  commission_before: number | null;
  commission_after: number;
}
export interface RateChangePreview {
  relationship_id: number; referred_name: string; game_id: number; game_name: string;
  effective_action_pct: number;
  start_week: string | null; end_week: string | null;
  old_pct_at_start: number | null; new_pct: number;
  weeks: RateChangeWeek[];                        // semaines À ACTIVITÉ dont le taux change
  line_commission_before: number; line_commission_after: number;
  agent: {
    affiliate_player_id: number;
    earned_before: number | null; earned_after: number | null;
    paid: number;
    due_before: number | null; due_after: number | null;
    blocked_before: number; blocked_after: number;
  };
  rows_after: RatePeriod[];
}
export type SetAgentRateArgs = {
  relationship_id: number; game_id: number; agent_pct: number;
  start_week: string | null;         // lundi, ou null = depuis l'origine
  note?: string | null;
  confirm_retroactive?: boolean;     // confirmation explicite (un clic sur l'aperçu)
  dry_run?: boolean;                 // aperçu seul : ne JAMAIS écrire
  today?: string;
};
export type SetAgentRateResult =
  | { ok: true; written: boolean; unchanged?: true; retroactive?: true; preview?: RateChangePreview }
  | {
      ok: false; error: string;
      needs_confirmation?: true;     // pas un refus : l'aperçu est là, il manque la confirmation
      preview?: RateChangePreview;
      frozen?: { frozen_through: string; earliest_week: string; payments: { paid_at: string; amount_usdt: number }[] };
    };

/**
 * Points gelés (≤ frozen) où un taux DÉFINI avant le changement diffère après. Les taux
 * sont constants par morceaux : il suffit de les comparer à chaque début de période
 * (avant ou après), au lendemain de chaque fin, et « avant tout » (−∞, la période
 * origine). Une semaine sans taux avant (jamais payée) n'est pas un point gelé.
 */
export function frozenRateChanges(before: RatePeriod[], after: RatePeriod[], frozen: string): { from: string | null; old_pct: number; new_pct: number | null }[] {
  const pts = new Set<string>();
  for (const r of [...before, ...after]) {
    if (r.start_week !== null) pts.add(r.start_week);
    if (r.end_week !== null) pts.add(addDays(r.end_week, 7));
  }
  const sorted = [...pts].filter(w => w <= frozen).sort();
  // « Avant tout » : une semaine antérieure à tous les points (couverte par les seules périodes origine).
  const probes: (string | null)[] = [null, ...sorted];
  const at = (rs: RatePeriod[], w: string | null) =>
    w === null ? rs.find(r => r.start_week === null) ?? null : periodAt(rs, w);
  const out: { from: string | null; old_pct: number; new_pct: number | null }[] = [];
  for (const w of probes) {
    const b = at(before, w), a = at(after, w);
    if (!b) continue;
    if (!a || Math.abs(a.agent_pct - b.agent_pct) >= 1e-9) out.push({ from: w, old_pct: b.agent_pct, new_pct: a ? a.agent_pct : null });
  }
  return out;
}

/**
 * Pose un taux agent sur (relation, game) à partir d'un lundi (ou de l'origine).
 *   • REFUS DUR si une semaine GELÉE (≤ lundi du dernier paiement de l'agent) où un
 *     taux était défini changerait de taux — un montant déjà payé ne bouge jamais.
 *     Une semaine gelée SANS taux (nouveau filleul avec historique) n'a jamais été
 *     payée : la noter n'est pas un refus, c'est un rétroactif à confirmer.
 *   • RÉTROACTIF (une semaine à activité change de taux, ou une période s'insère
 *     avant une période existante) : sans confirm_retroactive, on rend l'aperçu
 *     semaine par semaine et le dû de l'agent avant → après, SANS rien écrire.
 *     Confirmé, la trace est écrite d'office dans la note de la période.
 *   • Changement en fin de chronologie sans semaine à activité touchée ⇒ direct.
 *   • 0 % saisi à la main : note OBLIGATOIRE (aussi garanti par un CHECK).
 */
export function setAgentRateOn(db: DB, a: SetAgentRateArgs): SetAgentRateResult {
  if (a.start_week !== null && (!isIsoDate(a.start_week) || !isMonday(a.start_week)))
    return { ok: false, error: `date d'effet : un lundi est attendu (pas de prorata), reçu « ${a.start_week} »` };
  try { assertAgentPct(a.agent_pct); } catch (e: any) { return { ok: false, error: e.message }; }
  const note = a.note?.trim() || null;
  if (a.agent_pct === 0 && !note) return { ok: false, error: "un taux de 0 % saisi à la main exige une note (pourquoi ce filleul ne rapporte rien à l'agent)" };

  const rel = relRowOn(db, a.relationship_id);
  if (!rel) return { ok: false, error: `relation #${a.relationship_id} introuvable` };
  const game = db.prepare(`SELECT name FROM games WHERE id = ?`).get(a.game_id) as { name: string } | undefined;
  if (!game) return { ok: false, error: `game #${a.game_id} introuvable` };

  const rows = ratePeriodsOn(db, a.relationship_id, a.game_id);
  const change = applyRateChange(rows, { relationship_id: a.relationship_id, game_id: a.game_id, agent_pct: a.agent_pct, start_week: a.start_week, kind: "manual", note });
  const { containing, next, end_week } = change;
  if (containing && Math.abs(containing.agent_pct - a.agent_pct) < 1e-9 && containing.kind === "manual")
    return { ok: true, written: false, unchanged: true };   // déjà en vigueur : rien à écrire

  // Semaines gelées : un taux DÉFINI qui changerait sur une semaine ≤ frozen ⇒ refus.
  // On ne raisonne pas sur des chevauchements d'intervalles (NULL = −∞ en début, +∞ en
  // fin : c'est là que la première version se trompait, audit F1) : on compare le taux
  // AVANT et APRÈS en chaque point où l'un des deux peut changer, jusqu'à la semaine gelée.
  const frozen = frozenThroughOn(db, rel.affiliate_player_id);
  if (frozen) {
    const hit = frozenRateChanges(rows, change.rows, frozen);
    if (hit.length) {
      const payments = agentPaymentsOn(db, rel.affiliate_player_id).map(p => ({ paid_at: p.paid_at, amount_usdt: p.amount_usdt }));
      return {
        ok: false,
        error: `refusé : ${rel.referred_name} / ${game.name} — le taux changerait sur des semaines déjà payées `
             + `(gelées jusqu'à la semaine du ${frozen} par le paiement du ${payments[payments.length - 1]?.paid_at.slice(0, 10)}). `
             + `Taux gelés qui changeraient : ${hit.map(h => `${h.from === null ? "origine" : `sem. du ${h.from}`} ${pctLabel(h.old_pct)} → ${pctLabel(h.new_pct)}`).join(", ")}. `
             + `Date d'effet possible au plus tôt : ${addDays(frozen, 7)}.`,
        frozen: { frozen_through: frozen, earliest_week: addDays(frozen, 7), payments },
      };
    }
  }

  // Aperçu : le MÊME calcul que la prod, avec les périodes simulées.
  const override: RateOverride = { relationship_id: a.relationship_id, game_id: a.game_id, periods: change.rows };
  const before = computeAgentCommissionOn(db, rel.affiliate_player_id, { today: a.today });
  const after = computeAgentCommissionOn(db, rel.affiliate_player_id, { today: a.today, override });
  // Relation terminée : hors du cumul agent, on lit la ligne directement.
  const lineBefore = before.lines.find(l => l.relationship_id === a.relationship_id && l.game_id === a.game_id)
    ?? relationLinesOn(db, a.relationship_id, { today: a.today }).find(l => l.game_id === a.game_id);
  const lineAfter = after.lines.find(l => l.relationship_id === a.relationship_id && l.game_id === a.game_id)
    ?? relationLinesOn(db, a.relationship_id, { today: a.today, override }).find(l => l.game_id === a.game_id);
  const weeks: RateChangeWeek[] = [];
  for (const wb of lineBefore?.weeks ?? []) {
    if (wb.week === null) continue;
    const wa = lineAfter?.weeks.find(w => w.week === wb.week);
    if (!wa || wa.pct === null) continue;
    if (wb.pct !== null && Math.abs(wb.pct - wa.pct) < 1e-9) continue;
    if (Math.abs(wb.part) <= EPS) continue;
    weeks.push({ week: wb.week, part: wb.part, old_pct: wb.pct, new_pct: wa.pct, commission_before: wb.commission, commission_after: wa.commission! });
  }
  const preview: RateChangePreview = {
    relationship_id: a.relationship_id, referred_name: rel.referred_name, game_id: a.game_id, game_name: game.name,
    effective_action_pct: lineBefore?.effective_action_pct ?? 0,
    start_week: a.start_week, end_week,
    old_pct_at_start: containing ? containing.agent_pct : null, new_pct: a.agent_pct,
    weeks,
    line_commission_before: lineBefore?.commission ?? 0, line_commission_after: lineAfter?.commission ?? 0,
    agent: {
      affiliate_player_id: rel.affiliate_player_id,
      earned_before: before.earned, earned_after: after.earned, paid: before.paid,
      due_before: before.due_now, due_after: after.due_now,
      blocked_before: before.blocked.length, blocked_after: after.blocked.length,
    },
    rows_after: change.rows,
  };

  const retroactive = weeks.length > 0 || next !== null || (containing !== null && containing.end_week !== null);
  if (a.dry_run) return { ok: false, error: "aperçu seul (dry_run) — rien n'a été écrit", preview, needs_confirmation: true };
  if (retroactive && !a.confirm_retroactive) {
    return {
      ok: false, needs_confirmation: true, preview,
      error: weeks.length > 0
        ? `changement rétroactif : ${weeks.length} semaine(s) à activité recalculée(s) (${weeks.map(w => w.week).join(", ")}) — confirmation explicite requise`
        : `changement rétroactif : période insérée ${a.start_week ?? "origine"} → ${end_week ?? "…"} avant une période existante — confirmation explicite requise`,
    };
  }

  // Trace AUTOMATIQUE d'un rétroactif : date, semaines recalculées, dû agent avant → après.
  const money = (n: number | null) => n === null ? "bloqué" : n.toFixed(2).replace(".", ",");
  const trace = retroactive
    ? `[rétroactif ${todayIso()}] semaines recalculées : `
      + (weeks.map(w => `${w.week} (${pctLabel(w.old_pct)} → ${pctLabel(w.new_pct)})`).join(", ") || "aucune")
      + ` ; dû agent ${money(before.due_now)} → ${money(after.due_now)}`
    : null;
  // La trace va sur la période qui couvre S APRÈS le changement — y compris quand la
  // nouvelle période a été fusionnée dans la précédente (audit, réserve 7).
  const coverS = a.start_week === null ? change.rows.find(r => r.start_week === null) : periodAt(change.rows, a.start_week);
  const finalRows = trace && coverS
    ? change.rows.map(r => r === coverS ? { ...r, note: [r.note, trace].filter(Boolean).join(" · ") } : r)
    : change.rows;

  db.transaction(() => {
    const keep = new Set(finalRows.filter(r => r.id !== undefined).map(r => r.id));
    for (const r of rows) if (!keep.has(r.id)) db.prepare(`DELETE FROM affiliate_agent_rates WHERE id = ?`).run(r.id);
    // Deux passes : on ferme/raccourcit d'abord (end_week), puis on insère — l'index
    // « une seule période en cours » ne voit jamais deux périodes ouvertes.
    const upd = db.prepare(`UPDATE affiliate_agent_rates SET agent_pct = ?, start_week = ?, end_week = ?, kind = ?, note = ? WHERE id = ?`);
    for (const r of finalRows) if (r.id !== undefined) upd.run(r.agent_pct, r.start_week, r.end_week, r.kind, r.note, r.id);
    const ins = db.prepare(`INSERT INTO affiliate_agent_rates (relationship_id, game_id, agent_pct, start_week, end_week, kind, note) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const r of finalRows) if (r.id === undefined) ins.run(r.relationship_id, r.game_id, r.agent_pct, r.start_week, r.end_week, r.kind, r.note);
  })();
  return retroactive ? { ok: true, written: true, retroactive: true, preview } : { ok: true, written: true, preview };
}

// ── Changement du DEAL PERÇU d'un game ───────────────────────────────────────
//
// Le perçu est la base de TOUS les agents dont un filleul joue ce game : l'aperçu
// est donc par agent, et le gel se juge sur l'ARGENT — pour chaque agent payé,
// aucune commission d'une semaine ≤ son lundi gelé ne doit bouger (une semaine sans
// activité, ou à taux agent 0, ne change rien : elle n'est pas un refus).

export interface PerceivedWeekChange {
  relationship_id: number; referred_name: string; week: string;
  eff_before: number; eff_after: number;
  part_before: number; part_after: number;
  commission_before: number | null; commission_after: number | null;
}
export interface PerceivedAgentImpact {
  affiliate_player_id: number; agent_name: string;
  frozen_through: string | null; paid: number;
  weeks: PerceivedWeekChange[];                 // semaines à activité dont la part agence change
  earned_before: number | null; earned_after: number | null;
  due_before: number | null; due_after: number | null;
}
export interface PerceivedChangePreview {
  game_id: number; game_name: string;
  start_week: string | null; end_week: string | null;
  before_at_start: { action_pct: number | null; rakeback_pct: number | null; insurance_pct: number | null } | null;
  after: { action_pct: number | null; rakeback_pct: number | null; insurance_pct: number | null };
  agents: PerceivedAgentImpact[];
  rows_after: PerceivedPeriod[];
}
export type SetPerceivedArgs = {
  game_id: number; action_pct: number; rakeback_pct: number | null; insurance_pct: number | null;
  start_week: string | null; note?: string | null;
  confirm_retroactive?: boolean; dry_run?: boolean; today?: string;
};
export type SetPerceivedResult =
  | { ok: true; written: boolean; unchanged?: true; retroactive?: true; preview?: PerceivedChangePreview }
  | {
      ok: false; error: string; needs_confirmation?: true; preview?: PerceivedChangePreview;
      frozen?: { agent_name: string; frozen_through: string; earliest_week: string; last_payment: string | null; weeks: PerceivedWeekChange[] }[];
    };

function assertPerceivedPct(v: unknown, what: string, nullable: boolean) {
  if (v === null && nullable) return;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) throw new Error(`${what} : pourcent attendu dans [0, 100], reçu ${String(v)}`);
  if (v > 0 && v < 1) throw new Error(`${what} : ${v} ressemble à une fraction — les deals sont en POURCENT (20 = 20 %)`);
}

export function setPerceivedDealOn(db: DB, a: SetPerceivedArgs): SetPerceivedResult {
  if (a.start_week !== null && (!isIsoDate(a.start_week) || !isMonday(a.start_week)))
    return { ok: false, error: `date d'effet : un lundi est attendu (pas de prorata), reçu « ${a.start_week} »` };
  try {
    assertPerceivedPct(a.action_pct, "action perçue", false);
    assertPerceivedPct(a.rakeback_pct, "rakeback perçu", true);
    assertPerceivedPct(a.insurance_pct, "assurance perçue", true);
  } catch (e: any) { return { ok: false, error: e.message }; }
  const game = db.prepare(`SELECT name FROM games WHERE id = ?`).get(a.game_id) as { name: string } | undefined;
  if (!game) return { ok: false, error: `game #${a.game_id} introuvable` };
  const note = a.note?.trim() || null;

  const rows = perceivedPeriodsOn(db, a.game_id);
  const fresh: PerceivedPeriod = { game_id: a.game_id, action_pct: a.action_pct, rakeback_pct: a.rakeback_pct, insurance_pct: a.insurance_pct, start_week: a.start_week, end_week: null, note };
  const change = applyPeriodChange<PerceivedPeriod>(rows, fresh, samePerceived, perceivedLabel);
  const { containing, next, end_week } = change;
  if (containing && samePerceived(containing, fresh)) return { ok: true, written: false, unchanged: true };

  // Agents touchés : ceux dont un filleul ACTIF a un deal sur ce game (seules les relations actives comptent).
  const agents = db.prepare(`
    SELECT DISTINCT ar.affiliate_player_id AS id, p.name FROM affiliate_relationships ar
    JOIN player_game_deals d ON d.player_id = ar.referred_player_id AND d.game_id = ?
    JOIN players p ON p.id = ar.affiliate_player_id
    WHERE ar.status = 'active' ORDER BY p.name
  `).all(a.game_id) as { id: number; name: string }[];
  const perceived: PerceivedOverride = { game_id: a.game_id, periods: change.rows };
  const impacts: PerceivedAgentImpact[] = [];
  const frozenHits: NonNullable<Extract<SetPerceivedResult, { ok: false }>["frozen"]> = [];
  for (const ag of agents) {
    const before = computeAgentCommissionOn(db, ag.id, { today: a.today });
    const after = computeAgentCommissionOn(db, ag.id, { today: a.today, perceived });
    const weeks: PerceivedWeekChange[] = [];
    const hits: PerceivedWeekChange[] = [];
    for (const lb of before.lines.filter(l => l.game_id === a.game_id)) {
      const la = after.lines.find(l => l.relationship_id === lb.relationship_id && l.game_id === a.game_id);
      for (const wb of lb.weeks) {
        if (wb.week === null) continue;
        const wa = la?.weeks.find(w => w.week === wb.week);
        if (!wa) continue;
        const partMoved = Math.abs(wa.part - wb.part) > 1e-9;
        const commMoved = (wa.commission === null) !== (wb.commission === null)
          || (wa.commission !== null && wb.commission !== null && Math.abs(wa.commission - wb.commission) > 1e-9);
        if (!partMoved && !commMoved) continue;
        const c: PerceivedWeekChange = {
          relationship_id: lb.relationship_id, referred_name: lb.referred.name, week: wb.week,
          eff_before: wb.eff_action, eff_after: wa.eff_action, part_before: wb.part, part_after: wa.part,
          commission_before: wb.commission, commission_after: wa.commission,
        };
        if (Math.abs(wb.part) > EPS || Math.abs(wa.part) > EPS) weeks.push(c);
        if (commMoved && before.frozen_through && wb.week <= before.frozen_through) hits.push(c);
      }
    }
    if (hits.length) {
      const pays = agentPaymentsOn(db, ag.id);
      frozenHits.push({ agent_name: ag.name, frozen_through: before.frozen_through!, earliest_week: addDays(before.frozen_through!, 7),
        last_payment: pays[pays.length - 1]?.paid_at ?? null, weeks: hits });
    }
    if (weeks.length || before.due_now !== after.due_now)
      impacts.push({ affiliate_player_id: ag.id, agent_name: ag.name, frozen_through: before.frozen_through, paid: before.paid, weeks,
        earned_before: before.earned, earned_after: after.earned, due_before: before.due_now, due_after: after.due_now });
  }
  const preview: PerceivedChangePreview = {
    game_id: a.game_id, game_name: game.name, start_week: a.start_week, end_week,
    before_at_start: containing ? { action_pct: containing.action_pct, rakeback_pct: containing.rakeback_pct, insurance_pct: containing.insurance_pct } : null,
    after: { action_pct: a.action_pct, rakeback_pct: a.rakeback_pct, insurance_pct: a.insurance_pct },
    agents: impacts, rows_after: change.rows,
  };
  if (frozenHits.length) {
    return {
      ok: false, preview, frozen: frozenHits,
      error: `refusé : changer le perçu ${game.name} modifierait des commissions déjà payées — `
        + frozenHits.map(h => `${h.agent_name} (semaines ${[...new Set(h.weeks.map(w => w.week))].join(", ")} ; gelées jusqu'à celle du ${h.frozen_through} par le paiement du ${h.last_payment?.slice(0, 10)} ; date d'effet au plus tôt ${h.earliest_week})`).join(" ; ")
        + ".",
    };
  }

  const touched = impacts.reduce((n, i) => n + i.weeks.length, 0);
  const retroactive = touched > 0 || next !== null || (containing !== null && containing.end_week !== null);
  if (a.dry_run) return { ok: false, error: "aperçu seul (dry_run) — rien n'a été écrit", preview, needs_confirmation: true };
  if (retroactive && !a.confirm_retroactive)
    return { ok: false, needs_confirmation: true, preview,
      error: touched > 0
        ? `changement rétroactif : ${touched} semaine(s) à activité recalculée(s) chez ${impacts.filter(i => i.weeks.length).length} agent(s) — confirmation explicite requise`
        : `changement rétroactif : période insérée ${a.start_week ?? "origine"} → ${end_week ?? "…"} avant une période existante — confirmation explicite requise` };

  const money = (n: number | null) => n === null ? "bloqué" : n.toFixed(2).replace(".", ",");
  const trace = retroactive
    ? `[rétroactif ${todayIso()}] ` + (impacts.map(i => `${i.agent_name} dû ${money(i.due_before)} → ${money(i.due_after)}`).join(", ") || "aucun agent touché")
    : null;
  const coverS = a.start_week === null ? change.rows.find(r => r.start_week === null) : periodAtP(change.rows, a.start_week);
  const finalRows = trace && coverS ? change.rows.map(r => r === coverS ? { ...r, note: [r.note, trace].filter(Boolean).join(" · ") } : r) : change.rows;

  db.transaction(() => {
    const keep = new Set(finalRows.filter(r => r.id !== undefined).map(r => r.id));
    for (const r of rows) if (!keep.has(r.id)) db.prepare(`DELETE FROM game_perceived_deals WHERE id = ?`).run(r.id);
    const upd = db.prepare(`UPDATE game_perceived_deals SET action_pct = ?, rakeback_pct = ?, insurance_pct = ?, start_week = ?, end_week = ?, note = ? WHERE id = ?`);
    for (const r of finalRows) if (r.id !== undefined) upd.run(r.action_pct, r.rakeback_pct, r.insurance_pct, r.start_week, r.end_week, r.note, r.id);
    const ins = db.prepare(`INSERT INTO game_perceived_deals (game_id, action_pct, rakeback_pct, insurance_pct, start_week, end_week, note) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const r of finalRows) if (r.id === undefined) ins.run(a.game_id, r.action_pct, r.rakeback_pct, r.insurance_pct, r.start_week, r.end_week, r.note);
  })();
  return retroactive ? { ok: true, written: true, retroactive: true, preview } : { ok: true, written: true, preview };
}

// ── Garde générique : une écriture ne doit bouger AUCUNE commission payée ────
//
// Pour les écritures qui changent la BASE d'un filleul hors des deux parcours versionnés
// (override relation × game, disclosed de la relation — audit F1 du 25/09) : l'écriture
// s'exécute dans une transaction, les commissions des semaines ≤ gel de l'agent sont
// comparées avant/après, et tout écart annule l'écriture avec un refus nommé.

export type FrozenGuardResult =
  | { ok: true }
  | { ok: false; error: string; weeks: { referred_name: string; game_name: string; week: string; before: number | null; after: number | null }[] };

/**
 * Commissions ET parts des semaines ≤ gel, sur TOUTES les relations de l'agent, quel que
 * soit leur statut (audit F-A : une relation en pause, modifiée puis réactivée, contournait
 * un garde limité aux relations actives). La part est comparée aussi : une semaine gelée
 * sans taux dont la part changerait ferait basculer l'agent en « bloqué ».
 */
function frozenSnapshotOn(db: DB, affiliatePlayerId: number, today?: string): { frozen: string | null; m: Map<string, { referred_name: string; game_name: string; week: string; c: number | null; part: number }> } {
  const frozen = frozenThroughOn(db, affiliatePlayerId);
  const m = new Map<string, { referred_name: string; game_name: string; week: string; c: number | null; part: number }>();
  if (!frozen) return { frozen, m };
  const rels = db.prepare(`SELECT id FROM affiliate_relationships WHERE affiliate_player_id = ?`).all(affiliatePlayerId) as { id: number }[];
  for (const { id } of rels) for (const l of relationLinesOn(db, id, { today })) for (const w of l.weeks)
    if (w.week !== null && w.week <= frozen)
      m.set(`${l.relationship_id}:${l.game_id}:${w.week}`, { referred_name: l.referred.name, game_name: l.game_name, week: w.week, c: w.commission, part: w.part });
  return { frozen, m };
}

export function withFrozenGuardOn(db: DB, affiliatePlayerId: number, write: () => void, today?: string): FrozenGuardResult {
  let refusal: FrozenGuardResult | null = null;
  const REFUSED = new Error("frozen-guard-refused");
  try {
    db.transaction(() => {
      const before = frozenSnapshotOn(db, affiliatePlayerId, today);
      write();
      const b = before.m, a = frozenSnapshotOn(db, affiliatePlayerId, today).m;
      const moved: { referred_name: string; game_name: string; week: string; before: number | null; after: number | null }[] = [];
      for (const k of new Set([...b.keys(), ...a.keys()])) {
        const x = b.get(k), y = a.get(k);
        const cb = x?.c ?? 0, ca = y?.c ?? 0;
        const nullMoved = (x?.c === null) !== (y?.c === null);
        const partMoved = Math.abs((y?.part ?? 0) - (x?.part ?? 0)) > 1e-9;
        if (nullMoved || partMoved || Math.abs(ca - cb) > 1e-9) {
          const r = (y ?? x)!;
          moved.push({ referred_name: r.referred_name, game_name: r.game_name, week: r.week, before: x ? x.c : null, after: y ? y.c : null });
        }
      }
      if (moved.length) {
        const pays = agentPaymentsOn(db, affiliatePlayerId);
        refusal = {
          ok: false, weeks: moved,
          error: `refusé : cette modification changerait des commissions déjà payées (gelées jusqu'à la semaine du ${before.frozen}, `
            + `paiement du ${pays[pays.length - 1]?.paid_at.slice(0, 10)}) — `
            + moved.slice(0, 6).map(w => `${w.referred_name} / ${w.game_name} sem. du ${w.week}`).join(", ")
            + (moved.length > 6 ? ` … (+${moved.length - 6})` : "")
            + `. Pour changer la base à partir d'une date, passe par le perçu versionné ou le taux agent.`,
        };
        throw REFUSED;   // annule l'écriture
      }
    })();
  } catch (e) {
    if (e !== REFUSED) throw e;
  }
  return refusal ?? { ok: true };
}

/** Perçu en vigueur cette semaine (affichage : config games, formulaire affiliés). */
export function currentPerceivedOn(db: DB, gameId: number, today?: string): PerceivedPeriod | null {
  return periodAtP(perceivedPeriodsOn(db, gameId), mondayOf(today ?? todayIso()));
}

// ── 5. Vue PORTAIL d'un agent (Mini App) ─────────────────────────────────
// Ce que l'agent a le droit de voir : SES taux par filleul × game et SES montants.
// Jamais le deal réel du joueur, jamais la base perçue, ni la part agence ni le
// cumul agence (décision Baki 2026-09-26). Montants null = « en cours de calcul »
// (taux manquant) : le client ne doit jamais les afficher comme 0.

export interface PortalRatePeriod {
  agent_pct: number; start_week: string | null; end_week: string | null;
  commission: number;        // Σ commission signée des semaines de cette période
}
export interface PortalGame { game_name: string; periods: PortalRatePeriod[]; commission: number | null }
export interface PortalFilleul { name: string; handle: string | null; commission: number | null; games: PortalGame[] }
export interface PortalAgentView {
  earned: number | null; paid: number; due_now: number | null;
  commission_signed: number | null;     // total signé (peut être négatif : à combler) — null si bloqué
  filleuls: PortalFilleul[];
}

export function agentPortalViewOn(db: DB, affiliatePlayerId: number, opts: CalcOpts = {}): PortalAgentView {
  const d = computeAgentCommissionOn(db, affiliatePlayerId, opts);
  const blocked = d.blocked.length > 0;
  const handles = new Map((db.prepare(
    `SELECT ar.id, p.telegram_handle FROM affiliate_relationships ar JOIN players p ON p.id = ar.referred_player_id WHERE ar.affiliate_player_id = ?`
  ).all(affiliatePlayerId) as { id: number; telegram_handle: string | null }[]).map(r => [r.id, r.telegram_handle]));
  const byRel = new Map<number, PortalFilleul>();
  for (const l of d.lines) {
    const f = byRel.get(l.relationship_id) ?? { name: l.referred.name, handle: handles.get(l.relationship_id) ?? null, commission: 0, games: [] };
    const periods: PortalRatePeriod[] = l.periods.map(p => ({
      agent_pct: p.agent_pct, start_week: p.start_week, end_week: p.end_week,
      commission: l.weeks.filter(w => w.week !== null && periodAt([p], w.week) !== null).reduce((s, w) => s + (w.commission ?? 0), 0),
    }));
    // On montre les périodes qui ont rapporté (ou coûté) et la période en cours ; un 0 % sans activité n'apprend rien à l'agent.
    const shown = periods.filter(p => Math.abs(p.commission) > 0.005 || (p.end_week === null && p.agent_pct > 0));
    const incalculable = l.unrated_weeks.length > 0;
    if (shown.length || incalculable)
      f.games.push({ game_name: l.game_name, periods: shown, commission: incalculable ? null : l.commission });
    f.commission = f.commission === null || incalculable ? null : f.commission + l.commission;
    byRel.set(l.relationship_id, f);
  }
  return {
    earned: d.earned, paid: d.paid, due_now: d.due_now,
    commission_signed: blocked ? null : d.commission_signed,
    filleuls: [...byRel.values()],
  };
}

/** Historique des taux d'une relation, game par game (ordre chronologique). */
export function rateHistoryOn(db: DB, relationshipId: number): { game_id: number; game_name: string; periods: RatePeriod[] }[] {
  const rows = db.prepare(`
    SELECT r.id, r.relationship_id, r.game_id, r.agent_pct, r.start_week, r.end_week, r.kind, r.note, r.created_at, g.name AS game_name
    FROM affiliate_agent_rates r JOIN games g ON g.id = r.game_id WHERE r.relationship_id = ?
  `).all(relationshipId) as (RatePeriod & { game_name: string })[];
  const by = new Map<number, { game_id: number; game_name: string; periods: RatePeriod[] }>();
  for (const r of rows) {
    if (!by.has(r.game_id)) by.set(r.game_id, { game_id: r.game_id, game_name: r.game_name, periods: [] });
    const { game_name: _g, ...p } = r;
    by.get(r.game_id)!.periods.push(p);
  }
  for (const v of by.values()) v.periods.sort(byStart);
  return [...by.values()].sort((x, y) => x.game_id - y.game_id);
}

// ── Contrôle LEGACY (preuve de migration) ────────────────────────────────────
//
// L'ANCIEN calcul, recopié tel quel et indépendant du moteur ci-dessus : part agence
// SUR TOUTE LA DURÉE (une seule requête, pas de découpage par semaine), éligibilité
// relue sur player_game_deals.created_at, × 0.50 en dur. Ne sert qu'à prouver, en
// prod, que la migration rend le même dû au centime. À supprimer une fois la preuve
// faite et archivée.

function legacyAgencyPnlOn(db: DB, rel: RelRow, gameId: number, cnyRate: number): number {
  // Ancienne cascade, perçu lu dans les colonnes games.perceived_* (photo de la migration).
  const deal = db.prepare(`SELECT action_pct, rakeback_pct, COALESCE(insurance_pct, 0) AS insurance_pct, start_date, end_date FROM player_game_deals WHERE player_id = ? AND game_id = ?`)
    .get(rel.referred_player_id, gameId) as { action_pct: number; rakeback_pct: number; insurance_pct: number; start_date: string | null; end_date: string | null } | undefined;
  if (!deal) return 0;
  const perGame = db.prepare(`SELECT disclosed_action_pct, disclosed_rakeback_pct, disclosed_insurance_pct, excluded FROM affiliate_relationship_games WHERE relationship_id = ? AND game_id = ?`)
    .get(rel.id, gameId) as { disclosed_action_pct: number | null; disclosed_rakeback_pct: number | null; disclosed_insurance_pct: number | null; excluded: number } | undefined;
  if (perGame?.excluded) return 0;
  const game = db.prepare(`SELECT name, perceived_action_pct, perceived_rakeback_pct, perceived_insurance_pct FROM games WHERE id = ?`)
    .get(gameId) as { name: string; perceived_action_pct: number | null; perceived_rakeback_pct: number | null; perceived_insurance_pct: number | null } | undefined;
  if (!game) return 0;
  const d = {
    game_name: game.name, start_date: deal.start_date, end_date: deal.end_date,
    effAction: perGame?.disclosed_action_pct ?? game.perceived_action_pct ?? rel.disclosed_action_pct ?? deal.action_pct,
    effRb: perGame?.disclosed_rakeback_pct ?? game.perceived_rakeback_pct ?? rel.disclosed_rakeback_pct ?? deal.rakeback_pct,
    effIns: perGame?.disclosed_insurance_pct ?? game.perceived_insurance_pct ?? rel.disclosed_insurance_pct ?? deal.insurance_pct,
  };
  if (d.game_name === "Wepoker") {
    const row = db.prepare(`
      SELECT COALESCE(SUM(re.winnings_amount), 0) AS winnings, COALESCE(SUM(re.amount), 0) AS rake, COALESCE(SUM(re.insurance_amount), 0) AS insurance
      FROM rakeback_entries re JOIN rakeback_reports rr ON rr.id = re.report_id
      LEFT JOIN player_game_deals pgd ON pgd.player_id = re.player_id AND pgd.game_id = rr.game_id
      WHERE re.player_id = ? AND rr.game_id = ?
        AND (pgd.start_date IS NULL OR COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) >= pgd.start_date)
    `).get(rel.referred_player_id, gameId) as { winnings: number; rake: number; insurance: number };
    return cnyToUsdt(row.winnings * d.effAction / 100 + row.rake * d.effRb / 100 + row.insurance * d.effIns / 100, cnyRate);
  }
  const cond: string[] = [`wt.player_id = ?`, `wt.game_id = ?`, `(wt.source IS NULL OR wt.source != 'unknown')`, `(wt.status IS NULL OR wt.status = 'active')`];
  const params: unknown[] = [rel.referred_player_id, gameId];
  if (d.start_date) { cond.push(`wt.tx_datetime >= ?`); params.push(d.start_date); }
  if (d.end_date) { cond.push(`wt.tx_datetime <= ?`); params.push(d.end_date); }
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) AS net
    FROM wallet_transactions wt WHERE ${cond.join(" AND ")}
  `).get(...params) as { net: number };
  return row.net * d.effAction / 100;
}

export function legacyAgentCommissionOn(db: DB, affiliatePlayerId: number): { cumul: number; earned: number; paid: number; due_now: number } {
  const cnyRate = cnyRateOn(db);
  const rels = db.prepare(`SELECT id FROM affiliate_relationships WHERE affiliate_player_id = ? AND status = 'active'`).all(affiliatePlayerId) as { id: number }[];
  let cumul = 0;
  for (const { id } of rels) {
    const rel = relRowOn(db, id)!;
    const games = db.prepare(`SELECT DISTINCT pgd.game_id, pgd.created_at FROM player_game_deals pgd WHERE pgd.player_id = ?`).all(rel.referred_player_id) as { game_id: number; created_at: string | null }[];
    for (const g of games) if (legacyIsEligible(rel.start_date, g.created_at)) cumul += legacyAgencyPnlOn(db, rel, g.game_id, cnyRate);
  }
  const paid = (db.prepare(`
    SELECT COALESCE(SUM(amount_usdt), 0) AS paid FROM affiliate_payments
    WHERE relationship_id IN (SELECT id FROM affiliate_relationships WHERE affiliate_player_id = ?)
  `).get(affiliatePlayerId) as { paid: number }).paid;
  const earned = Math.max(0, cumul) * (LEGACY_AGENT_PCT / 100);
  return { cumul, earned, paid, due_now: Math.max(0, earned - paid) };
}
