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

export default async function A5POKERPage() {
  const a5GameId = (getDb().prepare(`SELECT id FROM games WHERE name = 'A5POKER'`).get() as { id: number } | undefined)?.id;
  if (!a5GameId) {
    return <PageHeader title="A5POKER — P&L" subtitle="Game A5POKER introuvable en base." />;
  }

  // Lifetime data (the QQPK-style client is period-independent; settlement operates on all unsettled tx).
  const summary = getWalletSummaryByPlayer({ game_name: "A5POKER" }) as any[];
  const kpis = getWalletKPIs({ game_name: "A5POKER" });
  const netSeries = getNetPnlSeries({ game_name: "A5POKER" }) as { day: string; cumulative_net: number }[];

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
      />
      <AgencyExtras gameKey="a5poker" />
    </>
  );
}
