"use client";

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

interface TimePoint { date: string; akpoker_usdt: number; wepoker_usdt: number; total_usdt: number }
interface BreakdownData { akpoker_usdt: number; wepoker_usdt: number }

export function PnLAreaChart({ data }: { data: TimePoint[] }) {
  if (data.length === 0) return <div style={{ padding: 40, color: "var(--text-dim)", textAlign: "center" }}>Pas encore de données</div>;

  let cumulative = 0;
  const cumulativeData = data.map(d => {
    cumulative += d.total_usdt;
    return { date: d.date.slice(5), cumul: Math.round(cumulative) };
  });

  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={cumulativeData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
        <XAxis dataKey="date" tick={{ fill: "var(--text-dim)", fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: "var(--text-dim)", fontSize: 11 }} axisLine={false} tickLine={false} width={60}
          tickFormatter={(v: number) => `${v >= 0 ? "+" : ""}${(v / 1000).toFixed(0)}k`} />
        <Tooltip contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, fontSize: 12 }}
          formatter={(v: number) => [`${v >= 0 ? "+" : ""}${v.toLocaleString()} USDT`, "Agency P&L"]}
          labelFormatter={(l: string) => `${l}`} />
        <Area type="monotone" dataKey="cumul" stroke="#D4AF37" fill="rgba(212,175,55,0.1)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function AppBreakdownDonut({ data }: { data: BreakdownData }) {
  const entries = [
    { name: "AKPOKER", value: Math.abs(data.akpoker_usdt), color: "#D4AF37" },
    { name: "WEPOKER", value: Math.abs(data.wepoker_usdt), color: "#10B981" },
  ].filter(e => e.value > 0);

  if (entries.length === 0) return <div style={{ padding: 40, color: "var(--text-dim)", textAlign: "center" }}>Pas de données</div>;

  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie data={entries} dataKey="value" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={4}>
          {entries.map((e, i) => <Cell key={i} fill={e.color} />)}
        </Pie>
        <Tooltip contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, fontSize: 12 }}
          formatter={(v: number, name: string) => [`${v.toLocaleString()} USDT`, name]} />
      </PieChart>
    </ResponsiveContainer>
  );
}
