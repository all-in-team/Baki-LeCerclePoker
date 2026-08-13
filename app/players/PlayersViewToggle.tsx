"use client";

import { useState, useEffect } from "react";
import { Plus, Search } from "lucide-react";
import PlayersTableView from "./PlayersTableView";
import PlayersKanbanView from "./PlayersKanbanView";
import PlayerEditModal from "./PlayerEditModal";
import AddPlayerModal from "./AddPlayerModal";
import type { Player, PlayersViewProps } from "./shared";

// Barre commune (toggle + recherche + Add Player) + modale d'édition unique, partagées
// par les deux vues. Avant la fusion : la recherche n'existait qu'en Kanban et le bouton
// "Add Player" n'existait que sur l'ancienne page /players.
export default function PlayersViewToggle(props: PlayersViewProps) {
  const { players, apps, dealsByPlayer, activeGames, affiliatedByPlayer, periodKey } = props;
  const [view, setView] = useState<"kanban" | "table">("kanban");
  const [search, setSearch] = useState("");
  const [editPlayer, setEditPlayer] = useState<Player | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    // Reprend la préférence de l'ancienne clé CRM pour ne pas repartir de zéro.
    const saved = localStorage.getItem("players_view") ?? localStorage.getItem("crm_view");
    if (saved === "table" || saved === "kanban") setView(saved);
  }, []);

  function toggle(v: "kanban" | "table") {
    setView(v);
    localStorage.setItem("players_view", v);
  }

  // Archivés masqués par défaut (soft-delete) : le toggle « Archivés » les fait réapparaître
  // pour restauration. Aucune ligne n'est jamais supprimée.
  const archivedCount = players.filter(p => p.archived_at).length;
  const visible = showArchived ? players.filter(p => p.archived_at) : players.filter(p => !p.archived_at);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? visible.filter(p => p.name.toLowerCase().includes(q) || (p.telegram_handle ?? "").toLowerCase().includes(q) || (p.telegram_phone ?? "").toLowerCase().includes(q))
    : visible;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6 }}>
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

        <div style={{ position: "relative", flex: 1, maxWidth: 320, minWidth: 200 }}>
          <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)" }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Chercher joueur / @telegram…"
            style={{ width: "100%", padding: "8px 12px 8px 32px", borderRadius: 8, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" }}
          />
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          {(archivedCount > 0 || showArchived) && (
            <button
              onClick={() => setShowArchived(v => !v)}
              title="Lignes archivées : jamais supprimées, restaurables d'un clic"
              style={{
                padding: "6px 12px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
                border: showArchived ? "1px solid rgba(240,185,11,0.4)" : "1px solid var(--border)",
                background: showArchived ? "rgba(240,185,11,0.12)" : "var(--bg-surface)",
                color: showArchived ? "#F0B90B" : "var(--text-muted)",
              }}
            >
              {showArchived ? `← Retour à la liste` : `Archivés (${archivedCount})`}
            </button>
          )}
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {filtered.length} joueur{filtered.length > 1 ? "s" : ""}
          </span>
          <button onClick={() => setAddOpen(true)} style={{
            padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
            background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <Plus size={14} /> Add Player
          </button>
        </div>
      </div>

      {view === "table"
        ? <PlayersTableView
            players={filtered}
            gamesByPlayer={props.gamesByPlayer}
            dealsByPlayer={dealsByPlayer}
            agencyByPlayer={props.agencyByPlayer}
            periodKey={periodKey}
            onEdit={setEditPlayer}
          />
        : <PlayersKanbanView
            players={filtered}
            gamesByPlayer={props.gamesByPlayer}
            dealsByPlayer={dealsByPlayer}
            agencyByPlayer={props.agencyByPlayer}
            pnlByPlayerGame={props.pnlByPlayerGame}
            periodKey={periodKey}
            activeGames={activeGames}
            onEdit={setEditPlayer}
          />
      }

      {editPlayer && (
        <PlayerEditModal
          key={editPlayer.id}
          player={editPlayer}
          dealsByPlayer={dealsByPlayer}
          activeGames={activeGames}
          apps={apps}
          affiliatedByPlayer={affiliatedByPlayer}
          onClose={() => setEditPlayer(null)}
        />
      )}

      <AddPlayerModal open={addOpen} onClose={() => setAddOpen(false)} />
    </>
  );
}
