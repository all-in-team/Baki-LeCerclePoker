export const dynamic = "force-dynamic";
import { getAgencyTotalPnL, getActivePlayersCount, getTopContributors, getPnLOverTime } from "@/lib/queries";
import { getDb } from "@/lib/db";
import { getCnyRate } from "@/lib/currency";
import Link from "next/link";
import { TrendingUp, Users, Wallet, AlertTriangle, CheckCircle, BarChart3 } from "lucide-react";
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
    <div className="animate-fade-in">
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "#E8E8EE", margin: 0 }}>Agency Dashboard</h1>
        <p style={{ fontSize: 13, color: "#8888A0", marginTop: 6 }}>Le Cercle Poker &middot; {today}</p>
      </div>

      {/* KPI Row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 32 }}>
        <StatCard
          label="All-time P&L"
          value={fmt(pnlAllTime.total_usdt)}
          accent={pnlAllTime.total_usdt >= 0 ? "gold" : "red"}
          icon={<TrendingUp size={18} />}
        />
        <StatCard
          label="Last 30 days"
          value={fmt(pnl30d.total_usdt)}
          accent={pnl30d.total_usdt >= 0 ? "gold" : "red"}
          sub={`${pctChange(pnl30d.total_usdt, pnl30dPrev.total_usdt)} vs 30j préc.`}
          icon={<BarChart3 size={18} />}
        />
        <StatCard
          label="Last 7 days"
          value={fmt(pnl7d.total_usdt)}
          accent={pnl7d.total_usdt >= 0 ? "gold" : "red"}
          sub={`${pctChange(pnl7d.total_usdt, pnl7dPrev.total_usdt)} vs sem. préc.`}
          icon={<Wallet size={18} />}
        />
        <StatCard
          label="Active Players (7d)"
          value={String(activePlayers7d)}
          accent="green"
          sub={`/ ${totalPlayers} total actifs`}
          icon={<Users size={18} />}
        />
      </div>

      <DashboardActions />

      {/* Chart: cumulative P&L */}
      <div style={{
        background: "#1A1D23", border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 16, padding: 24, marginBottom: 20,
      }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: "#E8E8EE", marginBottom: 16 }}>
          Agency P&L &middot; All-time (cumulatif)
        </div>
        <PnLAreaChart data={timeline} />
      </div>

      {/* Two-column: Breakdown + Top Contributors */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
        {/* Breakdown by App */}
        <div style={{
          background: "#1A1D23", border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 16, padding: 24,
        }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#E8E8EE", marginBottom: 16 }}>Breakdown by App (all-time)</div>
          <AppBreakdownDonut data={{ akpoker_usdt: pnlAllTime.akpoker_usdt, kkpoker_usdt: pnlAllTime.kkpoker_usdt, a5poker_usdt: pnlAllTime.a5poker_usdt, wepoker_usdt: pnlAllTime.wepoker_usdt }} />
          <div style={{ marginTop: 16, fontSize: 13 }}>
            {[
              { label: "AKPOKER", color: "#F5C518", val: fmt(pnlAllTime.akpoker_usdt) },
              { label: "KKPOKER", color: "#3B82F6", val: fmt(pnlAllTime.kkpoker_usdt) },
              { label: "A5POKER", color: "#F59E0B", val: fmt(pnlAllTime.a5poker_usdt) },
            ].map(a => (
              <div key={a.label} style={{
                display: "flex", justifyContent: "space-between",
                padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)",
              }}>
                <span style={{ color: a.color, fontWeight: 600 }}>{a.label}</span>
                <span style={{ color: "#E8E8EE", fontVariantNumeric: "tabular-nums" }}>{a.val}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}>
              <span style={{ color: "#10B981", fontWeight: 600 }}>WEPOKER</span>
              <span style={{ color: "#E8E8EE", fontVariantNumeric: "tabular-nums" }}>
                {pnlAllTime.wepoker_cny.toFixed(0)} CNY = {fmt(pnlAllTime.wepoker_usdt)}
              </span>
            </div>
            <div style={{ fontSize: 10, color: "#555568", marginTop: 6 }}>
              * WEPOKER converti à 1 CNY = {cnyRate} USDT
            </div>
          </div>
        </div>

        {/* Top Contributors */}
        <div style={{
          background: "#1A1D23", border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 16, padding: 24,
        }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#E8E8EE", marginBottom: 16 }}>
            Top Contributors &middot; 7 derniers jours
          </div>
          {top5.length === 0 && (
            <div style={{ padding: 20, color: "#555568", textAlign: "center" }}>Aucune activité cette semaine</div>
          )}
          {top5.map((c, i) => (
            <div key={c.player_id} style={{
              display: "flex", alignItems: "center", padding: "10px 0",
              borderBottom: i < top5.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
            }}>
              <span style={{
                width: 24, height: 24, borderRadius: 8,
                background: i === 0 ? "rgba(245,197,24,0.15)" : "rgba(255,255,255,0.04)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, fontWeight: 700,
                color: i === 0 ? "#F5C518" : "#555568",
                marginRight: 12, flexShrink: 0,
              }}>{i + 1}</span>
              <Link href={`/crm/${c.player_id}`} style={{
                flex: 1, fontSize: 13, fontWeight: 500, color: "#E8E8EE", textDecoration: "none",
              }}>
                {c.player_name}
              </Link>
              <span style={{
                fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums",
                color: c.agency_usdt >= 0 ? "#F5C518" : "#EF4444",
              }}>
                {fmt(c.agency_usdt)}
              </span>
            </div>
          ))}
          <Link href="/crm" style={{
            display: "block", marginTop: 14, fontSize: 12, color: "#10B981",
            textDecoration: "none", fontWeight: 500,
          }}>
            Voir tous les joueurs &rarr;
          </Link>
        </div>
      </div>

      {/* Tasks / Alerts */}
      <div style={{
        background: "#1A1D23", border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 16, padding: 24,
      }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: "#E8E8EE", marginBottom: 12 }}>Actions en attente</div>
        {pendingSettlements === 0 && unpaidAmount === 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 12, color: "#10B981" }}>
            <CheckCircle size={16} /> All caught up &mdash; pas d&apos;actions urgentes.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {unpaidAmount > 0 && (
              <Link href="/akpoker/settlements" style={{
                display: "flex", alignItems: "center", gap: 10, padding: "12px 16px",
                background: "rgba(245,197,24,0.06)", border: "1px solid rgba(245,197,24,0.15)", borderRadius: 12,
                textDecoration: "none", color: "#E8E8EE", fontSize: 13,
              }}>
                <AlertTriangle size={16} color="#F5C518" />
                <span><b>{pendingSettlements}</b> settlements &middot; <b>{unpaidAmount.toFixed(0)} USDT</b> à payer</span>
              </Link>
            )}
          </div>
        )}
      </div>

      <div style={{ marginTop: 24, fontSize: 11, color: "#555568", textAlign: "center" }}>
        Data as of {new Date().toISOString().replace("T", " ").slice(0, 16)} UTC &middot; Refresh page to update
      </div>
    </div>
  );
}
