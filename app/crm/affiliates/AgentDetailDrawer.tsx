"use client";

import { useEffect } from "react";
import { X, Pencil, XCircle, DollarSign, Users } from "lucide-react";

interface GameBreakdown {
  game_id: number; game_name: string; rate: number; rate_label: string;
  agency_pnl_lifetime: number; earned_lifetime: number; paid_lifetime: number; due_now: number;
}
interface EnrichedRel {
  id: number; status: string; start_date: string;
  affiliate: { id: number; name: string; telegram_handle: string | null };
  referred: { id: number; name: string; telegram_handle: string | null };
  origin_game: { id: number | null; name: string | null };
  disclosed_action_pct: number | null; disclosed_rakeback_pct: number | null; disclosed_insurance_pct: number | null;
  exclude_agency_extras: number; notes: string | null;
  games: GameBreakdown[];
  total_due_now: number; total_paid_lifetime: number; last_paid_at: string | null;
}
interface Agent {
  affiliate_player_id: number; joined_at: string; profile_status: string;
  name: string; telegram_handle: string | null; telegram_id: number | null;
}
interface AgentSummary {
  agent: Agent;
  filleuls: EnrichedRel[];
  totalCommissionEarned: number;
  totalDueNow: number;
}

interface Props {
  agentSummary: AgentSummary;
  onClose: () => void;
  onEditRel: (r: EnrichedRel) => void;
  onTerminateRel: (id: number) => void;
  onPayRel: (relId: number, gameId: number, gameName: string, due: number, affName: string, refName: string) => void;
  gameBadges: Record<string, { short: string; bg: string; color: string }>;
}

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  active: { bg: "rgba(16,185,129,0.15)", color: "#10B981" },
  paused: { bg: "rgba(234,179,8,0.15)", color: "#EAB308" },
  terminated: { bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" },
};

const fmt = (n: number) => n.toFixed(2);

