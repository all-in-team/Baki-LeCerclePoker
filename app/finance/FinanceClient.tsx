"use client";

import React, { useState, useEffect, useCallback } from "react";
import { TrendingUp, Users, ArrowDownCircle, ArrowUpCircle, DollarSign, ChevronDown, ChevronRight } from "lucide-react";
import {
  ComposedChart, Bar, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine, Cell,
} from "recharts";

type KPI = { currency: string; agency_rb: number; player_rb: number; wl_agency: number; wl_player: number; player_count: number; report_count: number; };
type PlayerRow = { player_id: number; player_name: string; currency: string; agency_rb: number; player_rb: number; wl_agency: number; wl_player: number; report_count: number; };
type PeriodRow = { report_id: number; report_date: string | null; period_label: string; currency: string; agency_rb: number; player_rb: number; wl_agency: number; wl_player: number; player_count: number; };
type DayRow = { day: string; currency: string; agency_rb: number; player_rb: number; wl_agency: number; wl_player: number; player_count: number; report_count: number; };
type EntryRow = { report_id: number; date: string | null; period_label: string; club_name: string | null; currency: string; rake: number; insurance: number; winnings: number; player_rb: number; wl_player: number; };
type Data = { kpis: KPI[]; byPlayer: PlayerRow[]; byPeriod: PeriodRow[]; byDay: DayRow[]; };
type Range = "all" | "48h" | "week" | "month";

