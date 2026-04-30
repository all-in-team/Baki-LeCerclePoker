export const dynamic = "force-dynamic";
import { getWalletSummaryByPlayer, getWalletKPIs, getWalletTransactions, getPlayers, getGames, getPlayerCashouts, getPlayerGameWallets } from "@/lib/queries";
import PageHeader from "@/components/PageHeader";
import WalletsClient from "./WalletsClient";

const PERIODS: Record<string, number> = { "48h": 2, "7d": 7, "30d": 30 };

function getSinceDate(period: string | undefined): string | undefined {
  const days = period ? PERIODS[period] : undefined;
  if (!days) return undefined;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export default async function WalletsPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const params = await searchParams;
  const period = params.period && (params.period in PERIODS || params.period === "lifetime") ? params.period : "lifetime";
  const since_date = getSinceDate(period);
  const filters = { game_name: "TELE" as const, since_date };

  const summary = getWalletSummaryByPlayer(filters) as any[];
  const kpis = getWalletKPIs(filters) ?? { total_deposited: 0, total_withdrawn: 0, total_net: 0, my_total_pnl: 0 };
  const transactions = getWalletTransactions({ ...filters, limit: 500 }) as any[];
  const players = getPlayers() as any[];
  const games = (getGames() as any[]).filter((g) => g.name === "TELE");
  const cashoutsByPlayer: Record<number, { id: number; address: string; label: string | null }[]> = {};
  const gameWalletsByPlayer: Record<number, { id: number; address: string; label: string | null }[]> = {};
  for (const p of players) {
    cashoutsByPlayer[p.id] = getPlayerCashouts(p.id);
    gameWalletsByPlayer[p.id] = getPlayerGameWallets(p.id);
  }

  return (
    <>
      <PageHeader
        title="TELE AKPOKER"
        subtitle="Dépôts & retraits par game — P&L calculé selon le deal de chaque joueur"
      />
      <WalletsClient
        initialSummary={summary}
        kpis={kpis}
        initialTransactions={transactions}
        players={players}
        games={games}
        cashoutsByPlayer={cashoutsByPlayer}
        gameWalletsByPlayer={gameWalletsByPlayer}
        period={period}
      />
    </>
  );
}
