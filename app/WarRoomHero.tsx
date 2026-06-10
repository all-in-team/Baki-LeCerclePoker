"use client";

import { useState, useCallback } from "react";
import Odometer from "@/components/Odometer";
import Sparkline from "@/components/Sparkline";
import FocalSlot from "./FocalSlot";
import { TrendingUp, TrendingDown } from "lucide-react";

interface WarRoomHeroProps {
  totalUsdt: number;
  pnl30d: number;
  pnl30dPrev: number;
  spark30d: number[];      // cumulative total, last 30 days
  activeAgents: number;
  activePlatforms: number;
}

function fmtSigned(n: number): string {
  return (n >= 0 ? "+" : "") + n.toLocaleString("fr-FR", { maximumFractionDigits: 0 });
}

export default function WarRoomHero({ totalUsdt, pnl30d, pnl30dPrev, spark30d, activeAgents, activePlatforms }: WarRoomHeroProps) {
  const up30 = pnl30d >= 0;
  const deltaPct = pnl30dPrev !== 0
    ? Math.round(((pnl30d - pnl30dPrev) / Math.abs(pnl30dPrev)) * 100)
    : null;

  // Gold particle burst when the odometer settles
  const [burstKey, setBurstKey] = useState(0);
  const fireBurst = useCallback(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setBurstKey(k => k + 1);
  }, []);

  return (
    <div className="glass-card" style={{ padding: "24px 26px 20px", position: "relative", overflow: "hidden" }}>
      <div className="flex flex-col md:flex-row md:items-stretch gap-5">
        {/* Left: the obsidian plate carrying the counter */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="obsidian-plate"
            style={{
              borderRadius: 14, padding: "22px 26px 20px",
              border: "1px solid transparent",
              background:
                "linear-gradient(180deg, #0A0A11 0%, #07070B 100%) padding-box, " +
                "linear-gradient(180deg, rgba(245,197,24,0.15), rgba(245,197,24,0.02)) border-box",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04), 0 12px 32px -12px rgba(0,0,0,0.7)",
            }}
          >
            <div style={{
              fontSize: 11, fontWeight: 600, color: "#8888A0",
              textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 14,
            }}>
              Net Worth — All Time
            </div>
            <div style={{ position: "relative" }}>
              <div className="counter-glow" aria-hidden style={{ inset: "-50% -12%" }} />
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", position: "relative" }}>
                <Odometer
                  value={Math.round(totalUsdt)}
                  signed
                  durationMs={1500}
                  onComplete={fireBurst}
                  style={{
                    fontSize: "clamp(38px, 5.5vw, 58px)", fontWeight: 800,
                    color: totalUsdt >= 0 ? "#F5C518" : "#EF4444",
                    letterSpacing: "-0.02em",
                    textShadow: "0 0 40px rgba(245,197,24,0.25)",
                  }}
                />
                <span style={{ fontSize: 19, fontWeight: 600, color: "#555568" }}>USDT</span>
              </div>
              {burstKey > 0 && (
                <div key={burstKey} aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2 }}>
                  {Array.from({ length: 14 }, (_, i) => (
                    <span
                      key={i}
                      className="burst-dot"
                      style={{
                        left: `${(8 + Math.random() * 80).toFixed(0)}%`,
                        top: "45%",
                        animationDelay: `${(Math.random() * 0.18).toFixed(2)}s`,
                        "--bx": `${(Math.random() * 120 - 60).toFixed(0)}px`,
                        "--by": `${(-(45 + Math.random() * 70)).toFixed(0)}px`,
                      } as React.CSSProperties}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="font-term" style={{
            marginTop: 16, fontSize: 11, color: "#8888A0", letterSpacing: "0.04em",
            display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
          }}>
            <span className="status-dot" style={{ color: "#10B981", fontSize: 10 }}>●</span>
            <span style={{ color: "#10B981" }}>SYSTEMS OPERATIONAL</span>
            <span style={{ color: "#555568" }}>—</span>
            <span>{activeAgents} AGENTS</span>
            <span style={{ color: "#555568" }}>—</span>
            <span>{activePlatforms} PLATEFORMES</span>
          </div>

          {/* Compact 30d trend */}
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums",
              color: up30 ? "#10B981" : "#EF4444",
            }}>
              {up30 ? <TrendingUp size={15} /> : <TrendingDown size={15} />}
              {fmtSigned(Math.round(pnl30d))}
            </span>
            <span style={{ fontSize: 11, color: "#8888A0" }}>
              30j {deltaPct !== null ? (
                <span style={{ color: deltaPct >= 0 ? "#10B981" : "#EF4444", fontWeight: 600 }}>
                  {deltaPct >= 0 ? "▲" : "▼"} {Math.abs(deltaPct)}%
                </span>
              ) : (
                <span style={{ color: "rgba(255,255,255,0.15)", fontWeight: 600 }}>—</span>
              )} vs préc.
            </span>
            <Sparkline data={spark30d} width={96} height={24} color={up30 ? "#10B981" : "#EF4444"} variant={up30 ? "gradient" : "solid"} />
          </div>
        </div>

        {/* Right: reserved focal zone (3D object mounts here later) */}
        <div className="hidden md:block" style={{ width: "38%", flexShrink: 0 }}>
          <FocalSlot />
        </div>
      </div>
    </div>
  );
}
