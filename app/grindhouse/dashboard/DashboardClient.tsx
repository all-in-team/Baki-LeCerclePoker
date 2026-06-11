"use client";
import { useState, useEffect, useCallback } from "react";
import { Clock, TrendingUp, Zap } from "lucide-react";

const GAME_BADGES: Record<string, { short: string; bg: string; color: string }> = {
  TELE: { short: "AK", bg: "rgba(212,175,55,0.15)", color: "#D4AF37" },
  KKPOKER: { short: "KK", bg: "rgba(59,130,246,0.15)", color: "#3B82F6" },
  A5POKER: { short: "A5", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
  Wepoker: { short: "WE", bg: "rgba(139,92,246,0.15)", color: "#8B5CF6" },
  ClubGG: { short: "CG", bg: "rgba(234,179,8,0.15)", color: "#EAB308" },
};

interface Unconverted { currency: string; sessions_pnl: number; hours: number }

interface ProfitData {
  total_sessions_pnl: number; total_grind_fees_attributed: number; total_pool_net: number;
  total_grinder_share: number; agency_brute: number; general_grind_fees: number;
  resto_fees: number; autre_fees: number; agency_net: number; total_hours: number;
  missing_rates?: string[];        // currencies with no configured rate — excluded from USDT figures
  unconverted?: Unconverted[];
  breakdown: { player_id: number; name: string; hours: number; sessions_pnl: number; grind_fees: number; pool_net: number; grinder_share: number; agency_share: number; unconverted?: { currency: string; pnl: number; hours: number }[] }[];
  per_game?: { game_id: number; game_name: string; currency?: string; hours: number; pnl: number; pnl_usdt?: number; rate_missing?: boolean }[];
}

type Preset = "today" | "7d" | "30d" | "custom";

function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
const today = () => new Date().toISOString().slice(0, 10);
const fmt = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtShort = (n: number) => Math.abs(n) >= 1000 ? (n / 1000).toFixed(1) + "k" : fmt(n);
const pnlColor = (n: number) => n > 0 ? "#22C55E" : n < 0 ? "#f87171" : "var(--text-dim)";
const pnlSign = (n: number) => (n >= 0 ? "+" : "") + fmt(n);
const hrRate = (pnl: number, h: number) => h > 0 ? `${pnl >= 0 ? "+" : ""}$${(pnl / h).toFixed(2)}/h` : "—";
const hrRateColor = (pnl: number, h: number) => h > 0 ? pnlColor(pnl / h) : "var(--text-dim)";

function formatRange(from: string, to: string) {
  const f = new Date(from + "T12:00:00Z");
  const t = new Date(to + "T12:00:00Z");
  const months = ["jan", "fév", "mar", "avr", "mai", "jun", "jul", "aoû", "sep", "oct", "nov", "déc"];
  if (f.getUTCMonth() === t.getUTCMonth()) return `${f.getUTCDate()} → ${t.getUTCDate()} ${months[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
  return `${f.getUTCDate()} ${months[f.getUTCMonth()]} → ${t.getUTCDate()} ${months[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

export default function DashboardClient() {
  const [preset, setPreset] = useState<Preset>("7d");
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(today());
  const [customOpen, setCustomOpen] = useState(false);
  const [data, setData] = useState<ProfitData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true);
    try { const r = await fetch(`/api/grindhouse-profitability?from=${f}&to=${t}`); if (r.ok) setData(await r.json()); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(from, to); }, [from, to, load]);

  function pick(p: Preset) {
    setPreset(p);
    setCustomOpen(false);
    if (p === "today") { setFrom(today()); setTo(today()); }
    else if (p === "7d") { setFrom(daysAgo(6)); setTo(today()); }
    else if (p === "30d") { setFrom(daysAgo(29)); setTo(today()); }
    else setCustomOpen(true);
  }

  const presetBtn = (p: Preset, label: string) => (
    <button onClick={() => pick(p)} style={{ padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", background: preset === p ? "rgba(34,197,94,0.15)" : "var(--bg-surface)", border: preset === p ? "1px solid rgba(34,197,94,0.3)" : "1px solid var(--border)", color: preset === p ? "#22C55E" : "var(--text-muted)" }}>{label}</button>
  );

  const inputStyle: React.CSSProperties = { padding: "6px 10px", borderRadius: 7, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" };

  const hasData = data && data.total_hours > 0;
  const missingRates = data?.missing_rates ?? [];

  return (
    <div style={{ padding: "8px 28px 0" }}>
      {/* Period picker */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
        {presetBtn("today", "Aujourd'hui")}
        {presetBtn("7d", "7 jours")}
        {presetBtn("30d", "30 jours")}
        {presetBtn("custom", "Custom 📅")}
        {customOpen && (<>
          <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPreset("custom"); }} style={inputStyle} />
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>→</span>
          <input type="date" value={to} onChange={e => { setTo(e.target.value); setPreset("custom"); }} style={inputStyle} />
        </>)}
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-dim)" }}>{formatRange(from, to)}</span>
      </div>

      {loading ? <div style={{ padding: 48, textAlign: "center", color: "var(--text-dim)" }}>Chargement...</div> : !hasData ? (
        <div style={{ padding: "48px 24px", textAlign: "center", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>Aucune session sur cette période</div>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Logge des sessions dans l'onglet Sessions.</div>
        </div>
      ) : (<>
        {missingRates.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", marginBottom: 16, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: 8, fontSize: 12, color: "#F59E0B" }}>
            ⚠ Taux de change manquant pour <b>{missingRates.join(", ")}</b> — ces montants sont exclus des chiffres USDT.{" "}
            <a href="/settings" style={{ color: "#F59E0B", fontWeight: 700, textDecoration: "underline" }}>Configurer dans Settings</a>
          </div>
        )}
        {/* Hero stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 28 }}>
          <div style={{ padding: "18px 20px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}><Clock size={13} /> Total heures</div>
            <div><span style={{ fontSize: 32, fontWeight: 600, color: "var(--text)" }}>{Math.round(data!.total_hours)}</span><span style={{ fontSize: 16, fontWeight: 400, color: "var(--text-dim)", marginLeft: 2 }}>h</span></div>
          </div>
          <div style={{ padding: "18px 20px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}><TrendingUp size={13} /> P&L net</div>
            <div style={{ fontSize: 32, fontWeight: 600, color: pnlColor(data!.total_sessions_pnl) }}>{pnlSign(data!.total_sessions_pnl)}<span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>USDT</span></div>
          </div>
          <div style={{ padding: "18px 20px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}><Zap size={13} /> Taux moyen</div>
            <div style={{ fontSize: 32, fontWeight: 600, color: hrRateColor(data!.total_sessions_pnl, data!.total_hours) }}>{hrRate(data!.total_sessions_pnl, data!.total_hours)}</div>
          </div>
        </div>

        {/* Per-grinder */}
        {data!.breakdown.length > 0 && (<>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Par grinder</div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(200px, 1fr))`, gap: 12, marginBottom: 28 }}>
            {data!.breakdown.map(b => {
              const hasHours = b.hours > 0;
              const avatarBg = !hasHours ? "rgba(156,163,175,0.2)" : b.sessions_pnl >= 0 ? "rgba(34,197,94,0.15)" : "rgba(248,113,113,0.15)";
              const avatarColor = !hasHours ? "#9CA3AF" : b.sessions_pnl >= 0 ? "#22C55E" : "#f87171";
              return (
                <div key={b.player_id} style={{ padding: "14px 16px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, opacity: hasHours ? 1 : 0.45 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <div style={{ width: 30, height: 30, borderRadius: "50%", background: avatarBg, color: avatarColor, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{b.name.slice(0, 2).toUpperCase()}</div>
                    <span style={{ fontWeight: 500, fontSize: 13, color: "var(--text)" }}>{b.name}</span>
                  </div>
                  {hasHours ? (
                    <>
                      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6 }}>
                        {b.hours.toFixed(1)}h · <span style={{ color: pnlColor(b.sessions_pnl), fontWeight: 500 }}>{pnlSign(b.sessions_pnl)} USDT</span>
                        {(b.unconverted ?? []).map(c => (
                          <span key={c.currency} style={{ color: "#F59E0B" }}> · ⚠ {pnlSign(c.pnl)} {c.currency}</span>
                        ))}
                      </div>
                      <div style={{ fontSize: 20, fontWeight: 500, color: hrRateColor(b.sessions_pnl, b.hours) }}>{hrRate(b.sessions_pnl, b.hours)}</div>
                    </>
                  ) : (
                    <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "8px 0 4px" }}>Aucune session</div>
                  )}
                </div>
              );
            })}
          </div>
        </>)}

        {/* Per-game table */}
        {data!.per_game && data!.per_game.length > 0 && (<>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Par game</div>
          <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 28 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}>{["Game", "Heures", "P&L", "$/h"].map((h, i) => (<th key={i} style={{ padding: "8px 14px", textAlign: i >= 1 ? "right" : "left", fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" }}>{h}</th>))}</tr></thead>
            <tbody>{data!.per_game.map(g => { const gb = GAME_BADGES[g.game_name] ?? { short: g.game_name.slice(0, 2), bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" }; return (
              <tr key={g.game_id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "10px 14px" }}><span style={{ background: gb.bg, color: gb.color, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{gb.short}</span><span style={{ marginLeft: 8, fontSize: 12, color: "var(--text)" }}>{g.game_name}</span></td>
                <td style={{ padding: "10px 14px", textAlign: "right", fontSize: 12, color: "var(--text-muted)" }}>{g.hours.toFixed(1)}h</td>
                <td style={{ padding: "10px 14px", textAlign: "right", fontSize: 12, fontWeight: 600, color: g.rate_missing ? "#F59E0B" : pnlColor(g.pnl_usdt ?? g.pnl) }}>
                  {g.rate_missing
                    ? <>⚠ {pnlSign(g.pnl)} <span style={{ fontWeight: 400 }}>{g.currency}</span></>
                    : <>{pnlSign(g.pnl_usdt ?? g.pnl)}{g.currency && g.currency !== "USDT" ? <span style={{ fontWeight: 400, color: "var(--text-dim)" }}> ({pnlSign(g.pnl)} {g.currency})</span> : null}</>}
                </td>
                <td style={{ padding: "10px 14px", textAlign: "right", fontSize: 12, fontWeight: 600, color: g.rate_missing ? "var(--text-dim)" : hrRateColor(g.pnl_usdt ?? g.pnl, g.hours) }}>{g.rate_missing ? "—" : hrRate(g.pnl_usdt ?? g.pnl, g.hours)}</td>
              </tr>
            ); })}</tbody></table>
          </div>
        </>)}

        {/* Profitability waterfall */}
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Rentabilité agence</div>
        <div style={{ padding: "20px 24px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 28 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span>Production brute</span><span style={{ fontWeight: 600, color: pnlColor(data!.total_sessions_pnl) }}>{pnlSign(data!.total_sessions_pnl)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--text-dim)" }}>− Frais grind attribués</span><span style={{ color: "#f87171" }}>−{fmt(data!.total_grind_fees_attributed)}</span></div>
            <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 500 }}><span>Pool net</span><span style={{ color: pnlColor(data!.total_pool_net) }}>{pnlSign(data!.total_pool_net)}</span></div>
            <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--text-dim)" }}>− Part grinders (50%)</span><span style={{ color: "#f87171" }}>−{fmt(Math.abs(data!.total_grinder_share))}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 500 }}><span>Part agence brute</span><span style={{ color: pnlColor(data!.agency_brute) }}>{pnlSign(data!.agency_brute)}</span></div>
            {data!.general_grind_fees > 0 && <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--text-dim)" }}>− Frais grind généraux</span><span style={{ color: "#f87171" }}>−{fmt(data!.general_grind_fees)}</span></div>}
            {data!.resto_fees > 0 && <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--text-dim)" }}>− Frais resto</span><span style={{ color: "#f87171" }}>−{fmt(data!.resto_fees)}</span></div>}
            {data!.autre_fees > 0 && <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--text-dim)" }}>− Frais autres</span><span style={{ color: "#f87171" }}>−{fmt(data!.autre_fees)}</span></div>}
            <div style={{ height: 2, background: "var(--border)", margin: "6px 0" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Rentabilité nette</span>
              <span style={{ fontSize: 20, fontWeight: 600, color: pnlColor(data!.agency_net) }}>{pnlSign(data!.agency_net)} USDT</span>
            </div>
          </div>
        </div>
      </>)}
    </div>
  );
}