const FR_MONTHS = ["janv", "févr", "mars", "avr", "mai", "juin", "juil", "août", "sept", "oct", "nov", "déc"];
function fmtDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${parseInt(d)} ${FR_MONTHS[parseInt(m) - 1]} ${y}`;
}

function pos(v: number) {
  const abs = Math.abs(v);
  return (v >= 0 ? "+" : "-") + (abs >= 10000 ? (abs / 1000).toFixed(1) + "k" : abs.toFixed(2));
}

const thS: React.CSSProperties = { padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", textAlign: "left", whiteSpace: "nowrap", background: "var(--bg-surface)" };
const tdS: React.CSSProperties = { padding: "11px 14px", fontSize: 13, borderTop: "1px solid var(--border)" };
const rTd: React.CSSProperties = { ...tdS, textAlign: "right" };
const col = (v: number): React.CSSProperties => ({ color: v > 0.005 ? "var(--green)" : v < -0.005 ? "#f87171" : "var(--text-muted)", fontWeight: 600 });

const RANGES: { key: Range; label: string }[] = [
  { key: "all",   label: "Tout" },
  { key: "48h",   label: "48h" },
  { key: "week",  label: "7 jours" },
  { key: "month", label: "30 jours" },
];

export default function FinanceClient() {
  const [data, setData] = useState<Data | null>(null);
  const [range, setRange] = useState<Range>("all");
  const [histView, setHistView] = useState<"day" | "report">("day");
  const [expandedPlayer, setExpandedPlayer] = useState<number | null>(null);
  const [playerDetail, setPlayerDetail] = useState<Record<number, EntryRow[]>>({});
  const [loadingDetail, setLoadingDetail] = useState<number | null>(null);

  useEffect(() => {
    const url = range !== "all" ? `/api/finance?range=${range}` : "/api/finance";
    fetch(url, { cache: "no-store" }).then(r => r.json()).then(setData);
  }, [range]);

  useEffect(() => {
    setPlayerDetail({});
    setExpandedPlayer(null);
  }, [range]);

  const togglePlayer = useCallback(async (playerId: number) => {
    if (expandedPlayer === playerId) { setExpandedPlayer(null); return; }
    setExpandedPlayer(playerId);
    if (playerDetail[playerId]) return;
    setLoadingDetail(playerId);
    const url = `/api/finance/player?player_id=${playerId}${range !== "all" ? `&range=${range}` : ""}`;
    const entries: EntryRow[] = await fetch(url, { cache: "no-store" }).then(r => r.json());
    setPlayerDetail(prev => ({ ...prev, [playerId]: entries }));
    setLoadingDetail(null);
  }, [expandedPlayer, playerDetail, range]);

  if (!data) return <div style={{ padding: 48, color: "var(--text-muted)", textAlign: "center" }}>Chargement…</div>;

  const players = data.byPlayer.map(p => ({ ...p, pl_agency: (p.agency_rb - p.player_rb) + p.wl_agency, pl_player: p.player_rb + p.wl_player }));
  const payouts: Record<string, number> = {};
  for (const p of players) if (p.pl_player > 0.005) payouts[p.currency] = (payouts[p.currency] ?? 0) + p.pl_player;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--text)", margin: 0, letterSpacing: "-0.5px" }}>Finance & Règlements</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)" }}>P&amp;L agence · règlements joueurs · historique</p>
        </div>
        <div style={{ display: "flex", gap: 4, background: "var(--bg-surface)", borderRadius: 8, padding: 4, border: "1px solid var(--border)" }}>
          {RANGES.map(({ key, label }) => (
            <button key={key} onClick={() => setRange(key)} style={{
              padding: "6px 16px", borderRadius: 6, border: "none", cursor: "pointer",
              fontSize: 12, fontWeight: 700,
              background: range === key ? "var(--bg-elevated)" : "transparent",
              color: range === key ? "var(--text)" : "var(--text-muted)",
              transition: "all 0.15s",
            }}>{label}</button>
          ))}
        </div>
      </div>

      {/* KPI cards */}
      {data.kpis.length === 0 ? (
        <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
          Aucune donnée — importez des rapports d'abord
        </div>
      ) : data.kpis.map(kpi => {
        const agencyRbProfit = kpi.agency_rb - kpi.player_rb;
        const plAgency = agencyRbProfit + kpi.wl_agency;
        const totalPayout = players.filter(p => p.currency === kpi.currency && p.pl_player > 0.005).reduce((s, p) => s + p.pl_player, 0);
        const cards = [
          { label: "P/L Agence",     value: plAgency,         sub: `${kpi.report_count} rapport${kpi.report_count !== 1 ? "s" : ""}`, icon: <TrendingUp size={16} />,      hero: true, accent: plAgency >= 0 ? "#22c55e" : "#f87171" },
          { label: "Agency RB reçu", value: kpi.agency_rb,    sub: "Des clubs",              icon: <ArrowDownCircle size={16} />, accent: "#60a5fa" },
          { label: "Players RB dû",  value: -kpi.player_rb,   sub: "À verser aux joueurs",   icon: <ArrowUpCircle size={16} />,   accent: "#f97316" },
          { label: "W/L Agence",     value: kpi.wl_agency,    sub: `${kpi.player_count} joueur${kpi.player_count !== 1 ? "s" : ""}`, icon: <DollarSign size={16} />, accent: kpi.wl_agency >= 0 ? "#22c55e" : "#f87171" },
          { label: "À régler total", value: totalPayout,      sub: "Joueurs en positif",     icon: <Users size={16} />,           accent: "#c084fc" },
        ];
        return (
          <div key={kpi.currency} style={{ marginBottom: 28 }}>
            {data.kpis.length > 1 && (
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>{kpi.currency}</div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 14 }}>
              {cards.map(card => (
                <div key={card.label} style={{ background: card.hero ? `${card.accent}12` : "var(--bg-raised)", border: `1px solid ${card.hero ? card.accent + "40" : "var(--border)"}`, borderRadius: 10, padding: "16px 18px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                    <span style={{ color: card.accent, opacity: 0.8 }}>{card.icon}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{card.label}</span>
                  </div>
                  <div style={{ fontSize: card.hero ? 24 : 20, fontWeight: 800, color: card.accent, letterSpacing: "-0.5px" }}>{pos(card.value)}</div>
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
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{players.length} joueur{players.length !== 1 ? "s" : ""} · cliquer pour détail</span>
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
                  <th style={{ ...thS, width: 32 }}></th>
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
                  const isExpanded = expandedPlayer === p.player_id;
                  const detail = playerDetail[p.player_id];
                  const isLoadingThis = loadingDetail === p.player_id;
                  return (
                    <React.Fragment key={`${p.player_id}-${p.currency}`}>
                      <tr
                        style={{ background: i % 2 === 1 ? "rgba(255,255,255,0.015)" : "transparent", cursor: "pointer" }}
                        onClick={() => togglePlayer(p.player_id)}
                      >
                        <td style={{ ...tdS, textAlign: "center", width: 32, color: "var(--text-muted)", paddingRight: 0 }}>
                          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </td>
                        <td style={{ ...tdS, fontWeight: 600, color: "var(--text)" }}>{p.player_name}</td>
                        <td style={{ ...rTd, ...col(p.player_rb) }}>{pos(p.player_rb)}</td>
                        <td style={{ ...rTd, ...col(p.wl_player) }}>{pos(p.wl_player)}</td>
                        <td style={{ ...rTd, fontSize: 15, fontWeight: 800, color: owe ? "#f97316" : credit ? "#f87171" : "var(--text-muted)" }}>{pos(p.pl_player)}</td>
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
                      {isExpanded && (
                        <tr>
                          <td colSpan={8} style={{ padding: 0, background: "rgba(0,0,0,0.18)", borderTop: "none" }}>
                            {isLoadingThis ? (
                              <div style={{ padding: "12px 24px 12px 48px", color: "var(--text-muted)", fontSize: 12 }}>Chargement…</div>
                            ) : !detail || detail.length === 0 ? (
                              <div style={{ padding: "12px 24px 12px 48px", color: "var(--text-dim)", fontSize: 12 }}>Aucune session dans cette période</div>
                            ) : (
                              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                <thead>
                                  <tr>
                                    <th style={{ ...thS, background: "transparent", paddingLeft: 48, fontSize: 10 }}>Date</th>
                                    <th style={{ ...thS, background: "transparent", fontSize: 10 }}>Club</th>
                                    <th style={{ ...thS, background: "transparent", textAlign: "right", fontSize: 10 }}>Rake</th>
                                    <th style={{ ...thS, background: "transparent", textAlign: "right", fontSize: 10 }}>Insurance</th>
                                    <th style={{ ...thS, background: "transparent", textAlign: "right", fontSize: 10 }}>Winnings</th>
                                    <th style={{ ...thS, background: "transparent", textAlign: "right", fontSize: 10 }}>Player RB</th>
                                    <th style={{ ...thS, background: "transparent", textAlign: "right", fontSize: 10 }}>W/L</th>
                                    <th style={{ ...thS, background: "transparent", textAlign: "right", fontSize: 10 }}>P/L</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {detail.map(e => {
                                    const pl = e.player_rb + e.wl_player;
                                    return (
                                      <tr key={e.report_id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                                        <td style={{ ...tdS, paddingLeft: 48, fontSize: 12, color: "var(--text-muted)", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                                          {e.date ? fmtDate(e.date) : e.period_label}
                                        </td>
                                        <td style={{ ...tdS, fontSize: 12, borderTop: "1px solid rgba(255,255,255,0.04)" }}>{e.club_name ?? "—"}</td>
                                        <td style={{ ...rTd, fontSize: 12, borderTop: "1px solid rgba(255,255,255,0.04)" }}>{e.rake.toFixed(2)}</td>
                                        <td style={{ ...rTd, fontSize: 12, borderTop: "1px solid rgba(255,255,255,0.04)" }}>{e.insurance.toFixed(2)}</td>
                                        <td style={{ ...rTd, fontSize: 12, borderTop: "1px solid rgba(255,255,255,0.04)", ...col(e.winnings) }}>{pos(e.winnings)}</td>
                                        <td style={{ ...rTd, fontSize: 12, borderTop: "1px solid rgba(255,255,255,0.04)", color: "#60a5fa", fontWeight: 600 }}>{pos(e.player_rb)}</td>
                                        <td style={{ ...rTd, fontSize: 12, borderTop: "1px solid rgba(255,255,255,0.04)", ...col(e.wl_player) }}>{pos(e.wl_player)}</td>
                                        <td style={{ ...rTd, fontSize: 13, fontWeight: 800, borderTop: "1px solid rgba(255,255,255,0.04)", ...col(pl) }}>{pos(pl)}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* P/L chart */}
      {data.byDay.length > 0 && (() => {
        const cur = data.kpis[0]?.currency ?? "CNY";
        const days = data.byDay.filter(r => r.currency === cur).slice().reverse();
        let running = 0;
        const chartData = days.map(r => {
          const pl = (r.agency_rb - r.player_rb) + r.wl_agency;
          running += pl;
          return { label: fmtDate(r.day), daily: pl, cumul: running };
        });
        const bestDay = Math.max(...chartData.map(d => d.daily));
        const worstDay = Math.min(...chartData.map(d => d.daily));
        const avg = running / (chartData.length || 1);
        const fmtV = (v: number) => (Math.abs(v) >= 1000 ? (v < 0 ? "-" : "") + (Math.abs(v) / 1000).toFixed(1) + "k" : v.toFixed(0));
        const fmtFull = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2);

        const ChartTooltip = ({ active, payload, label }: any) => {
          if (!active || !payload?.length) return null;
          const daily = payload.find((p: any) => p.dataKey === "daily")?.value ?? 0;
          const cumul = payload.find((p: any) => p.dataKey === "cumul")?.value ?? 0;
          return (
            <div style={{
              background: "rgba(15,17,26,0.96)", border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 10, padding: "12px 16px", fontSize: 12,
              boxShadow: "0 12px 40px rgba(0,0,0,0.5)", backdropFilter: "blur(8px)",
            }}>
              <div style={{ fontWeight: 700, color: "rgba(255,255,255,0.9)", marginBottom: 10, fontSize: 13 }}>{label}</div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 28, marginBottom: 5 }}>
                <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 11 }}>Journée</span>
                <span style={{ fontWeight: 800, color: daily >= 0 ? "#22c55e" : "#f87171", fontSize: 13 }}>{fmtFull(daily)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 28 }}>
                <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 11 }}>Cumulé</span>
                <span style={{ fontWeight: 700, color: "#93c5fd", fontSize: 13 }}>{fmtFull(cumul)}</span>
              </div>
            </div>
          );
        };

        return (
          <div style={{
            background: "linear-gradient(160deg, rgba(24,27,42,0.9) 0%, rgba(14,16,28,0.98) 100%)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 14, padding: "22px 24px 16px", marginBottom: 24,
            boxShadow: "0 4px 24px rgba(0,0,0,0.3)",
          }}>
            {/* Header row */}
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>
                  Évolution du P/L · {cur}
                </div>
                <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 3, background: "#22c55e", opacity: 0.85 }} />
                    <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>Profit du jour</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 18, height: 2.5, background: "linear-gradient(90deg, #60a5fa, #93c5fd)", borderRadius: 2 }} />
                    <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>Cumulé</span>
                  </div>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{
                  fontSize: 28, fontWeight: 900, letterSpacing: "-1.5px", lineHeight: 1,
                  color: running >= 0 ? "#22c55e" : "#f87171",
                }}>
                  {running >= 0 ? "+" : ""}{Math.abs(running) >= 1000 ? (running / 1000).toFixed(2) + "k" : running.toFixed(2)}
                </div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.07em" }}>Total cumulé</div>
              </div>
            </div>

            {/* Stats pills */}
            <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
              {[
                { label: "Meilleur jour", value: fmtFull(bestDay), color: "#22c55e" },
                { label: "Pire jour",     value: fmtFull(worstDay), color: "#f87171" },
                { label: "Moyenne/jour",  value: fmtFull(avg), color: avg >= 0 ? "#22c55e" : "#f87171" },
                { label: "Jours actifs",  value: String(chartData.length), color: "rgba(255,255,255,0.6)" },
              ].map(s => (
                <div key={s.label} style={{
                  background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 8, padding: "6px 12px", display: "flex", gap: 8, alignItems: "center",
                }}>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{s.label}</span>
                  <span style={{ fontSize: 12, fontWeight: 800, color: s.color }}>{s.value}</span>
                </div>
              ))}
            </div>

            {/* Chart */}
            <ResponsiveContainer width="100%" height={230}>
              <ComposedChart data={chartData} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradCumul" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor="#60a5fa" stopOpacity={0.18} />
                    <stop offset="100%" stopColor="#60a5fa" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradGreen" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor="#22c55e" stopOpacity={0.9} />
                    <stop offset="100%" stopColor="#16a34a" stopOpacity={0.7} />
                  </linearGradient>
                  <linearGradient id="gradRed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor="#f87171" stopOpacity={0.9} />
                    <stop offset="100%" stopColor="#dc2626" stopOpacity={0.7} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="1 6" stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11, fontWeight: 500 }}
                  axisLine={false} tickLine={false} dy={8}
                />
                <YAxis
                  yAxisId="bar"
                  tick={{ fill: "rgba(255,255,255,0.2)", fontSize: 10 }}
                  axisLine={false} tickLine={false} width={38}
                  tickFormatter={fmtV}
                />
                <YAxis yAxisId="line" orientation="right" hide />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
                <ReferenceLine yAxisId="bar" y={0} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
                <Bar yAxisId="bar" dataKey="daily" radius={[5, 5, 1, 1]} maxBarSize={44} isAnimationActive>
                  {chartData.map((e, i) => (
                    <Cell key={i} fill={e.daily >= 0 ? "url(#gradGreen)" : "url(#gradRed)"} />
                  ))}
                </Bar>
                <Area
                  yAxisId="line" dataKey="cumul" type="monotone"
                  stroke="#60a5fa" strokeWidth={2.5}
                  fill="url(#gradCumul)"
                  dot={false}
                  activeDot={{ r: 5, fill: "#93c5fd", stroke: "rgba(96,165,250,0.25)", strokeWidth: 6 }}
                  isAnimationActive
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        );
      })()}

      {/* History — day view or per-report view */}
      {(data.byDay.length > 0 || data.byPeriod.length > 0) && (
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: "var(--text)" }}>Historique</span>
            <div style={{ display: "flex", gap: 2, background: "var(--bg-surface)", borderRadius: 6, padding: 3, border: "1px solid var(--border)" }}>
              {(["day", "report"] as const).map(v => (
                <button key={v} onClick={() => setHistView(v)} style={{
                  padding: "4px 12px", borderRadius: 4, border: "none", cursor: "pointer",
                  fontSize: 11, fontWeight: 700,
                  background: histView === v ? "var(--bg-elevated)" : "transparent",
                  color: histView === v ? "var(--text)" : "var(--text-muted)",
                }}>
                  {v === "day" ? "Par jour" : "Par rapport"}
                </button>
              ))}
            </div>
          </div>

          {histView === "day" ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thS}>Jour</th>
                    <th style={{ ...thS, textAlign: "right" }}>Rapports</th>
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
                  {data.byDay.map((row, i) => {
                    const plA = (row.agency_rb - row.player_rb) + row.wl_agency;
                    const plP = row.player_rb + row.wl_player;
                    return (
                      <tr key={`${row.day}-${row.currency}`} style={{ background: i % 2 === 1 ? "rgba(255,255,255,0.015)" : "transparent" }}>
                        <td style={{ ...tdS, fontWeight: 700, color: "var(--text)" }}>{fmtDate(row.day)}</td>
                        <td style={{ ...rTd, color: "var(--text-muted)", fontSize: 12 }}>{row.report_count}</td>
                        <td style={{ ...rTd, color: "#60a5fa" }}>{pos(row.agency_rb)}</td>
                        <td style={{ ...rTd, color: "#f97316" }}>-{Math.abs(row.player_rb).toFixed(2)}</td>
                        <td style={{ ...rTd, ...col(row.wl_agency) }}>{pos(row.wl_agency)}</td>
                        <td style={{ ...rTd, fontWeight: 800, fontSize: 15, ...col(plA) }}>{pos(plA)}</td>
                        <td style={{ ...rTd, ...col(plP) }}>{pos(plP)}</td>
                        <td style={{ ...tdS, fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>{row.currency}</td>
                        <td style={{ ...rTd, color: "var(--text-muted)" }}>{row.player_count}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thS}>Date</th>
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
                      <tr key={`${row.report_id}-${row.currency}`} style={{ background: i % 2 === 1 ? "rgba(255,255,255,0.015)" : "transparent" }}>
                        <td style={{ ...tdS, fontSize: 12, color: "var(--text-muted)" }}>{row.report_date ? fmtDate(row.report_date) : "—"}</td>
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
          )}
        </div>
      )}
    </div>
  );
}
