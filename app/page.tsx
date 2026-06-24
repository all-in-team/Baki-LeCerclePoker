export const dynamic = "force-dynamic";
import {
  getAgencyTotalPnL, getActivePlayersCount, getTopContributors, getPnLOverTime,
  getOpsFeed, getDashboardStatus, getVolumeByGame, type GameVolume,
} from "@/lib/queries";
import { getDb } from "@/lib/db";
import Link from "next/link";
import { TrendingUp, Users, Wallet, AlertTriangle, CheckCircle, BarChart3, Activity } from "lucide-react";
import StatCard from "@/components/StatCard";
import Odometer from "@/components/Odometer";
import WarRoomHero from "./WarRoomHero";
import OpsFeedTerminal from "./OpsFeedTerminal";
import PlatformTickers, { type PlatformTicker } from "./PlatformTickers";
import { WarRoomPnLChart } from "./WarRoomCharts";
import DashboardActions from "./DashboardActions";
import VolumePie, { type VolumeSlice } from "./VolumePie";

// Internal game name → dashboard display label + ticker color (mirrors PlatformTickers colors).
const VOLUME_GAME_META: Record<string, { label: string; color: string }> = {
  TELE: { label: "AKPOKER", color: "#F5C518" },
  KKPOKER: { label: "KKPOKER", color: "#3B82F6" },
  A5POKER: { label: "A5POKER", color: "#F59E0B" },
  AKS: { label: "AKS", color: "#EC4899" },
  WEPOKER: { label: "WEPOKER", color: "#10B981" },
  QQPK: { label: "QQPK", color: "#06B6D4" },
};
const VOLUME_FALLBACK_COLORS = ["#A855F7", "#F43F5E", "#8B5CF6", "#22D3EE", "#84CC16"];

