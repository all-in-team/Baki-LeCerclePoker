"use client";

import { useEffect, useState, type ReactNode } from "react";
import { X, Pencil, XCircle, DollarSign, Users, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import { windowInfo } from "./eligibility";
import RateEditor from "./RateEditor";
import type { AgentSummary, EnrichedRel, GameBreakdown, RatePeriodView } from "./AffiliatesClient";

interface Props {
  agentSummary: AgentSummary;
  onClose: () => void;
  onEditRel: (r: EnrichedRel) => void;
  onTerminateRel: (id: number) => void;
  onPayAgent: (agentId: number, agentName: string, due: number, earned: number, paid: number) => void;
  onRatesChanged: () => void;
  gameBadges: Record<string, { short: string; bg: string; color: string }>;
}

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  active: { bg: "rgba(16,185,129,0.15)", color: "#10B981" },
  paused: { bg: "rgba(234,179,8,0.15)", color: "#EAB308" },
  terminated: { bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" },
};

const GREEN = "#22C55E", RED = "#EF4444", GREY = "var(--text-dim)";
const f2 = (n: number) => n.toFixed(2);
function money(n: number, cur = "USDT") {
  const c = n > 0.005 ? GREEN : n < -0.005 ? RED : GREY;
  const sign = n > 0.005 ? "+" : "";
  return { text: `${sign}${f2(n)} ${cur}`, color: c };
}
function Amt({ n, cur = "USDT", bold }: { n: number; cur?: string; bold?: boolean }) {
  const m = money(n, cur);
  return <span style={{ color: m.color, fontWeight: bold ? 700 : 600, fontVariantNumeric: "tabular-nums" }}>{m.text}</span>;
}

// Contribution SIGNÉE d'un filleul à la commission de l'agent : Σ (part agence × taux) par
// game et par semaine, calculée côté serveur (earned_lifetime de chaque game).
function commissionOf(r: EnrichedRel): number {
  return (r.games ?? []).reduce((s, g) => s + g.earned_lifetime, 0);
}
function countedPartOf(r: EnrichedRel): number {
  return (r.games ?? []).reduce((s, g) => s + g.counted_part, 0);
}

const KIND_LABEL: Record<string, { label: string; color: string }> = {
  migration: { label: "migré", color: "var(--text-dim)" },
  hors_fenetre: { label: "hors fenêtre", color: "#9CA3AF" },
  manual: { label: "manuel", color: "#3B82F6" },
  default: { label: "par défaut — à confirmer", color: "#EAB308" },
};
const periodRange = (p: RatePeriodView) => `${p.start_week ?? "origine"} → ${p.end_week ? `sem. du ${p.end_week}` : "en cours"}`;

export default function AgentDetailDrawer({ agentSummary, onClose, onEditRel, onTerminateRel, onPayAgent, onRatesChanged, gameBadges }: Props) {
  const { agent, filleuls, commissionSigned, earned, paid, due, blocked, frozenThrough } = agentSummary;
  const [editing, setEditing] = useState<string | null>(null);        // `${relId}:${gameId}`
  const [historyOpen, setHistoryOpen] = useState<Set<string>>(new Set());
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

  // Garde de cohérence : Σ commissions des filleuls actifs (lues game par game) = commission agent (serveur).
  const sumCommission = activeFilleuls.reduce((s, r) => s + commissionOf(r), 0);
  const coherent = Math.abs(sumCommission - commissionSigned) < 0.01;

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
          <Stat label="Filleuls actifs" value={<span style={{ display: "flex", alignItems: "center", gap: 6 }}><Users size={16} style={{ color: "var(--text-dim)" }} /> {activeFilleuls.length}</span>} />
          <Stat label="Commission (earned)" value={earned === null ? "bloqué" : earned > 0 ? f2(earned) : "—"} color={earned === null ? RED : earned > 0 ? "var(--text)" : "var(--text-dim)"} />
          <Stat label="Due now" value={due === null ? "bloqué" : due > 0 ? f2(due) : "—"} color={due === null ? RED : due > 0 ? GREEN : "var(--text-dim)"} highlight={due !== null && due > 0} />
        </div>

        {!coherent && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderRadius: 8, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: RED, fontSize: 12, fontWeight: 600 }}>
            <AlertTriangle size={14} /> Incohérence : Σ commissions filleuls = {f2(sumCommission)} ≠ commission agent {f2(commissionSigned)}
          </div>
        )}

        {blocked.length > 0 && (
          <div style={{ padding: "9px 12px", borderRadius: 8, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: RED, fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}><AlertTriangle size={14} /> Dû bloqué — taux agent manquant, aucun paiement possible</div>
            {blocked.map((b, i) => (
              <div key={i}>• {b.referred_name} / {b.game_name} : {b.reason === "taux_manquant" ? `part agence ${f2(b.part)} sans taux (semaine${b.weeks.length > 1 ? "s" : ""} ${b.weeks.join(", ")})` : `transaction à date illisible (${f2(b.part)})`}</div>
            ))}
          </div>
        )}

        {/* Filleuls — cards (part agence brute, négatifs visibles) */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
            Filleuls ({filleuls.length}) — contribution au cumul
          </div>
          {filleuls.length === 0 && (
            <div style={{ padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 13, background: "var(--bg-surface)", borderRadius: 8, border: "1px solid var(--border)" }}>Aucun filleul</div>
          )}
          {ordered.map(r => {
            const games = r.games ?? [];
            const part = countedPartOf(r);
            const commission = commissionOf(r);
            const win = windowInfo(r.start_date);
            const st = STATUS_STYLE[r.status] ?? STATUS_STYLE.terminated;
            const isOpen = expanded.has(r.id);
            const payOpen = showPayments.has(r.id);
            return (
              <div key={r.id} style={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg-surface)", overflow: "hidden", opacity: r.status === "terminated" ? 0.6 : 1 }}>
                <div onClick={() => toggle(expanded, setExpanded, r.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", cursor: "pointer" }}>
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
                      Part agence (comptée) <Amt n={part} /> · commission <Amt n={commission} />
                    </div>
                    {/* Relation-level eligibility window (relStart + 30j) — same source as /crm/[id] */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                      <span>Affilié depuis le {r.start_date}</span>
                      <span style={{ fontWeight: 600, borderRadius: 4, padding: "1px 6px",
                        background: win.open ? "rgba(34,197,94,0.10)" : "rgba(156,163,175,0.12)",
                        color: win.open ? GREEN : "var(--text-dim)",
                        border: "1px solid " + (win.open ? "rgba(34,197,94,0.3)" : "var(--border)") }}>
                        {win.open ? `🟢 éligible jusqu'au ${win.expires}` : `⚪ fenêtre fermée le ${win.expires}`}
                      </span>
                    </div>
                  </div>
                  <span style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{isOpen ? "▾" : "détail ▸"}</span>
                </div>

                {isOpen && (
                  <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                    {games.length === 0 && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Aucun game avec deal pour ce filleul.</div>}
                    {games.map(g => <GameBlock key={g.game_id} rel={r} g={g}
                      editing={editing === `${r.id}:${g.game_id}`}
                      onEdit={() => setEditing(editing === `${r.id}:${g.game_id}` ? null : `${r.id}:${g.game_id}`)}
                      historyOpen={historyOpen.has(`${r.id}:${g.game_id}`)}
                      onToggleHistory={() => { const k = `${r.id}:${g.game_id}`; const n = new Set(historyOpen); n.has(k) ? n.delete(k) : n.add(k); setHistoryOpen(n); }}
                      frozenThrough={frozenThrough}
                      onSaved={onRatesChanged} />)}

                    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                      <Row label="Σ commission signée (ce filleul)" value={<Amt n={commission} bold />} />
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                        <button onClick={() => toggle(showPayments, setShowPayments, r.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 0, fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                          {payOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Paiements ({r.payments?.length ?? 0})
                        </button>
                        <span style={{ color: (r.total_paid_lifetime ?? 0) > 0.005 ? RED : GREY, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>−{f2(r.total_paid_lifetime ?? 0)} USDT</span>
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
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 2 }}>
                        <button onClick={() => onEditRel(r)} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "4px 10px", color: "var(--text-muted)", fontSize: 11 }}>
                          <Pencil size={11} /> Edit
                        </button>
                        {r.status !== "terminated" && (
                          <button onClick={() => onTerminateRel(r.id)} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "4px 10px", color: "var(--text-muted)", fontSize: 11 }}>
                            <XCircle size={11} /> Terminer
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* TOTAL AGENT — cross-makeup */}
        <div style={{ borderRadius: 10, border: `1px solid ${commissionSigned < 0 || earned === null ? "rgba(239,68,68,0.3)" : "var(--border)"}`, background: "var(--bg-surface)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>Total agent (makeup croisé)</div>
          <Row label="Σ commissions signées (part agence × taux, par filleul × game × semaine)" value={<Amt n={commissionSigned} bold />} />
          <Row label="Commission (plancher 0)" value={earned === null ? <span style={{ color: RED, fontWeight: 700 }}>bloqué</span> : <Amt n={earned} bold />} />
          <Row label="− Déjà payé" value={<span style={{ color: paid > 0.005 ? RED : GREY, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>−{f2(paid)} USDT</span>} />
          {commissionSigned < 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 7, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: RED, fontSize: 11, fontWeight: 600 }}>
              <AlertTriangle size={13} /> Commission cumulée négative — {f2(-commissionSigned)} USDT de commission à combler avant de toucher quoi que ce soit.
            </div>
          )}
          {frozenThrough && (
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Semaines payées (gelées, aucun taux ne peut y changer) jusqu&apos;à celle du {frozenThrough}.</div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4, paddingTop: 10, borderTop: "1px dashed var(--border)" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Dû maintenant</span>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 22, fontWeight: 800, color: due === null ? RED : due > 0.005 ? GREEN : GREY, fontVariantNumeric: "tabular-nums" }}>{due === null ? "bloqué" : `${due > 0.005 ? `+${f2(due)}` : f2(due)} USDT`}</span>
              {due !== null && earned !== null && due > 0.005 && (
                <button onClick={() => onPayAgent(agent.affiliate_player_id, agent.name, due, earned, paid)}
                  style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 7, cursor: "pointer", padding: "7px 14px", color: GREEN, fontSize: 13, fontWeight: 700 }}>
                  <DollarSign size={14} /> Payer l'agent
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, color, highlight }: { label: string; value: ReactNode; color?: string; highlight?: boolean }) {
  return (
    <div style={{ padding: "12px 14px", background: highlight ? "rgba(34,197,94,0.06)" : "var(--bg-surface)", borderRadius: 8, border: `1px solid ${highlight ? "rgba(34,197,94,0.25)" : "var(--border)"}` }}>
      <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color ?? "var(--text)" }}>{value}</div>
    </div>
  );
}

function Row({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
      <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{label}{sub && <span style={{ fontSize: 10, marginLeft: 5, opacity: 0.7 }}>({sub})</span>}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

function GameBlock({ rel, g, editing, onEdit, historyOpen, onToggleHistory, frozenThrough, onSaved }: {
  rel: EnrichedRel; g: GameBreakdown; editing: boolean; onEdit: () => void;
  historyOpen: boolean; onToggleHistory: () => void; frozenThrough: string | null; onSaved: () => void;
}) {
  const current = g.rate_periods.find(p => p.end_week === null) ?? g.rate_periods[g.rate_periods.length - 1] ?? null;
  const kind = current ? KIND_LABEL[current.kind] ?? KIND_LABEL.manual : null;
  const unrated = g.unrated_weeks.length > 0;
  const counts = g.rate_periods.some(p => p.agent_pct > 0);
  const [confirming, setConfirming] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  // Confirmer un taux par défaut = le reposer à l'identique en « manuel » (aucun montant ne bouge).
  async function confirmDefault() {
    if (!current || current.kind !== "default") return;
    setConfirming(true); setConfirmErr(null);
    try {
      const r = await fetch("/api/affiliate-agent-rates", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relationship_id: rel.id, game_id: g.game_id, agent_pct: current.agent_pct, start_week: current.start_week, note: "taux par défaut confirmé", confirm_retroactive: true }) });
      const j = await r.json();
      if (j.ok) onSaved(); else setConfirmErr(j.error ?? "Erreur");
    } catch (e: any) { setConfirmErr(e.message); } finally { setConfirming(false); }
  }
  return (
    <div style={{ border: `1px solid ${unrated ? "rgba(239,68,68,0.4)" : "var(--border)"}`, borderRadius: 8, padding: "10px 12px", background: "var(--bg-raised)", opacity: counts || unrated || editing ? 1 : 0.6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{g.game_name}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
          {g.agent_pct_current === null
            ? <span style={{ color: RED, fontWeight: 700 }}>⛔ aucun taux agent</span>
            : <span style={{ fontWeight: 700, color: g.agent_pct_current > 0 ? GREEN : "var(--text-dim)" }}>agent {g.agent_pct_current} %</span>}
          {kind && <span style={{ color: kind.color, border: "1px solid var(--border)", borderRadius: 4, padding: "0 5px", fontSize: 10 }}>{kind.label}</span>}
          {current && <span style={{ color: "var(--text-dim)", fontSize: 10 }}>depuis {current.start_week ?? "l'origine"}</span>}
          {current?.kind === "default" && (
            <button disabled={confirming} onClick={confirmDefault} style={{ background: "rgba(234,179,8,0.12)", border: "1px solid rgba(234,179,8,0.4)", borderRadius: 5, cursor: "pointer", padding: "2px 7px", color: "#EAB308", fontSize: 10, fontWeight: 700 }}>
              Confirmer
            </button>
          )}
          <button onClick={onEdit} style={{ display: "flex", alignItems: "center", gap: 3, background: "none", border: "1px solid var(--border)", borderRadius: 5, cursor: "pointer", padding: "2px 7px", color: "var(--text-muted)", fontSize: 10 }}>
            <Pencil size={10} /> taux
          </button>
        </span>
      </div>
      {g.is_composite ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
          <div style={{ color: "var(--text-dim)", fontStyle: "italic" }}>Formule composite (winnings/rake/insurance)</div>
          <Row label="Part agence (natif)" value={<Amt n={g.agency_pnl_native} cur={g.currency} />} />
          {g.cny_rate_missing ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#EAB308", fontSize: 11, fontWeight: 600 }}>
              <AlertTriangle size={12} /> taux {g.currency} manquant → conversion USDT impossible
            </div>
          ) : (
            <Row label="≈ Part agence (USDT)" value={<Amt n={g.agency_pnl_lifetime} bold />} />
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
          <Row label="P&L joueur" value={<Amt n={g.player_pnl_lifetime ?? 0} cur={g.currency} />} />
          <Row label={`× Deal agence perçu (${g.effective_action_pct}%)`} value={<Amt n={g.agency_pnl_lifetime} cur={g.currency} />} sub="part agence" />
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, marginTop: 4 }}>
        <Row label="Commission agent (Σ part × taux de chaque semaine)" value={<Amt n={g.earned_lifetime} bold />} />
      </div>
      {confirmErr && <div style={{ marginTop: 6, color: RED, fontSize: 11 }}>{confirmErr}</div>}
      {unrated && (
        <div style={{ marginTop: 6, color: RED, fontSize: 11, fontWeight: 600 }}>
          ⚠️ Part agence {f2(g.unrated_part)} sans taux agent (semaine{g.unrated_weeks.length > 1 ? "s" : ""} {g.unrated_weeks.join(", ")}) — l&apos;agent est bloqué tant qu&apos;aucun taux ne couvre ces semaines.
        </div>
      )}
      {g.rate_periods.length > 0 && (
        <button onClick={onToggleHistory} style={{ marginTop: 6, background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 0, fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
          {historyOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Historique des taux ({g.rate_periods.length})
        </button>
      )}
      {historyOpen && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3, paddingLeft: 14, marginTop: 4 }}>
          {g.rate_periods.map((p, i) => {
            const k = KIND_LABEL[p.kind] ?? KIND_LABEL.manual;
            return (
              <div key={p.id ?? i} style={{ fontSize: 11, color: "var(--text-dim)" }}>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{periodRange(p)}</span> · <b style={{ color: "var(--text)" }}>{p.agent_pct} %</b> · <span style={{ color: k.color }}>{k.label}</span>
                {p.note && <div style={{ paddingLeft: 10, fontStyle: "italic" }}>{p.note}</div>}
              </div>
            );
          })}
        </div>
      )}
      {editing && (
        <RateEditor relationshipId={rel.id} referredName={rel.referred.name} game={g} frozenThrough={frozenThrough}
          onClose={onEdit} onSaved={onSaved} />
      )}
    </div>
  );
}
