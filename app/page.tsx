export const dynamic = "force-dynamic";
import { getWalletKPIs, getWalletSummaryByPlayer } from "@/lib/queries";
import { getDb } from "@/lib/db";
import PageHeader from "@/components/PageHeader";
import StatCard from "@/components/StatCard";
import Badge from "@/components/Badge";
import Link from "next/link";
import { TrendingUp, Users, Wallet, DollarSign } from "lucide-react";
import DashboardActions from "./DashboardActions";

function fmt(n: number) {
  const abs = Math.abs(n);
  const s = abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : abs.toFixed(0);
  return `${n < 0 ? "-" : "+"}${s} USDT`;
}

export default function DashboardPage() {
  const db = getDb();

  const walletKpis = getWalletKPIs() ?? { total_deposited: 0, total_withdrawn: 0, total_net: 0, my_total_pnl: 0 };
  const walletByPlayer = getWalletSummaryByPlayer() as any[];

  const activeCount = (db.prepare(`SELECT COUNT(*) AS n FROM players WHERE status = 'active'`).get() as { n: number }).n;
  const totalPlayers = (db.prepare(`SELECT COUNT(*) AS n FROM players`).get() as { n: number }).n;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Vue d'ensemble — tous jeux confondus"
      />

      {/* KPI Row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 32 }}>
        <StatCard label="Dépôts totaux" value={`${walletKpis.total_deposited.toFixed(0)} USDT`} sub="Tous joueurs, all-time" accent="neutral" icon={<DollarSign size={18} />} />
        <StatCard label="Retraits totaux" value={`${walletKpis.total_withdrawn.toFixed(0)} USDT`} sub="Cashouts all-time" accent="gold" icon={<TrendingUp size={18} />} />
        <StatCard label="Mon P&L" value={fmt(walletKpis.my_total_pnl)} sub="Ma part (action %)" accent={walletKpis.my_total_pnl >= 0 ? "green" : "red"} icon={<Wallet size={18} />} />
        <StatCard label="Joueurs actifs" value={`${activeCount} / ${totalPlayers}`} sub="Roster" accent="neutral" icon={<Users size={18} />} />
      </div>

      <DashboardActions />

      {/* Player P&L table */}
      {walletByPlayer.length > 0 && (
        <div style={{ marginTop: 24, background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>P&L par joueur (all-time)</span>
          </div>
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
              {walletByPlayer.map((p: any) => (
                <tr key={`${p.player_id}-${p.game_id}`}>
                  <td>
                    <Link href={`/players/${p.player_id}`} style={{ fontWeight: 600, color: "var(--text)", textDecoration: "none" }}>
                      {p.player_name}
                    </Link>
                  </td>
                  <td style={{ color: "var(--text-muted)" }}>{(p.total_deposited ?? 0).toFixed(0)} USDT</td>
                  <td style={{ color: "var(--text-muted)" }}>{(p.total_withdrawn ?? 0).toFixed(0)} USDT</td>
                  <td style={{ fontWeight: 600, color: (p.net ?? 0) >= 0 ? "var(--green)" : "#f87171" }}>
                    {(p.net ?? 0) >= 0 ? "+" : ""}{(p.net ?? 0).toFixed(0)} USDT
                  </td>
                  <td style={{ color: "var(--gold)" }}>{p.action_pct}%</td>
                  <td style={{ fontWeight: 700, color: (p.my_pnl ?? 0) >= 0 ? "var(--green)" : "#f87171" }}>
                    {(p.my_pnl ?? 0) >= 0 ? "+" : ""}{(p.my_pnl ?? 0).toFixed(0)} USDT
                  </td>
                  <td>
                    <Badge
                      label={(p.net ?? 0) > 0 ? "Winning" : (p.net ?? 0) < 0 ? "Losing" : "Flat"}
                      color={(p.net ?? 0) > 0 ? "green" : (p.net ?? 0) < 0 ? "red" : "gray"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
