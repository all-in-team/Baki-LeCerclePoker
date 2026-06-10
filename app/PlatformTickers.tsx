import Sparkline from "@/components/Sparkline";
import { Globe } from "lucide-react";

export interface PlatformTicker {
  name: string;
  color: string;
  pnl30d: number;
  pnl30dPrev: number;
  allTime: number;
  spark: number[];   // cumulative 30d
}

function fmtSigned(n: number): string {
  return (n >= 0 ? "+" : "") + n.toLocaleString("fr-FR", { maximumFractionDigits: 0 });
}

// Stock-ticker style tiles, one per platform
export default function PlatformTickers({ tickers }: { tickers: PlatformTicker[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {tickers.map(t => {
        const up = t.pnl30d >= 0;
        const deltaPct = t.pnl30dPrev !== 0
          ? Math.round(((t.pnl30d - t.pnl30dPrev) / Math.abs(t.pnl30dPrev)) * 100)
          : null;
        return (
          <div key={t.name} style={{
            background: "#1A1D23", border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 14, padding: "16px 18px",
            display: "flex", flexDirection: "column", gap: 10,
            position: "relative", overflow: "hidden",
          }}>
            <div style={{
              position: "absolute", top: 0, left: 0, right: 0, height: 1,
              background: `linear-gradient(90deg, transparent, ${t.color}50, transparent)`,
            }} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="font-term" style={{
                fontSize: 11, fontWeight: 700, color: t.color, letterSpacing: "0.1em",
              }}>{t.name}</span>
              <Globe size={13} color="#555568" />
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div className="tabular-nums" style={{
                  fontSize: 20, fontWeight: 700, lineHeight: 1.1,
                  color: up ? "#10B981" : "#EF4444",
                }}>
                  {fmtSigned(Math.round(t.pnl30d))}
                </div>
                <div style={{ fontSize: 10, color: "#8888A0", marginTop: 4 }}>
                  30j {deltaPct !== null && (
                    <span style={{ color: deltaPct >= 0 ? "#10B981" : "#EF4444", fontWeight: 600 }}>
                      {deltaPct >= 0 ? "▲" : "▼"} {Math.abs(deltaPct)}%
                    </span>
                  )}
                </div>
              </div>
              <Sparkline data={t.spark} width={84} height={30} color={up ? "#10B981" : "#EF4444"} />
            </div>
            <div className="tabular-nums" style={{
              fontSize: 11, color: "#555568",
              borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 8,
            }}>
              All-time <span style={{ color: "#8888A0", fontWeight: 600 }}>{fmtSigned(Math.round(t.allTime))} USDT</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
