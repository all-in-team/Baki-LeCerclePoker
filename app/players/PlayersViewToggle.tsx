"use client";

import { useState, useEffect } from "react";
import { Plus, Search } from "lucide-react";
import PlayersTableView from "./PlayersTableView";
import PlayersKanbanView from "./PlayersKanbanView";
import PlayerEditModal from "./PlayerEditModal";
import AddPlayerModal from "./AddPlayerModal";
import { archivedCounts, isHiddenFromMain, sortArchivedView, type Player, type PlayersViewProps } from "./shared";

// Barre commune (toggle + recherche + Add Player) + modale d'édition unique, partagées
// par les deux vues. Avant la fusion : la recherche n'existait qu'en Kanban et le bouton
// "Add Player" n'existait que sur l'ancienne page /players.
export default function PlayersViewToggle(props: PlayersViewProps) {
  const { players, apps, dealsByPlayer, activeGames, affiliatedByPlayer, period } = props;
  const [view, setView] = useState<"kanban" | "table">("kanban");
  const [search, setSearch] = useState("");
  const [editPlayer, setEditPlayer] = useState<Player | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // main = vue principale (non archivé OU ouvert) ; archived = les archivés ; all = tout le monde.
  const [scope, setScope] = useState<"main" | "archived" | "all">("main");

  useEffect(() => {
    // Reprend la préférence de l'ancienne clé CRM pour ne pas repartir de zéro.
    const saved = localStorage.getItem("players_view") ?? localStorage.getItem("crm_view");
    if (saved === "table" || saved === "kanban") setView(saved);
  }, []);

  function toggle(v: "kanban" | "table") {
    setView(v);
    localStorage.setItem("players_view", v);
  }

  // Vue principale = actifs non archivés (règle Baki, seconde version). « Archivés » met en
  // tête ceux qui ont quelque chose à régler (badge « à régler » + motif) ; « Tout afficher »
  // montre tout le monde, inactifs non archivés compris.
  const hiddenCount = players.filter(isHiddenFromMain).length;
  const { total: archivedCount, toSettle } = archivedCounts(players);
  const visible = scope === "all" ? players
    : scope === "archived" ? sortArchivedView(players.filter(p => p.archived_at))
    : players.filter(p => !isHiddenFromMain(p));

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
          {hiddenCount > 0 && scope === "main" && (
            <button
              onClick={() => setScope("all")}
              title="Inactifs et archivés : hors de la vue principale, jamais supprimés"
              style={{ padding: "6px 12px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid var(--border)", background: "var(--bg-surface)", color: "var(--text-muted)" }}
            >
              {hiddenCount} masqué{hiddenCount > 1 ? "s" : ""} · Tout afficher
            </button>
          )}
          {(archivedCount > 0 || scope !== "main") && (
            <button
              onClick={() => setScope(s => s === "archived" ? "main" : "archived")}
              title="Joueurs archivés : consultables et désarchivables d'un clic"
              style={{
                padding: "6px 12px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
                border: scope === "archived" ? "1px solid rgba(240,185,11,0.4)" : "1px solid var(--border)",
                background: scope === "archived" ? "rgba(240,185,11,0.12)" : "var(--bg-surface)",
                color: scope === "archived" ? "#F0B90B" : "var(--text-muted)",
              }}
            >
              {scope === "archived" ? "← Retour à la liste" : `Archivés (${archivedCount} · ${toSettle} à régler)`}
            </button>
          )}
          {scope === "all" && (
            <button
              onClick={() => setScope("main")}
              style={{ padding: "6px 12px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid var(--green)", background: "rgba(34,197,94,0.12)", color: "var(--green)" }}
            >
              ← Vue principale
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

      {props.openError && (
        <div role="alert" style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, fontSize: 12, border: "1px solid rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.08)", color: "#EF4444" }}>
          L&apos;état « à régler » des joueurs n&apos;a pas pu être calculé : par sécurité, tous les archivés sont marqués « à régler ». ({props.openError})
        </div>
      )}

      {view === "table"
        ? <PlayersTableView
            players={filtered}
            gamesByPlayer={props.gamesByPlayer}
            dealsByPlayer={dealsByPlayer}
            agencyByPlayer={props.agencyByPlayer}
            period={period}
            onEdit={setEditPlayer}
            toSettleFirst={scope === "archived"}
          />
        : <PlayersKanbanView
            players={filtered}
            gamesByPlayer={props.gamesByPlayer}
            dealsByPlayer={dealsByPlayer}
            agencyByPlayer={props.agencyByPlayer}
            pnlByPlayerGame={props.pnlByPlayerGame}
            period={period}
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
