export const dynamic = "force-dynamic";
import { ExternalLink } from "lucide-react";
import LedgerShell from "@/components/ledger/LedgerShell";
import { loadKkpokerLedger } from "@/lib/games/kkpoker/ledger";
import type { WalletMere } from "@/lib/queries";
import ShadowTable from "./ShadowTable";
import { previewShadowAction } from "./actions";

/**
 * SHADOW route — full LedgerShell pilot for KKPOKER (base shell + the two
 * extras Baki considers vital: player wallets check + settlement flow).
 *
 * Side-by-side validation against the real page (/kkpoker/pnl, TELEClient),
 * which stays untouched. Not linked from the sidebar.
 *
 * Write safety: settlement preview computes on live data (read-only in the
 * engine); lock/pay/unlock are NOT wired (actions.ts only exports preview).
 * Wallets panel is read-only. AgencyExtras deliberately not mounted.
 */

const TRONSCAN = "https://tronscan.org/#/address/";

function WalletMeresBanner({ walletMeres }: { walletMeres: WalletMere[] }) {
  if (walletMeres.length === 0) return null;
  return (
    <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#4ade80", textTransform: "uppercase", letterSpacing: "0.08em" }}>
        WALLET{walletMeres.length > 1 ? "S" : ""} MÈRE{walletMeres.length > 1 ? "S" : ""}
      </div>
      {walletMeres.map(wm => (
        <a key={wm.id} href={TRONSCAN + wm.address} target="_blank" rel="noreferrer"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none", padding: "4px 10px", background: "rgba(74,222,128,0.08)", borderRadius: 6, border: "1px solid rgba(74,222,128,0.2)" }}>
          <span style={{ fontSize: 11, fontFamily: "monospace", color: "#4ade80", fontWeight: 600 }}>
            {wm.label ? `${wm.label}: ` : ""}{wm.address.slice(0, 6)}…{wm.address.slice(-6)}
          </span>
          <ExternalLink size={10} color="#4ade80" />
        </a>
      ))}
    </div>
  );
}

export default async function KkpokerShadowPage({ searchParams }: { searchParams: Promise<{ filter?: string; player?: string }> }) {
  const params = await searchParams;
  const data = loadKkpokerLedger(params, "/kkpoker/pnl/shadow");

  return (
    <>
      <div style={{ margin: "16px 28px 0", padding: "10px 16px", borderRadius: 8, background: "rgba(168,85,247,0.10)", border: "1px solid rgba(168,85,247,0.35)", fontSize: 12, color: "#c084fc", fontWeight: 600 }}>
        SHADOW — pilote LedgerShell complet (wallets + settlement). Settlement : preview réel sur la vraie data, Lock/Payer/Délock désactivés. Compare avec la vraie page :{" "}
        <a href={`/kkpoker/pnl${params.filter ? `?filter=${encodeURIComponent(params.filter)}` : ""}`} style={{ color: "#c084fc" }}>/kkpoker/pnl</a>
      </div>
      <LedgerShell
        config={{ ...data.config, title: "KKPOKER — P&L (shadow)" }}
        kpiCards={data.kpiCards}
        period={data.period}
        chart={data.chart}
        headerAction={data.filterPlayerName ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ background: "rgba(212,175,55,0.15)", color: "#D4AF37", padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
              Filtré : {data.filterPlayerName}
            </span>
            <a href="/kkpoker/pnl/shadow" style={{ fontSize: 11, color: "var(--text-muted)", textDecoration: "none" }}>✕ Retirer le filtre</a>
          </span>
        ) : undefined}
        walletMeresBanner={<WalletMeresBanner walletMeres={data.walletMeres} />}
      >
        <ShadowTable
          rows={data.summaryByPlayer}
          gameId={data.gameId}
          cashoutsByPlayer={data.cashoutsByPlayer}
          gameWalletsByPlayer={data.gameWalletsByPlayer}
          availableByPlayer={data.availableByPlayer}
          settlementsByPlayer={data.settlementsByPlayer}
          estimatedDueByPlayer={data.estimatedDueByPlayer}
          previewAction={previewShadowAction}
          showSettlementPreview={false}
        />
      </LedgerShell>
    </>
  );
}
