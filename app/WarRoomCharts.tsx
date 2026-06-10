"use client";

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

interface TimePoint { date: string; akpoker_usdt: number; kkpoker_usdt: number; a5poker_usdt: number; wepoker_usdt: number; total_usdt: number }

function ObsidianTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (!active || !payload?.length) return null;
  const v = payload[0].value;
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
      <circle className="chart-pulse" cx={cx} cy={cy} r={4} fill="#F0B90B" />
      <circle cx={cx} cy={cy} r={3.5} fill="#F0B90B" stroke="#07070B" strokeWidth={1.5} />
    </g>
  );
}

export function WarRoomPnLChart({ data }: { data: TimePoint[] }) {
  if (data.length === 0) return <div style={{ padding: 40, color: "#555568", textAlign: "center" }}>Pas encore de données</div>;

  let cumulative = 0;
  const cumulativeData = data.map(d => {
    cumulative += d.total_usdt;
    return { date: `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}`, cumul: Math.round(cumulative) };
  });
  // at most 6 evenly-spaced X labels
  const tickInterval = Math.max(0, Math.ceil(cumulativeData.length / 6) - 1);

  return (
    <div className="chart-reveal chart-glow">
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={cumulativeData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
        <defs>
          <linearGradient id="obsidianFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10B981" stopOpacity={0.20} />
            <stop offset="100%" stopColor="#F0B90B" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="obsidianStroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#10B981" />
            <stop offset="100%" stopColor="#F0B90B" />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="date"
          tick={{ fill: "#555568", fontSize: 11 }}
          axisLine={false} tickLine={false}
          interval={tickInterval}
        />
        <YAxis tick={{ fill: "#555568", fontSize: 11 }} axisLine={false} tickLine={false} width={60}
          tickFormatter={(v: number) => `${v >= 0 ? "+" : ""}${(v / 1000).toFixed(0)}k`} />
        <Tooltip content={<ObsidianTooltip />} />
        <Area
          type="monotone" dataKey="cumul" stroke="url(#obsidianStroke)" fill="url(#obsidianFill)" strokeWidth={2}
          dot={(props) => <LastPointDot {...props} dataLength={cumulativeData.length} />}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
    </div>
  );
}
