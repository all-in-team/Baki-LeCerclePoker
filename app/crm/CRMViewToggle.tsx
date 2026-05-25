"use client";

import { useState, useEffect } from "react";
import CRMListClient from "./CRMListClient";
import CRMKanbanView from "./CRMKanbanView";

interface Player { id: number; name: string; telegram_handle: string | null; status: string; tier: string | null; last_note_at: string | null; }
interface Deal { deal_id: number; player_id: number; game_id: number; action_pct: number; rakeback_pct: number; start_date: string | null; }
interface Game { id: number; name: string; default_action_pct: number | null; }

interface Props {
  players: Player[];
  gamesByPlayer: Record<number, string[]>;
  dealsByPlayer: Record<number, Deal[]>;
  agencyByPlayer: Record<number, number>;
  activeGames: Game[];
}

export default function CRMViewToggle(props: Props) {
  const [view, setView] = useState<"kanban" | "table">("kanban");

  useEffect(() => {
    const saved = localStorage.getItem("crm_view");
    if (saved === "table" || saved === "kanban") setView(saved);
  }, []);

  function toggle(v: "kanban" | "table") {
    setView(v);
    localStorage.setItem("crm_view", v);
  }

  return (
    <>
      <div style={{ padding: "0 28px 16px", display: "flex", gap: 6 }}>
        {(["kanban", "table"] as const).map(v => (
          <button key={v} onClick={() => toggle(v)} style={{
            padding: "6px 16px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
            border: view === v ? "1px solid var(--green)" : "1px solid var(--border)",
            background: view === v ? "rgba(34,197,94,0.12)" : "var(--bg-surface)",
            color: view === v ? "var(--green)" : "var(--text-muted)",
          }}>
            {v === "kanban" ? "Kanban" : "Table"}
          </button>
        ))}
      </div>
      {view === "table"
        ? <CRMListClient {...props} />
        : <CRMKanbanView {...props} />
      }
    </>
  );
}
