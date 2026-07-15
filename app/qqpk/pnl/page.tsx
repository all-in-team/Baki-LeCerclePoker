export const dynamic = "force-dynamic";
import { Settings2 } from "lucide-react";
import LedgerShell from "@/components/ledger/LedgerShell";
import WalletMeresBanner from "@/components/ledger/WalletMeresBanner";
import SyncWalletsButton from "@/components/ledger/extras/SyncWalletsButton";
import { loadQqpkLedger } from "@/lib/games/qqpk/ledger";
import QqpkShellTable from "./QqpkShellTable";
import QqpkEvolutionChart from "./QqpkEvolutionChart";

/**
 * QQPK P&L (staking) on the generic LedgerShell. All numbers come from the
 * staking engine via loadQqpkLedger — zero math in the page (invariant #2).
 *
 * The cycle selector REPLACES PeriodFilterBar (rolling monthly cycles have no
 * day granularity). Cycles are per player, so past views are RELATIVE:
 * "Cycle −n" = each player's n-th most recent settled cycle.
 */

const CHIP_BASE: React.CSSProperties = { padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" };

function CycleSelector({ cycleView, maxPastCycles }: { cycleView: number; maxPastCycles: number }) {
  const chips = [{ v: 0, label: "Cycle courant" }];
  for (let n = 1; n <= Math.min(maxPastCycles, 12); n++) chips.push({ v: n, label: `Cycle −${n}` });
  return (
    <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 20px", marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {chips.map((c) => {
          const active = c.v === cycleView;
          return (
            <a key={c.v} href={c.v === 0 ? "/qqpk/pnl" : `/qqpk/pnl?cycle=${c.v}`} style={{
              ...CHIP_BASE,
              border: active ? "1px solid var(--green)" : "1px solid var(--border)",
              background: active ? "rgba(34,197,94,0.12)" : "var(--bg-surface)",
              color: active ? "var(--green)" : "var(--text-muted)",
            }}>{c.label}</a>
          );
        })}
        {maxPastCycles === 0 && (
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Aucun cycle réglé pour l'instant — l'historique par cycle apparaîtra après le premier règlement.</span>
        )}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-dim)" }}>
        Cycles roulants par joueur (onboarding +1 mois) — « Cycle −n » = le n-ième cycle réglé le plus récent de chaque joueur.
      </div>
    </div>
  );
}

export default async function QQPKPage({ searchParams }: { searchParams: Promise<{ cycle?: string }> }) {
  const params = await searchParams;
  const data = loadQqpkLedger(params);

  return (
    <LedgerShell
      config={data.config}
      kpiCards={data.kpiCards}
      period={data.period}
      periodContent={<CycleSelector cycleView={data.cycleView} maxPastCycles={data.maxPastCycles} />}
      chart={data.chart}
      actions={
        <>
          <SyncWalletsButton gameName="QQPK" />
          {/* lien statique stylé "secondary" — Btn porte des handlers hover, interdit en RSC */}
          <a href="/settings" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 8, fontSize: 13, background: "#22252B", color: "#E8E8EE", border: "1px solid rgba(255,255,255,0.08)", fontWeight: 500, textDecoration: "none" }}>
            <Settings2 size={14} /> Config Wallets
          </a>
        </>
      }
      walletMeresBanner={
        data.walletMeres.length > 0 ? (
          <WalletMeresBanner walletMeres={data.walletMeres} />
        ) : (
          <div style={{ background: "rgba(245,197,24,0.06)", border: "1px solid rgba(245,197,24,0.2)", borderRadius: 10, padding: "10px 16px", marginBottom: 20, fontSize: 12, color: "var(--text-muted)" }}>
            ⚠️ Aucune wallet mère QQPK configurée — les retraits ne seront pas détectés au sync. Configure-la dans <a href="/settings" style={{ color: "#F5C518" }}>Settings → Config Wallets</a>.
          </div>
        )
      }
    >
      <QqpkEvolutionChart graph={data.graph} kpiTotal={data.totalCercleKpi} cycleView={data.cycleView} />
      <QqpkShellTable
        rows={data.rows}
        history={data.history}
        gameId={data.gameId}
        cycleView={data.cycleView}
        cashoutsByPlayer={data.cashoutsByPlayer}
        gameWalletsByPlayer={data.gameWalletsByPlayer}
        transactionsByPlayer={data.transactionsByPlayer}
        loadedAt={data.loadedAt}
      />
    </LedgerShell>
  );
}
