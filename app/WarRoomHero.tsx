import Odometer from "@/components/Odometer";
import Sparkline from "@/components/Sparkline";
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

  return (
    <div style={{
      background: "#1A1D23", border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: 16, padding: "28px 28px 22px", position: "relative", overflow: "hidden",
    }}>
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 1,
        background: "linear-gradient(90deg, transparent, rgba(245,197,24,0.35), transparent)",
      }} />

      <div className="flex flex-wrap items-start justify-between gap-6">
        {/* Left: the empire counter */}
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: "#8888A0",
            textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 14,
          }}>
            Net Worth — All Time
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <Odometer
              value={Math.round(totalUsdt)}
              signed
              durationMs={1500}
              style={{
                fontSize: "clamp(40px, 6vw, 62px)", fontWeight: 800,
                color: totalUsdt >= 0 ? "#F5C518" : "#EF4444",
                letterSpacing: "-0.02em",
              }}
            />
            <span style={{ fontSize: 20, fontWeight: 600, color: "#555568" }}>USDT</span>
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
        <div style={{ textAlign: "right", flexShrink: 0 }}>
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
