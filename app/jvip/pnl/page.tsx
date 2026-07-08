export const dynamic = "force-dynamic";
import LedgerShell from "@/components/ledger/LedgerShell";
import LedgerTable from "@/components/ledger/LedgerTable";
import WalletMeresBanner from "@/components/ledger/WalletMeresBanner";
import SyncWalletsButton from "@/components/ledger/extras/SyncWalletsButton";
import AgencyExtras from "@/components/AgencyExtras";
import { loadWalletLedger } from "@/lib/games/wallet-ledger";
import { previewAction, lockAction, markPaidAction, unlockAction, updateActionPctAction } from "./actions";

/**
 * JVIP P&L on the generic LedgerShell (same swap as AKS/A5NUTS).
 * Config-only clone of app/aks/pnl/page.tsx — all math lives in the generic
 * loader/engine, nothing game-specific here beyond the config literals.
 */
export default async function JVIPPage({ searchParams }: { searchParams: Promise<{ filter?: string; player?: string }> }) {
  const params = await searchParams;
  const data = loadWalletLedger(params, {
    gameName: "JVIP",
    extrasKey: "jvip",
    title: "JVIP — P&L",
    basePath: "/jvip/pnl",
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
            <a href="/jvip/pnl" style={{ fontSize: 11, color: "var(--text-muted)", textDecoration: "none" }}>✕ Retirer le filtre</a>
          </span>
        ) : undefined}
        actions={<SyncWalletsButton gameName="JVIP" />}
        walletMeresBanner={<WalletMeresBanner walletMeres={data.walletMeres} />}
      >
        <LedgerTable
          rows={data.summaryByPlayer}
          gameLabel="JVIP"
          gameId={data.gameId}
          cashoutsByPlayer={data.cashoutsByPlayer}
          gameWalletsByPlayer={data.gameWalletsByPlayer}
          availableByPlayer={data.availableByPlayer}
          settlementsByPlayer={data.settlementsByPlayer}
          estimatedDueByPlayer={data.estimatedDueByPlayer}
          aliasByPlayer={data.aliasByPlayer}
          updateActionPctAction={updateActionPctAction}
          previewAction={previewAction}
          lockAction={lockAction}
          markPaidAction={markPaidAction}
          unlockAction={unlockAction}
          showSettlementPreview={true}
        />
      </LedgerShell>
      <AgencyExtras gameKey="jvip" />
    </>
  );
}
