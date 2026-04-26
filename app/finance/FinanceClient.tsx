"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { TrendingUp, Users, ArrowDownCircle, ArrowUpCircle, DollarSign } from "lucide-react";

type KPI = {
  currency: string;
  agency_rb: number;
  player_rb: number;
  wl_agency: number;
  wl_player: number;
  player_count: number;
  report_count: number;
};

type PlayerRow = {
  player_id: number;
  player_name: string;
  currency: string;
  agency_rb: number;
  player_rb: number;
  wl_agency: number;
  wl_player: number;
  report_count: number;
};

type PeriodRow = {
  period_label: string;
  currency: string;
  latest_date: string;
  agency_rb: number;
  player_rb: number;
  wl_agency: number;
  wl_player: number;
  player_count: number;
};

type Data = {
  kpis: KPI[];
  byPlayer: PlayerRow[];
  byPeriod: PeriodRow[];
  periods: string[];
};

function n(v: number) {
  const abs = Math.abs(v);
  return (v < 0 ? "-" : "+") + (abs >= 10000 ? (abs / 1000).toFixed(1) + "k" : abs.toFixed(2));
}
function pos(v: number) { return (v >= 0 ? "+" : "") + (Math.abs(v) >= 10000 ? (v < 0 ? "-" : "") + (Math.abs(v) / 1000).toFixed(1) + "k" : v.toFixed(2)); }

