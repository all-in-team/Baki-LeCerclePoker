import { getNetByApp, getNetByPlayer, getNetByMonth, getNetByWeek, getPeriods, getWalletKPIs, getWalletSummaryByPlayer } from "@/lib/queries";
import PageHeader from "@/components/PageHeader";
import StatCard from "@/components/StatCard";
import Badge from "@/components/Badge";
import Link from "next/link";
import { TrendingUp, Users, AppWindow, DollarSign, Wallet } from "lucide-react";
import ChartsWrapper from "./ChartsWrapper";

function fmt(n: number, currency = "€") {
  const abs = Math.abs(n);
  const s = abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : abs.toFixed(2);
  return `${n < 0 ? "-" : ""}${currency}${s}`;
}

export default function DashboardPage() {
  const byApp = getNetByApp() as { id: number; name: string; currency: string; gross: number; player_cuts: number; net: number }[];
  const byPlayer = getNetByPlayer() as { id: number; name: string; status: string; gross: number; player_cuts: number; net: number }[];
  const byMonth = getNetByMonth() as { month: string; gross: number; player_cuts: number; net: number }[];
  const byWeek = getNetByWeek() as { week: string; gross: number; player_cuts: number; net: number }[];
  const periods = getPeriods();

  const totalGross = byApp.reduce((s, a) => s + a.gross, 0);
  const totalNet = byApp.reduce((s, a) => s + a.net, 0);
  const totalCuts = byApp.reduce((s, a) => s + a.player_cuts, 0);
  const margin = totalGross > 0 ? ((totalNet / totalGross) * 100).toFixed(1) : "0";

  const thisMonth = byMonth[0];

  const walletKpis = getWalletKPIs() ?? { total_deposited: 0, total_withdrawn: 0, total_net: 0, my_total_pnl: 0 };
  const walletByPlayer = getWalletSummaryByPlayer() as { id: number; name: string; action_pct: number; total_deposited: number; total_withdrawn: number; net: number; my_pnl: number }[];

  return (
    <div>
      <PageHeader
        title="Accounting Dashboard"
        subtitle="All-time earnings overview"
      />

      {/* KPI Row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 32 }}>
        <StatCard label="Total Gross" value={fmt(totalGross)} sub="All apps, all time" accent="neutral" icon={<DollarSign size={18} />} />
        <StatCard label="My Net" value={fmt(totalNet)} sub="After player cuts" accent="green" icon={<TrendingUp size={18} />} />
        <StatCard label="Player Cuts" value={fmt(totalCuts)} sub="Paid to players" accent="gold" icon={<Users size={18} />} />
        <StatCard label="Margin" value={`${margin}%`} sub="Net / Gross ratio" accent={Number(margin) >= 50 ? "green" : "gold"} icon={<AppWindow size={18} />} />
      </div>

      {/* This month */}
      {thisMonth && (
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
            {thisMonth.month}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
            <StatCard label="Gross this month" value={fmt(thisMonth.gross)} accent="neutral" />
            <StatCard label="Net this month" value={fmt(thisMonth.net)} accent={thisMonth.net >= 0 ? "green" : "red"} />
            <StatCard label="Player cuts this month" value={fmt(thisMonth.player_cuts)} accent="gold" />
          </div>
        </div>
      )}

      <ChartsWrapper byMonth={byMonth} byWeek={byWeek} byApp={byApp} byPlayer={byPlayer} />

      {/* Tables */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginTop: 32 }}>
        {/* By App */}
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Net by App</span>
          </div>
          <table>
            <thead>
              <tr><th>App</th><th>Gross</th><th>Cuts</th><th>Net</th></tr>
            </thead>
            <tbody>
              {byApp.length === 0 && (
                <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--text-dim)", padding: 24 }}>No data yet</td></tr>
              )}
              {byApp.map(a => (
                <tr key={a.id}>
                  <td style={{ fontWeight: 500 }}>{a.name}</td>
                  <td style={{ color: "var(--text-muted)" }}>{fmt(a.gross)}</td>
                  <td style={{ color: "var(--gold)" }}>-{fmt(a.player_cuts)}</td>
                  <td style={{ color: a.net >= 0 ? "var(--green)" : "#f87171", fontWeight: 600 }}>{fmt(a.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* By Player */}
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Net by Player</span>
          </div>
          <table>
            <thead>
              <tr><th>Player</th><th>Gross</th><th>Their cut</th><th>My net</th></tr>
            </thead>
            <tbody>
              {byPlayer.length === 0 && (
                <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--text-dim)", padding: 24 }}>No data yet</td></tr>
              )}
              {byPlayer.map(p => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 500 }}>{p.name}</td>
                  <td style={{ color: "var(--text-muted)" }}>{fmt(p.gross)}</td>
                  <td style={{ color: "var(--gold)" }}>{fmt(p.player_cuts)}</td>
                  <td style={{ color: p.net >= 0 ? "var(--green)" : "#f87171", fontWeight: 600 }}>{fmt(p.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Wallet Tracker section */}
      <div style={{ marginTop: 40 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", display: "flex", alignItems: "center", gap: 8 }}>
            <Wallet size={14} /> TELE WT — Mon P&L Actions
          </div>
          <Link href="/wallets" style={{ fontSize: 12, color: "var(--green)", textDecoration: "none" }}>Voir tout →</Link>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 20 }}>
          <StatCard
            label="Total Retiré (joueurs)"
            value={walletKpis.total_withdrawn.toFixed(0) + " USDT"}
            sub="Encaissements tous joueurs"
            accent="gold"
            icon={<TrendingUp size={18} />}
          />
          <StatCard
            label="Net P&L joueurs"
            value={(walletKpis.total_net >= 0 ? "+" : "") + walletKpis.total_net.toFixed(0) + " USDT"}
            sub="Retraits − Dépôts"
            accent={walletKpis.total_net >= 0 ? "green" : "red"}
          />
          <StatCard
            label="Mon P&L (actions)"
            value={(walletKpis.my_total_pnl >= 0 ? "+" : "") + walletKpis.my_total_pnl.toFixed(0) + " USDT"}
            sub="Ta part % sur tous les joueurs"
            accent={walletKpis.my_total_pnl >= 0 ? "green" : "red"}
            icon={<Wallet size={18} />}
          />
        </div>

        {walletByPlayer.length > 0 && (
          <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
            <table>
              <thead>
                <tr>
                  <th>Joueur</th>
                  <th>Déposé</th>
                  <th>Retiré</th>
                  <th>Net joueur</th>
                  <th>Mon %</th>
                  <th>Mon P&L</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {walletByPlayer.map(p => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/players/${p.id}`} style={{ fontWeight: 600, color: "var(--text)", textDecoration: "none" }}>
                        {p.name}
                      </Link>
                    </td>
                    <td style={{ color: "var(--text-muted)" }}>{p.total_deposited.toFixed(0)} USDT</td>
                    <td style={{ color: "var(--text-muted)" }}>{p.total_withdrawn.toFixed(0)} USDT</td>
                    <td style={{ fontWeight: 600, color: p.net >= 0 ? "var(--green)" : "#f87171" }}>
                      {p.net >= 0 ? "+" : ""}{p.net.toFixed(0)} USDT
                    </td>
                    <td style={{ color: "var(--gold)" }}>{p.action_pct}%</td>
                    <td style={{ fontWeight: 700, color: p.my_pnl >= 0 ? "var(--green)" : "#f87171" }}>
                      {p.my_pnl >= 0 ? "+" : ""}{p.my_pnl.toFixed(0)} USDT
                    </td>
                    <td>
                      <Badge
                        label={p.net > 0 ? "Winning" : p.net < 0 ? "Losing" : "Flat"}
                        color={p.net > 0 ? "green" : p.net < 0 ? "red" : "gray"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
