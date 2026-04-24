import { getWalletSummaryByPlayer, getWalletKPIs, getWalletTransactions, getPlayers, getApps } from "@/lib/queries";
import PageHeader from "@/components/PageHeader";
import WalletsClient from "./WalletsClient";

export default function WalletsPage() {
  const summary = getWalletSummaryByPlayer() as any[];
  const kpis = getWalletKPIs() ?? { total_deposited: 0, total_withdrawn: 0, total_net: 0, my_total_pnl: 0 };
  const transactions = getWalletTransactions({ limit: 200 }) as any[];
  const players = getPlayers() as any[];
  const apps = getApps() as any[];

  return (
    <>
      <PageHeader
        title="TELE WT"
        subtitle="Suivi des wallets TELE — dépôts & retraits USDT, P&L calculé automatiquement"
      />
      <WalletsClient
        initialSummary={summary}
        kpis={kpis}
        initialTransactions={transactions}
        players={players}
        apps={apps}
      />
    </>
  );
}
