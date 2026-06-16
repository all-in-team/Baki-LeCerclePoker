"use client";

import { useState } from "react";
import { ComposedChart, Area, Line, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

interface Point { day: string; cumulative_net: number; }
interface Props { series: Point[]; cardNet: number; currency?: string; rangeLabel?: string; }

const GREEN = "#22C55E", GREEN_PALE = "#5B8A6B", RED = "#EF4444", GREY = "#64748B";
const signed = (n: number, cur: string) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ${cur}`;
const compact = (v: number) => `${v < 0 ? "−" : ""}${Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) + "k" : Math.abs(v).toFixed(0)}`;

function weekStart(dStr: string) {
  const d = new Date(dStr + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export default function NetPnlChart({ series, cardNet, currency = "USDT", rangeLabel }: Props) {
  const [mode, setMode] = useState<"cumul" | "daily">("cumul");
  const wrap: React.CSSProperties = { background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px 10px", marginBottom: 28 };

  if (!series || series.length === 0) {
    return (
      <div style={{ ...wrap, padding: "22px 20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
        Évolution Players Net P&L — aucune transaction sur cette période.
      </div>
    );
  }

  const last = series[series.length - 1].cumulative_net;
  const first = series[0].cumulative_net;
  const color = last >= 0 ? GREEN : RED;
  const coherent = Math.abs(last - cardNet) < 0.01;
  const n = series.length;

  // Per-step daily net (derived from the cumulative → Σ steps == last == card)
  const steps = series.map((p, i) => i === 0 ? p.cumulative_net : p.cumulative_net - series[i - 1].cumulative_net);
  const avgAbs = steps.reduce((s, v) => s + Math.abs(v), 0) / Math.max(1, n);

  // Slope class per point → vivid green (strong up), pale (flat/stagnation), red (down)
  const slopeColor = (step: number) => step < -avgAbs * 0.1 ? RED : step > avgAbs ? GREEN : GREEN_PALE;

  // Cumulative data + linear average-rhythm line
  const cumulData = series.map((p, i) => ({
    day: p.day,
    cumulative_net: p.cumulative_net,
    net_day: steps[i],
    avg_line: n > 1 ? first + (last - first) * (i / (n - 1)) : p.cumulative_net,
  }));

  // Daily/weekly buckets for the bar view (weekly when the span is long)
  const spanDays = (new Date(series[n - 1].day).getTime() - new Date(series[0].day).getTime()) / 86400000;
  const weekly = spanDays > 60;
  const bucketMap = new Map<string, number>();
  series.forEach((p, i) => {
    const key = weekly ? weekStart(p.day) : p.day;
    bucketMap.set(key, (bucketMap.get(key) ?? 0) + steps[i]);
  });
  const barData = [...bucketMap.entries()].map(([label, value]) => ({ label, value }));
  const barsSum = barData.reduce((s, b) => s + b.value, 0); // == last == card

  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: "3px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
    background: active ? "rgba(255,255,255,0.07)" : "transparent",
    color: active ? "var(--text)" : "var(--text-dim)", border: "1px solid " + (active ? "var(--border)" : "transparent"),
  });

  return (
    <div style={wrap}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Évolution Players Net P&L</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", gap: 4, background: "var(--bg-surface)", borderRadius: 8, padding: 2 }}>
            <button onClick={() => setMode("cumul")} style={tabBtn(mode === "cumul")}>Cumulé</button>
            <button onClick={() => setMode("daily")} style={tabBtn(mode === "daily")}>Par {weekly ? "semaine" : "jour"}</button>
          </div>
          <span style={{ fontSize: 14, fontWeight: 700, color }}>{signed(last, currency)}</span>
        </div>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>{rangeLabel ?? "Cumul retraits − dépôts sur la période"}</div>
      {!coherent && (
        <div style={{ fontSize: 11, color: RED, fontWeight: 600, marginBottom: 6 }}>
          ⚠️ Écart courbe ({signed(last, currency)}) vs card Players Net P&L ({signed(cardNet, currency)})
        </div>
      )}

      <ResponsiveContainer width="100%" height={190}>
        {mode === "cumul" ? (
          <ComposedChart data={cumulData} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="npFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.20} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
              {/* slope-colored stroke: a stop per point coloured by local slope */}
              <linearGradient id="npSlope" x1="0" y1="0" x2="1" y2="0">
                {cumulData.map((d, i) => (
                  <stop key={i} offset={`${n > 1 ? (i / (n - 1)) * 100 : 0}%`} stopColor={slopeColor(d.net_day)} />
                ))}
              </linearGradient>
            </defs>
            <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 10, fill: "var(--text-dim)" }} axisLine={false} tickLine={false} minTickGap={30} />
            <YAxis tick={{ fontSize: 10, fill: "var(--text-dim)" }} axisLine={false} tickLine={false} width={46} tickFormatter={compact} />
            <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="4 4" />
            <Tooltip
              cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
              contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: "var(--text-dim)", fontSize: 11, marginBottom: 2 }}
              formatter={(v: any, name: any) => name === "cumulative_net" ? [signed(Number(v), currency), "Cumul"] : null as any}
              labelFormatter={(d: any) => String(d)}
            />
            <Area type="monotone" dataKey="cumulative_net" stroke="url(#npSlope)" strokeWidth={2.5} fill="url(#npFill)" dot={false} activeDot={{ r: 3, fill: color }} isAnimationActive={false} />
            <Line type="linear" dataKey="avg_line" stroke={GREY} strokeWidth={1} strokeDasharray="5 4" dot={false} activeDot={false} isAnimationActive={false} legendType="none" />
          </ComposedChart>
        ) : (
          <BarChart data={barData} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <XAxis dataKey="label" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 10, fill: "var(--text-dim)" }} axisLine={false} tickLine={false} minTickGap={20} />
            <YAxis tick={{ fontSize: 10, fill: "var(--text-dim)" }} axisLine={false} tickLine={false} width={46} tickFormatter={compact} />
            <ReferenceLine y={0} stroke="var(--border)" />
            <Tooltip
              cursor={{ fill: "rgba(255,255,255,0.03)" }}
              contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: "var(--text-dim)", fontSize: 11, marginBottom: 2 }}
              formatter={(v: any) => [signed(Number(v), currency), weekly ? "P&L semaine" : "P&L jour"]}
              labelFormatter={(d: any) => String(d)}
            />
            <Bar dataKey="value" radius={[2, 2, 0, 0]} isAnimationActive={false}>
              {barData.map((b, i) => <Cell key={i} fill={b.value >= 0 ? GREEN : RED} fillOpacity={0.85} />)}
            </Bar>
          </BarChart>
        )}
      </ResponsiveContainer>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
        <div style={{ display: "flex", gap: 12, fontSize: 10, color: "var(--text-dim)" }}>
          {mode === "cumul" ? (
            <>
              <span><span style={{ color: GREEN }}>▬</span> hausse</span>
              <span><span style={{ color: GREEN_PALE }}>▬</span> plat</span>
              <span><span style={{ color: RED }}>▬</span> baisse</span>
              <span><span style={{ color: GREY }}>┈</span> rythme moyen</span>
            </>
          ) : (
            <span>Vert = {weekly ? "semaine" : "jour"} positif · Rouge = négatif</span>
          )}
        </div>
        {mode === "daily" && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>Σ = {signed(barsSum, currency)}</span>}
      </div>
    </div>
  );
}
