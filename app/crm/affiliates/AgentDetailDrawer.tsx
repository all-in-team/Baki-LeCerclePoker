"use client";

import { useEffect, useState, type ReactNode } from "react";
import { X, Pencil, XCircle, DollarSign, Users, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";

interface GameBreakdown {
  game_id: number; game_name: string; rate: number; rate_label: string;
  agency_pnl_lifetime: number; earned_lifetime: number; paid_lifetime: number; due_now: number;
  player_pnl_lifetime: number | null; effective_action_pct: number; currency: string;
  agency_pnl_native: number; cny_rate_missing: boolean; is_composite: boolean;
}
interface AffPayment {
  paid_at: string; amount_usdt: number; game_id: number; game_name: string | null;
  tx_hash: string | null; week_start_date: string; week_end_date: string; notes: string | null;
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
  payments: AffPayment[];
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
  onPayRel: (relId: number, gameId: number, gameName: string, due: number, affName: string, refName: string, earned: number, paid: number) => void;
  gameBadges: Record<string, { short: string; bg: string; color: string }>;
}

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  active: { bg: "rgba(16,185,129,0.15)", color: "#10B981" },
  paused: { bg: "rgba(234,179,8,0.15)", color: "#EAB308" },
  terminated: { bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" },
};

const GREEN = "#22C55E", RED = "#EF4444", GREY = "var(--text-dim)";
const f2 = (n: number) => n.toFixed(2);
// Signed amount + currency, color-coded
function money(n: number, cur = "USDT") {
  const c = n > 0.005 ? GREEN : n < -0.005 ? RED : GREY;
  const sign = n > 0.005 ? "+" : "";
  return { text: `${sign}${f2(n)} ${cur}`, color: c };
}
function Amt({ n, cur = "USDT", bold }: { n: number; cur?: string; bold?: boolean }) {
  const m = money(n, cur);
  return <span style={{ color: m.color, fontWeight: bold ? 700 : 600, fontVariantNumeric: "tabular-nums" }}>{m.text}</span>;
}

// Why is the agent's share 0 on this game?
function zeroReason(g: GameBreakdown): string | null {
  if (g.earned_lifetime > 0.005) return null;
  if (g.rate_label === "hors_fenetre") return "hors fenêtre 30j";
  if (g.agency_pnl_lifetime <= 0.005) return "makeup négatif (P&L agence ≤ 0)";
  if (g.effective_action_pct === 0) return "0% sur ce game";
  return null;
}

export default function AgentDetailDrawer({ agentSummary, onClose, onEditRel, onTerminateRel, onPayRel, gameBadges }: Props) {
  const { agent, filleuls, totalCommissionEarned, totalDueNow } = agentSummary;
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [showPayments, setShowPayments] = useState<Set<number>>(new Set());

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const toggle = (set: Set<number>, setter: (s: Set<number>) => void, id: number) => {
    const next = new Set(set);
    next.has(id) ? next.delete(id) : next.add(id);
    setter(next);
  };

  const activeFilleuls = filleuls.filter(r => r.status === "active");
  const ordered = [...activeFilleuls, ...filleuls.filter(r => r.status !== "active")];

  // Coherence guard: sum of per-filleul dues must equal the header "Due now"
  const sumDue = filleuls.reduce((s, r) => s + (r.total_due_now ?? 0), 0);
  const coherent = Math.abs(sumDue - totalDueNow) < 0.01;

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.5)" }} />
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 201, width: "min(580px, 100vw)", background: "var(--bg-raised)", borderLeft: "1px solid var(--border)", overflowY: "auto", padding: "24px", display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)" }}>{agent.name}</div>
            <div style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 2, display: "flex", alignItems: "center", gap: 8 }}>
              {agent.telegram_handle && <span>@{agent.telegram_handle}</span>}
              {agent.telegram_id ? (
                <span style={{ color: GREEN, fontSize: 11, fontWeight: 600 }}>ID: {agent.telegram_id}</span>
              ) : (
                <span style={{ color: RED, fontSize: 11, fontWeight: 600 }}>telegram_id manquant</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>Actif depuis {agent.joined_at?.slice(0, 10)}</div>
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
              {totalCommissionEarned > 0 ? f2(totalCommissionEarned) : "—"}
            </div>
          </div>
          <div style={{ padding: "12px 14px", background: totalDueNow > 0 ? "rgba(34,197,94,0.06)" : "var(--bg-surface)", borderRadius: 8, border: `1px solid ${totalDueNow > 0 ? "rgba(34,197,94,0.25)" : "var(--border)"}` }}>
            <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>Due now</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: totalDueNow > 0 ? GREEN : "var(--text-dim)" }}>
              {totalDueNow > 0 ? f2(totalDueNow) : "—"}
            </div>
          </div>
        </div>

        {/* Coherence guard */}
        {!coherent && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderRadius: 8, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: RED, fontSize: 12, fontWeight: 600 }}>
            <AlertTriangle size={14} /> Incohérence : Σ dûs filleuls = {f2(sumDue)} ≠ Due now {f2(totalDueNow)}
          </div>
        )}

        {/* Filleuls — cards */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
            Filleuls ({filleuls.length})
          </div>
          {filleuls.length === 0 && (
            <div style={{ padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 13, background: "var(--bg-surface)", borderRadius: 8, border: "1px solid var(--border)" }}>Aucun filleul</div>
          )}
          {ordered.map(r => {
            const games = r.games ?? [];
            const earned = games.reduce((s, g) => s + g.earned_lifetime, 0);
            const paid = r.total_paid_lifetime ?? 0;
            const due = r.total_due_now ?? 0;
            const st = STATUS_STYLE[r.status] ?? STATUS_STYLE.terminated;
            const isOpen = expanded.has(r.id);
            const payOpen = showPayments.has(r.id);

            return (
              <div key={r.id} style={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg-surface)", overflow: "hidden", opacity: r.status === "terminated" ? 0.6 : 1 }}>
                {/* Collapsed header row */}
                <div onClick={() => toggle(expanded, setExpanded, r.id)}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", cursor: "pointer" }}>
                  {isOpen ? <ChevronDown size={15} style={{ color: "var(--text-dim)", flexShrink: 0 }} /> : <ChevronRight size={15} style={{ color: "var(--text-dim)", flexShrink: 0 }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 600, color: "var(--text)" }}>{r.referred.name}</span>
                      <div style={{ display: "flex", gap: 3 }}>
                        {games.map(g => {
                          const gb = gameBadges[g.game_name] ?? { short: g.game_name.slice(0, 2), bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" };
                          return <span key={g.game_id} style={{ background: gb.bg, color: gb.color, padding: "1px 5px", borderRadius: 4, fontSize: 9, fontWeight: 700 }}>{gb.short}</span>;
                        })}
                      </div>
                      <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: st.bg, color: st.color }}>{r.status}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 3 }}>
                      Commission <Amt n={earned} /> · Dû <Amt n={due} />
                    </div>
                  </div>
                  <span style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{isOpen ? "▾" : "détail ▸"}</span>
                </div>

                {/* Expanded — audit chain */}
                {isOpen && (
                  <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                    {games.length === 0 && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Aucun game avec deal pour ce filleul.</div>}
                    {games.map(g => {
                      const reason = zeroReason(g);
                      const eligible = g.rate_label === "éligible";
                      return (
                        <div key={g.game_id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-raised)" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{g.game_name}</span>
                            <span style={{ fontSize: 10, fontWeight: 600, color: eligible ? GREEN : "#EAB308" }}>
                              {eligible ? "✅ fenêtre 30j" : "❌ hors fenêtre 30j"}
                            </span>
                          </div>

                          {g.is_composite ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                              <div style={{ color: "var(--text-dim)", fontStyle: "italic" }}>Formule composite (winnings × action + rake × rb + ins × ins)</div>
                              <Row label={`Part agence (natif)`} value={<Amt n={g.agency_pnl_native} cur={g.currency} />} />
                              {g.cny_rate_missing ? (
                                <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#EAB308", fontSize: 11, fontWeight: 600 }}>
                                  <AlertTriangle size={12} /> taux {g.currency} manquant → conversion USDT impossible
                                </div>
                              ) : (
                                <Row label="≈ Part agence (USDT)" value={<Amt n={g.agency_pnl_lifetime} />} />
                              )}
                              <Row label={`× Part agent (${Math.round(g.rate * 100)}%)`} value={reason ? <span style={{ color: GREY }}>0 — {reason}</span> : <Amt n={g.earned_lifetime} bold />} />
                            </div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                              <Row label="P&L joueur" value={<Amt n={g.player_pnl_lifetime ?? 0} cur={g.currency} />} />
                              <Row label={`× Deal agence (${g.effective_action_pct}%)`} value={<Amt n={g.agency_pnl_lifetime} cur={g.currency} />} sub="ta part" />
                              <Row label={`× Part agent (${Math.round(g.rate * 100)}%)`} value={reason ? <span style={{ color: GREY }}>0 — {reason}</span> : <Amt n={g.earned_lifetime} bold />} />
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Total filleul */}
                    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                      <Row label="Earned cumulé" value={<Amt n={earned} />} />
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                        <button onClick={() => toggle(showPayments, setShowPayments, r.id)}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 0, fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                          {payOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Déjà payé ({r.payments?.length ?? 0})
                        </button>
                        <span style={{ color: paid > 0.005 ? RED : GREY, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>−{f2(paid)} USDT</span>
                      </div>
                      {payOpen && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 3, paddingLeft: 16 }}>
                          {(r.payments ?? []).length === 0 && <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Aucun paiement.</div>}
                          {(r.payments ?? []).map((p, i) => (
                            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-dim)" }}>
                              <span>{p.paid_at?.slice(0, 10)} · {p.game_name ?? "?"}{p.tx_hash ? " · tx ✓" : ""}</span>
                              <span style={{ fontVariantNumeric: "tabular-nums" }}>{f2(p.amount_usdt)} USDT</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4, paddingTop: 8, borderTop: "1px dashed var(--border)" }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Dû maintenant</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ fontSize: 20, fontWeight: 800, color: due > 0.005 ? GREEN : GREY, fontVariantNumeric: "tabular-nums" }}>{due > 0.005 ? `+${f2(due)}` : f2(due)} USDT</span>
                          {due > 0.005 && games.filter(g => g.due_now > 0.005).map(g => (
                            <button key={g.game_id} onClick={() => onPayRel(r.id, g.game_id, g.game_name, g.due_now, agent.name, r.referred.name, g.earned_lifetime, g.paid_lifetime)}
                              title={`Payer ${g.game_name}`}
                              style={{ display: "flex", alignItems: "center", gap: 4, background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 6, cursor: "pointer", padding: "5px 10px", color: GREEN, fontSize: 12, fontWeight: 600 }}>
                              <DollarSign size={12} /> {g.game_name}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Rel actions */}
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 2 }}>
                      <button onClick={() => onEditRel(r)} title="Edit relation"
                        style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "4px 10px", color: "var(--text-muted)", fontSize: 11 }}>
                        <Pencil size={11} /> Edit
                      </button>
                      {r.status !== "terminated" && (
                        <button onClick={() => onTerminateRel(r.id)} title="Terminer"
                          style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "4px 10px", color: "var(--text-muted)", fontSize: 11 }}>
                          <XCircle size={11} /> Terminer
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function Row({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
      <span style={{ color: "var(--text-dim)" }}>{label}{sub && <span style={{ fontSize: 10, marginLeft: 5, opacity: 0.7 }}>({sub})</span>}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}