const thS: React.CSSProperties = { padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", textAlign: "left", whiteSpace: "nowrap", background: "var(--bg-surface)" };
const tdS: React.CSSProperties = { padding: "11px 14px", fontSize: 13, borderTop: "1px solid var(--border)" };
const rTd: React.CSSProperties = { ...tdS, textAlign: "right" };
const col = (v: number): React.CSSProperties => ({ color: v > 0.005 ? "var(--green)" : v < -0.005 ? "#f87171" : "var(--text-muted)", fontWeight: 600 });

export default function FinanceClient() {
  const [data, setData] = useState<Data | null>(null);
  const [period, setPeriod] = useState("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const url = period !== "all" ? `/api/finance?period=${encodeURIComponent(period)}` : "/api/finance";
    fetch(url).then(r => r.json()).then(d => { setData(d); setLoading(false); });
  }, [period]);

  if (!data) return <div style={{ padding: 48, color: "var(--text-muted)", textAlign: "center" }}>Chargement…</div>;

  const players = data.byPlayer.map(p => ({
    ...p,
    pl_agency: (p.agency_rb - p.player_rb) + p.wl_agency,
    pl_player: p.player_rb + p.wl_player,
  }));

  // Total we need to pay out (positive pl_player only)
  const payouts: Record<string, number> = {};
  for (const p of players) if (p.pl_player > 0.005) payouts[p.currency] = (payouts[p.currency] ?? 0) + p.pl_player;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--text)", margin: 0, letterSpacing: "-0.5px" }}>Finance & Règlements</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
            P&amp;L agence · règlements joueurs · historique par période
          </p>
        </div>
        <select value={period} onChange={e => setPeriod(e.target.value)}
          style={{ padding: "8px 14px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--text)", fontSize: 13, cursor: "pointer" }}>
          <option value="all">Toutes les périodes</option>
          {data.periods.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {/* KPI cards — one block per currency */}
      {data.kpis.length === 0 ? (
        <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
          Aucune donnée — importez des rapports d'abord
        </div>
      ) : data.kpis.map(kpi => {
        const agencyRbProfit = kpi.agency_rb - kpi.player_rb;
        const plAgency = agencyRbProfit + kpi.wl_agency;
        const plPlayers = kpi.player_rb + kpi.wl_player;
        const totalPayout = players.filter(p => p.currency === kpi.currency && p.pl_player > 0.005).reduce((s, p) => s + p.pl_player, 0);
        const cards = [
          { label: "P/L Agence", value: plAgency, sub: `${kpi.report_count} rapport${kpi.report_count !== 1 ? "s" : ""}`, icon: <TrendingUp size={16} />, hero: true, accent: plAgency >= 0 ? "#22c55e" : "#f87171" },
          { label: "Agency RB reçu", value: kpi.agency_rb, sub: "Des clubs", icon: <ArrowDownCircle size={16} />, accent: "#60a5fa" },
          { label: "Players RB dû", value: -kpi.player_rb, sub: "À verser aux joueurs", icon: <ArrowUpCircle size={16} />, accent: "#f97316" },
          { label: "W/L Agence", value: kpi.wl_agency, sub: `${kpi.player_count} joueur${kpi.player_count !== 1 ? "s" : ""}`, icon: <DollarSign size={16} />, accent: kpi.wl_agency >= 0 ? "#22c55e" : "#f87171" },
          { label: "À régler total", value: totalPayout, sub: "Joueurs en positif", icon: <Users size={16} />, accent: "#c084fc" },
        ];
        return (
          <div key={kpi.currency} style={{ marginBottom: 28 }}>
            {data.kpis.length > 1 && (
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
                {kpi.currency}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 14 }}>
              {cards.map(card => (
                <div key={card.label} style={{
                  background: card.hero ? `${card.accent}12` : "var(--bg-raised)",
                  border: `1px solid ${card.hero ? card.accent + "40" : "var(--border)"}`,
                  borderRadius: 10, padding: "16px 18px",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                    <span style={{ color: card.accent, opacity: 0.8 }}>{card.icon}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{card.label}</span>
                  </div>
                  <div style={{ fontSize: card.hero ? 24 : 20, fontWeight: 800, color: card.accent, letterSpacing: "-0.5px" }}>
                    {pos(card.value)}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 5 }}>{kpi.currency} · {card.sub}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* Settlements table */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", marginBottom: 24 }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: "var(--text)" }}>Règlements joueurs</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{players.length} joueur{players.length !== 1 ? "s" : ""}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
            {Object.entries(payouts).map(([cur, amt]) => (
              <span key={cur} style={{ fontSize: 13, fontWeight: 800, padding: "4px 12px", borderRadius: 6, background: "rgba(249,115,22,0.12)", color: "#f97316", border: "1px solid rgba(249,115,22,0.25)" }}>
                À payer : {amt.toFixed(2)} {cur}
              </span>
            ))}
          </div>
        </div>
        {players.length === 0 ? (
          <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Aucun joueur identifié dans les rapports</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thS}>Joueur</th>
                  <th style={{ ...thS, textAlign: "right" }}>RB Joueur</th>
                  <th style={{ ...thS, textAlign: "right" }}>W/L Joueur</th>
                  <th style={{ ...thS, textAlign: "right" }}>P/L Joueur</th>
                  <th style={{ ...thS, textAlign: "right" }}>P/L Agence</th>
                  <th style={thS}>Devise</th>
                  <th style={thS}>Statut</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p, i) => {
                  const owe = p.pl_player > 0.005;
                  const credit = p.pl_player < -0.005;
                  return (
                    <tr key={`${p.player_id}-${p.currency}`} style={{ background: i % 2 === 1 ? "rgba(255,255,255,0.015)" : "transparent" }}>
                      <td style={{ ...tdS, fontWeight: 600 }}>
                        <Link href={`/players/${p.player_id}`} style={{ color: "var(--text)", textDecoration: "none" }}>
                          {p.player_name}
                        </Link>
                      </td>
                      <td style={{ ...rTd, ...col(p.player_rb) }}>{pos(p.player_rb)}</td>
                      <td style={{ ...rTd, ...col(p.wl_player) }}>{pos(p.wl_player)}</td>
                      <td style={{ ...rTd, fontSize: 15, fontWeight: 800, color: owe ? "#f97316" : credit ? "#f87171" : "var(--text-muted)" }}>
                        {pos(p.pl_player)}
                      </td>
                      <td style={{ ...rTd, ...col(p.pl_agency) }}>{pos(p.pl_agency)}</td>
                      <td style={{ ...tdS, fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>{p.currency}</td>
                      <td style={tdS}>
                        {owe
                          ? <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 5, background: "rgba(249,115,22,0.15)", color: "#f97316", border: "1px solid rgba(249,115,22,0.25)" }}>À payer</span>
                          : credit
                            ? <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 5, background: "rgba(248,113,113,0.12)", color: "#f87171", border: "1px solid rgba(248,113,113,0.25)" }}>Doit payer</span>
                            : <span style={{ fontSize: 11, color: "var(--text-dim)" }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Period history — only when viewing all periods */}
      {period === "all" && data.byPeriod.length > 0 && (
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: "var(--text)" }}>Historique par période</span>
            <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 10 }}>Cliquer sur une période pour filtrer ↑</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thS}>Période</th>
                  <th style={{ ...thS, textAlign: "right" }}>Agency RB</th>
                  <th style={{ ...thS, textAlign: "right" }}>Players RB</th>
                  <th style={{ ...thS, textAlign: "right" }}>W/L Agence</th>
                  <th style={{ ...thS, textAlign: "right" }}>P/L Agence</th>
                  <th style={{ ...thS, textAlign: "right" }}>P/L Joueurs</th>
                  <th style={thS}>Devise</th>
                  <th style={{ ...thS, textAlign: "right" }}>Joueurs</th>
                </tr>
              </thead>
              <tbody>
                {data.byPeriod.map((row, i) => {
                  const plA = (row.agency_rb - row.player_rb) + row.wl_agency;
                  const plP = row.player_rb + row.wl_player;
                  return (
                    <tr key={`${row.period_label}-${row.currency}`} style={{ background: i % 2 === 1 ? "rgba(255,255,255,0.015)" : "transparent", cursor: "pointer" }}
                      onClick={() => setPeriod(row.period_label)}>
                      <td style={{ ...tdS, fontWeight: 700, color: "var(--green)" }}>{row.period_label}</td>
                      <td style={{ ...rTd, color: "#60a5fa" }}>{pos(row.agency_rb)}</td>
                      <td style={{ ...rTd, color: "#f97316" }}>-{Math.abs(row.player_rb).toFixed(2)}</td>
                      <td style={{ ...rTd, ...col(row.wl_agency) }}>{pos(row.wl_agency)}</td>
                      <td style={{ ...rTd, fontWeight: 800, fontSize: 14, ...col(plA) }}>{pos(plA)}</td>
                      <td style={{ ...rTd, ...col(plP) }}>{pos(plP)}</td>
                      <td style={{ ...tdS, fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>{row.currency}</td>
                      <td style={{ ...rTd, color: "var(--text-muted)" }}>{row.player_count}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
