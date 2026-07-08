export const dynamic = "force-dynamic";
import LedgerShell from "@/components/ledger/LedgerShell";
import LedgerTable from "@/components/ledger/LedgerTable";
import WalletMeresBanner from "@/components/ledger/WalletMeresBanner";
import SyncWalletsButton from "@/components/ledger/extras/SyncWalletsButton";
import AgencyExtras from "@/components/AgencyExtras";
import { loadWalletLedger } from "@/lib/games/wallet-ledger";
import { previewAction, lockAction, markPaidAction, unlockAction } from "./actions";

/**
 * AKS/OK POKER — MERGED AKS + OKPOKER P&L (decision Baki: same game, two skins).
 * Same club, same wallet mère on-chain: the split dashboard was a fiction. This
 * page unions both games' deals + transactions; game rows, Telegram flows and
 * player_game_deals stay per-game (two onboarding flows converge here).
 * Canonical game = AKS (all settlement history): new settlements + manual txs
 * are stamped with it. /okpoker/pnl redirects here.
 *
 * TWO sync buttons — wallets are registered per-game, a single button would
 * leave the other game's wallets never synced (A5NUTS lesson).
 */
export default async function AKSPage({ searchParams }: { searchParams: Promise<{ filter?: string; player?: string }> }) {
  const params = await searchParams;
  const data = loadWalletLedger(params, {
    gameName: "AKS",
    gameNames: ["AKS", "OKPOKER"],
    extrasKey: ["aks", "okpoker"],
    title: "AKS/OK POKER — P&L",
    basePath: "/aks/pnl",
  });

  // Same mère address is registered under both games — dedupe for the banner.
  const meresDeduped = data.walletMeres.filter(
    (wm, i, arr) => arr.findIndex(w => w.address.toLowerCase() === wm.address.toLowerCase()) === i
  );

  return (
    <>
      <LedgerShell
        config={data.config}
        kpiCards={data.kpiCards}
        period={data.period}
        chart={data.chart}
        headerAction={data.filterPlayerName ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ background: "rgba(212,175,55,0.15)", color: "#D4AF37", padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
              Filtré : {data.filterPlayerName}
            </span>
            <a href="/aks/pnl" style={{ fontSize: 11, color: "var(--text-muted)", textDecoration: "none" }}>✕ Retirer le filtre</a>
          </span>
        ) : undefined}
        actions={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <SyncWalletsButton gameName="AKS" />
            <SyncWalletsButton gameName="OKPOKER" />
          </span>
        }
        walletMeresBanner={<WalletMeresBanner walletMeres={meresDeduped} />}
      >
        <LedgerTable
          rows={data.summaryByPlayer}
          gameLabel="AKS/OK POKER"
          gameId={data.gameId}
          cashoutsByPlayer={data.cashoutsByPlayer}
          gameWalletsByPlayer={data.gameWalletsByPlayer}
          availableByPlayer={data.availableByPlayer}
          settlementsByPlayer={data.settlementsByPlayer}
          estimatedDueByPlayer={data.estimatedDueByPlayer}
          previewAction={previewAction}
          lockAction={lockAction}
          markPaidAction={markPaidAction}
          unlockAction={unlockAction}
          showSettlementPreview={true}
        />
      </LedgerShell>
      <AgencyExtras gameKey="aks" />
    </>
  );
}
