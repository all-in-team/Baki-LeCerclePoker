import { ReactNode } from "react";

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  accent?: "green" | "gold" | "neutral" | "red";
  icon?: ReactNode;
}

const ACCENT_COLORS: Record<string, string> = {
  green: "#10B981",
  gold: "#F5C518",
  neutral: "#E8E8EE",
  red: "#EF4444",
};

export default function StatCard({ label, value, sub, accent = "neutral", icon }: StatCardProps) {
  const accentColor = ACCENT_COLORS[accent];
  const subIsPositive = typeof sub === "string" && sub.startsWith("▲");
  const subIsNegative = typeof sub === "string" && sub.startsWith("▼");
  const subColor = subIsPositive ? "#10B981" : subIsNegative ? "#EF4444" : "#8888A0";

  return (
    <div style={{
      background: "#1A1D23",
      border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: 16,
      padding: "20px 24px",
      display: "flex",
      flexDirection: "column",
      gap: 8,
      position: "relative",
      overflow: "hidden",
    }}>
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 1,
        background: `linear-gradient(90deg, transparent, ${accentColor}40, transparent)`,
      }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span style={{
          fontSize: 11, fontWeight: 600, color: "#8888A0",
          textTransform: "uppercase", letterSpacing: "0.08em",
        }}>{label}</span>
        {icon && <span style={{ color: accentColor, opacity: 0.5 }}>{icon}</span>}
      </div>
      <div style={{
        fontSize: 28, fontWeight: 700, color: accentColor,
        lineHeight: 1, fontVariantNumeric: "tabular-nums",
      }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: subColor, fontWeight: 500 }}>{sub}</div>}
    </div>
  );
}
