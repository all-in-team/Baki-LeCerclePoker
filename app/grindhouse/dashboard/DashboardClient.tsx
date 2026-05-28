"use client";
import { useState } from "react";
import { TrendingUp, Clock, DollarSign } from "lucide-react";

const GAME_BADGES: Record<string, { short: string; bg: string; color: string }> = {
  TELE: { short: "AK", bg: "rgba(212,175,55,0.15)", color: "#D4AF37" },
  KKPOKER: { short: "KK", bg: "rgba(59,130,246,0.15)", color: "#3B82F6" },
  A5POKER: { short: "A5", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
  Wepoker: { short: "WE", bg: "rgba(139,92,246,0.15)", color: "#8B5CF6" },
  ClubGG: { short: "CG", bg: "rgba(234,179,8,0.15)", color: "#EAB308" },
};

interface ProfitData {
  total_sessions_pnl: number; total_grind_fees_attributed: number; total_pool_net: number;
  total_grinder_share: number; agency_brute: number; general_grind_fees: number;
  resto_fees: number; autre_fees: number; agency_net: number; total_hours: number;
  breakdown: { player_id: number; name: string; hours: number; sessions_pnl: number; grind_fees: number; pool_net: number; grinder_share: number; agency_share: number }[];
}

interface GameStats { game_id: number; game_name: string; hours: number; pnl: number }

function monday() { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
function sunday() { const d = new Date(monday() + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 6); return d.toISOString().slice(0, 10); }
function firstOfMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; }
const fmt = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pnlColor = (n: number) => n >= 0 ? "var(--green)" : "#f87171";
const pnlSign = (n: number) => (n >= 0 ? "+" : "") + fmt(n);
const hourlyRate = (pnl: number, hours: number) => hours > 0 ? pnlSign(pnl / hours) : "—";

export default function DashboardClient() {
  const [from, setFrom] = useState(monday());
  const [to, setTo] = useState(sunday());
  const [data, setData] = useState<ProfitData | null>(null);
  const [gameStats, setGameStats] = useState<GameStats[]>([]);
  const [loading, setLoading] = useState(false);

  async function compute() {
    setLoading(true);
    try {
      const [profRes, sessRes] = await Promise.all([
        fetch(`/api/grindhouse-profitability?from=${from}&to=${to}`),
        fetch(`/api/grindhouse-sessions?date=__range&from=${from}&to=${to}`),
      ]);
      if (profRes.ok) setData(await profRes.json());
      // Compute per-game stats from sessions endpoint doesn't support range — use profitability data instead
    } finally { setLoading(false); }
  }

  const inputStyle: React.CSSProperties = { padding: "7px 10px", borderRadius: 7, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" };

  return (
    <div style={{ padding: "0 28px" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inputStyle} />
        <span style={{ color: "var(--text-dim)" }}>→</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inputStyle} />
        <button onClick={() => { setFrom(monday()); setTo(sunday()); }} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Cette semaine</button>
        <button onClick={() => { setFrom(firstOfMonth()); setTo(new Date().toISOString().slice(0, 10)); }} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Ce mois</button>
        <button onClick={compute} style={{ padding: "7px 16px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}>Calculer</button>
      </div>

      {loading ? <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)" }}>Calcul...</div> : data && (<>
        {/* Hero stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
          <div style={{ padding: "16px 20px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 6 }}><Clock size={14} /> Total heures</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: "var(--text)" }}>{data.total_hours.toFixed(1)}h</div>
          </div>
          <div style={{ padding: "16px 20px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 6 }}><TrendingUp size={14} /> Total P&L</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: pnlColor(data.total_sessions_pnl) }}>{pnlSign(data.total_sessions_pnl)}</div>
          </div>
          <div style={{ padding: "16px 20px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 6 }}><DollarSign size={14} /> Avg $/h</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: data.total_hours > 0 ? pnlColor(data.total_sessions_pnl / data.total_hours) : "var(--text-dim)" }}>{hourlyRate(data.total_sessions_pnl, data.total_hours)}</div>
          </div>
        </div>

        {/* Per-grinder */}
        {data.breakdown.length > 0 && (
          <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 24 }}>
            <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>Par grinder</div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr style={{ borderBottom: "1px solid var(--border)" }}>{["Grinder", "Heures", "P&L", "$/h", "Part grinder", "Part agence"].map((h, i) => (<th key={i} style={{ padding: "8px 12px", textAlign: i >= 1 ? "right" : "left", fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" }}>{h}</th>))}</tr></thead>
            <tbody>{data.breakdown.map(b => (<tr key={b.player_id} style={{ borderBottom: "1px solid var(--border)" }}><td style={{ padding: "10px 12px", fontSize: 13, fontWeight: 600 }}>{b.name}</td><td style={{ padding: "10px 12px", textAlign: "right", fontSize: 12, color: "var(--text-muted)" }}>{b.hours.toFixed(1)}h</td><td style={{ padding: "10px 12px", textAlign: "right", fontSize: 12, fontWeight: 600, color: pnlColor(b.sessions_pnl) }}>{pnlSign(b.sessions_pnl)}</td><td style={{ padding: "10px 12px", textAlign: "right", fontSize: 12, fontWeight: 600, color: b.hours > 0 ? pnlColor(b.sessions_pnl / b.hours) : "var(--text-dim)" }}>{hourlyRate(b.sessions_pnl, b.hours)}</td><td style={{ padding: "10px 12px", textAlign: "right", fontSize: 12, fontWeight: 600, color: pnlColor(b.grinder_share) }}>{pnlSign(b.grinder_share)}</td><td style={{ padding: "10px 12px", textAlign: "right", fontSize: 12, fontWeight: 600, color: pnlColor(b.agency_share) }}>{pnlSign(b.agency_share)}</td></tr>))}</tbody></table>
          </div>
        )}

        {/* Profitability waterfall */}
        <div style={{ padding: "20px 24px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 12 }}>Rentabilité agence</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span>Production brute (sessions)</span><span style={{ fontWeight: 600, color: pnlColor(data.total_sessions_pnl) }}>{pnlSign(data.total_sessions_pnl)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--text-dim)" }}>- Frais grind attribués</span><span style={{ color: "#f87171" }}>-{fmt(data.total_grind_fees_attributed)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 8, fontWeight: 600 }}><span>= Pool net</span><span style={{ color: pnlColor(data.total_pool_net) }}>{pnlSign(data.total_pool_net)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--text-dim)" }}>- Part grinders (50%)</span><span style={{ color: "#f87171" }}>-{fmt(Math.abs(data.total_grinder_share))}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600 }}><span>= Part agence brute</span><span style={{ color: pnlColor(data.agency_brute) }}>{pnlSign(data.agency_brute)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--text-dim)" }}>- Frais grind généraux</span><span style={{ color: "#f87171" }}>-{fmt(data.general_grind_fees)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--text-dim)" }}>- Frais resto</span><span style={{ color: "#f87171" }}>-{fmt(data.resto_fees)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--text-dim)" }}>- Frais autres</span><span style={{ color: "#f87171" }}>-{fmt(data.autre_fees)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", borderTop: "2px solid var(--border)", paddingTop: 10, marginTop: 4 }}><span style={{ fontSize: 15, fontWeight: 700 }}>Rentabilité nette agence</span><span style={{ fontSize: 20, fontWeight: 700, color: pnlColor(data.agency_net) }}>{pnlSign(data.agency_net)} USDT</span></div>
          </div>
        </div>
      </>)}
    </div>
  );
}
