"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import Odometer from "@/components/Odometer";
import Sparkline from "@/components/Sparkline";
import { TrendingUp, TrendingDown } from "lucide-react";

const CoreSphere = dynamic(() => import("./CoreSphere"), { ssr: false });

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

  // Mouse parallax — direct style writes via rAF lerp, zero re-renders
  const sphereLayer = useRef<HTMLDivElement>(null);
  const counterLayer = useRef<HTMLDivElement>(null);
  const rightLayer = useRef<HTMLDivElement>(null);
  const pos = useRef({ x: 0, y: 0 });
  const target = useRef({ x: 0, y: 0 });
  const raf = useRef(0);
  const looping = useRef(false);

  const step = useCallback(() => {
    const p = pos.current, t = target.current;
    p.x += (t.x - p.x) * 0.08;
    p.y += (t.y - p.y) * 0.08;
    if (sphereLayer.current) sphereLayer.current.style.transform = `translate3d(${(p.x * 15).toFixed(2)}px, ${(p.y * 15).toFixed(2)}px, 0)`;
    if (counterLayer.current) counterLayer.current.style.transform = `translate3d(${(-p.x * 6).toFixed(2)}px, ${(-p.y * 6).toFixed(2)}px, 0)`;
    if (rightLayer.current) rightLayer.current.style.transform = `translate3d(${(-p.x * 3).toFixed(2)}px, ${(-p.y * 3).toFixed(2)}px, 0)`;
    const settled = Math.abs(t.x - p.x) < 0.001 && Math.abs(t.y - p.y) < 0.001;
    if (settled && t.x === 0 && t.y === 0) { looping.current = false; return; }
    raf.current = requestAnimationFrame(step);
  }, []);

  const parallaxEnabled = () =>
    window.matchMedia("(hover: hover)").matches &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
    window.innerWidth >= 768;

  const onMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!parallaxEnabled()) return;
    const r = e.currentTarget.getBoundingClientRect();
    target.current.x = (e.clientX - r.left) / r.width - 0.5;
    target.current.y = (e.clientY - r.top) / r.height - 0.5;
    if (!looping.current) { looping.current = true; raf.current = requestAnimationFrame(step); }
  }, [step]);

  const onLeave = useCallback(() => {
    target.current.x = 0;
    target.current.y = 0;
    if (!looping.current && (pos.current.x !== 0 || pos.current.y !== 0)) {
      looping.current = true;
      raf.current = requestAnimationFrame(step);
    }
  }, [step]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // Gold particle burst when the odometer settles
  const [burstKey, setBurstKey] = useState(0);
  const fireBurst = useCallback(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setBurstKey(k => k + 1);
  }, []);

  return (
    <div
      className="glass-card"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={{ borderRadius: 16, padding: "28px 28px 22px", position: "relative", overflow: "hidden" }}
    >
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 1,
        background: "linear-gradient(90deg, transparent, rgba(245,197,24,0.35), transparent)",
        zIndex: 2,
      }} />

      {/* THE CORE — ambient background object in the empty band between the
          counter and the 30d column. Small, dim, radially masked: it touches
          neither the status line (below it) nor the sparkline (right of it). */}
      <div
        className="opacity-40 md:opacity-70"
        style={{
          position: "absolute", top: "42%", right: "26%",
          width: 140, height: 140, transform: "translateY(-50%)",
          pointerEvents: "none", zIndex: 0,
          WebkitMaskImage: "radial-gradient(circle at 50% 50%, black 40%, transparent 72%)",
          maskImage: "radial-gradient(circle at 50% 50%, black 40%, transparent 72%)",
        }}
      >
        <div ref={sphereLayer} style={{ width: "100%", height: "100%", willChange: "transform" }}>
          <CoreSphere />
        </div>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-6" style={{ position: "relative", zIndex: 1 }}>
        {/* Left: the empire counter */}
        <div ref={counterLayer} style={{ minWidth: 0, willChange: "transform" }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: "#8888A0",
            textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 14,
          }}>
            Net Worth — All Time
          </div>
          <div style={{ position: "relative" }}>
            <div className="counter-glow" aria-hidden style={{ inset: "-45% -15%" }} />
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", position: "relative" }}>
              <Odometer
                value={Math.round(totalUsdt)}
                signed
                durationMs={1500}
                onComplete={fireBurst}
                style={{
                  fontSize: "clamp(40px, 6vw, 62px)", fontWeight: 800,
                  color: totalUsdt >= 0 ? "#F5C518" : "#EF4444",
                  letterSpacing: "-0.02em",
                  textShadow: "0 0 40px rgba(245,197,24,0.25)",
                }}
              />
              <span style={{ fontSize: 20, fontWeight: 600, color: "#555568" }}>USDT</span>
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
          <div className="font-term" style={{
            marginTop: 18, fontSize: 11, color: "#8888A0", letterSpacing: "0.04em",
            display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
          }}>
            <span className="status-dot" style={{ color: "#10B981", fontSize: 10 }}>●</span>
            <span style={{ color: "#10B981" }}>SYSTEMS OPERATIONAL</span>
            <span style={{ color: "#555568" }}>—</span>
            <span>{activeAgents} AGENTS ACTIFS</span>
            <span style={{ color: "#555568" }}>—</span>
            <span>{activePlatforms} PLATEFORMES</span>
          </div>
        </div>

        {/* Right: 30d variation + sparkline */}
        <div ref={rightLayer} style={{ textAlign: "right", flexShrink: 0, willChange: "transform" }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: "#8888A0",
            textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8,
          }}>
            30 jours
          </div>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6,
            fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums",
            color: up30 ? "#10B981" : "#EF4444",
          }}>
            {up30 ? <TrendingUp size={18} /> : <TrendingDown size={18} />}
            {fmtSigned(Math.round(pnl30d))}
          </div>
          {deltaPct !== null && (
            <div style={{ fontSize: 11, color: deltaPct >= 0 ? "#10B981" : "#EF4444", marginTop: 2 }}>
              {deltaPct >= 0 ? "▲" : "▼"} {Math.abs(deltaPct)}% vs 30j préc.
            </div>
          )}
          <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
            <Sparkline data={spark30d} width={130} height={36} color={up30 ? "#10B981" : "#EF4444"} />
          </div>
        </div>
      </div>
    </div>
  );
}
