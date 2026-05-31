"use client";

import { useEffect } from "react";
import { X, Pencil } from "lucide-react";

const GAME_BADGES: Record<string, { short: string; bg: string; color: string }> = {
  TELE:    { short: "AK", bg: "rgba(212,175,55,0.15)", color: "#D4AF37" },
  KKPOKER: { short: "KK", bg: "rgba(59,130,246,0.15)", color: "#3B82F6" },
  A5POKER: { short: "A5", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
  Wepoker: { short: "WE", bg: "rgba(139,92,246,0.15)", color: "#8B5CF6" },
  Xpoker:  { short: "XP", bg: "rgba(236,72,153,0.15)", color: "#EC4899" },
  ClubGG:  { short: "CG", bg: "rgba(234,179,8,0.15)",  color: "#EAB308" },
};
const BADGE_FALLBACK = { short: "??", bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" };

interface Player { id: number; name: string; telegram_handle: string | null; status: string; tier: string | null; }
interface Deal { deal_id: number; player_id: number; game_id: number; action_pct: number; rakeback_pct: number; start_date: string | null; end_date: string | null; }
interface Game { id: number; name: string; default_action_pct: number | null; status: string; }

interface Props {
  player: Player;
  deals: Deal[];
  pnlByPlayerGame: Record<string, { player_net: number; agency_pnl: number }>;
  activeGames: Game[];
  agencyTotal: number;
  onClose: () => void;
  onEdit: () => void;
}

function fmtAmt(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toLocaleString("fr-FR", { maximumFractionDigits: 0 })}`;
}

function fmtAmt2(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function PlayerDetailDrawer({ player, deals, pnlByPlayerGame, activeGames, agencyTotal, onClose, onEdit }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const activeDeals = deals.filter(d => !d.end_date);
  const archivedDeals = deals.filter(d => d.end_date);

  const gameMap = new Map(activeGames.map(g => [g.id, g]));

  let totalPlayerNet = 0;
  let totalAgencyPnl = 0;

  const rows = activeDeals.map(deal => {
    const game = gameMap.get(deal.game_id);
    const gameName = game?.name ?? `Game #${deal.game_id}`;
    const pnl = pnlByPlayerGame[`${player.id}_${deal.game_id}`];
    const playerNet = pnl?.player_net ?? 0;
    const agencyPnl = pnl?.agency_pnl ?? 0;
    totalPlayerNet += playerNet;
    totalAgencyPnl += agencyPnl;
    return { deal, gameName, playerNet, agencyPnl };
  });

  return (
    <>
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, zIndex: 200,
        background: "rgba(0,0,0,0.5)",
      }} />
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 201,
        width: "min(420px, 100vw)", background: "var(--bg-raised)",
        borderLeft: "1px solid var(--border)",
        boxShadow: "-8px 0 40px rgba(0,0,0,0.4)",
        display: "flex", flexDirection: "column",
        animation: "slideIn 0.2s ease-out",
      }}>
        <style>{`@keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>

        {/* Header */}
        <div style={{ padding: "20px 20px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)" }}>{player.name}</div>
            {player.telegram_handle && <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>@{player.telegram_handle}</div>}
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <span style={{
                padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                background: player.status === "active" ? "rgba(16,185,129,0.15)" : "rgba(156,163,175,0.15)",
                color: player.status === "active" ? "#10B981" : "var(--text-muted)",
              }}>{player.status}</span>
              {player.tier && <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: "rgba(212,175,55,0.15)", color: "#D4AF37" }}>Tier {player.tier}</span>}
            </div>
          </div>
          <button onClick={onEdit} title="Edit deals" style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "6px 8px", color: "var(--text-muted)", display: "flex", alignItems: "center" }}>
            <Pencil size={14} />
          </button>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {/* P&L by game */}
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 12 }}>
            P&L par game (30 jours)
          </div>

          {rows.length === 0 && (
            <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>Aucun deal actif</div>
          )}

          {rows.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 16 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 10, textTransform: "uppercase" }}>
                  <th style={{ textAlign: "left", padding: "6px 8px" }}>Game</th>
                  <th style={{ textAlign: "right", padding: "6px 8px" }}>Player</th>
                  <th style={{ textAlign: "right", padding: "6px 8px" }}>Agency</th>
                  <th style={{ textAlign: "center", padding: "6px 8px" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ deal, gameName, playerNet, agencyPnl }) => {
                  const badge = GAME_BADGES[gameName] ?? BADGE_FALLBACK;
                  return (
                    <tr key={deal.deal_id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "8px" }}>
                        <span style={{ background: badge.bg, color: badge.color, padding: "2px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{badge.short}</span>
                        <span style={{ marginLeft: 6, color: "var(--text)" }}>{gameName}</span>
                      </td>
                      <td style={{ textAlign: "right", padding: "8px", fontWeight: 600, color: playerNet > 0 ? "#22C55E" : playerNet < 0 ? "#EF4444" : "var(--text-dim)" }}>
                        {playerNet !== 0 ? `${fmtAmt2(playerNet)}` : "—"}
                      </td>
                      <td style={{ textAlign: "right", padding: "8px", fontWeight: 600, color: agencyPnl > 0 ? "#D4AF37" : agencyPnl < 0 ? "#EF4444" : "var(--text-dim)" }}>
                        {agencyPnl !== 0 ? `${fmtAmt2(agencyPnl)}` : "—"}
                      </td>
                      <td style={{ textAlign: "center", padding: "8px", color: "var(--text-muted)" }}>
                        {deal.action_pct}%
                      </td>
                    </tr>
                  );
                })}
                <tr style={{ borderTop: "2px solid var(--border)" }}>
                  <td style={{ padding: "8px", fontWeight: 700, color: "var(--text)" }}>TOTAL</td>
                  <td style={{ textAlign: "right", padding: "8px", fontWeight: 700, color: totalPlayerNet > 0 ? "#22C55E" : totalPlayerNet < 0 ? "#EF4444" : "var(--text-dim)" }}>
                    {fmtAmt2(totalPlayerNet)}
                  </td>
                  <td style={{ textAlign: "right", padding: "8px", fontWeight: 700, color: totalAgencyPnl > 0 ? "#D4AF37" : totalAgencyPnl < 0 ? "#EF4444" : "var(--text-dim)" }}>
                    {fmtAmt2(totalAgencyPnl)}
                  </td>
                  <td style={{ textAlign: "center", padding: "8px", color: "var(--text-dim)" }}>—</td>
                </tr>
              </tbody>
            </table>
          )}

          {/* Archived deals */}
          {archivedDeals.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
                Deals archivés
              </div>
              {archivedDeals.map(deal => {
                const game = gameMap.get(deal.game_id);
                const gameName = game?.name ?? `Game #${deal.game_id}`;
                const badge = GAME_BADGES[gameName] ?? BADGE_FALLBACK;
                return (
                  <div key={deal.deal_id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", opacity: 0.5, fontSize: 12 }}>
                    <span style={{ background: badge.bg, color: badge.color, padding: "2px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{badge.short}</span>
                    <span style={{ color: "var(--text-muted)" }}>{gameName}</span>
                    <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)" }}>fin {deal.end_date}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border)", display: "flex", gap: 10 }}>
          <button onClick={onEdit} style={{
            flex: 1, padding: "10px 0", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer",
            background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E",
          }}>
            Edit deals
          </button>
          <button onClick={onClose} style={{
            padding: "10px 20px", borderRadius: 8, fontSize: 13, cursor: "pointer",
            background: "none", border: "1px solid var(--border)", color: "var(--text-muted)",
          }}>
            Fermer
          </button>
        </div>
      </div>
    </>
  );
}
