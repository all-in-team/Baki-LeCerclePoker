"use client";

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, LineChart, Line,
} from "recharts";

interface MonthRow { month: string; gross: number; player_cuts: number; net: number }
interface WeekRow { week: string; gross: number; player_cuts: number; net: number }
interface AppRow { name: string; net: number }
interface PlayerRow { name: string; net: number }

interface Props {
  byMonth: MonthRow[];
  byWeek: WeekRow[];
  byApp: AppRow[];
  byPlayer: PlayerRow[];
}

const TT_STYLE = {
  background: "#1a1a1f",
  border: "1px solid #2a2a35",
  borderRadius: 8,
  fontSize: 12,
  color: "#e8e8ee",
};

export default function AccountingCharts({ byMonth, byWeek }: Props) {
  const monthData = [...byMonth].reverse().slice(-12);
  const weekData = [...byWeek].reverse().slice(-12);

  if (monthData.length === 0 && weekData.length === 0) {
    return (
      <div style={{
        background: "var(--bg-raised)", border: "1px solid var(--border)",
        borderRadius: 10, padding: 48, textAlign: "center", color: "var(--text-dim)",
        fontSize: 13,
      }}>
        Import reports to see revenue charts
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
      {/* Monthly */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 16, color: "var(--text)" }}>Monthly Revenue</div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={monthData} barSize={18}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2a35" vertical={false} />
            <XAxis dataKey="month" tick={{ fill: "#8888a0", fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "#8888a0", fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={TT_STYLE} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
            <Legend wrapperStyle={{ fontSize: 11, color: "#8888a0" }} />
            <Bar dataKey="gross" name="Gross" fill="#374151" radius={[3, 3, 0, 0]} />
            <Bar dataKey="net" name="My Net" fill="#22c55e" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Weekly */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 16, color: "var(--text)" }}>Weekly Net (last 12w)</div>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={weekData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2a35" vertical={false} />
            <XAxis dataKey="week" tick={{ fill: "#8888a0", fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "#8888a0", fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={TT_STYLE} />
            <Line type="monotone" dataKey="net" name="My Net" stroke="#d4af37" strokeWidth={2} dot={{ fill: "#d4af37", r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
