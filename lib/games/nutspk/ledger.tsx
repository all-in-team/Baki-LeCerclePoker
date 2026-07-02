import { ArrowDownLeft, ArrowUpRight, TrendingUp, Wallet } from "lucide-react";
import { getDb } from "@/lib/db";
import {
  getLockAwareSummaryByPlayer,
  getLockAwareKPIsWithExtras,
  getNetPnlSeries,
  getWalletMeresForGame,
  getPlayers,
  type WalletMere,
} from "@/lib/queries";
import { computePeriodFilter } from "@/lib/period-filter";
import { getLast12Weeks } from "@/lib/date-utils";
import { fmtKpiAmount } from "@/components/ledger/format";
import type { LedgerChart, LedgerGameConfig, LedgerKpiCard, LedgerPeriod } from "@/components/ledger/types";
import { NUTSPK_GAME_NAME } from "./config";

/**
 * NUTSPK ledger loader — server-side, builds LedgerShell props from the same
 * query calls as app/nutspk/pnl/page.tsx. This is the loader/config half of
 * the shell pattern: ALL money numbers come from lib/queries.ts unchanged and
 * are formatted here at the display boundary; the shell itself stays
 * money-blind (see components/ledger/types.ts).
 *
 * PARITY CONSTRAINT — the KPI cards and per-player rows must render the exact
 * same values as the live /nutspk/pnl (TELEClient) view for any filter/player
 * combination. The per-player KPI recompute below is copied verbatim from
 * page.tsx (extras are agency-level, no player_id → excluded when filtering).
 */

export interface NutspkLedgerRow {
  deal_id: number;
  player_id: number;
  player_name: string;
  action_pct: number;
  rakeback_pct: number;
  start_date: string | null;
  total_deposited: number;
  total_withdrawn: number;
  net: number;
  my_pnl: number;
}

export interface NutspkLedgerData {
  config: LedgerGameConfig;
  kpiCards: LedgerKpiCard[];
  period: LedgerPeriod;
  chart: LedgerChart;
  walletMeres: WalletMere[];
  summaryByPlayer: NutspkLedgerRow[];
  filterPlayerName: string | null;
}

export function loadNutspkLedger(
  params: { filter?: string; player?: string },
  basePath = "/nutspk/pnl",
): NutspkLedgerData {
  const playerFilter = params.player ? parseInt(params.player) : undefined;
  const { key, startDate, endDate, rangeLabel } = computePeriodFilter(params.filter);
  const weeks = getLast12Weeks();

  const filters = { game_name: NUTSPK_GAME_NAME, since_date: startDate, end_date: endDate };
  let summary = getLockAwareSummaryByPlayer(filters) as NutspkLedgerRow[];
  let kpis = getLockAwareKPIsWithExtras(filters, "nutspk");

  if (playerFilter) {
    summary = summary.filter((r) => r.player_id === playerFilter);
    // per-player view: extras are agency-level (no player_id) → excluded here
    kpis = {
      total_deposited: summary.reduce((s, r) => s + (r.total_deposited ?? 0), 0),
      total_withdrawn: summary.reduce((s, r) => s + (r.total_withdrawn ?? 0), 0),
      total_net: summary.reduce((s, r) => s + (r.net ?? 0), 0),
      my_total_pnl: summary.reduce((s, r) => s + (r.my_pnl ?? 0), 0),
      extras_net: 0,
    };
  }

  const netSeries = getNetPnlSeries({ ...filters, player_id: playerFilter }) as { day: string; cumulative_net: number }[];

  const nutspkGameId = (getDb().prepare(`SELECT id FROM games WHERE name = 'NUTSPK'`).get() as { id: number } | undefined)?.id;
  const walletMeres = nutspkGameId ? getWalletMeresForGame(nutspkGameId) : [];

  const players = getPlayers() as { id: number; name: string }[];
  const filterPlayerName = playerFilter ? (players.find((p) => p.id === playerFilter)?.name ?? `#${playerFilter}`) : null;

  // Aggregate deals per player + sort by my_pnl desc — copied verbatim from TELEClient.
  const summaryByPlayer = Object.values(
    summary.reduce<Record<number, NutspkLedgerRow>>((acc, r) => {
      if (!acc[r.player_id]) { acc[r.player_id] = { ...r }; }
      else { acc[r.player_id].total_deposited += r.total_deposited; acc[r.player_id].total_withdrawn += r.total_withdrawn; acc[r.player_id].net += r.net; acc[r.player_id].my_pnl += r.my_pnl; }
      return acc;
    }, {})
  ).sort((a, b) => b.my_pnl - a.my_pnl);

  const myPnlAccent: "gold" | "red" = kpis.my_total_pnl >= 0 ? "gold" : "red";
  const netAccent: "green" | "red" | "neutral" = kpis.total_net > 0 ? "green" : kpis.total_net < 0 ? "red" : "neutral";

  // Order = visual priority: Baki's two key numbers first (emphasis), raw totals after.
  const kpiCards: LedgerKpiCard[] = [
    { label: "Mon Total P&L", value: (kpis.my_total_pnl >= 0 ? "+" : "−") + fmtKpiAmount(Math.abs(kpis.my_total_pnl)) + " USDT", sub: "Ma part selon chaque deal", accent: myPnlAccent, icon: <Wallet size={18} />, emphasis: true },
    { label: "Players Net P&L", value: (kpis.total_net >= 0 ? "+" : "−") + fmtKpiAmount(Math.abs(kpis.total_net)) + " USDT", sub: "Retraits − Dépôts", accent: netAccent, icon: <TrendingUp size={18} />, emphasis: true },
    { label: "Total Deposited", value: fmtKpiAmount(kpis.total_deposited) + " USDT", sub: "Tous joueurs", accent: "neutral", icon: <ArrowDownLeft size={18} /> },
    { label: "Total Withdrawn", value: fmtKpiAmount(kpis.total_withdrawn) + " USDT", sub: "Tous joueurs", accent: "neutral", icon: <ArrowUpRight size={18} /> },
  ];

  return {
    config: {
      title: "NUTSPK — P&L",
      subtitle: "Dépôts & retraits par joueur — P&L calculé selon le deal de chaque joueur",
      basePath,
    },
    kpiCards,
    period: {
      supported: true,
      activeFilter: key,
      rangeLabel,
      weeks: weeks.map((w) => ({ isoWeek: w.isoWeek, label: w.label })),
      basePath,
    },
    chart: {
      supported: true,
      series: netSeries,
      cardNet: kpis.total_net,
      currency: "USDT",
      rangeLabel,
    },
    walletMeres,
    summaryByPlayer,
    filterPlayerName,
  };
}
