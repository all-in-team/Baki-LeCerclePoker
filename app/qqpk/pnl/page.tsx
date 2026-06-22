export const dynamic = "force-dynamic";
import { getQqpkStakingOverview, getQqpkBlockHistory, getWalletMeresForGame, getPlayerCashouts, getPlayerGameWallets } from "@/lib/queries";
import { getDb } from "@/lib/db";
import PageHeader from "@/components/PageHeader";
import QqpkStakingClient from "./QqpkStakingClient";

export default async function QQPKPage() {
  const { rows } = getQqpkStakingOverview();
  const history = getQqpkBlockHistory();

  const qqpkGameId = (getDb().prepare(`SELECT id FROM games WHERE name = 'QQPK'`).get() as { id: number } | undefined)?.id ?? 0;
  const walletMeres = qqpkGameId ? getWalletMeresForGame(qqpkGameId) : [];

  const cashoutsByPlayer: Record<number, { id: number; address: string; label: string | null }[]> = {};
  const gameWalletsByPlayer: Record<number, { id: number; address: string; label: string | null }[]> = {};
  for (const r of rows) {
    cashoutsByPlayer[r.player_id] = qqpkGameId ? getPlayerCashouts(r.player_id, qqpkGameId) : [];
    gameWalletsByPlayer[r.player_id] = qqpkGameId ? getPlayerGameWallets(r.player_id, qqpkGameId) : [];
  }

  return (
    <>
      <PageHeader
        title="QQPK — Staking"
        subtitle="Cycle roulant par joueur (date d'onboarding +1 mois) · reset sec · 70/30"
      />
      <QqpkStakingClient
        rows={rows}
        history={history}
        gameId={qqpkGameId}
        walletMeres={walletMeres}
        cashoutsByPlayer={cashoutsByPlayer}
        gameWalletsByPlayer={gameWalletsByPlayer}
      />
    </>
  );
}
