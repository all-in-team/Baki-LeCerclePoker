export const dynamic = "force-dynamic";
import { getWalletSummaryByPlayer, getWalletKPIs, getWalletTransactions, getPlayers, getGames } from "@/lib/queries";
import PageHeader from "@/components/PageHeader";
import WalletsClient from "./WalletsClient";

export default function WalletsPage() {
  const summary = getWalletSummaryByPlayer() as any[];
  const kpis = getWalletKPIs() ?? { total_deposited: 0, total_withdrawn: 0, total_net: 0, my_total_pnl: 0 };
  const transactions = getWalletTransactions({ limit: 200 }) as any[];
  const players = getPlayers() as any[];
  const games = getGames();

  return (
    <>
      <PageHeader
        title="Wallet Tracker"
        subtitle="Dépôts & retraits par game — P&L calculé selon le deal de chaque joueur"
      />
      <WalletsClient
        initialSummary={summary}
        kpis={kpis}
        initialTransactions={transactions}
        players={players}
        games={games}
      />
    </>
  );
}
