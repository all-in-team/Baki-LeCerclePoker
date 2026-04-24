import { notFound } from "next/navigation";
import { getPlayerById, getWalletTransactions, getPlayerAssignments, getApps } from "@/lib/queries";
import PageHeader from "@/components/PageHeader";
import PlayerDetailClient from "./PlayerDetailClient";

export default async function PlayerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const player = getPlayerById(Number(id)) as any;
  if (!player) notFound();

  const transactions = getWalletTransactions({ player_id: Number(id), limit: 500 }) as any[];
  const assignments = getPlayerAssignments(Number(id)) as any[];
  const allApps = getApps() as any[];

  const deposited = transactions.filter(t => t.type === "deposit").reduce((s, t) => s + t.amount, 0);
  const withdrawn = transactions.filter(t => t.type === "withdrawal").reduce((s, t) => s + t.amount, 0);
  const net = withdrawn - deposited;
  const myPnl = net * (player.action_pct / 100);

  return (
    <>
      <PageHeader
        title={player.name}
        subtitle={player.tron_address ? `Wallet : ${player.tron_address}` : "Aucune adresse Tron configurée"}
      />
      <PlayerDetailClient
        player={player}
        transactions={transactions}
        assignments={assignments}
        allApps={allApps}
        stats={{ deposited, withdrawn, net, myPnl }}
      />
    </>
  );
}
