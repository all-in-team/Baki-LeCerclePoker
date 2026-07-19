export const dynamic = "force-dynamic";
import LedgerShell from "@/components/ledger/LedgerShell";
import LedgerTable from "@/components/ledger/LedgerTable";
import WalletMeresBanner from "@/components/ledger/WalletMeresBanner";
import SyncWalletsButton from "@/components/ledger/extras/SyncWalletsButton";
import AgencyExtras from "@/components/AgencyExtras";
import { loadWalletLedger } from "@/lib/games/wallet-ledger";
import { previewAction, lockAction, markPaidAction, unlockAction, updateActionPctAction } from "./actions";

/**
 * A5NUTS — MERGED A5POKER + NUTSPK P&L (decision Baki, Tir 2).
 * Same owner, same wallets: winnings are indissociables par game, so the split
 * dashboard was a fiction. This page unions both games' deals + transactions;
 * game_name in DB, Telegram flows and player_game_deals stay per-game.
 * Canonical game = A5POKER: new settlements + manual txs are stamped with it.
 * Replaces /a5poker/pnl and /nutspk/pnl (both redirect here).
 */
export default async function A5NUTSPage({ searchParams }: { searchParams: Promise<{ filter?: string; player?: string }> }) {
  const params = await searchParams;
  const data = loadWalletLedger(params, {
    gameName: "A5POKER",
    gameNames: ["A5POKER", "NUTSPK"],
    extrasKey: ["a5poker", "nutspk"],
    title: "A5NUTS — P&L",
    basePath: "/a5nuts/pnl",
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
            <a href="/a5nuts/pnl" style={{ fontSize: 11, color: "var(--text-muted)", textDecoration: "none" }}>✕ Retirer le filtre</a>
          </span>
        ) : undefined}
        actions={
          // Vue fusionnée A5+NUTS : un bouton par game, comme la page AKS/OKPOKER.
          // (History: seul A5POKER était syncable ici — les wallets NUTSPK n'étaient
          // JAMAIS scannés, ex. buy-in 190 USDT de Gaetan du 04/07 invisible.)
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <SyncWalletsButton gameName="A5POKER" />
            <SyncWalletsButton gameName="NUTSPK" />
          </span>
        }
        walletMeresBanner={<WalletMeresBanner walletMeres={data.walletMeres} />}
      >
        <LedgerTable
          rows={data.summaryByPlayer}
          gameLabel="A5NUTS"
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
      <AgencyExtras gameKey="a5poker" />
    </>
  );
}
