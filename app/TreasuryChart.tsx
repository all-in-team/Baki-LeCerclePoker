"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

/**
 * Trésorerie · évolution — soldes quotidiens des wallets opérationnels depuis le
 * 10/01 (même départ que le Profit cumulé). Ligne épaisse = total, lignes fines =
 * par wallet. Données précalculées serveur (treasury_snapshots) — zéro math ici
 * au-delà du formatage.
 */

export interface TreasuryChartPoint {
  date: string;                    // YYYY-MM-DD
  total: number;
  byWallet: Record<string, number>;
}

const WALLET_COLORS: Record<string, string> = {
  "Hugo short": "#3B82F6",
  "Hugo short gasfee": "#14B8A6",
  "Général": "#10B981",
  "Général gas fee": "#EC4899",
  "Baki gas fee": "#A855F7",
};
const TOTAL_COLOR = "#F0B90B";

function fmtUsdt(n: number): string {
  return n.toLocaleString("fr-FR", { maximumFractionDigits: 0 });
}

function ObsidianTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  const rows = [...payload].sort((a, b) => (a.name === "Total" ? -1 : b.name === "Total" ? 1 : b.value - a.value));
  return (
    <div className="font-term" style={{
      borderRadius: 12, padding: "9px 13px",
      border: "1px solid transparent",
      background:
        "linear-gradient(180deg, #13141C, #0D0E14) padding-box, " +
        "linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.01)) border-box",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 2px 6px rgba(0,0,0,0.45), 0 16px 32px -8px rgba(0,0,0,0.6)",
    }}>
      <div style={{ fontSize: 10, color: "#555568", marginBottom: 4, letterSpacing: "0.08em" }}>{label}</div>
      {rows.map((r) => (
        <div key={r.name} className="tabular-nums" style={{ fontSize: r.name === "Total" ? 13 : 11, fontWeight: r.name === "Total" ? 700 : 500, color: r.color, display: "flex", justifyContent: "space-between", gap: 14 }}>
          <span>{r.name}</span>
          <span>{fmtUsdt(r.value)} USDT</span>
        </div>
      ))}
    </div>
  );
}

export default function TreasuryChart({ data }: { data: TreasuryChartPoint[] }) {
  if (data.length === 0) {
    return <div style={{ padding: 40, color: "#555568", textAlign: "center", fontSize: 13 }}>Pas encore de snapshots — lance le backfill trésorerie.</div>;
  }

  const labels = Object.keys(WALLET_COLORS);
  const chartData = data.map((p) => ({
    date: `${p.date.slice(8, 10)}/${p.date.slice(5, 7)}`,
    Total: Math.round(p.total),
    ...Object.fromEntries(labels.map((l) => [l, Math.round(p.byWallet[l] ?? 0)])),
  }));
  const tickInterval = Math.max(0, Math.ceil(chartData.length / 6) - 1);

  return (
    <div className="chart-reveal chart-glow">
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
          <XAxis dataKey="date" tick={{ fill: "#555568", fontSize: 11 }} axisLine={false} tickLine={false} interval={tickInterval} />
          <YAxis tick={{ fill: "#555568", fontSize: 11 }} axisLine={false} tickLine={false} width={60}
            tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`} />
          <Tooltip content={<ObsidianTooltip />} />
          {labels.map((l) => (
            <Line key={l} type="monotone" dataKey={l} stroke={WALLET_COLORS[l]} strokeWidth={1} dot={false} strokeOpacity={0.65} isAnimationActive={false} />
          ))}
          <Line type="monotone" dataKey="Total" stroke={TOTAL_COLOR} strokeWidth={2.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "6px 4px 0" }}>
        <LegendDot color={TOTAL_COLOR} label="Total" bold />
        {labels.map((l) => <LegendDot key={l} color={WALLET_COLORS[l]} label={l} />)}
      </div>
    </div>
  );
}

function LegendDot({ color, label, bold }: { color: string; label: string; bold?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: "#8888A0", fontWeight: bold ? 700 : 500 }}>
      <span style={{ width: 8, height: 3, borderRadius: 2, background: color, display: "inline-block" }} />
      {label}
    </span>
  );
}
