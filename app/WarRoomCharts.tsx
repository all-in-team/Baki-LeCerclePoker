"use client";

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

interface TimePoint { date: string; akpoker_usdt: number; kkpoker_usdt: number; a5poker_usdt: number; wepoker_usdt: number; total_usdt: number }

function TerminalTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (!active || !payload?.length) return null;
  const v = payload[0].value;
  return (
    <div className="font-term" style={{
      background: "#0A0B0E", border: "1px solid rgba(16,185,129,0.25)",
      borderRadius: 8, padding: "8px 12px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
    }}>
      <div style={{ fontSize: 10, color: "#555568", marginBottom: 4, letterSpacing: "0.08em" }}>{label}</div>
      <div className="tabular-nums" style={{ fontSize: 13, fontWeight: 700, color: v >= 0 ? "#10B981" : "#EF4444" }}>
        {v >= 0 ? "+" : ""}{v.toLocaleString("fr-FR")} USDT
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function LastPointDot(props: any) {
  const { cx, cy, index, dataLength } = props;
  if (index !== dataLength - 1 || cx == null || cy == null) return <g key={`d-${index}`} />;
  return (
    <g key={`d-${index}`}>
      <circle className="chart-pulse" cx={cx} cy={cy} r={4} fill="#10B981" />
      <circle cx={cx} cy={cy} r={3.5} fill="#10B981" stroke="#0A0B0E" strokeWidth={1.5} />
    </g>
  );
}

export function WarRoomPnLChart({ data }: { data: TimePoint[] }) {
  if (data.length === 0) return <div style={{ padding: 40, color: "#555568", textAlign: "center" }}>Pas encore de données</div>;

  let cumulative = 0;
  const cumulativeData = data.map(d => {
    cumulative += d.total_usdt;
    return { date: d.date.slice(5), cumul: Math.round(cumulative) };
  });

  return (
    <div className="chart-reveal">
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={cumulativeData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
        <defs>
          <linearGradient id="warroomEmerald" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10B981" stopOpacity={0.22} />
            <stop offset="100%" stopColor="#10B981" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="date" tick={{ fill: "#555568", fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: "#555568", fontSize: 11 }} axisLine={false} tickLine={false} width={60}
          tickFormatter={(v: number) => `${v >= 0 ? "+" : ""}${(v / 1000).toFixed(0)}k`} />
        <Tooltip content={<TerminalTooltip />} />
        <Area
          type="monotone" dataKey="cumul" stroke="#10B981" fill="url(#warroomEmerald)" strokeWidth={2}
          dot={(props) => <LastPointDot {...props} dataLength={cumulativeData.length} />}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
    </div>
  );
}
