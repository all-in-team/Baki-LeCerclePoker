"use client";

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

interface Point { day: string; cumulative_net: number; }
interface Props { series: Point[]; cardNet: number; currency?: string; rangeLabel?: string; }

const GREEN = "#22C55E", RED = "#EF4444";
const signed = (n: number, cur: string) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ${cur}`;
const compact = (v: number) => `${v < 0 ? "−" : ""}${Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) + "k" : Math.abs(v).toFixed(0)}`;

export default function NetPnlChart({ series, cardNet, currency = "USDT", rangeLabel }: Props) {
  const wrap: React.CSSProperties = { background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px 10px", marginBottom: 28 };

  if (!series || series.length === 0) {
    return (
      <div style={{ ...wrap, padding: "22px 20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
        Évolution Players Net P&L — aucune transaction sur cette période.
      </div>
    );
  }

  const last = series[series.length - 1].cumulative_net;
  const color = last >= 0 ? GREEN : RED;
  const coherent = Math.abs(last - cardNet) < 0.01;

  return (
    <div style={wrap}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Évolution Players Net P&L</span>
        <span style={{ fontSize: 14, fontWeight: 700, color }}>{signed(last, currency)}</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>{rangeLabel ?? "Cumul retraits − dépôts sur la période"}</div>
      {!coherent && (
        <div style={{ fontSize: 11, color: RED, fontWeight: 600, marginBottom: 6 }}>
          ⚠️ Écart courbe ({signed(last, currency)}) vs card Players Net P&L ({signed(cardNet, currency)})
        </div>
      )}
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={series} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="netPnlGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 10, fill: "var(--text-dim)" }} axisLine={false} tickLine={false} minTickGap={30} />
          <YAxis tick={{ fontSize: 10, fill: "var(--text-dim)" }} axisLine={false} tickLine={false} width={46} tickFormatter={compact} />
          <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="4 4" />
          <Tooltip
            cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
            contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "var(--text-dim)", fontSize: 11, marginBottom: 2 }}
            formatter={(v: any) => [signed(Number(v), currency), "Cumul"]}
            labelFormatter={(d: any) => String(d)}
          />
          <Area type="monotone" dataKey="cumulative_net" stroke={color} strokeWidth={2} fill="url(#netPnlGrad)" dot={false} activeDot={{ r: 3, fill: color }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
