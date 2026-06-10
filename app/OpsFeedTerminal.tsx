"use client";

import { useEffect, useState } from "react";
import { Radio } from "lucide-react";
import type { OpsFeedEvent } from "@/lib/queries";

const TZ = "Europe/Paris";

const TYPE_LABEL: Record<OpsFeedEvent["type"], string> = {
  session: "SESSION",
  settlement: "SETTLEMENT",
  expense: "FRAIS",
  onboard: "ONBOARD",
};

const TYPE_COLOR: Record<OpsFeedEvent["type"], string> = {
  session: "#10B981",
  settlement: "#F5C518",
  expense: "#EF4444",
  onboard: "#3B82F6",
};

function fmtTs(ts: string, todayParis: string): { time: string; date: string | null } {
  const d = new Date(ts.replace(" ", "T") + (ts.endsWith("Z") ? "" : "Z"));
  if (isNaN(d.getTime())) return { time: ts.slice(11, 16) || "--:--", date: ts.slice(5, 10) || null };
  const day = d.toLocaleDateString("fr-FR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
  const time = d.toLocaleTimeString("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const dayIso = d.toLocaleDateString("sv-SE", { timeZone: TZ });
  return { time, date: dayIso === todayParis ? null : day };
}

function fmtAmount(n: number): string {
  return (n >= 0 ? "+" : "") + n.toLocaleString("fr-FR", { maximumFractionDigits: 0 });
}

export default function OpsFeedTerminal({ events }: { events: OpsFeedEvent[] }) {
  const todayParis = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const n = events.length;

  // Every 8-12s, one random line shimmers — suggests live activity
  const [shimmerIdx, setShimmerIdx] = useState(-1);
  useEffect(() => {
    if (n === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setShimmerIdx(Math.floor(Math.random() * n));
        schedule();
      }, 8000 + Math.random() * 4000);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [n]);

  return (
    <div className="glass-card" style={{
      display: "flex", flexDirection: "column",
      height: "100%", minHeight: 0, overflow: "hidden",
    }}>
      {/* Terminal header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 18px", borderBottom: "1px solid rgba(255,255,255,0.06)", flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Radio size={14} color="#10B981" />
          <span className="font-term" style={{
            fontSize: 11, fontWeight: 700, color: "#E8E8EE", letterSpacing: "0.12em",
          }}>OPS FEED</span>
        </div>
        <span className="font-term" style={{
          fontSize: 10, color: "#10B981", letterSpacing: "0.1em",
          display: "flex", alignItems: "center", gap: 5,
        }}>
          <span className="status-dot">●</span> LIVE
        </span>
      </div>

      {/* Lines — newest on top, cascade fills bottom-up like a terminal */}
      <div className="font-term warroom-feed-list" style={{
        flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 0",
      }}>
        {n === 0 && (
          <div style={{ padding: 24, fontSize: 11, color: "#555568", textAlign: "center", letterSpacing: "0.1em" }}>
            — AUCUNE ACTIVITÉ —
          </div>
        )}
        {events.map((e, i) => {
          const { time, date } = fmtTs(e.ts, todayParis);
          const delay = (n - 1 - i) * 50;
          const isNewest = i === 0;
          const amountColor = e.type === "settlement" ? "#F5C518"
            : e.amount !== null && e.amount < 0 ? "#EF4444"
            : "#10B981";
          return (
            <div
              key={`${e.ts}-${e.type}-${i}`}
              className={`${isNewest ? "feed-line-new" : "feed-line"}${i === shimmerIdx ? " feed-shimmer" : ""}`}
              style={{
                display: "flex", alignItems: "baseline", gap: 10,
                padding: "6px 18px", fontSize: 12, lineHeight: 1.5,
                animationDelay: isNewest ? `${delay}ms, ${delay + 700}ms` : `${delay}ms`,
              }}
            >
              <span style={{ color: "#555568", fontSize: 11, flexShrink: 0, whiteSpace: "nowrap" }}>
                {date ? `${date} ${time}` : time}
              </span>
              <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <span style={{ color: TYPE_COLOR[e.type], fontWeight: 600 }}>{TYPE_LABEL[e.type]}</span>
                <span style={{ color: "#8888A0" }}> — </span>
                <span style={{ color: "#E8E8EE" }}>{e.label}</span>
                {e.detail && <span style={{ color: "#555568" }}> · {e.detail}</span>}
              </span>
              <span className="tabular-nums" style={{
                flexShrink: 0, fontWeight: 600,
                color: e.amount === null ? "#3B82F6" : amountColor,
              }}>
                {e.amount === null ? "NEW" : fmtAmount(Math.round(e.amount))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
