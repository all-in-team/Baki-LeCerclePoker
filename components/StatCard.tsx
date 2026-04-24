import { ReactNode } from "react";

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  accent?: "green" | "gold" | "neutral" | "red";
  icon?: ReactNode;
}

export default function StatCard({ label, value, sub, accent = "neutral", icon }: StatCardProps) {
  const colors = {
    green: "var(--green)",
    gold: "var(--gold)",
    neutral: "var(--text)",
    red: "#f87171",
  };

  return (
    <div style={{
      background: "var(--bg-raised)",
      border: "1px solid var(--border)",
      borderRadius: 10,
      padding: "18px 20px",
      display: "flex",
      flexDirection: "column",
      gap: 6,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
        {icon && <span style={{ color: colors[accent], opacity: 0.7 }}>{icon}</span>}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: colors[accent], lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{sub}</div>}
    </div>
  );
}
