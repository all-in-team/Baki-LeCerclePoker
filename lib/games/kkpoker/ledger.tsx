import { ArrowDownLeft, ArrowUpRight, TrendingUp, Wallet } from "lucide-react";
import { getDb } from "@/lib/db";
import {
  getLockAwareSummaryByPlayer,
  getLockAwareKPIsWithExtras,
  getNetPnlSeries,
  getWalletMeresForGame,
  getPlayers,
  getPlayerCashouts,
  getPlayerGameWallets,
  type WalletMere,
} from "@/lib/queries";
import { getAvailableTransactions, getManualSettlementHistory } from "@/lib/manual-settlement-engine";
import { computePeriodFilter } from "@/lib/period-filter";
import { getLast12Weeks } from "@/lib/date-utils";
import { fmtKpiAmount } from "@/components/ledger/format";
import type { LedgerChart, LedgerGameConfig, LedgerKpiCard, LedgerPeriod } from "@/components/ledger/types";
import type { AvailableTx, SettlementRow } from "@/components/ledger/extras/SettlementFlow";
import type { WalletAddr } from "@/components/ledger/extras/PlayerWalletsPanel";

/**
 * KKPOKER ledger loader — server-side, builds LedgerShell props + the wallets
 * and settlement extras data. Same loader pattern as lib/games/nutspk/ledger.tsx.
 *
 * PARITY CONSTRAINT — the P&L half (KPI cards, per-player rows, chart) mirrors
 * app/kkpoker/pnl/page.tsx byte-for-byte: same queries, same filters, same
 * per-player KPI recompute, same aggregation as TELEClient. The extras half
 * (availableByPlayer / settlementsByPlayer) uses lib/manual-settlement-engine
 * exactly like app/a5poker/pnl/page.tsx does for A5 — engine unchanged, just
 * called with the KKPOKER game_id.
 */

export interface KkLedgerRow {
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

export interface KkLedgerData {
  config: LedgerGameConfig;
  kpiCards: LedgerKpiCard[];
  period: LedgerPeriod;
  chart: LedgerChart;
  walletMeres: WalletMere[];
  summaryByPlayer: KkLedgerRow[];
  filterPlayerName: string | null;
  gameId: number;
  cashoutsByPlayer: Record<number, WalletAddr[]>;
  gameWalletsByPlayer: Record<number, WalletAddr[]>;
  availableByPlayer: Record<number, AvailableTx[]>;
  settlementsByPlayer: Record<number, SettlementRow[]>;
}

export function loadKkpokerLedger(
  params: { filter?: string; player?: string },
  basePath = "/kkpoker/pnl",
): KkLedgerData {
  const playerFilter = params.player ? parseInt(params.player) : undefined;
  const { key, startDate, endDate, rangeLabel } = computePeriodFilter(params.filter);
  const weeks = getLast12Weeks();

  const filters = { game_name: "KKPOKER" as const, since_date: startDate, end_date: endDate };
  let summary = getLockAwareSummaryByPlayer(filters) as KkLedgerRow[];
  let kpis = getLockAwareKPIsWithExtras(filters, "kkpoker");

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

  const kkGameId = (getDb().prepare(`SELECT id FROM games WHERE name = 'KKPOKER'`).get() as { id: number } | undefined)?.id ?? 0;
  const walletMeres = kkGameId ? getWalletMeresForGame(kkGameId) : [];

  const players = getPlayers() as { id: number; name: string }[];
  const filterPlayerName = playerFilter ? (players.find((p) => p.id === playerFilter)?.name ?? `#${playerFilter}`) : null;

  // Aggregate deals per player + sort by my_pnl desc — copied verbatim from TELEClient.
  const summaryByPlayer = Object.values(
    summary.reduce<Record<number, KkLedgerRow>>((acc, r) => {
      if (!acc[r.player_id]) { acc[r.player_id] = { ...r }; }
      else { acc[r.player_id].total_deposited += r.total_deposited; acc[r.player_id].total_withdrawn += r.total_withdrawn; acc[r.player_id].net += r.net; acc[r.player_id].my_pnl += r.my_pnl; }
      return acc;
    }, {})
  ).sort((a, b) => b.my_pnl - a.my_pnl);

  // Extras data — per listed player, same calls as app/a5poker/pnl/page.tsx.
  const cashoutsByPlayer: Record<number, WalletAddr[]> = {};
  const gameWalletsByPlayer: Record<number, WalletAddr[]> = {};
  const availableByPlayer: Record<number, AvailableTx[]> = {};
  for (const r of summaryByPlayer) {
    cashoutsByPlayer[r.player_id] = kkGameId ? getPlayerCashouts(r.player_id, kkGameId) as WalletAddr[] : [];
    gameWalletsByPlayer[r.player_id] = kkGameId ? getPlayerGameWallets(r.player_id, kkGameId) as WalletAddr[] : [];
    availableByPlayer[r.player_id] = kkGameId ? getAvailableTransactions(kkGameId, r.player_id) : [];
  }
  const history = kkGameId ? getManualSettlementHistory(kkGameId) : [];
  const settlementsByPlayer: Record<number, SettlementRow[]> = {};
  for (const s of history as SettlementRow[]) (settlementsByPlayer[s.player_id] = settlementsByPlayer[s.player_id] || []).push(s);

  const myPnlAccent: "gold" | "red" = kpis.my_total_pnl >= 0 ? "gold" : "red";
  const netAccent: "green" | "red" | "neutral" = kpis.total_net > 0 ? "green" : kpis.total_net < 0 ? "red" : "neutral";

  const kpiCards: LedgerKpiCard[] = [
    { label: "Total Deposited", value: fmtKpiAmount(kpis.total_deposited) + " USDT", sub: "Tous joueurs", accent: "neutral", icon: <ArrowDownLeft size={18} /> },
    { label: "Total Withdrawn", value: fmtKpiAmount(kpis.total_withdrawn) + " USDT", sub: "Tous joueurs", accent: "neutral", icon: <ArrowUpRight size={18} /> },
    { label: "Players Net P&L", value: (kpis.total_net >= 0 ? "+" : "−") + fmtKpiAmount(Math.abs(kpis.total_net)) + " USDT", sub: "Retraits − Dépôts", accent: netAccent, icon: <TrendingUp size={18} /> },
    { label: "Mon Total P&L", value: (kpis.my_total_pnl >= 0 ? "+" : "−") + fmtKpiAmount(Math.abs(kpis.my_total_pnl)) + " USDT", sub: "Ma part selon chaque deal", accent: myPnlAccent, icon: <Wallet size={18} /> },
  ];

  return {
    config: {
      title: "KKPOKER — P&L",
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
    gameId: kkGameId,
    cashoutsByPlayer,
    gameWalletsByPlayer,
    availableByPlayer,
    settlementsByPlayer,
  };
}
