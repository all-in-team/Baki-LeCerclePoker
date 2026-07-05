export const dynamic = "force-dynamic";
import LedgerShell from "@/components/ledger/LedgerShell";
import LedgerTable from "@/components/ledger/LedgerTable";
import WalletMeresBanner from "@/components/ledger/WalletMeresBanner";
import SyncWalletsButton from "@/components/ledger/extras/SyncWalletsButton";
import AgencyExtras from "@/components/AgencyExtras";
import { loadWalletLedger } from "@/lib/games/wallet-ledger";
import { previewAction, lockAction, markPaidAction, unlockAction } from "./actions";

/**
 * OKPOKER P&L on the generic LedgerShell (same swap as AKS/A5NUTS).
 * Config-only clone of app/aks/pnl/page.tsx — all math lives in the generic
 * loader/engine, nothing game-specific here beyond the config literals.
 */
export default async function OKPOKERPage({ searchParams }: { searchParams: Promise<{ filter?: string; player?: string }> }) {
  const params = await searchParams;
  const data = loadWalletLedger(params, {
    gameName: "OKPOKER",
    extrasKey: "okpoker",
    title: "OKPOKER — P&L",
    basePath: "/okpoker/pnl",
  });

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
            <a href="/okpoker/pnl" style={{ fontSize: 11, color: "var(--text-muted)", textDecoration: "none" }}>✕ Retirer le filtre</a>
          </span>
        ) : undefined}
        actions={<SyncWalletsButton gameName="OKPOKER" />}
        walletMeresBanner={<WalletMeresBanner walletMeres={data.walletMeres} />}
      >
        <LedgerTable
          rows={data.summaryByPlayer}
          gameLabel="OKPOKER"
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
      <AgencyExtras gameKey="okpoker" />
    </>
  );
}
