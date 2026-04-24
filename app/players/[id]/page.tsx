export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import { getPlayerById, getWalletTransactions, getPlayerGameDeals, getGames, getPlayerWalletStats } from "@/lib/queries";
import PageHeader from "@/components/PageHeader";
import PlayerDetailClient from "./PlayerDetailClient";

export default async function PlayerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const player = getPlayerById(Number(id)) as any;
  if (!player) notFound();

  const transactions = getWalletTransactions({ player_id: Number(id), limit: 500 }) as any[];
  const gameDeals = getPlayerGameDeals(Number(id)) as any[];
  const allGames = getGames();
  const rawStats = getPlayerWalletStats(Number(id));
  const stats = rawStats ?? { deposited: 0, withdrawn: 0, net: 0, my_pnl: 0 };

  return (
    <>
      <PageHeader
        title={player.name}
        subtitle={player.tron_address ? `Wallet TELE : ${player.tron_address}` : undefined}
      />
      <PlayerDetailClient
        player={player}
        transactions={transactions}
        gameDeals={gameDeals}
        allGames={allGames}
        stats={stats}
      />
    </>
  );
}
