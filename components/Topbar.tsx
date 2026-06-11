"use client";

import { useEffect, useState } from "react";
import { Calendar } from "lucide-react";

// Ordered: longest prefixes first is handled by the matcher below.
const TITLES: [string, string][] = [
  ["/crm/affiliates", "Affiliates"],
  ["/crm/games", "Games & Deals"],
  ["/crm", "CRM Joueurs"],
  ["/players", "Joueurs"],
  ["/settings", "Settings"],
  ["/kkpoker/pnl", "KKPOKER — P&L"],
  ["/kkpoker/settlements", "KKPOKER — Settlements"],
  ["/a5poker/pnl", "A5POKER — P&L"],
  ["/a5poker/settlements", "A5POKER — Settlements"],
  ["/wepoker/pnl", "WEPOKER — P&L"],
  ["/wepoker/settlements", "WEPOKER — Settlements"],
  ["/akpoker/pnl", "AKPOKER — P&L"],
  ["/akpoker/settlements", "AKPOKER — Settlements"],
  ["/grindhouse/sessions", "Grindhouse — Sessions"],
  ["/grindhouse/expenses", "Grindhouse — Frais"],
  ["/grindhouse/settlements", "Grindhouse — Settlements"],
  ["/grindhouse/dashboard", "Grindhouse — Dashboard"],
  ["/grindhouse/weekly", "Grindhouse — Week results"],
];

function titleFor(path: string): string {
  if (path === "/") return "War Room";
  const hit = TITLES
    .filter(([p]) => path.startsWith(p))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? hit[1] : "Le Cercle";
}

export default function Topbar({ pathname }: { pathname: string }) {
  const [agents, setAgents] = useState<number | null>(null);
  useEffect(() => {
    fetch("/api/dashboard/ops-feed")
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.ok) setAgents(d.status.active_players); })
      .catch(() => {});
  }, []);

  const dateLabel = new Date().toLocaleDateString("fr-FR", {
    timeZone: "Europe/Paris", day: "numeric", month: "long", year: "numeric",
  });

  return (
    <div style={{
      height: 64, display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 12, marginBottom: 16,
    }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, color: "#E8E8EE", margin: 0, letterSpacing: "-0.01em" }}>
        {titleFor(pathname)}
      </h1>
      <div className="hidden md:flex" style={{ alignItems: "center", gap: 10 }}>
        <span className="topbar-pill" suppressHydrationWarning>
          <Calendar size={13} />
          {dateLabel}
        </span>
        <span className="topbar-pill">
          <span className="status-dot" style={{ color: "#10B981", fontSize: 9 }}>●</span>
          <span style={{ color: "#10B981", fontWeight: 600 }}>LIVE</span>
          {agents !== null && <span>— {agents} agents</span>}
        </span>
        <span style={{
          width: 34, height: 34, borderRadius: "50%",
          background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.25)",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          fontSize: 13, fontWeight: 700, color: "#10B981",
        }}>B</span>
      </div>
    </div>
  );
}
