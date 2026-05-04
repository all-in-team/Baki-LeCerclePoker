"use client";

import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell, ReferenceLine, Legend,
} from "recharts";

interface PlayerSummary {
  id: number; name: string; net: number; my_pnl: number;
  action_pct: number; total_deposited: number; total_withdrawn: number;
}

interface WalletTx {
  id: number; player_id: number; type: "deposit" | "withdrawal";
  amount: number; currency: string; tx_date: string; player_name: string;
}

const TOOLTIP = {
  contentStyle: { background: "#1a1a1f", border: "1px solid #2a2a35", borderRadius: 8, fontSize: 12, color: "#e8e8ee" },
  cursor: { fill: "rgba(255,255,255,0.04)" },
};
const GRID = { strokeDasharray: "3 3" as const, stroke: "#2a2a35", vertical: false };
const AXIS = { tick: { fill: "#8888a0", fontSize: 11 }, axisLine: false as const, tickLine: false as const };

function fmtAmt(v: number) {
  return (v >= 0 ? "+" : "") + v.toFixed(0) + " USDT";
}

function buildCumulative(txs: WalletTx[]) {
  const sorted = [...txs].sort((a, b) => a.tx_date.localeCompare(b.tx_date));
  let cumulative = 0;
  const points: { date: string; net: number; cumulative: number; myPnl: number }[] = [];
  const byDate: Record<string, number> = {};

  for (const tx of sorted) {
    const delta = tx.type === "withdrawal" ? tx.amount : -tx.amount;
    byDate[tx.tx_date] = (byDate[tx.tx_date] ?? 0) + delta;
  }

  for (const [date, net] of Object.entries(byDate).sort()) {
    cumulative += net;
    points.push({ date, net, cumulative, myPnl: cumulative * 0.4 });
  }
  return points;
}

function buildMonthly(txs: WalletTx[]) {
  const map: Record<string, { deposited: number; withdrawn: number }> = {};
  for (const tx of txs) {
    const month = tx.tx_date.slice(0, 7);
    if (!map[month]) map[month] = { deposited: 0, withdrawn: 0 };
    if (tx.type === "deposit") map[month].deposited += tx.amount;
    else map[month].withdrawn += tx.amount;
  }
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({
      month: new Date(month + "-01").toLocaleDateString("fr-FR", { month: "short", year: "2-digit" }),
      deposited: v.deposited,
      withdrawn: v.withdrawn,
      net: v.withdrawn - v.deposited,
    }));
}

function CustomCursorArea({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div style={{ background: "#1a1a1f", border: "1px solid #2a2a35", borderRadius: 8, padding: "10px 14px", fontSize: 12 }}>
      <div style={{ color: "#8888a0", marginBottom: 4 }}>{label}</div>
      <div style={{ color: d.cumulative >= 0 ? "#22c55e" : "#f87171", fontWeight: 700 }}>
        P&L joueur : {fmtAmt(d.cumulative)}
      </div>
      <div style={{ color: d.cumulative >= 0 ? "#d4af37" : "#f87171", marginTop: 2 }}>
        Mon 40% : {fmtAmt(d.cumulative * 0.4)}
      </div>
    </div>
  );
}

export default function WalletCharts({
  data, transactions,
}: {
  data: PlayerSummary[];
  transactions: WalletTx[];
}) {
  const cumData = buildCumulative(transactions);
  const monthlyData = buildMonthly(transactions);
  const perPlayer = data.map(d => ({ name: d.name, net: d.net, my_pnl: d.my_pnl }));

  const isEmpty = transactions.length === 0;

  if (isEmpty) {
    return (
      <div style={{
        gridColumn: "1/-1", textAlign: "center", color: "var(--text-dim)",
        padding: 48, fontSize: 13, background: "var(--bg-raised)",
        border: "1px solid var(--border)", borderRadius: 10,
      }}>
        Aucune transaction — clique sur <strong style={{ color: "var(--text-muted)" }}>Sync Wallets</strong> pour importer depuis la blockchain
      </div>
    );
  }

  const playerPnl = cumData[cumData.length - 1]?.cumulative ?? 0;
  // positive = more withdrawals than deposits = player profitable
  const areaColor = playerPnl >= 0 ? "#22c55e" : "#f87171";

  return (
    <>
      {/* Cumulative P&L line — full width */}
      <div style={{
        gridColumn: "1/-1",
        background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: 20,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Net P&L Cumulatif
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: areaColor, marginTop: 4 }}>
              {fmtAmt(playerPnl)}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Mon 40%</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: areaColor, marginTop: 2 }}>
              {fmtAmt(playerPnl * 0.4)}
            </div>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={cumData} margin={{ left: 8, right: 8, top: 4, bottom: 4 }}>
            <defs>
              <linearGradient id="gradNet" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={areaColor} stopOpacity={0.18} />
                <stop offset="95%" stopColor={areaColor} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="date" {...AXIS} tickFormatter={d => d.slice(5)} />
            <YAxis {...AXIS} tickFormatter={v => v.toFixed(0)} />
            <Tooltip content={<CustomCursorArea />} />
            <ReferenceLine y={0} stroke="#2a2a35" strokeWidth={1} />
            <Area
              type="monotone" dataKey="cumulative" stroke={areaColor}
              strokeWidth={2} fill="url(#gradNet)" dot={false} activeDot={{ r: 4, fill: areaColor }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Monthly breakdown */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>
          Activité Mensuelle
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={monthlyData} margin={{ left: 4, right: 4, top: 4, bottom: 4 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="month" {...AXIS} />
            <YAxis {...AXIS} tickFormatter={v => v.toFixed(0)} />
            <Tooltip
              {...TOOLTIP}
              formatter={(v: number, name: string) => [
                v.toFixed(2) + " USDT",
                name === "deposited" ? "Dépôts" : name === "withdrawn" ? "Retraits" : "Net"
              ]}
            />
            <Legend formatter={v => v === "deposited" ? "Dépôts" : v === "withdrawn" ? "Retraits" : "Net"} wrapperStyle={{ fontSize: 11, color: "#8888a0" }} />
            <Bar dataKey="withdrawn" fill="rgba(34,197,94,0.5)" radius={[3, 3, 0, 0]} />
            <Bar dataKey="deposited" fill="rgba(248,113,113,0.4)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Per-player net */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>
          Net P&L par Joueur
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={perPlayer} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
            <CartesianGrid {...GRID} horizontal={false} vertical />
            <XAxis type="number" {...AXIS} tickFormatter={v => v.toFixed(0)} />
            <YAxis type="category" dataKey="name" {...AXIS} width={90} />
            <Tooltip {...TOOLTIP} formatter={(v: number) => [fmtAmt(v), "Net P&L"]} />
            <ReferenceLine x={0} stroke="#2a2a35" strokeWidth={1} />
            <Bar dataKey="net" radius={[0, 3, 3, 0]}>
              {perPlayer.map((entry, i) => (
                <Cell key={i} fill={entry.net >= 0 ? "#22c55e" : "#f87171"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