function toVolumeSlices(vols: GameVolume[]): VolumeSlice[] {
  return vols.map((v, i) => {
    const meta = VOLUME_GAME_META[v.game_name];
    return {
      name: meta?.label ?? v.game_name,
      color: meta?.color ?? VOLUME_FALLBACK_COLORS[i % VOLUME_FALLBACK_COLORS.length],
      value: Math.round(v.volume_usdt),
      missingRate: v.missing_rate,
    };
  });
}
const volTotal = (vols: GameVolume[]) => vols.reduce((s, v) => s + v.volume_usdt, 0);

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
  const status = getDashboardStatus();
  const events = getOpsFeed(20);
  const top5 = getTopContributors({ from: d7, to: today }, 5);
  const timeline = getPnLOverTime({});

  // Volume par game (déposits + retraits, USDT) — current vs previous period for evolution %.
  const range = (from: string, to: string) => ({ since_date: from + "T00:00:00Z", end_date: to + "T23:59:59Z" });
  const vol7d = getVolumeByGame(range(d7, today));
  const vol7dPrev = getVolumeByGame(range(d14, d7));
  const vol30d = getVolumeByGame(range(d30, today));
  const vol30dPrev = getVolumeByGame(range(d60, d30));

  // Hero sparkline: cumulative total over the last 30 days
  let cum = 0;
  const cumAll = timeline.map(p => { cum += p.total_usdt; return { date: p.date, v: cum }; });
  const spark30d = cumAll.filter(p => p.date >= d30).map(p => p.v);

  // Per-platform 30d cumulative sparklines
  const sparkFor = (key: "akpoker_usdt" | "kkpoker_usdt" | "a5poker_usdt" | "aks_usdt" | "wepoker_usdt" | "grindhouse_usdt") => {
    let c = 0;
    return timeline.map(p => { c += p[key]; return { date: p.date, v: c }; })
      .filter(p => p.date >= d30).map(p => p.v);
  };

  const tickers: PlatformTicker[] = [
    { name: "AKPOKER", color: "#F5C518", pnl30d: pnl30d.akpoker_usdt, pnl30dPrev: pnl30dPrev.akpoker_usdt, allTime: pnlAllTime.akpoker_usdt, spark: sparkFor("akpoker_usdt") },
    { name: "KKPOKER", color: "#3B82F6", pnl30d: pnl30d.kkpoker_usdt, pnl30dPrev: pnl30dPrev.kkpoker_usdt, allTime: pnlAllTime.kkpoker_usdt, spark: sparkFor("kkpoker_usdt") },
    { name: "A5POKER", color: "#F59E0B", pnl30d: pnl30d.a5poker_usdt, pnl30dPrev: pnl30dPrev.a5poker_usdt, allTime: pnlAllTime.a5poker_usdt, spark: sparkFor("a5poker_usdt") },
    { name: "AKS", color: "#EC4899", pnl30d: pnl30d.aks_usdt, pnl30dPrev: pnl30dPrev.aks_usdt, allTime: pnlAllTime.aks_usdt, spark: sparkFor("aks_usdt") },
    { name: "WEPOKER", color: "#10B981", pnl30d: pnl30d.wepoker_usdt, pnl30dPrev: pnl30dPrev.wepoker_usdt, allTime: pnlAllTime.wepoker_usdt, spark: sparkFor("wepoker_usdt") },
    { name: "GRINDHOUSE", color: "#A855F7", pnl30d: pnl30d.grindhouse_usdt, pnl30dPrev: pnl30dPrev.grindhouse_usdt, allTime: pnlAllTime.grindhouse_usdt, spark: sparkFor("grindhouse_usdt"), href: "/grindhouse/dashboard" },
  ];

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
      {/* Hero + main chart (left 2/3) · Ops feed (right 1/3, full height) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <div className="lg:col-span-2 min-w-0">
          <WarRoomHero
            totalUsdt={pnlAllTime.total_usdt}
            gamesUsdt={pnlAllTime.games_usdt}
            grindhouseUsdt={pnlAllTime.grindhouse_usdt}
            extrasUsdt={pnlAllTime.extras_usdt}
            pnl30d={pnl30d.total_usdt}
            pnl30dPrev={pnl30dPrev.total_usdt}
            spark30d={spark30d}
            activePlayers={status.active_players}
            activePlatforms={status.active_games}
          />
        </div>
        {/* Mobile: feed sits right under the hero. Desktop: right column spanning hero + chart rows. */}
        <div className="min-w-0 lg:col-start-3 lg:row-start-1 lg:row-span-2" style={{ maxHeight: 560 }}>
          <OpsFeedTerminal events={events} />
        </div>
        <div className="lg:col-span-2 min-w-0 glass-card" style={{ padding: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <Activity size={15} color="#10B981" />
            <span style={{ fontSize: 14, fontWeight: 600, color: "#E8E8EE" }}>
              Profit cumulé · All-time
            </span>
          </div>
          <WarRoomPnLChart data={timeline} />
        </div>
      </div>

      {/* Platform tickers */}
      <div className="mb-4">
        <PlatformTickers tickers={tickers} />
      </div>

      {/* KPI StatCards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 16 }}>
        <StatCard
          label="All-time P&L"
          value={<Odometer value={Math.round(pnlAllTime.total_usdt)} signed suffix=" USDT" durationMs={800} />}
          accent={pnlAllTime.total_usdt >= 0 ? "gold" : "red"}
          icon={<TrendingUp size={18} />}
        />
        <StatCard
          label="Last 30 days"
          value={<Odometer value={Math.round(pnl30d.total_usdt)} signed suffix=" USDT" durationMs={800} />}
          accent={pnl30d.total_usdt >= 0 ? "gold" : "red"}
          sub={`${pctChange(pnl30d.total_usdt, pnl30dPrev.total_usdt)} vs 30j préc.`}
          icon={<BarChart3 size={18} />}
        />
        <StatCard
          label="Last 7 days"
          value={<Odometer value={Math.round(pnl7d.total_usdt)} signed suffix=" USDT" durationMs={800} />}
          accent={pnl7d.total_usdt >= 0 ? "gold" : "red"}
          sub={`${pctChange(pnl7d.total_usdt, pnl7dPrev.total_usdt)} vs sem. préc.`}
          icon={<Wallet size={18} />}
        />
        <StatCard
          label="Active Players (7d)"
          value={<Odometer value={activePlayers7d} durationMs={800} />}
          accent="green"
          sub={`/ ${status.active_players} total actifs`}
          icon={<Users size={18} />}
        />
      </div>

      <DashboardActions />

      {/* Volume par game — pie + évolution globale */}
      <div className="mb-4" style={{ marginTop: 16 }}>
        <VolumePie
          d7={{ slices: toVolumeSlices(vol7d), total: volTotal(vol7d) }}
          d7Prev={volTotal(vol7dPrev)}
          d30={{ slices: toVolumeSlices(vol30d), total: volTotal(vol30d) }}
          d30Prev={volTotal(vol30dPrev)}
        />
      </div>

      {/* Bottom row: Top contributors + Actions en attente */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="glass-card" style={{ padding: 24 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#E8E8EE", marginBottom: 16 }}>
            Top Contributors · 7 derniers jours
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

        <div className="glass-card" style={{ padding: 24 }}>
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
      </div>

      <div className="font-term" style={{ marginTop: 24, fontSize: 10, color: "#555568", textAlign: "center", letterSpacing: "0.06em" }}>
        DATA AS OF {new Date().toISOString().replace("T", " ").slice(0, 16)} UTC — REFRESH TO UPDATE
      </div>
    </div>
  );
}
