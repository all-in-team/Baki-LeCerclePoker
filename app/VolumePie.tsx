"use client";

import { useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";

export interface VolumeSlice { name: string; color: string; value: number; missingRate: boolean }
interface PeriodVolume { slices: VolumeSlice[]; total: number }

function fmtUsdt(n: number): string {
  return Math.round(n).toLocaleString("fr-FR") + " USDT";
}

function pctEvolution(current: number, previous: number): { text: string; up: boolean | null } {
  if (previous === 0) {
    if (current === 0) return { text: "—", up: null };
    return { text: "nouveau", up: true };
  }
  const pct = (current - previous) / Math.abs(previous) * 100;
  const rounded = Math.round(pct);
  return { text: `${rounded >= 0 ? "+" : ""}${rounded}%`, up: rounded >= 0 };
}

function VolumeTooltip({ active, payload, total }: { active?: boolean; payload?: Array<{ payload: VolumeSlice }>; total: number }) {
  if (!active || !payload?.length) return null;
  const s = payload[0].payload;
  const share = total > 0 ? Math.round(s.value / total * 100) : 0;
  return (
    <div className="font-term" style={{
      borderRadius: 10, padding: "8px 12px", border: "1px solid transparent",
      background:
        "linear-gradient(180deg, #13141C, #0D0E14) padding-box, " +
        "linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.01)) border-box",
      boxShadow: "0 2px 6px rgba(0,0,0,0.45), 0 16px 32px -8px rgba(0,0,0,0.6)",
    }}>
      <div style={{ fontSize: 11, color: s.color, fontWeight: 700, marginBottom: 2 }}>{s.name}</div>
      <div className="tabular-nums" style={{ fontSize: 13, fontWeight: 700, color: "#E8E8EE" }}>
        {fmtUsdt(s.value)}
      </div>
      <div className="tabular-nums" style={{ fontSize: 11, color: "#8888A0" }}>{share}% du volume</div>
    </div>
  );
}

export default function VolumePie({
  d7, d7Prev, d30, d30Prev,
}: {
  d7: PeriodVolume; d7Prev: number;
  d30: PeriodVolume; d30Prev: number;
}) {
  const [period, setPeriod] = useState<"7" | "30">("7");
  const data = period === "7" ? d7 : d30;
  const prevTotal = period === "7" ? d7Prev : d30Prev;
  const evo = pctEvolution(data.total, prevTotal);
  const evoColor = evo.up === null ? "#8888A0" : evo.up ? "#10B981" : "#EF4444";
  const periodLabel = period === "7" ? "7j" : "30j";
  const isEmpty = data.slices.length === 0 || data.total === 0;
  const anyMissing = data.slices.some(s => s.missingRate);

  return (
    <div className="glass-card" style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: "#E8E8EE" }}>
          Volume par game
        </div>
        <div style={{ display: "flex", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, overflow: "hidden" }}>
          {(["7", "30"] as const).map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              style={{
                padding: "5px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: "none",
                background: period === p ? "rgba(16,185,129,0.14)" : "transparent",
                color: period === p ? "#10B981" : "#555568",
              }}
            >
              {p === "7" ? "7 jours" : "30 jours"}
            </button>
          ))}
        </div>
      </div>

      {isEmpty ? (
        <div style={{ padding: 40, color: "#555568", textAlign: "center", fontSize: 13 }}>
          Aucun volume sur les {periodLabel} derniers jours
        </div>
      ) : (
        <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
          {/* Donut + center total */}
          <div style={{ position: "relative", width: 220, height: 220, flexShrink: 0 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data.slices}
                  dataKey="value"
                  nameKey="name"
                  cx="50%" cy="50%"
                  innerRadius={66} outerRadius={96}
                  paddingAngle={2}
                  stroke="#07070B" strokeWidth={2}
                  isAnimationActive={false}
                >
                  {data.slices.map((s, i) => (
                    <Cell key={i} fill={s.color} />
                  ))}
                </Pie>
                <Tooltip content={<VolumeTooltip total={data.total} />} />
              </PieChart>
            </ResponsiveContainer>
            <div style={{
              position: "absolute", inset: 0, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", pointerEvents: "none",
            }}>
              <div style={{ fontSize: 10, color: "#555568", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                Volume {periodLabel}
              </div>
              <div className="tabular-nums" style={{ fontSize: 18, fontWeight: 700, color: "#E8E8EE", marginTop: 2 }}>
                {Math.round(data.total).toLocaleString("fr-FR")}
              </div>
              <div style={{ fontSize: 9, color: "#555568", marginTop: 1 }}>USDT</div>
              <div className="tabular-nums" style={{ fontSize: 13, fontWeight: 700, color: evoColor, marginTop: 6 }}>
                {evo.up === null ? "—" : `${evo.up ? "▲" : "▼"} ${evo.text}`}
              </div>
              <div style={{ fontSize: 9, color: "#555568" }}>vs {periodLabel} préc.</div>
            </div>
          </div>

          {/* Legend */}
          <div style={{ flex: 1, minWidth: 180, display: "flex", flexDirection: "column", gap: 8 }}>
            {data.slices.map((s, i) => {
              const share = data.total > 0 ? Math.round(s.value / data.total * 100) : 0;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 13, fontWeight: 500, color: "#E8E8EE", flex: 1 }}>
                    {s.name}{s.missingRate && <span style={{ color: "#F59E0B" }} title="Taux de change manquant"> ⚠</span>}
                  </span>
                  <span className="tabular-nums" style={{ fontSize: 13, fontWeight: 600, color: "#E8E8EE" }}>
                    {fmtUsdt(s.value)}
                  </span>
                  <span className="tabular-nums" style={{ fontSize: 12, color: "#8888A0", width: 38, textAlign: "right" }}>
                    {share}%
                  </span>
                </div>
              );
            })}
            {anyMissing && (
              <div style={{ fontSize: 10, color: "#F59E0B", marginTop: 4 }}>
                ⚠ Taux de change manquant — volume sous-estimé pour cette game.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
