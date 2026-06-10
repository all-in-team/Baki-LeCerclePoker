"use client";

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

interface TimePoint { date: string; akpoker_usdt: number; kkpoker_usdt: number; a5poker_usdt: number; wepoker_usdt: number; total_usdt: number }
interface BreakdownData { akpoker_usdt: number; kkpoker_usdt: number; a5poker_usdt: number; wepoker_usdt: number }

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (!active || !payload?.length) return null;
  const v = payload[0].value;
  return (
    <div style={{
      background: "#22252B", border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 10, padding: "8px 12px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
    }}>
      <div style={{ fontSize: 11, color: "#8888A0", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums", color: v >= 0 ? "#F5C518" : "#EF4444" }}>
        {v >= 0 ? "+" : ""}{v.toLocaleString()} USDT
      </div>
    </div>
  );
}

export function PnLAreaChart({ data }: { data: TimePoint[] }) {
  if (data.length === 0) return <div style={{ padding: 40, color: "#555568", textAlign: "center" }}>Pas encore de données</div>;

  let cumulative = 0;
  const cumulativeData = data.map(d => {
    cumulative += d.total_usdt;
    return { date: d.date.slice(5), cumul: Math.round(cumulative) };
  });

  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={cumulativeData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
        <defs>
          <linearGradient id="emeraldGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10B981" stopOpacity={0.25} />
            <stop offset="100%" stopColor="#10B981" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="date" tick={{ fill: "#555568", fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: "#555568", fontSize: 11 }} axisLine={false} tickLine={false} width={60}
          tickFormatter={(v: number) => `${v >= 0 ? "+" : ""}${(v / 1000).toFixed(0)}k`} />
        <Tooltip content={<CustomTooltip />} />
        <Area type="monotone" dataKey="cumul" stroke="#10B981" fill="url(#emeraldGradient)" strokeWidth={2.5} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function AppBreakdownDonut({ data }: { data: BreakdownData }) {
  const entries = [
    { name: "AKPOKER", value: Math.abs(data.akpoker_usdt), color: "#F5C518" },
    { name: "KKPOKER", value: Math.abs(data.kkpoker_usdt), color: "#3B82F6" },
    { name: "A5POKER", value: Math.abs(data.a5poker_usdt), color: "#F59E0B" },
    { name: "WEPOKER", value: Math.abs(data.wepoker_usdt), color: "#10B981" },
  ].filter(e => e.value > 0);

  if (entries.length === 0) return <div style={{ padding: 40, color: "#555568", textAlign: "center" }}>Pas de données</div>;

  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie data={entries} dataKey="value" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={4} strokeWidth={0}>
          {entries.map((e, i) => <Cell key={i} fill={e.color} />)}
        </Pie>
        <Tooltip
          contentStyle={{
            background: "#22252B", border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 10, fontSize: 12,
          }}
          formatter={(v: number, name: string) => [`${v.toLocaleString()} USDT`, name]}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
