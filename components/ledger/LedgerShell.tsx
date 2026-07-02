import PageHeader from "@/components/PageHeader";
import StatCard from "@/components/StatCard";
import PeriodFilterBar from "@/components/PeriodFilterBar";
import NetPnlChart from "@/app/akpoker/pnl/NetPnlChart";
import type { LedgerShellProps } from "./types";

/**
 * Generic P&L ledger shell — shared chrome for every game's P&L page.
 *
 * Renders, top to bottom:
 *   PageHeader → action bar → wallet-mère banner → KPI/total cards →
 *   period filter (shared PeriodFilterBar, or "Non applicable") →
 *   Net P&L evolution chart (optional) → children (table + game extras).
 *
 * The shell is a SERVER component: it composes client children
 * (PeriodFilterBar, NetPnlChart) but holds no state and does no math.
 * See ./types.ts for the money-blind design invariant.
 *
 * Not yet wired to any page — introduced as scaffolding alongside the
 * existing per-game clients (TELEClient, A5SettlementClient,
 * QqpkStakingClient), which remain the live implementations until each
 * game is migrated onto this shell one at a time.
 */
export default function LedgerShell({
  config, kpiCards, period, chart, headerAction, actions, walletMeresBanner, children,
}: LedgerShellProps) {
  return (
    <div style={{ padding: "8px 28px 40px" }}>
      <PageHeader title={config.title} subtitle={config.subtitle} action={headerAction} />

      {actions && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "0 0 16px" }}>
          {actions}
        </div>
      )}

      {walletMeresBanner}

      {kpiCards.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: kpiCards.map(c => (c.emphasis ? "1.3fr" : "1fr")).join(" "), gap: 16, marginBottom: 20 }}>
          {kpiCards.map((c, i) => (
            <StatCard key={i} label={c.label} value={c.value} sub={c.sub} accent={c.accent} icon={c.icon} />
          ))}
        </div>
      )}

      {period.supported ? (
        <PeriodFilterBar
          activeFilter={period.activeFilter ?? "current"}
          rangeLabel={period.rangeLabel ?? ""}
          weeks={period.weeks ?? []}
          basePath={period.basePath ?? config.basePath}
        />
      ) : (
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", padding: "4px 12px", borderRadius: 6, background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
            Filtre période — Non applicable
          </span>
          {period.notApplicableReason && (
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{period.notApplicableReason}</span>
          )}
        </div>
      )}

      {chart?.supported && (
        <NetPnlChart
          series={chart.series ?? []}
          cardNet={chart.cardNet ?? 0}
          currency={chart.currency ?? "USDT"}
          rangeLabel={chart.rangeLabel}
        />
      )}

      {children}
    </div>
  );
}
