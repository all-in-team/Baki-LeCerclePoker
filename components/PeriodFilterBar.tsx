"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Calendar, Clock, ChevronDown } from "lucide-react";

export interface WeekOpt { isoWeek: string; label: string }

/**
 * Shared period filter bar: Cette semaine / Semaine dernière / week-picker /
 * 30 jours / Lifetime / Custom (date+time range, Europe/Paris).
 *
 * URL contract (paired with `computePeriodFilter` in lib/period-filter.ts):
 *   - "current"        → basePath (no query)
 *   - "last" | "30d" | "lifetime" | ISO week (2026-W18) | "custom:<start>~<end>"
 *
 * Reused by every P&L page so the filters stay identical across games.
 */
export default function PeriodFilterBar({
  activeFilter, rangeLabel, weeks, basePath,
}: {
  activeFilter: string;
  rangeLabel: string;
  weeks: WeekOpt[];
  basePath: string;
}) {
  const router = useRouter();
  const [weekOpen, setWeekOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customStartTime, setCustomStartTime] = useState("00:00");
  const [customEnd, setCustomEnd] = useState("");
  const [customEndTime, setCustomEndTime] = useState("23:59");

  function navigate(filter: string) {
    setWeekOpen(false);
    router.push(filter === "current" ? basePath : `${basePath}?filter=${filter}`);
  }

  const isWeekPick = /^\d{4}-W\d{2}$/.test(activeFilter);
  const activeWeekLabel = isWeekPick ? weeks.find(w => w.isoWeek === activeFilter)?.label : null;
  const isCustom = activeFilter.startsWith("custom:");

  function applyCustomRange() {
    if (!customStart || !customEnd) return;
    navigate(`custom:${customStart}T${customStartTime}~${customEnd}T${customEndTime}`);
    setCustomOpen(false);
  }

  return (
    <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 20px", marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {([
          { key: "current", label: "Cette semaine" },
          { key: "last", label: "Semaine dernière" },
        ] as const).map(f => (
          <button key={f.key} onClick={() => navigate(f.key)} style={{
            padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
            border: activeFilter === f.key ? "1px solid var(--green)" : "1px solid var(--border)",
            background: activeFilter === f.key ? "rgba(34,197,94,0.12)" : "var(--bg-surface)",
            color: activeFilter === f.key ? "var(--green)" : "var(--text-muted)",
          }}>
            {f.label}
          </button>
        ))}
        <div style={{ position: "relative" }}>
          <button onClick={() => setWeekOpen(!weekOpen)} style={{
            padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
            border: isWeekPick ? "1px solid var(--green)" : "1px solid var(--border)",
            background: isWeekPick ? "rgba(34,197,94,0.12)" : "var(--bg-surface)",
            color: isWeekPick ? "var(--green)" : "var(--text-muted)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <Calendar size={12} />
            {isWeekPick ? `Sem. du ${activeWeekLabel}` : "Semaine…"}
            <ChevronDown size={12} />
          </button>
          {weekOpen && (
            <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 100, background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.25)", minWidth: 260, maxHeight: 320, overflowY: "auto" }}>
              {weeks.map(w => (
                <button key={w.isoWeek} onClick={() => navigate(w.isoWeek)} style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 14px", fontSize: 12, cursor: "pointer", border: "none", background: activeFilter === w.isoWeek ? "rgba(34,197,94,0.10)" : "transparent", color: activeFilter === w.isoWeek ? "var(--green)" : "var(--text-muted)", fontWeight: activeFilter === w.isoWeek ? 700 : 400, borderBottom: "1px solid var(--border)" }}>
                  Sem. du {w.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div style={{ width: 1, height: 20, background: "var(--border)", margin: "0 4px" }} />
        {([
          { key: "30d", label: "30 jours" },
          { key: "lifetime", label: "Lifetime" },
        ] as const).map(f => (
          <button key={f.key} onClick={() => navigate(f.key)} style={{
            padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
            border: activeFilter === f.key ? "1px solid var(--green)" : "1px solid var(--border)",
            background: activeFilter === f.key ? "rgba(34,197,94,0.12)" : "var(--bg-surface)",
            color: activeFilter === f.key ? "var(--green)" : "var(--text-muted)",
          }}>
            {f.label}
          </button>
        ))}
        <div style={{ width: 1, height: 20, background: "var(--border)", margin: "0 4px" }} />
        <button onClick={() => setCustomOpen(!customOpen)} style={{
          padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
          border: isCustom ? "1px solid var(--green)" : "1px solid var(--border)",
          background: isCustom ? "rgba(34,197,94,0.12)" : "var(--bg-surface)",
          color: isCustom ? "var(--green)" : "var(--text-muted)",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <Clock size={12} />
          {isCustom ? "Custom" : "Custom…"}
        </button>
      </div>
      {customOpen && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          <label style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>Du</label>
          <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none" }} />
          <input type="time" value={customStartTime} onChange={e => setCustomStartTime(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", width: 90 }} />
          <label style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>Au</label>
          <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none" }} />
          <input type="time" value={customEndTime} onChange={e => setCustomEndTime(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", width: 90 }} />
          <button onClick={applyCustomRange} disabled={!customStart || !customEnd} style={{ padding: "5px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: customStart && customEnd ? "pointer" : "not-allowed", border: "1px solid var(--green)", background: "rgba(34,197,94,0.12)", color: "var(--green)", opacity: customStart && customEnd ? 1 : 0.4 }}>
            Appliquer
          </button>
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>Heure France (Europe/Paris)</span>
        </div>
      )}
      <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 6 }}>
        <Calendar size={12} />
        {rangeLabel}
      </div>
    </div>
  );
}
