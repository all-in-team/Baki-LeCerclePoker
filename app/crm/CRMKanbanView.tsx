"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X, Plus, Search, Pencil, Archive, RotateCcw } from "lucide-react";
import Modal from "@/components/Modal";
import AddPlayerToGameModal from "./AddPlayerToGameModal";
import PlayerDetailDrawer from "./PlayerDetailDrawer";

const GAME_BADGES: Record<string, { short: string; bg: string; color: string }> = {
  TELE:    { short: "AK", bg: "rgba(212,175,55,0.15)", color: "#D4AF37" },
  KKPOKER: { short: "KK", bg: "rgba(59,130,246,0.15)", color: "#3B82F6" },
  A5POKER: { short: "A5", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
  Wepoker: { short: "WE", bg: "rgba(139,92,246,0.15)", color: "#8B5CF6" },
  Xpoker:  { short: "XP", bg: "rgba(236,72,153,0.15)", color: "#EC4899" },
  ClubGG:  { short: "CG", bg: "rgba(234,179,8,0.15)",  color: "#EAB308" },
};
const BADGE_FALLBACK = { short: "??", bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" };

interface Player { id: number; name: string; telegram_handle: string | null; status: string; tier: string | null; last_note_at: string | null; }
interface Deal { deal_id: number; player_id: number; game_id: number; action_pct: number; rakeback_pct: number; start_date: string | null; end_date: string | null; }
interface Game { id: number; name: string; default_action_pct: number | null; status: string; }

interface Props {
  players: Player[];
  gamesByPlayer: Record<number, string[]>;
  dealsByPlayer: Record<number, Deal[]>;
  agencyByPlayer: Record<number, number>;
  pnlByPlayerGame: Record<string, { player_net: number; agency_pnl: number }>;
  activeGames: Game[];
}

function fmtAmt(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toLocaleString("fr-FR", { maximumFractionDigits: 0 })}`;
}

// Edit modal — same as CRMListClient but extracted inline here for independence
function useEditModal(players: Player[], dealsByPlayer: Record<number, Deal[]>, activeGames: Game[]) {
  const router = useRouter();
  const [editPlayer, setEditPlayer] = useState<Player | null>(null);
  const [form, setForm] = useState({ name: "", tier: "B", status: "active" });
  const [dealForm, setDealForm] = useState<Record<number, { checked: boolean; action_pct: string; rakeback_pct: string; had_deal: boolean; deal_id: number | null; end_date: string | null }>>({});
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function openEdit(p: Player) {
    setEditPlayer(p);
    setForm({ name: p.name, tier: p.tier ?? "B", status: p.status });
    const deals = dealsByPlayer[p.id] ?? [];
    const df: Record<number, { checked: boolean; action_pct: string; rakeback_pct: string; had_deal: boolean; deal_id: number | null; end_date: string | null }> = {};
    for (const g of activeGames) {
      const existing = deals.find(d => d.game_id === g.id);
      df[g.id] = existing
        ? { checked: !existing.end_date, action_pct: String(existing.action_pct), rakeback_pct: String(existing.rakeback_pct), had_deal: true, deal_id: existing.deal_id, end_date: existing.end_date }
        : { checked: false, action_pct: String(g.default_action_pct ?? 50), rakeback_pct: "0", had_deal: false, deal_id: null, end_date: null };
    }
    setDealForm(df);
  }

  async function handleSave() {
    if (!editPlayer) return;
    setSaving(true);
    try {
      await fetch(`/api/players/${editPlayer.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, tier: form.tier, status: form.status }),
      });
      for (const g of activeGames) {
        const df = dealForm[g.id];
        if (!df) continue;
        if (df.checked) {
          await fetch("/api/games/deals", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ player_id: editPlayer.id, game_id: g.id, action_pct: Number(df.action_pct), rakeback_pct: Number(df.rakeback_pct), end_date: null }),
          });
        } else if (df.had_deal && !df.end_date) {
          const today = new Date().toISOString().slice(0, 10);
          await fetch("/api/games/deals", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ player_id: editPlayer.id, game_id: g.id, action_pct: Number(df.action_pct), rakeback_pct: Number(df.rakeback_pct), end_date: today }),
          });
        }
      }
      setEditPlayer(null);
      router.refresh();
    } catch (e: any) {
      alert("Erreur: " + (e.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  const modal = (
    <Modal open={!!editPlayer} onClose={() => { setEditPlayer(null); setConfirmDelete(false); }} title={`Edit — ${editPlayer?.name ?? ""}${editPlayer?.telegram_handle ? ` @${editPlayer.telegram_handle}` : ""}`} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>Nom</label>
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" }} />
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>Tier</label>
            <select value={form.tier} onChange={e => setForm({ ...form, tier: e.target.value })} style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none" }}>
              <option value="S">S</option><option value="A">A</option><option value="B">B</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>Status</label>
            <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none" }}>
              <option value="active">Active</option><option value="inactive">Inactive</option><option value="churned">Churned</option>
            </select>
          </div>
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 8 }}>Games & Deals</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {activeGames.map(g => {
              const df = dealForm[g.id];
              if (!df) return null;
              const badge = GAME_BADGES[g.name] ?? BADGE_FALLBACK;
              return (
                <div key={g.id} style={{ padding: "10px 12px", background: "var(--bg-surface)", borderRadius: 8, border: "1px solid var(--border)" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
                    <input type="checkbox" checked={df.checked} onChange={e => setDealForm({ ...dealForm, [g.id]: { ...df, checked: e.target.checked } })} style={{ accentColor: badge.color }} />
                    <span style={{ background: badge.bg, color: badge.color, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700 }}>{badge.short}</span>
                    <span style={{ color: "var(--text)", fontWeight: 600 }}>{g.name}</span>
                    {df.end_date && !df.checked && <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>Archivé le {df.end_date}</span>}
                  </label>
                  {df.checked && (
                    <div style={{ display: "flex", gap: 12, marginTop: 8, paddingLeft: 28 }}>
                      <div>
                        <label style={{ fontSize: 10, color: "var(--text-dim)", display: "block", marginBottom: 3 }}>Action %</label>
                        <input type="number" min={0} max={100} value={df.action_pct} onChange={e => setDealForm({ ...dealForm, [g.id]: { ...df, action_pct: e.target.value } })}
                          style={{ width: 70, padding: "6px 8px", borderRadius: 6, fontSize: 12, background: "var(--bg-raised)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", textAlign: "center" }} />
                      </div>
                      <div>
                        <label style={{ fontSize: 10, color: "var(--text-dim)", display: "block", marginBottom: 3 }}>Rakeback %</label>
                        <input type="number" min={0} max={100} value={df.rakeback_pct} onChange={e => setDealForm({ ...dealForm, [g.id]: { ...df, rakeback_pct: e.target.value } })}
                          style={{ width: 70, padding: "6px 8px", borderRadius: 6, fontSize: 12, background: "var(--bg-raised)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", textAlign: "center" }} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {confirmDelete && editPlayer ? (
          <div style={{ padding: 14, background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, marginTop: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#EF4444", marginBottom: 8 }}>Supprimer {editPlayer.name} ?</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 12 }}>
              Action IRRÉVERSIBLE. Tous les deals, wallets, transactions et sessions seront supprimés.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmDelete(false)} style={{ padding: "6px 14px", borderRadius: 7, fontSize: 12, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Annuler</button>
              <button disabled={saving} onClick={async () => {
                setSaving(true);
                try { await fetch(`/api/players/${editPlayer.id}`, { method: "DELETE" }); setEditPlayer(null); setConfirmDelete(false); router.refresh(); }
                catch (e: any) { alert("Erreur: " + (e.message ?? e)); }
                finally { setSaving(false); }
              }} style={{ padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", color: "#EF4444" }}>
                {saving ? "..." : "Confirmer suppression"}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
            <button onClick={() => setConfirmDelete(true)} style={{ padding: "8px 12px", borderRadius: 7, fontSize: 12, cursor: "pointer", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#EF4444" }}>Supprimer</button>
            <button disabled={saving} onClick={async () => {
              if (!editPlayer) return;
              setSaving(true);
              const newStatus = editPlayer.status === "churned" ? "active" : "churned";
              try { await fetch(`/api/players/${editPlayer.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: newStatus }) }); setEditPlayer(null); router.refresh(); }
              catch (e: any) { alert("Erreur: " + (e.message ?? e)); }
              finally { setSaving(false); }
            }} style={{ padding: "8px 12px", borderRadius: 7, fontSize: 12, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
              {editPlayer?.status === "churned" ? "Réactiver" : "Archiver"}
            </button>
            <div style={{ flex: 1 }} />
            <button onClick={() => { setEditPlayer(null); setConfirmDelete(false); }} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Annuler</button>
            <button onClick={handleSave} disabled={saving || !form.name.trim()} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E", opacity: saving || !form.name.trim() ? 0.5 : 1 }}>
              {saving ? "Saving..." : "Sauvegarder"}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );

  return { openEdit, modal };
}

export default function CRMKanbanView({ players, gamesByPlayer, dealsByPlayer, agencyByPlayer, pnlByPlayerGame, activeGames }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [addGameModal, setAddGameModal] = useState<Game | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [drawerPlayer, setDrawerPlayer] = useState<Player | null>(null);
  const [archiveGame, setArchiveGame] = useState<Game | null>(null);
  const [unarchiveGame, setUnarchiveGame] = useState<Game | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [showArchivedGames, setShowArchivedGames] = useState(false);

  const { openEdit, modal: editModal } = useEditModal(players, dealsByPlayer, activeGames);

  const filtered = players.filter(p => {
    if (!showInactive && p.status !== "active" && p.status !== "signed") return false;
    if (search) {
      const q = search.toLowerCase();
      return p.name.toLowerCase().includes(q) || (p.telegram_handle ?? "").toLowerCase().includes(q);
    }
    return true;
  });

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
    <div style={{ padding: "0 28px" }}>
      {/* Search + filters */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 320 }}>
          <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)" }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Chercher joueur..."
            style={{ width: "100%", padding: "8px 12px 8px 32px", borderRadius: 8, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" }} />
        </div>
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
          const badge = GAME_BADGES[game.name] ?? BADGE_FALLBACK;
          const isArchivedGame = game.status === "archived";
          const gameDeals = Object.values(dealsByPlayer).flat().filter(d => d.game_id === game.id && !d.end_date);
          const gamePlayers = gameDeals
            .map(d => ({ player: playerMap.get(d.player_id), deal: d }))
            .filter((x): x is { player: Player; deal: Deal } => !!x.player)
            .sort((a, b) => (agencyByPlayer[b.player.id] ?? 0) - (agencyByPlayer[a.player.id] ?? 0));

          const totalCut = gamePlayers.reduce((s, { player }) => s + (pnlByPlayerGame[`${player.id}_${game.id}`]?.agency_pnl ?? 0), 0);
          const existingIds = new Set(gamePlayers.map(x => x.player.id));

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
                  const pnlKey = `${player.id}_${game.id}`;
                  const pnl = pnlByPlayerGame[pnlKey];
                  const playerNet = pnl?.player_net ?? 0;
                  const agencyPnl = pnl?.agency_pnl ?? 0;
                  const otherGames = (gamesByPlayer[player.id] ?? []).filter(gn => gn !== game.name);
                  const isInactive = player.status !== "active" && player.status !== "signed";
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
                      {player.telegram_handle && <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 4 }}>@{player.telegram_handle}</div>}
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
                            const ob = GAME_BADGES[gn] ?? BADGE_FALLBACK;
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
              <div key={p.id} onClick={() => setDrawerPlayer(p)} style={{
                padding: "6px 12px", borderRadius: 7, background: "var(--bg-raised)", border: "1px solid var(--border)",
                fontSize: 12, color: "var(--text-muted)", cursor: "pointer",
                opacity: p.status !== "active" && p.status !== "signed" ? 0.5 : 1,
              }}>
                {p.name}
              </div>
            ))}
          </div>
        </div>
      )}

      {editModal}

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
          onEdit={() => { setDrawerPlayer(null); openEdit(drawerPlayer); }}
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
