export const dynamic = "force-dynamic";
import { getWalletSummaryByPlayer, getWalletKPIs, getWalletTransactions, getPlayers, getGames, getPlayerCashouts } from "@/lib/queries";
import PageHeader from "@/components/PageHeader";
import WalletsClient from "./WalletsClient";

export default function WalletsPage() {
  const summary = getWalletSummaryByPlayer({ game_name: "TELE" }) as any[];
  const kpis = getWalletKPIs({ game_name: "TELE" }) ?? { total_deposited: 0, total_withdrawn: 0, total_net: 0, my_total_pnl: 0 };
  const transactions = getWalletTransactions({ limit: 200, game_name: "TELE" }) as any[];
  const players = getPlayers() as any[];
  const games = (getGames() as any[]).filter((g) => g.name === "TELE");
  const cashoutsByPlayer: Record<number, { id: number; address: string; label: string | null }[]> = {};
  for (const p of players) cashoutsByPlayer[p.id] = getPlayerCashouts(p.id);

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
      />
    </>
  );
}
