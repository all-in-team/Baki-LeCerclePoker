"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X, Plus, Archive, RotateCcw } from "lucide-react";
import Modal from "@/components/Modal";
import AddPlayerToGameModal from "./AddPlayerToGameModal";
import PlayerDetailDrawer from "./PlayerDetailDrawer";
import { badgeFor, fmtAmt, isActiveStatus, type Deal, type Game, type Player } from "./shared";

interface Props {
  players: Player[];
  gamesByPlayer: Record<number, string[]>;
  dealsByPlayer: Record<number, Deal[]>;
  agencyByPlayer: Record<number, number>;
  pnlByPlayerGame: Record<string, { player_net: number; agency_pnl: number }>;
  activeGames: Game[];
  onEdit: (p: Player) => void;
}

export default function PlayersKanbanView({ players, gamesByPlayer, dealsByPlayer, agencyByPlayer, pnlByPlayerGame, activeGames, onEdit }: Props) {
  const router = useRouter();
  const [showInactive, setShowInactive] = useState(false);
  const [addGameModal, setAddGameModal] = useState<Game | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [drawerPlayer, setDrawerPlayer] = useState<Player | null>(null);
  const [archiveGame, setArchiveGame] = useState<Game | null>(null);
  const [unarchiveGame, setUnarchiveGame] = useState<Game | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [showArchivedGames, setShowArchivedGames] = useState(false);

  const filtered = players.filter(p => showInactive || isActiveStatus(p.status));

  const playerMap = new Map(filtered.map(p => [p.id, p]));
  const playersWithActiveDeals = new Set(Object.keys(dealsByPlayer).map(Number).filter(id => (dealsByPlayer[id] ?? []).some(d => !d.end_date)));
  const poolPlayers = filtered.filter(p => !playersWithActiveDeals.has(p.id));

  async function removeDeal(dealId: number) {
    if (!confirm("Retirer ce joueur de cette game ?")) return;
    setRemoving(dealId);
    try {
      await fetch(`/api/games/deals/${dealId}`, { method: "DELETE" });
      router.refresh();
    } catch (e: any) {
      alert("Erreur: " + (e.message ?? e));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div>
      {/* Filtres propres à la Kanban (la recherche est au niveau page, partagée avec la vue Table) */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button onClick={() => setShowInactive(!showInactive)} style={{
          padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
          border: showInactive ? "1px solid var(--green)" : "1px solid var(--border)",
          background: showInactive ? "rgba(34,197,94,0.12)" : "var(--bg-surface)",
          color: showInactive ? "var(--green)" : "var(--text-muted)",
        }}>
          {showInactive ? "Inactifs visibles" : "Show inactive"}
        </button>
        <button onClick={() => setShowArchivedGames(!showArchivedGames)} style={{
          padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
          border: showArchivedGames ? "1px solid var(--green)" : "1px solid var(--border)",
          background: showArchivedGames ? "rgba(34,197,94,0.12)" : "var(--bg-surface)",
          color: showArchivedGames ? "var(--green)" : "var(--text-muted)",
        }}>
          {showArchivedGames ? "Archived visibles" : "Show archived games"}
        </button>
      </div>

      {/* Kanban columns */}
      <div style={{ display: "flex", gap: 16, overflowX: "auto", paddingBottom: 20, minHeight: 300 }}>
        {activeGames.filter(g => g.status === "active" || showArchivedGames).map(game => {
          const badge = badgeFor(game.name);
          const isArchivedGame = game.status === "archived";
          const gameDeals = Object.values(dealsByPlayer).flat().filter(d => d.game_id === game.id && !d.end_date);
          const gamePlayers = gameDeals
            .map(d => ({ player: playerMap.get(d.player_id), deal: d }))
            .filter((x): x is { player: Player; deal: Deal } => !!x.player)
            .sort((a, b) => (agencyByPlayer[b.player.id] ?? 0) - (agencyByPlayer[a.player.id] ?? 0));

          const totalCut = gamePlayers.reduce((s, { player }) => s + (pnlByPlayerGame[`${player.id}_${game.id}`]?.agency_pnl ?? 0), 0);

          return (
            <div key={game.id} style={{ minWidth: 260, maxWidth: 300, flex: "0 0 280px", background: "var(--bg-surface)", borderRadius: 12, border: "1px solid var(--border)", display: "flex", flexDirection: "column", opacity: isArchivedGame ? 0.5 : 1 }}>
              {/* Column header */}
              <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ background: badge.bg, color: badge.color, padding: "3px 10px", borderRadius: 5, fontSize: 12, fontWeight: 700 }}>{badge.short}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{game.name}</span>
                  {isArchivedGame && <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "rgba(255,255,255,0.08)", color: "var(--text-dim)", fontWeight: 600 }}>ARCHIVED</span>}
                  <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: "auto" }}>{gamePlayers.length}</span>
                  {isArchivedGame ? (
                    <button onClick={() => setUnarchiveGame(game)} title="Réactiver ce game" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 2, opacity: 0.7 }}>
                      <RotateCcw size={13} />
                    </button>
                  ) : (
                    <button onClick={() => setArchiveGame(game)} title="Archiver ce game" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 2, opacity: 0.5 }}>
                      <Archive size={13} />
                    </button>
                  )}
                </div>
                {totalCut !== 0 && (
                  <div style={{ fontSize: 11, color: totalCut > 0 ? "#D4AF37" : "#EF4444", fontWeight: 600 }}>
                    {fmtAmt(totalCut)} USDT (30j)
                  </div>
                )}
              </div>

              {/* Cards */}
              <div style={{ flex: 1, padding: 8, display: "flex", flexDirection: "column", gap: 6, overflowY: "auto", maxHeight: 500 }}>
                {gamePlayers.map(({ player, deal }) => {
                  const pnl = pnlByPlayerGame[`${player.id}_${game.id}`];
                  const playerNet = pnl?.player_net ?? 0;
                  const agencyPnl = pnl?.agency_pnl ?? 0;
                  const otherGames = (gamesByPlayer[player.id] ?? []).filter(gn => gn !== game.name);
                  const isInactive = !isActiveStatus(player.status);
                  return (
                    <div key={player.id} onClick={() => setDrawerPlayer(player)} style={{
                      padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-raised)",
                      cursor: "pointer", position: "relative", opacity: isInactive ? 0.5 : 1,
                      transition: "border-color 0.15s",
                    }}>
                      <button onClick={e => { e.stopPropagation(); removeDeal(deal.deal_id); }} disabled={removing === deal.deal_id}
                        style={{ position: "absolute", top: 6, right: 6, background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 2, opacity: removing === deal.deal_id ? 0.3 : 0.6 }}
                        title="Retirer de cette game">
                        <X size={12} />
                      </button>
                      <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text)", marginBottom: 2, paddingRight: 20 }}>{player.name}</div>
                      <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
                        {player.telegram_handle && <span>@{player.telegram_handle}</span>}
                        {!!player.is_affiliate && <span style={{ padding: "0px 4px", borderRadius: 3, background: "rgba(139,92,246,0.15)", color: "#A78BFA" }}>Aff</span>}
                        {!!player.is_referred && <span style={{ padding: "0px 4px", borderRadius: 3, background: "rgba(236,72,153,0.15)", color: "#F472B6" }}>Ref</span>}
                      </div>
                      <div style={{ fontSize: 11, color: playerNet > 0 ? "#22C55E" : playerNet < 0 ? "#EF4444" : "var(--text-dim)", marginBottom: 2 }}>
                        Player: {playerNet !== 0 ? `${fmtAmt(playerNet)} USDT` : "—"}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: agencyPnl > 0 ? "#D4AF37" : agencyPnl < 0 ? "#EF4444" : "var(--text-dim)" }}>
                          Agency: {agencyPnl !== 0 ? `${fmtAmt(agencyPnl)} USDT` : "—"}
                        </span>
                        <span style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600 }}>
                          {deal.action_pct}%{deal.rakeback_pct > 0 ? ` · rb ${deal.rakeback_pct}%` : ""}
                        </span>
                      </div>
                      {otherGames.length > 0 && (
                        <div style={{ display: "flex", gap: 3, marginTop: 6 }}>
                          {otherGames.map(gn => {
                            const ob = badgeFor(gn);
                            return <span key={gn} style={{ background: ob.bg, color: ob.color, padding: "1px 5px", borderRadius: 3, fontSize: 8, fontWeight: 700 }}>{ob.short}</span>;
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Add button */}
              <div style={{ padding: 8, borderTop: "1px solid var(--border)" }}>
                <button onClick={() => setAddGameModal(game)} style={{
                  width: "100%", padding: "7px 0", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  background: "none", border: "1px dashed var(--border)", color: "var(--text-dim)",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                }}>
                  <Plus size={13} /> Ajouter ici
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Pool */}
      {poolPlayers.length > 0 && (
        <div style={{ marginTop: 20, padding: "16px 20px", background: "var(--bg-surface)", borderRadius: 12, border: "1px solid var(--border)" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
            Pool — sans game ({poolPlayers.length})
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {poolPlayers.map(p => (
              <div key={p.id} onClick={() => onEdit(p)} style={{
                padding: "6px 12px", borderRadius: 7, background: "var(--bg-raised)", border: "1px solid var(--border)",
                fontSize: 12, color: "var(--text-muted)", cursor: "pointer",
                opacity: isActiveStatus(p.status) ? 1 : 0.5,
              }}>
                {p.name}
              </div>
            ))}
          </div>
        </div>
      )}

      {addGameModal && (
        <AddPlayerToGameModal
          open={!!addGameModal}
          onClose={() => setAddGameModal(null)}
          game={addGameModal}
          existingPlayerIds={new Set(
            Object.values(dealsByPlayer).flat().filter(d => d.game_id === addGameModal.id && !d.end_date).map(d => d.player_id)
          )}
          allPlayers={players}
        />
      )}

      {drawerPlayer && (
        <PlayerDetailDrawer
          player={drawerPlayer}
          deals={dealsByPlayer[drawerPlayer.id] ?? []}
          pnlByPlayerGame={pnlByPlayerGame}
          activeGames={activeGames}
          agencyTotal={agencyByPlayer[drawerPlayer.id] ?? 0}
          onClose={() => setDrawerPlayer(null)}
          onEdit={() => { const p = drawerPlayer; setDrawerPlayer(null); onEdit(p); }}
        />
      )}

      <Modal open={!!archiveGame} onClose={() => setArchiveGame(null)} title={`Archiver ${archiveGame?.name ?? ""} ?`} width={440}>
        {archiveGame && (() => {
          const gId = archiveGame.id;
          const activeDealsCount = Object.values(dealsByPlayer).flat().filter(d => d.game_id === gId && !d.end_date).length;
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
                <p style={{ margin: "0 0 8px" }}><b>{activeDealsCount} deal(s) actif(s)</b> seront archivés (end_date = aujourd&apos;hui). L&apos;historique P&amp;L est préservé.</p>
                <p style={{ margin: "0 0 8px" }}>Les wallet mères associées seront marquées &quot;retired&quot;.</p>
                <p style={{ margin: 0 }}>Le game disparaîtra de la Kanban et des dropdowns.</p>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button onClick={() => setArchiveGame(null)} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                  Annuler
                </button>
                <button
                  disabled={archiving}
                  onClick={async () => {
                    setArchiving(true);
                    try {
                      const res = await fetch("/api/games", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: gId, status: "archived" }),
                      });
                      const data = await res.json();
                      if (!res.ok) throw new Error(data.error ?? "Failed");
                      setArchiveGame(null);
                      alert(`Archivé. ${data.deals_archived ?? 0} deal(s) fermés, ${data.meres_retired ?? 0} wallet mère(s) retirées.`);
                      router.refresh();
                    } catch (e: any) {
                      alert("Erreur: " + (e.message ?? e));
                    } finally {
                      setArchiving(false);
                    }
                  }}
                  style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: archiving ? "wait" : "pointer", background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", color: "#EF4444", opacity: archiving ? 0.5 : 1 }}
                >
                  {archiving ? "..." : "Confirmer archivage"}
                </button>
              </div>
            </div>
          );
        })()}
      </Modal>

      <Modal open={!!unarchiveGame} onClose={() => setUnarchiveGame(null)} title={`Réactiver ${unarchiveGame?.name ?? ""} ?`} width={440}>
        {unarchiveGame && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
              <p style={{ margin: "0 0 8px" }}>Le game redeviendra actif et apparaîtra dans la Kanban et les dropdowns.</p>
              <p style={{ margin: "0 0 8px" }}>Les deals des joueurs (archivés au moment de l&apos;archive) ne seront <b>PAS</b> réactivés automatiquement.</p>
              <p style={{ margin: 0 }}>Les wallet mères (retired) resteront retired. Réactive-les manuellement dans Settings si besoin.</p>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button onClick={() => setUnarchiveGame(null)} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                Annuler
              </button>
              <button
                disabled={archiving}
                onClick={async () => {
                  setArchiving(true);
                  try {
                    const res = await fetch("/api/games", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: unarchiveGame.id, status: "active" }),
                    });
                    if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
                    setUnarchiveGame(null);
                    router.refresh();
                  } catch (e: any) {
                    alert("Erreur: " + (e.message ?? e));
                  } finally {
                    setArchiving(false);
                  }
                }}
                style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: archiving ? "wait" : "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E", opacity: archiving ? 0.5 : 1 }}
              >
                {archiving ? "..." : "Confirmer réactivation"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