export default function AgentDetailDrawer({ agentSummary, onClose, onEditRel, onTerminateRel, onPayRel, gameBadges }: Props) {
  const { agent, filleuls, totalCommissionEarned, totalDueNow } = agentSummary;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const activeFilleuls = filleuls.filter(r => r.status === "active");
  const inactiveFilleuls = filleuls.filter(r => r.status !== "active");

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.5)" }} />
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 201, width: "min(560px, 100vw)", background: "var(--bg-raised)", borderLeft: "1px solid var(--border)", overflowY: "auto", padding: "24px", display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)" }}>{agent.name}</div>
            <div style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 2, display: "flex", alignItems: "center", gap: 8 }}>
              {agent.telegram_handle && <span>@{agent.telegram_handle}</span>}
              {agent.telegram_id ? (
                <span style={{ color: "#22C55E", fontSize: 11, fontWeight: 600 }}>ID: {agent.telegram_id}</span>
              ) : (
                <span style={{ color: "#EF4444", fontSize: 11, fontWeight: 600 }}>telegram_id manquant</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>
              Actif depuis {agent.joined_at?.slice(0, 10)}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 4 }}><X size={18} /></button>
        </div>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <div style={{ padding: "12px 14px", background: "var(--bg-surface)", borderRadius: 8, border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>Filleuls actifs</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }}>
              <Users size={16} style={{ color: "var(--text-dim)" }} /> {activeFilleuls.length}
            </div>
          </div>
          <div style={{ padding: "12px 14px", background: "var(--bg-surface)", borderRadius: 8, border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>Commission totale</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: totalCommissionEarned > 0 ? "var(--text)" : "var(--text-dim)" }}>
              {totalCommissionEarned > 0 ? `${fmt(totalCommissionEarned)}` : "—"}
            </div>
          </div>
          <div style={{ padding: "12px 14px", background: totalDueNow > 0 ? "rgba(34,197,94,0.06)" : "var(--bg-surface)", borderRadius: 8, border: `1px solid ${totalDueNow > 0 ? "rgba(34,197,94,0.25)" : "var(--border)"}` }}>
            <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>Due now</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: totalDueNow > 0 ? "#22C55E" : "var(--text-dim)" }}>
              {totalDueNow > 0 ? `${fmt(totalDueNow)}` : "—"}
            </div>
          </div>
        </div>

        {/* Filleuls table */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
            Filleuls ({filleuls.length})
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                <th style={{ textAlign: "left", padding: "6px 6px" }}>Joueur</th>
                <th style={{ textAlign: "center", padding: "6px 6px" }}>Games</th>
                <th style={{ textAlign: "right", padding: "6px 6px" }}>Earned</th>
                <th style={{ textAlign: "right", padding: "6px 6px" }}>Due</th>
                <th style={{ textAlign: "center", padding: "6px 6px" }}>Status</th>
                <th style={{ textAlign: "center", padding: "6px 6px" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filleuls.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 20, textAlign: "center", color: "var(--text-dim)" }}>Aucun filleul</td></tr>
              )}
              {[...activeFilleuls, ...inactiveFilleuls].map(r => {
                const st = STATUS_STYLE[r.status] ?? STATUS_STYLE.terminated;
                const games = r.games ?? [];
                const earned = games.reduce((s, g) => s + g.earned_lifetime, 0);
                const due = r.total_due_now ?? 0;
                return (
                  <tr key={r.id} style={{ borderBottom: "1px solid var(--border)", opacity: r.status === "terminated" ? 0.5 : 1 }}>
                    <td style={{ padding: "10px 6px" }}>
                      <div style={{ fontWeight: 600, color: "var(--text)" }}>{r.referred.name}</div>
                      {r.referred.telegram_handle && <div style={{ fontSize: 10, color: "var(--text-dim)" }}>@{r.referred.telegram_handle}</div>}
                    </td>
                    <td style={{ textAlign: "center", padding: "10px 6px" }}>
                      <div style={{ display: "flex", gap: 3, justifyContent: "center", flexWrap: "wrap" }}>
                        {games.map(g => {
                          const gb = gameBadges[g.game_name] ?? { short: g.game_name.slice(0, 2), bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" };
                          return (
                            <span key={g.game_id} style={{ background: gb.bg, color: gb.color, padding: "1px 5px", borderRadius: 4, fontSize: 9, fontWeight: 700 }}>{gb.short}</span>
                          );
                        })}
                        {games.length === 0 && <span style={{ color: "var(--text-dim)", fontSize: 10 }}>—</span>}
                      </div>
                    </td>
                    <td style={{ textAlign: "right", padding: "10px 6px", color: earned > 0 ? "var(--text)" : "var(--text-dim)" }}>
                      {earned > 0 ? fmt(earned) : "—"}
                    </td>
                    <td style={{ textAlign: "right", padding: "10px 6px", fontWeight: 600, color: due > 0 ? "#22C55E" : "var(--text-dim)" }}>
                      {due > 0 ? fmt(due) : "—"}
                    </td>
                    <td style={{ textAlign: "center", padding: "10px 6px" }}>
                      <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: st.bg, color: st.color }}>{r.status}</span>
                    </td>
                    <td style={{ textAlign: "center", padding: "10px 6px" }}>
                      <div style={{ display: "flex", justifyContent: "center", gap: 4 }}>
                        {due > 0 && games.filter(g => g.due_now > 0).map(g => (
                          <button key={g.game_id} onClick={() => onPayRel(r.id, g.game_id, g.game_name, g.due_now, agent.name, r.referred.name)} title={`Pay ${g.game_name}`}
                            style={{ background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 5, cursor: "pointer", padding: "3px 5px", color: "#22C55E", display: "flex", alignItems: "center" }}>
                            <DollarSign size={11} />
                          </button>
                        ))}
                        <button onClick={() => onEditRel(r)} title="Edit"
                          style={{ background: "none", border: "1px solid var(--border)", borderRadius: 5, cursor: "pointer", padding: "3px 5px", color: "var(--text-muted)", display: "flex", alignItems: "center" }}>
                          <Pencil size={11} />
                        </button>
                        {r.status !== "terminated" && (
                          <button onClick={() => onTerminateRel(r.id)} title="Terminer"
                            style={{ background: "none", border: "1px solid var(--border)", borderRadius: 5, cursor: "pointer", padding: "3px 5px", color: "var(--text-muted)", display: "flex", alignItems: "center" }}>
                            <XCircle size={11} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
