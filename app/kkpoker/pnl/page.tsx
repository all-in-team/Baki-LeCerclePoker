export const dynamic = "force-dynamic";
import LedgerShell from "@/components/ledger/LedgerShell";
import LedgerTable from "@/components/ledger/LedgerTable";
import WalletMeresBanner from "@/components/ledger/WalletMeresBanner";
import SyncWalletsButton from "@/components/ledger/extras/SyncWalletsButton";
import AgencyExtras from "@/components/AgencyExtras";
import { loadWalletLedger } from "@/lib/games/wallet-ledger";
import { previewAction, lockAction, markPaidAction, unlockAction, updateActionPctAction } from "./actions";

/**
 * KKPOKER P&L — first real page on the generic LedgerShell (shadow-validated).
 * showSettlementPreview=false (Baki: no settlement numbers outside the Régler
 * panel — KK is a continuous wallet flow, a permanent estimated due is noise).
 * The shadow route (/kkpoker/pnl/shadow) stays in place until cleanup.
 */
export default async function KKPOKERPage({ searchParams }: { searchParams: Promise<{ filter?: string; player?: string }> }) {
  const params = await searchParams;
  const data = loadWalletLedger(params, {
    gameName: "KKPOKER",
    extrasKey: "kkpoker",
    title: "KKPOKER — P&L",
    basePath: "/kkpoker/pnl",
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
            <a href="/kkpoker/pnl" style={{ fontSize: 11, color: "var(--text-muted)", textDecoration: "none" }}>✕ Retirer le filtre</a>
          </span>
        ) : undefined}
        actions={<SyncWalletsButton gameName="KKPOKER" />}
        walletMeresBanner={<WalletMeresBanner walletMeres={data.walletMeres} />}
      >
        <LedgerTable
          rows={data.summaryByPlayer}
          gameLabel="KKPOKER"
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
          showSettlementPreview={false}
        />
      </LedgerShell>
      <AgencyExtras gameKey="kkpoker" />
    </>
  );
}
