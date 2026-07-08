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
import { getAvailableTransactions, getManualSettlementHistory, previewSettlement } from "@/lib/manual-settlement-engine";
import { getAliasesForPlayers, type AliasInfo } from "@/lib/aliases";
import { computePeriodFilter } from "@/lib/period-filter";
import { getLast12Weeks } from "@/lib/date-utils";
import { fmtKpiAmount } from "@/components/ledger/format";
import type { LedgerChart, LedgerGameConfig, LedgerKpiCard, LedgerPeriod } from "@/components/ledger/types";
import type { AvailableTx, SettlementRow } from "@/components/ledger/extras/SettlementFlow";
import type { WalletAddr } from "@/components/ledger/extras/PlayerWalletsPanel";

/**
 * Generic wallet-game ledger loader — server-side, builds LedgerShell props +
 * the wallets and settlement extras data for any USDT wallet-based action game
 * (KKPOKER / AKS / NUTSPK). Generalized from lib/games/kkpoker/ledger.tsx,
 * which was validated for parity against the TELEClient pages via the shadow
 * routes.
 *
 * PARITY CONSTRAINT — the P&L half (KPI cards, per-player rows, chart) mirrors
 * the TELEClient pages byte-for-byte: same queries, same filters, same
 * per-player KPI recompute, same aggregation. The extras half
 * (availableByPlayer / settlementsByPlayer / estimatedDueByPlayer) uses
 * lib/manual-settlement-engine exactly like app/a5poker/pnl/page.tsx —
 * engine unchanged, just called with the game's id.
 */

