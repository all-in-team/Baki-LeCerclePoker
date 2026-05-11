export const dynamic = "force-dynamic";
import { getAgencyTotalPnL, getActivePlayersCount, getTopContributors, getPnLOverTime, type Period } from "@/lib/queries";
import { getDb } from "@/lib/db";
import { getCnyRate } from "@/lib/currency";
import Link from "next/link";
import { TrendingUp, Users, Wallet, AlertTriangle, CheckCircle } from "lucide-react";
import StatCard from "@/components/StatCard";
import { PnLAreaChart, AppBreakdownDonut } from "./DashboardCharts";
import DashboardActions from "./DashboardActions";

function daysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function fmt(n: number): string {
  return (n >= 0 ? "+" : "") + n.toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + " USDT";
}

function pctChange(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? "▲" : current < 0 ? "▼" : "—";
  const pct = ((current - previous) / Math.abs(previous) * 100).toFixed(0);
  return Number(pct) >= 0 ? `▲ +${pct}%` : `▼ ${pct}%`;
}

export default function DashboardPage() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const d7 = daysAgo(7);
  const d14 = daysAgo(14);
  const d30 = daysAgo(30);
  const d60 = daysAgo(60);

  const pnl7d = getAgencyTotalPnL({ from: d7, to: today });
  const pnl7dPrev = getAgencyTotalPnL({ from: d14, to: d7 });
  const pnl30d = getAgencyTotalPnL({ from: d30, to: today });
  const pnl30dPrev = getAgencyTotalPnL({ from: d60, to: d30 });
  const pnlAllTime = getAgencyTotalPnL();

  const activePlayers7d = getActivePlayersCount({ from: d7, to: today });
  const totalPlayers = (db.prepare(`SELECT COUNT(*) AS n FROM players WHERE status = 'active'`).get() as { n: number }).n;

  const top5 = getTopContributors({ from: d7, to: today }, 5);
  const timeline = getPnLOverTime({});
  const cnyRate = getCnyRate();

  const pendingSettlements = (db.prepare(`
    SELECT COUNT(*) AS n FROM weekly_settlements
    WHERE status IN ('auto_settled', 'pending_manual') AND payment_received = 0
  `).get() as { n: number }).n;

  const unpaidAmount = (db.prepare(`
    SELECT COALESCE(SUM(ABS(pnl_player)), 0) AS total
    FROM weekly_settlements
    WHERE status IN ('auto_settled', 'settled') AND payment_received = 0
  `).get() as { total: number }).total;

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", margin: 0 }}>Agency Dashboard</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>Le Cercle Poker · {today}</p>
      </div>

      {/* KPI Row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 32 }}>
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Last 7 days</div>
          <div style={{ fontSize: 32, fontWeight: 700, color: pnl7d.total_usdt >= 0 ? "#D4AF37" : "#EF4444" }}>
            {fmt(pnl7d.total_usdt)}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{pctChange(pnl7d.total_usdt, pnl7dPrev.total_usdt)} vs semaine précédente</div>
        </div>

        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Last 30 days</div>
          <div style={{ fontSize: 32, fontWeight: 700, color: pnl30d.total_usdt >= 0 ? "#D4AF37" : "#EF4444" }}>
            {fmt(pnl30d.total_usdt)}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{pctChange(pnl30d.total_usdt, pnl30dPrev.total_usdt)} vs 30j précédents</div>
        </div>

        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Active players (7d)</div>
          <div style={{ fontSize: 32, fontWeight: 700, color: "var(--text)" }}>
            {activePlayers7d}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>/ {totalPlayers} total actifs</div>
        </div>
      </div>

      <DashboardActions />

      {/* Chart: cumulative P&L */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginBottom: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 12 }}>Agency P&L · All-time (cumulatif)</div>
        <PnLAreaChart data={timeline} />
      </div>

      {/* Two-column: Breakdown + Top Contributors */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
        {/* Breakdown by App */}
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 12 }}>Breakdown by App (all-time)</div>
          <AppBreakdownDonut data={{ akpoker_usdt: pnlAllTime.akpoker_usdt, wepoker_usdt: pnlAllTime.wepoker_usdt }} />
          <div style={{ marginTop: 12, fontSize: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
              <span style={{ color: "#D4AF37", fontWeight: 600 }}>AKPOKER</span>
              <span style={{ color: "var(--text)" }}>{fmt(pnlAllTime.akpoker_usdt)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0" }}>
              <span style={{ color: "#10B981", fontWeight: 600 }}>WEPOKER</span>
              <span style={{ color: "var(--text)" }}>
                {pnlAllTime.wepoker_cny.toFixed(0)} CNY = {fmt(pnlAllTime.wepoker_usdt)}
              </span>
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>* WEPOKER converti à 1 CNY = {cnyRate} USDT</div>
          </div>
        </div>

        {/* Top Contributors */}
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 12 }}>Top Contributors · 7 derniers jours</div>
          {top5.length === 0 && <div style={{ padding: 20, color: "var(--text-dim)", textAlign: "center" }}>Aucune activité cette semaine</div>}
          {top5.map((c, i) => (
            <div key={c.player_id} style={{ display: "flex", alignItems: "center", padding: "8px 0", borderBottom: i < top5.length - 1 ? "1px solid var(--border)" : "none" }}>
              <span style={{ width: 24, fontSize: 13, fontWeight: 700, color: "var(--text-dim)" }}>{i + 1}.</span>
              <Link href={`/crm/${c.player_id}`} style={{ flex: 1, fontSize: 13, fontWeight: 500, color: "var(--text)", textDecoration: "none" }}>
                {c.player_name}
              </Link>
              <span style={{ fontSize: 13, fontWeight: 600, color: c.agency_usdt >= 0 ? "#D4AF37" : "#EF4444" }}>
                {fmt(c.agency_usdt)}
              </span>
            </div>
          ))}
          <Link href="/crm" style={{ display: "block", marginTop: 12, fontSize: 12, color: "var(--green)", textDecoration: "none" }}>Voir tous les joueurs →</Link>
        </div>
      </div>

      {/* Tasks / Alerts */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 12 }}>Actions en attente</div>
        {pendingSettlements === 0 && unpaidAmount === 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 12, color: "var(--green)" }}>
            <CheckCircle size={16} /> All caught up — pas d'actions urgentes.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {unpaidAmount > 0 && (
              <Link href="/akpoker/settlements" style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                background: "rgba(212,175,55,0.08)", border: "1px solid rgba(212,175,55,0.2)", borderRadius: 8,
                textDecoration: "none", color: "var(--text)", fontSize: 13,
              }}>
                <AlertTriangle size={16} color="#D4AF37" />
                <span><b>{pendingSettlements}</b> settlements · <b>{unpaidAmount.toFixed(0)} USDT</b> à payer</span>
              </Link>
            )}
          </div>
        )}
      </div>

      <div style={{ marginTop: 24, fontSize: 11, color: "var(--text-dim)", textAlign: "center" }}>
        Data as of {new Date().toISOString().replace("T", " ").slice(0, 16)} UTC · Refresh page to update
      </div>
    </div>
  );
}
