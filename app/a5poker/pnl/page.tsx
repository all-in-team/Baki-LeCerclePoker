export const dynamic = "force-dynamic";
import { getDb } from "@/lib/db";
import {
  getWalletSummaryByPlayer, getWalletKPIs, getNetPnlSeries,
  getPlayerCashouts, getPlayerGameWallets, getWalletMeresForGame,
} from "@/lib/queries";
import { getAvailableTransactions, getManualSettlementHistory } from "@/lib/manual-settlement-engine";
import PageHeader from "@/components/PageHeader";
import AgencyExtras from "@/components/AgencyExtras";
import A5SettlementClient from "./A5SettlementClient";

function computePeriod(filter: string | undefined): { key: string; since?: string; end?: string; label: string } {
  const now = new Date();
  if (filter === "7d") {
    const s = new Date(now.getTime() - 7 * 86400000);
    return { key: "7d", since: s.toISOString(), end: now.toISOString(), label: "7 derniers jours" };
  }
  if (filter === "30d") {
    const s = new Date(now.getTime() - 30 * 86400000);
    return { key: "30d", since: s.toISOString(), end: now.toISOString(), label: "30 derniers jours" };
  }
  return { key: "lifetime", since: undefined, end: undefined, label: "Lifetime" };
}

export default async function A5POKERPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { filter } = await searchParams;
  const period = computePeriod(filter);
  const a5GameId = (getDb().prepare(`SELECT id FROM games WHERE name = 'A5POKER'`).get() as { id: number } | undefined)?.id;
  if (!a5GameId) {
    return <PageHeader title="A5POKER — P&L" subtitle="Game A5POKER introuvable en base." />;
  }

  // P&L view (KPIs / rows / curve) honors the period filter. The settlement flow below is
  // period-INDEPENDENT (operates on ALL unsettled tx) — availableByPlayer stays lifetime.
  const pFilter = { game_name: "A5POKER" as const, since_date: period.since, end_date: period.end };
  const summary = getWalletSummaryByPlayer(pFilter) as any[];
  const kpis = getWalletKPIs(pFilter);
  const netSeries = getNetPnlSeries(pFilter) as { day: string; cumulative_net: number }[];

  // Deal players (incl. those with no tx yet) — the table rows.
  const dealPlayers = getDb().prepare(`
    SELECT p.id AS player_id, p.name AS player_name, pgd.action_pct, pgd.start_date
    FROM player_game_deals pgd JOIN players p ON p.id = pgd.player_id
    WHERE pgd.game_id = ? ORDER BY p.name
  `).all(a5GameId) as { player_id: number; player_name: string; action_pct: number; start_date: string | null }[];

  const summaryByPid = new Map(summary.map((s) => [s.player_id, s]));
  const rows = dealPlayers.map((p) => {
    const s = summaryByPid.get(p.player_id);
    return {
      player_id: p.player_id, player_name: p.player_name,
      action_pct: p.action_pct, start_date: p.start_date,
      deposited: s?.total_deposited ?? 0, withdrawn: s?.total_withdrawn ?? 0,
      net: s?.net ?? 0, my_pnl: s?.my_pnl ?? 0,
    };
  });

  const walletMeres = getWalletMeresForGame(a5GameId);
  const cashoutsByPlayer: Record<number, any[]> = {};
  const gameWalletsByPlayer: Record<number, any[]> = {};
  const availableByPlayer: Record<number, any[]> = {};
  for (const p of dealPlayers) {
    cashoutsByPlayer[p.player_id] = getPlayerCashouts(p.player_id, a5GameId);
    gameWalletsByPlayer[p.player_id] = getPlayerGameWallets(p.player_id, a5GameId);
    availableByPlayer[p.player_id] = getAvailableTransactions(a5GameId, p.player_id);
  }

  const history = getManualSettlementHistory(a5GameId);
  const settlementsByPlayer: Record<number, any[]> = {};
  for (const s of history as any[]) (settlementsByPlayer[s.player_id] = settlementsByPlayer[s.player_id] || []).push(s);

  return (
    <>
      <PageHeader
        title="A5POKER — P&L & Règlements"
        subtitle="Wallets, transactions et règlements manuels par joueur — déplie un joueur pour tout gérer"
      />
      <A5SettlementClient
        rows={rows}
        kpis={kpis}
        netSeries={netSeries}
        availableByPlayer={availableByPlayer}
        settlementsByPlayer={settlementsByPlayer}
        cashoutsByPlayer={cashoutsByPlayer}
        gameWalletsByPlayer={gameWalletsByPlayer}
        walletMeres={walletMeres}
        gameId={a5GameId}
        activeFilter={period.key}
        rangeLabel={period.label}
        basePath="/a5poker/pnl"
      />
      <AgencyExtras gameKey="a5poker" />
    </>
  );
}