export interface WalletLedgerRow {
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

export interface WalletLedgerData {
  config: LedgerGameConfig;
  kpiCards: LedgerKpiCard[];
  period: LedgerPeriod;
  chart: LedgerChart;
  walletMeres: WalletMere[];
  summaryByPlayer: WalletLedgerRow[];
  filterPlayerName: string | null;
  gameId: number;
  cashoutsByPlayer: Record<number, WalletAddr[]>;
  gameWalletsByPlayer: Record<number, WalletAddr[]>;
  availableByPlayer: Record<number, AvailableTx[]>;
  settlementsByPlayer: Record<number, SettlementRow[]>;
  /** amount_due_usdt from previewSettlement over ALL unsettled tx (absent if none or preview !ok). */
  estimatedDueByPlayer: Record<number, number>;
  /** Alias membership for the listed players (display-only "Vue alias"). Absent players have no alias. */
  aliasByPlayer: Record<number, AliasInfo>;
}

export interface WalletLedgerGame {
  /** DB name in `games` (SELECT id FROM games WHERE name = ?). CANONICAL game for merged views. */
  gameName: string;
  /**
   * Merged view (A5NUTS): ALL game names whose deals+txs feed the P&L, canonical first.
   * Omitted = single-game page ([gameName]). New settlements are always written under gameName.
   */
  gameNames?: string[];
  /** Key(s) for getLockAwareKPIsWithExtras / AgencyExtras (e.g. "kkpoker"). Array = summed. */
  extrasKey: string | string[];
  /** Page title, e.g. "KKPOKER — P&L". */
  title: string;
  basePath: string;
}

export function loadWalletLedger(
  params: { filter?: string; player?: string },
  game: WalletLedgerGame,
): WalletLedgerData {
  const { gameName, extrasKey, title, basePath } = game;
  const gameNames = game.gameNames?.length ? game.gameNames : [gameName];
  const playerFilter = params.player ? parseInt(params.player) : undefined;
  const { key, startDate, endDate, rangeLabel } = computePeriodFilter(params.filter);
  const weeks = getLast12Weeks();

  const filters = gameNames.length > 1
    ? { game_names: gameNames, since_date: startDate, end_date: endDate }
    : { game_name: gameName, since_date: startDate, end_date: endDate };
  let summary = getLockAwareSummaryByPlayer(filters) as WalletLedgerRow[];
  let kpis = getLockAwareKPIsWithExtras(filters, extrasKey);

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

  // gameId = CANONICAL game (first name) — manual tx entry + new settlements are stamped with it.
  // gameIds = full scope for reads (available txs, settlement history, wallets, mères).
  const db = getDb();
  const gameIds = gameNames
    .map((n) => (db.prepare(`SELECT id FROM games WHERE name = ?`).get(n) as { id: number } | undefined)?.id)
    .filter((id): id is number => id !== undefined);
  const gameId = gameIds[0] ?? 0;
  const walletMeres = gameIds.flatMap((id) => getWalletMeresForGame(id));

  const players = getPlayers() as { id: number; name: string }[];
  const filterPlayerName = playerFilter ? (players.find((p) => p.id === playerFilter)?.name ?? `#${playerFilter}`) : null;

  // Aggregate deals per player + sort by my_pnl desc — copied verbatim from TELEClient.
  const summaryByPlayer = Object.values(
    summary.reduce<Record<number, WalletLedgerRow>>((acc, r) => {
      if (!acc[r.player_id]) { acc[r.player_id] = { ...r }; }
      else { acc[r.player_id].total_deposited += r.total_deposited; acc[r.player_id].total_withdrawn += r.total_withdrawn; acc[r.player_id].net += r.net; acc[r.player_id].my_pnl += r.my_pnl; }
      return acc;
    }, {})
  ).sort((a, b) => b.my_pnl - a.my_pnl);

  // Extras data — per listed player, same calls as app/a5poker/pnl/page.tsx.
  // Merged scope: wallet lists span all games, deduped by address (same owner → same wallets
  // registered under both games must show once).
  const dedupeByAddress = (addrs: WalletAddr[]): WalletAddr[] => {
    const seen = new Set<string>();
    return addrs.filter((a) => (seen.has(a.address) ? false : (seen.add(a.address), true)));
  };
  const cashoutsByPlayer: Record<number, WalletAddr[]> = {};
  const gameWalletsByPlayer: Record<number, WalletAddr[]> = {};
  const availableByPlayer: Record<number, AvailableTx[]> = {};
  for (const r of summaryByPlayer) {
    cashoutsByPlayer[r.player_id] = dedupeByAddress(gameIds.flatMap((id) => getPlayerCashouts(r.player_id, id) as WalletAddr[]));
    gameWalletsByPlayer[r.player_id] = dedupeByAddress(gameIds.flatMap((id) => getPlayerGameWallets(r.player_id, id) as WalletAddr[]));
    availableByPlayer[r.player_id] = gameIds.length ? getAvailableTransactions(gameIds, r.player_id) : [];
  }
  const history = gameIds.length ? getManualSettlementHistory(gameIds) : [];
  const settlementsByPlayer: Record<number, SettlementRow[]> = {};
  for (const s of history as SettlementRow[]) (settlementsByPlayer[s.player_id] = settlementsByPlayer[s.player_id] || []).push(s);

  // Estimated due per player, shown on the row without opening the flow.
  // MUST match the Régler recap to the cent → same engine path (previewSettlement)
  // with ALL unsettled tx selected. No math here (invariant #2); skipped when
  // preview reports ok:false (e.g. missing deal).
  const estimatedDueByPlayer: Record<number, number> = {};
  for (const r of summaryByPlayer) {
    const avail = availableByPlayer[r.player_id];
    if (gameIds.length && avail.length > 0) {
      const p = previewSettlement(gameIds, r.player_id, avail.map(t => t.id));
      if (p.ok) estimatedDueByPlayer[r.player_id] = p.amount_due_usdt;
    }
  }

  // Alias membership (display-only) for the listed players — powers the "Vue alias" toggle.
  const aliasByPlayer = getAliasesForPlayers(summaryByPlayer.map((r) => r.player_id));

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
      title,
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
    gameId,
    cashoutsByPlayer,
    gameWalletsByPlayer,
    availableByPlayer,
    settlementsByPlayer,
    estimatedDueByPlayer,
    aliasByPlayer,
  };
}
