"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, XCircle, DollarSign, Loader2, RefreshCw, ChevronRight, ChevronDown, Users } from "lucide-react";
import Modal from "@/components/Modal";
import AgentDetailDrawer from "./AgentDetailDrawer";
import { windowInfo } from "./eligibility";

const GAME_BADGES: Record<string, { short: string; bg: string; color: string }> = {
  TELE:    { short: "AK", bg: "rgba(212,175,55,0.15)", color: "#D4AF37" },
  KKPOKER: { short: "KK", bg: "rgba(59,130,246,0.15)", color: "#3B82F6" },
  A5POKER: { short: "A5", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
  Wepoker: { short: "WE", bg: "rgba(139,92,246,0.15)", color: "#8B5CF6" },
  Xpoker:  { short: "XP", bg: "rgba(236,72,153,0.15)", color: "#EC4899" },
  ClubGG:  { short: "CG", bg: "rgba(234,179,8,0.15)",  color: "#EAB308" },
};

interface Player { id: number; name: string; telegram_handle: string | null; telegram_id: number | null; }
interface Game { id: number; name: string; perceived_action_pct: number | null; perceived_rakeback_pct: number | null; perceived_insurance_pct: number | null; }
interface Agent {
  affiliate_player_id: number; joined_at: string; profile_status: string;
  name: string; telegram_handle: string | null; telegram_id: number | null;
}

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

interface AgentCommission { cumul_agence_eligible: number; earned: number; paid: number; due_now: number; }
interface AgentSummary {
  agent: Agent;
  filleuls: EnrichedRel[];
  cumulAgence: number;
  earned: number;
  paid: number;
  due: number;
}

interface BackfillResult {
  player_id: number; full_name: string;
  method: "handle" | "group_exclusion" | null;
  status: "backfilled" | "would_backfill" | "skipped";
  new_telegram_id?: number; reason?: string;
}
interface BackfillResponse {
  dry_run: boolean;
  summary: { total_broken: number; would_backfill: number; would_skip: number };
  results: BackfillResult[];
}

interface GameRateRow {
  game_id: number; game_name: string;
  disclosed_action_pct: string; disclosed_rakeback_pct: string; disclosed_insurance_pct: string;
  exclude_agency_extras: boolean;
  overridden: boolean;
  excluded: boolean;
}

interface Props {
  agents: Agent[];
  players: Player[];
  activeGames: Game[];
  existingReferredIds: number[];
  agentCommissions: Record<number, AgentCommission>;
}

const emptyForm = () => ({
  affiliate_player_id: 0, referred_player_id: 0, origin_game_id: 0,
  start_date: new Date().toISOString().slice(0, 10),
  disclosed_action_pct: "", disclosed_rakeback_pct: "", disclosed_insurance_pct: "",
  exclude_agency_extras: true, notes: "", status: "active",
});

function lastMonday(): string {
  const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function lastSunday(): string {
  const d = new Date(lastMonday()); d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
}

const fmt = (n: number) => n.toFixed(2);

export default function AffiliatesClient({ agents, players, activeGames, existingReferredIds, agentCommissions }: Props) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editRel, setEditRel] = useState<EnrichedRel | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [searchAff, setSearchAff] = useState("");
  const [searchRef, setSearchRef] = useState("");

  const [enrichedRels, setEnrichedRels] = useState<EnrichedRel[]>([]);
  const [loading, setLoading] = useState(true);

  // Add agent (promote existing player → affiliate_profile)
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [agentPlayerId, setAgentPlayerId] = useState(0);
  const [searchAgent, setSearchAgent] = useState("");
  const [savingAgent, setSavingAgent] = useState(false);

  const [drawerAgent, setDrawerAgent] = useState<AgentSummary | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const toggleCollapse = (id: number) => setCollapsed(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const [gameRates, setGameRates] = useState<GameRateRow[]>([]);
  const [showExcluded, setShowExcluded] = useState(false);

  // Backfill
  const [backfillCount, setBackfillCount] = useState<number | null>(null);
  const [backfillData, setBackfillData] = useState<BackfillResponse | null>(null);
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillApplied, setBackfillApplied] = useState(false);

  // Pay
  const [payTarget, setPayTarget] = useState<{ agentId: number; agentName: string; due: number; earned: number; paid: number } | null>(null);
  const [payForm, setPayForm] = useState({ amount: "", tx_hash: "", notes: "", week_start: lastMonday(), week_end: lastSunday() });

  const loadEnriched = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/affiliate-relationships");
      if (res.ok) setEnrichedRels(await res.json());
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadEnriched(); }, [loadEnriched]);

  // Build agent summaries
  const agentSummaries: AgentSummary[] = agents.map(agent => {
    const filleuls = enrichedRels.filter(r => r.affiliate.id === agent.affiliate_player_id);
    const ac = agentCommissions[agent.affiliate_player_id] ?? { cumul_agence_eligible: 0, earned: 0, paid: 0, due_now: 0 };
    return { agent, filleuls, cumulAgence: ac.cumul_agence_eligible, earned: ac.earned, paid: ac.paid, due: ac.due_now };
  });

  const brokenTgCount = agents.filter(a => !a.telegram_id).length;

  // Backfill: fetch initial count
  useEffect(() => {
    fetch("/api/admin/backfill-telegram-ids", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "db-diag-20260518" }),
    }).then(r => r.ok ? r.json() : null).then((data: BackfillResponse | null) => {
      if (data) setBackfillCount(data.summary.total_broken);
    }).catch(() => { setBackfillCount(brokenTgCount > 0 ? brokenTgCount : 0); });
  }, [backfillApplied, brokenTgCount]);

  async function openBackfillModal() {
    setBackfillOpen(true);
    setBackfillLoading(true);
    setBackfillData(null);
    setBackfillApplied(false);
    try {
      const res = await fetch("/api/admin/backfill-telegram-ids", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "db-diag-20260518" }),
      });
      if (res.ok) setBackfillData(await res.json());
    } finally { setBackfillLoading(false); }
  }

  async function applyBackfill() {
    setBackfillLoading(true);
    try {
      const res = await fetch("/api/admin/backfill-telegram-ids?apply=1", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "db-diag-20260518" }),
      });
      if (res.ok) {
        setBackfillData(await res.json());
        setBackfillApplied(true);
        setBackfillCount(0);
      }
    } finally { setBackfillLoading(false); }
  }

  // Create / Edit / Pay handlers
  function openCreate() {
    setForm(emptyForm()); setSearchAff(""); setSearchRef("");
    setCreateOpen(true);
  }

  function openAddAgent() {
    setAgentPlayerId(0); setSearchAgent(""); setAddAgentOpen(true);
  }

  async function handleCreateAgent() {
    if (!agentPlayerId) return;
    setSavingAgent(true);
    try {
      const res = await fetch("/api/affiliate-profiles", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_id: agentPlayerId }),
      });
      if (!res.ok) { const d = await res.json(); alert(d.error ?? "Erreur"); return; }
      setAddAgentOpen(false); router.refresh();
    } catch (e: any) { alert(e.message); } finally { setSavingAgent(false); }
  }

  function openEdit(r: EnrichedRel) {
    setEditRel(r);
    setForm({
      affiliate_player_id: r.affiliate.id, referred_player_id: r.referred.id,
      origin_game_id: r.origin_game?.id ?? 0, start_date: r.start_date, status: r.status,
      disclosed_action_pct: "", disclosed_rakeback_pct: "", disclosed_insurance_pct: "",
      exclude_agency_extras: true, notes: r.notes ?? "",
    });
    const inherited: GameRateRow[] = activeGames.map(g => ({
      game_id: g.id, game_name: g.name, overridden: false, excluded: false,
      disclosed_action_pct: g.perceived_action_pct != null ? String(g.perceived_action_pct) : "",
      disclosed_rakeback_pct: g.perceived_rakeback_pct != null ? String(g.perceived_rakeback_pct) : "",
      disclosed_insurance_pct: g.perceived_insurance_pct != null ? String(g.perceived_insurance_pct) : "",
      exclude_agency_extras: true,
    }));
    setGameRates(inherited);
    fetch(`/api/affiliate-relationships/${r.id}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!data?.game_rates) return;
        const overrides = new Map(data.game_rates.map((gr: any) => [gr.game_id, gr]));
        setGameRates(inherited.map(row => {
          const ov = overrides.get(row.game_id) as any;
          if (!ov) return row;
          if (ov.excluded) return { ...row, excluded: true, overridden: false };
          return {
            ...row, overridden: true,
            disclosed_action_pct: ov.disclosed_action_pct != null ? String(ov.disclosed_action_pct) : "",
            disclosed_rakeback_pct: ov.disclosed_rakeback_pct != null ? String(ov.disclosed_rakeback_pct) : "",
            disclosed_insurance_pct: ov.disclosed_insurance_pct != null ? String(ov.disclosed_insurance_pct) : "",
            exclude_agency_extras: !!ov.exclude_agency_extras,
          };
        }));
      }).catch(() => {});
  }

  async function handleCreate() {
    if (!form.affiliate_player_id || !form.referred_player_id || !form.origin_game_id) return;
    setSaving(true);
    try {
      const res = await fetch("/api/affiliate-relationships", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          affiliate_player_id: form.affiliate_player_id,
          referred_player_id: form.referred_player_id,
          origin_game_id: form.origin_game_id,
          start_date: form.start_date,
          notes: form.notes || null,
        }),
      });
      if (!res.ok) { const d = await res.json(); alert(d.error ?? "Erreur"); return; }
      setCreateOpen(false); loadEnriched(); router.refresh();
    } catch (e: any) { alert(e.message); } finally { setSaving(false); }
  }

  async function handleEdit() {
    if (!editRel) return;
    setSaving(true);
    try {
      await fetch(`/api/affiliate-relationships/${editRel.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin_game_id: form.origin_game_id, start_date: form.start_date, status: form.status,
          notes: form.notes || null,
          game_rates: gameRates.filter(gr => gr.overridden || gr.excluded).map(gr => ({
            game_id: gr.game_id,
            disclosed_action_pct: gr.excluded ? null : (gr.disclosed_action_pct ? Number(gr.disclosed_action_pct) : null),
            disclosed_rakeback_pct: gr.excluded ? null : (gr.disclosed_rakeback_pct ? Number(gr.disclosed_rakeback_pct) : null),
            disclosed_insurance_pct: gr.excluded ? null : (gr.disclosed_insurance_pct ? Number(gr.disclosed_insurance_pct) : null),
            exclude_agency_extras: gr.exclude_agency_extras ? 1 : 0,
            excluded: gr.excluded ? 1 : 0,
          })),
        }),
      });
      setEditRel(null); loadEnriched(); router.refresh();
    } catch (e: any) { alert(e.message); } finally { setSaving(false); }
  }

  async function terminate(id: number) {
    if (!confirm("Terminer cette relation affiliate ?")) return;
    await fetch(`/api/affiliate-relationships/${id}`, { method: "DELETE" });
    loadEnriched(); router.refresh();
  }

  function openPayAgent(agentId: number, agentName: string, due: number, earned: number, paid: number) {
    setPayTarget({ agentId, agentName, due, earned, paid });
    setPayForm({ amount: due.toFixed(2), tx_hash: "", notes: "", week_start: lastMonday(), week_end: lastSunday() });
  }

  async function handlePay() {
    if (!payTarget) return;
    setSaving(true);
    try {
      const res = await fetch("/api/affiliate-payments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          affiliate_player_id: payTarget.agentId,
          amount_usdt: Number(payForm.amount),
          week_start_date: payForm.week_start, week_end_date: payForm.week_end,
          tx_hash: payForm.tx_hash || null, notes: payForm.notes || null,
        }),
      });
      if (!res.ok) { const d = await res.json(); alert(d.error ?? "Erreur"); return; }
      setPayTarget(null); setDrawerAgent(null); loadEnriched(); router.refresh();
    } catch (e: any) { alert(e.message); } finally { setSaving(false); }
  }

  const playerName = (id: number) => players.find(p => p.id === id)?.name ?? `#${id}`;

  const agentIds = new Set(agents.map(a => a.affiliate_player_id));
  const agentCandidates = players.filter(p => !agentIds.has(p.id) && (!searchAgent || p.name.toLowerCase().includes(searchAgent.toLowerCase()) || (p.telegram_handle ?? "").toLowerCase().includes(searchAgent.toLowerCase())));
  const selectedAgentPlayer = players.find(p => p.id === agentPlayerId) ?? null;

  const filteredAff = players.filter(p => p.id !== form.referred_player_id && (!searchAff || p.name.toLowerCase().includes(searchAff.toLowerCase()) || (p.telegram_handle ?? "").toLowerCase().includes(searchAff.toLowerCase())));
  const usedReferredIds = new Set(existingReferredIds);
  const filteredRef = players.filter(p => p.id !== form.affiliate_player_id && !usedReferredIds.has(p.id) && (!searchRef || p.name.toLowerCase().includes(searchRef.toLowerCase()) || (p.telegram_handle ?? "").toLowerCase().includes(searchRef.toLowerCase())));

  function renderPlayerPicker(label: string, selected: number, onSelect: (id: number) => void, search: string, setSearch: (s: string) => void, candidates: Player[], readOnly?: boolean) {
    if (readOnly) {
      return (
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>{label}</label>
          <div style={{ padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text-dim)", border: "1px solid var(--border)" }}>{playerName(selected)}</div>
        </div>
      );
    }
    return (
      <div>
        <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>{label}</label>
        {selected ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ padding: "6px 12px", borderRadius: 7, background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E", fontSize: 13, fontWeight: 600 }}>{playerName(selected)}</span>
            <button onClick={() => { onSelect(0); setSearch(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 11 }}>changer</button>
          </div>
        ) : (
          <>
            <input placeholder="Chercher joueur..." value={search} onChange={e => setSearch(e.target.value)}
              style={{ width: "100%", padding: "8px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box", marginBottom: 4 }} />
            <div style={{ maxHeight: 140, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
              {candidates.slice(0, 15).map(p => (
                <button key={p.id} onClick={() => { onSelect(p.id); setSearch(""); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px", fontSize: 12, cursor: "pointer", border: "none", borderBottom: "1px solid var(--border)", background: "transparent", color: "var(--text)" }}>
                  {p.name}{p.telegram_handle && <span style={{ color: "var(--text-dim)", marginLeft: 6 }}>@{p.telegram_handle}</span>}
                </button>
              ))}
              {candidates.length === 0 && <div style={{ padding: 8, fontSize: 11, color: "var(--text-dim)", textAlign: "center" }}>Aucun joueur disponible</div>}
            </div>
          </>
        )}
      </div>
    );
  }

  function renderFormFields(isEdit: boolean) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {renderPlayerPicker("Affiliate", form.affiliate_player_id, id => setForm({ ...form, affiliate_player_id: id }), searchAff, setSearchAff, filteredAff, isEdit)}
        {renderPlayerPicker("Referred", form.referred_player_id, id => setForm({ ...form, referred_player_id: id }), searchRef, setSearchRef, filteredRef, isEdit)}
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>Origin Game</label>
            <select value={form.origin_game_id} onChange={e => setForm({ ...form, origin_game_id: Number(e.target.value) })}
              style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none" }}>
              <option value={0}>Choisir...</option>
              {activeGames.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>Start Date</label>
            <input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })}
              style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" }} />
          </div>
        </div>
        {isEdit && (
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>Status</label>
            <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}
              style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none" }}>
              <option value="active">Active</option><option value="paused">Paused</option><option value="terminated">Terminated</option>
            </select>
          </div>
        )}
        {isEdit && (() => {
          const activeRows = gameRates.filter(gr => !gr.excluded);
          const excludedRows = gameRates.filter(gr => gr.excluded);
          return (
          <div style={{ padding: "10px 12px", background: "var(--bg-surface)", borderRadius: 8, border: "1px solid var(--border)" }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 8 }}>Games & Rates</label>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 9, textTransform: "uppercase" }}>
                  <th style={{ textAlign: "left", padding: "4px 4px" }}>Game</th>
                  <th style={{ textAlign: "center", padding: "4px 2px" }}>Action %</th>
                  <th style={{ textAlign: "center", padding: "4px 2px" }}>RB %</th>
                  <th style={{ textAlign: "center", padding: "4px 2px" }}>Ins %</th>
                  <th style={{ textAlign: "center", padding: "4px 2px", width: 90 }}></th>
                </tr>
              </thead>
              <tbody>
                {activeRows.map(gr => {
                  const i = gameRates.findIndex(r => r.game_id === gr.game_id);
                  const inherited = !gr.overridden;
                  const rowBg = gr.overridden ? "rgba(245,158,11,0.04)" : "transparent";
                  return (
                    <tr key={gr.game_id} style={{ borderBottom: "1px solid var(--border)", background: rowBg }}>
                      <td style={{ padding: "6px 4px", fontWeight: 600, fontSize: 11 }}>{gr.game_name}</td>
                      {(["disclosed_action_pct", "disclosed_rakeback_pct", "disclosed_insurance_pct"] as const).map(k => (
                        <td key={k} style={{ padding: "4px 2px", textAlign: "center" }}>
                          {inherited ? (
                            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{(gr as any)[k] || "—"}</span>
                          ) : (
                            <input type="number" step="0.01" min={0} max={100} value={(gr as any)[k]}
                              onChange={e => { const u = [...gameRates]; u[i] = { ...gr, [k]: e.target.value }; setGameRates(u); }}
                              placeholder="—" style={{ width: 52, padding: "3px 4px", borderRadius: 4, fontSize: 11, background: "var(--bg-raised)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", textAlign: "center", boxSizing: "border-box" as const }} />
                          )}
                        </td>
                      ))}
                      <td style={{ padding: "4px 2px", textAlign: "center", display: "flex", gap: 3, justifyContent: "center" }}>
                        {inherited ? (
                          <button onClick={() => { const u = [...gameRates]; u[i] = { ...gr, overridden: true }; setGameRates(u); }}
                            style={{ padding: "2px 8px", borderRadius: 4, fontSize: 9, fontWeight: 600, cursor: "pointer", background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.3)", color: "#F59E0B" }}>
                            Override
                          </button>
                        ) : (
                          <button onClick={() => {
                            const g = activeGames.find(ag => ag.id === gr.game_id);
                            const u = [...gameRates]; u[i] = {
                              ...gr, overridden: false,
                              disclosed_action_pct: g?.perceived_action_pct != null ? String(g.perceived_action_pct) : "",
                              disclosed_rakeback_pct: g?.perceived_rakeback_pct != null ? String(g.perceived_rakeback_pct) : "",
                              disclosed_insurance_pct: g?.perceived_insurance_pct != null ? String(g.perceived_insurance_pct) : "",
                            }; setGameRates(u);
                          }}
                            style={{ padding: "2px 8px", borderRadius: 4, fontSize: 9, fontWeight: 600, cursor: "pointer", background: "rgba(156,163,175,0.10)", border: "1px solid rgba(156,163,175,0.3)", color: "#9CA3AF" }}>
                            Reset
                          </button>
                        )}
                        <button onClick={() => { if (!confirm(`Exclure ${gr.game_name} pour ce filleul ?`)) return; const u = [...gameRates]; u[i] = { ...gr, excluded: true, overridden: false }; setGameRates(u); }}
                          title="Exclure" style={{ padding: "2px 5px", borderRadius: 4, fontSize: 9, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-dim)", display: "flex", alignItems: "center" }}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {excludedRows.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <button onClick={() => setShowExcluded(!showExcluded)}
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: "var(--text-dim)", padding: "4px 0" }}>
                  {showExcluded ? "▾" : "▸"} Games exclus ({excludedRows.length})
                </button>
                {showExcluded && excludedRows.map(gr => {
                  const i = gameRates.findIndex(r => r.game_id === gr.game_id);
                  return (
                    <div key={gr.game_id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 6px", fontSize: 11, color: "var(--text-dim)", opacity: 0.6 }}>
                      <span>{gr.game_name}</span>
                      <button onClick={() => { const u = [...gameRates]; const g = activeGames.find(ag => ag.id === gr.game_id); u[i] = {
                        ...gr, excluded: false, overridden: false,
                        disclosed_action_pct: g?.perceived_action_pct != null ? String(g.perceived_action_pct) : "",
                        disclosed_rakeback_pct: g?.perceived_rakeback_pct != null ? String(g.perceived_rakeback_pct) : "",
                        disclosed_insurance_pct: g?.perceived_insurance_pct != null ? String(g.perceived_insurance_pct) : "",
                      }; setGameRates(u); }}
                        style={{ padding: "2px 8px", borderRadius: 4, fontSize: 9, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}>
                        Restore
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>
              Rates herites de Games & Deals config. Override pour personnaliser, ✕ pour exclure.
            </div>
          </div>
          );
        })()}
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>Notes</label>
          <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2}
            style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", resize: "vertical", boxSizing: "border-box" }} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "0 28px" }}>
      {/* Header actions */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginBottom: 16 }}>
        {(backfillCount ?? brokenTgCount) > 0 && (
          <button onClick={openBackfillModal} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", color: "#F59E0B" }}>
            <RefreshCw size={14} /> Backfill telegram_id ({backfillCount ?? brokenTgCount} agent{(backfillCount ?? brokenTgCount) > 1 ? "s" : ""})
          </button>
        )}
        <button onClick={openAddAgent} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.3)", color: "#3B82F6" }}>
          <Plus size={14} /> Ajouter agent
        </button>
        <button onClick={openCreate} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}>
          <Plus size={14} /> Ajouter filleul
        </button>
      </div>

      {/* Branches view — agent (parent) → filleuls listed underneath. Survol rapide;
          le drawer auditable reste accessible au clic. Pur rendu, aucun calcul touché. */}
      {loading && <div style={{ textAlign: "center", padding: 12, color: "var(--text-dim)", fontSize: 12 }}>Chargement...</div>}
      {agentSummaries.length === 0 && (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 10 }}>Aucun agent actif</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {agentSummaries.map((summary) => {
          const { agent, filleuls, cumulAgence, earned, paid, due } = summary;
          const activeFilleuls = filleuls.filter(r => r.status === "active");
          const isCollapsed = collapsed.has(agent.affiliate_player_id);
          return (
            <div key={agent.affiliate_player_id} style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-raised)", overflow: "hidden" }}>
              {/* Agent header (parent) */}
              <div
                onClick={() => setDrawerAgent(summary)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", cursor: "pointer", transition: "background 0.1s" }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.02)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                <button
                  onClick={(e) => { e.stopPropagation(); toggleCollapse(agent.affiliate_player_id); }}
                  title={isCollapsed ? "Déplier" : "Replier"}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", display: "flex", padding: 0 }}>
                  {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 700, color: "var(--text)", fontSize: 14 }}>{agent.name}</span>
                    {agent.telegram_handle && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>@{agent.telegram_handle}</span>}
                    {agent.telegram_id
                      ? <span style={{ color: "#22C55E", fontSize: 10, fontWeight: 600, border: "1px solid rgba(34,197,94,0.3)", borderRadius: 4, padding: "1px 5px" }}>TG OK</span>
                      : <span style={{ color: "#EF4444", fontSize: 10, fontWeight: 600, border: "1px solid rgba(239,68,68,0.3)", borderRadius: 4, padding: "1px 5px" }}>TG à fix</span>}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <Users size={12} /> {activeFilleuls.length} filleul{activeFilleuls.length > 1 ? "s" : ""}
                      {filleuls.length > activeFilleuls.length && <span style={{ color: "var(--text-dim)" }}> ({filleuls.length} total)</span>}
                    </span>
                    {agent.joined_at && <span>· depuis {agent.joined_at.slice(0, 10)}</span>}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Commission</div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: earned > 0 ? "var(--text)" : cumulAgence < 0 ? "#EF4444" : "var(--text-dim)" }}>
                    {earned > 0 ? `${fmt(earned)} USDT` : cumulAgence < 0 ? `cumul ${fmt(cumulAgence)}` : "—"}
                  </div>
                </div>
                <div style={{ textAlign: "right", minWidth: 86 }}>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Dû now</div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: due > 0 ? "#22C55E" : "var(--text-dim)" }}>{due > 0 ? `${fmt(due)}` : "—"}</div>
                </div>
                {due > 0 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); openPayAgent(agent.affiliate_player_id, agent.name, due, earned, paid); }}
                    style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 10px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}>
                    <DollarSign size={12} /> Payer
                  </button>
                )}
                <ChevronRight size={14} style={{ color: "var(--text-dim)" }} />
              </div>

              {/* Filleuls (children) */}
              {!isCollapsed && (
                <div style={{ borderTop: "1px solid var(--border)", paddingLeft: 14 }}>
                  {filleuls.length === 0 && (
                    <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>Aucun filleul</div>
                  )}
                  {filleuls.map((r) => {
                    const win = windowInfo(r.start_date);
                    const games = r.games.filter(g => g.agency_pnl_lifetime !== 0 || g.rate_label === "éligible");
                    const isTerminated = r.status === "terminated";
                    return (
                      <div
                        key={r.id}
                        onClick={() => setDrawerAgent(summary)}
                        title="Voir le détail auditable"
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px 9px 8px", borderTop: "1px solid var(--border)", borderLeft: "2px solid var(--border)", cursor: "pointer", opacity: isTerminated ? 0.5 : 1, transition: "background 0.1s" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.02)")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{r.referred.name}</span>
                            {r.referred.telegram_handle && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>@{r.referred.telegram_handle}</span>}
                            {games.map(g => {
                              const b = GAME_BADGES[g.game_name] ?? { short: g.game_name.slice(0, 2).toUpperCase(), bg: "rgba(148,163,184,0.15)", color: "#94A3B8" };
                              return <span key={g.game_id} style={{ fontSize: 9, fontWeight: 700, background: b.bg, color: b.color, borderRadius: 4, padding: "1px 5px" }}>{b.short}</span>;
                            })}
                            {isTerminated && <span style={{ fontSize: 9, color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px" }}>terminé</span>}
                          </div>
                        </div>
                        {/* Éligibilité (fenêtre 30j) */}
                        <span style={{ fontSize: 10, fontWeight: 600, borderRadius: 4, padding: "2px 7px", whiteSpace: "nowrap",
                          background: win.open ? "rgba(34,197,94,0.10)" : "rgba(148,163,184,0.10)",
                          color: win.open ? "#22C55E" : "var(--text-dim)",
                          border: "1px solid " + (win.open ? "rgba(34,197,94,0.3)" : "var(--border)") }}>
                          {win.open ? `éligible · jusqu'au ${win.expires}` : `hors fenêtre · depuis ${win.expires}`}
                        </span>
                        <div style={{ textAlign: "right", minWidth: 70 }}>
                          <div style={{ fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase" }}>Dû</div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: r.total_due_now > 0 ? "#22C55E" : "var(--text-dim)" }}>{r.total_due_now > 0 ? fmt(r.total_due_now) : "—"}</div>
                        </div>
                        <ChevronRight size={13} style={{ color: "var(--text-dim)" }} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Agent detail drawer */}
      {drawerAgent && (
        <AgentDetailDrawer
          agentSummary={drawerAgent}
          onClose={() => setDrawerAgent(null)}
          onEditRel={(r) => { openEdit(r); setDrawerAgent(null); }}
          onTerminateRel={(id) => { terminate(id); }}
          onPayAgent={(agentId, agentName, due, earned, paid) => openPayAgent(agentId, agentName, due, earned, paid)}
          gameBadges={GAME_BADGES}
        />
      )}

      {/* Add agent modal */}
      <Modal open={addAgentOpen} onClose={() => setAddAgentOpen(false)} title="Ajouter un agent" width={480}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {renderPlayerPicker("Player à promouvoir agent", agentPlayerId, id => setAgentPlayerId(id), searchAgent, setSearchAgent, agentCandidates)}
          {selectedAgentPlayer && !selectedAgentPlayer.telegram_id && (
            <div style={{ padding: "9px 12px", borderRadius: 7, fontSize: 12, background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.3)", color: "#F59E0B" }}>
              ⚠️ Ce joueur n'a pas de <code>telegram_id</code> — il ne pourra pas ouvrir sa Mini App tant qu'il n'a pas DM le bot ou été backfillé (bouton Backfill). La création reste possible.
            </div>
          )}
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            Commission fixe 50% des profits agency (filleuls onboardés ≤30j). Identique à <code>/startaffi</code>.
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
          <button onClick={() => setAddAgentOpen(false)} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Annuler</button>
          <button onClick={handleCreateAgent} disabled={savingAgent || !agentPlayerId} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: savingAgent ? "wait" : "pointer", background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.3)", color: "#3B82F6", opacity: savingAgent || !agentPlayerId ? 0.5 : 1 }}>
            {savingAgent ? "..." : "Créer agent"}
          </button>
        </div>
      </Modal>

      {/* Create modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Ajouter un filleul" width={520}>
        {renderFormFields(false)}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
          <button onClick={() => setCreateOpen(false)} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Annuler</button>
          <button onClick={handleCreate} disabled={saving || !form.affiliate_player_id || !form.referred_player_id || !form.origin_game_id} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E", opacity: saving || !form.affiliate_player_id || !form.referred_player_id || !form.origin_game_id ? 0.5 : 1 }}>
            {saving ? "..." : "Creer"}
          </button>
        </div>
      </Modal>

      {/* Edit modal */}
      <Modal open={!!editRel} onClose={() => setEditRel(null)} title={`Edit — ${editRel?.affiliate.name ?? ""} → ${editRel?.referred.name ?? ""}`} width={520}>
        {renderFormFields(true)}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
          <button onClick={() => setEditRel(null)} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Annuler</button>
          <button onClick={handleEdit} disabled={saving} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E", opacity: saving ? 0.5 : 1 }}>
            {saving ? "..." : "Sauvegarder"}
          </button>
        </div>
      </Modal>

      {/* Pay modal */}
      <Modal open={!!payTarget} onClose={() => setPayTarget(null)} title={`Payer l'agent — ${payTarget?.agentName ?? ""}`} width={440}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {payTarget && (
            <div style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.2)", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
              Payer <strong style={{ color: "#22C55E" }}>{payTarget.due.toFixed(2)} USDT</strong> à <strong style={{ color: "var(--text)" }}>{payTarget.agentName}</strong> ?<br />
              <span style={{ fontSize: 12 }}>Commission agent (Earned) {payTarget.earned.toFixed(2)} − Déjà payé {payTarget.paid.toFixed(2)} = <strong style={{ color: "#22C55E" }}>{payTarget.due.toFixed(2)}</strong></span>
            </div>
          )}
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>Montant USDT</label>
            <input type="number" step="0.01" min={0} value={payForm.amount} onChange={e => setPayForm({ ...payForm, amount: e.target.value })}
              style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 14, fontWeight: 600, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" }} />
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>Week start</label>
              <input type="date" value={payForm.week_start} onChange={e => setPayForm({ ...payForm, week_start: e.target.value })}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>Week end</label>
              <input type="date" value={payForm.week_end} onChange={e => setPayForm({ ...payForm, week_end: e.target.value })}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" }} />
            </div>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>TX Hash (optionnel)</label>
            <input type="text" value={payForm.tx_hash} onChange={e => setPayForm({ ...payForm, tx_hash: e.target.value })} placeholder="tron tx hash..."
              style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" }} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>Notes</label>
            <textarea value={payForm.notes} onChange={e => setPayForm({ ...payForm, notes: e.target.value })} rows={2}
              style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", resize: "vertical", boxSizing: "border-box" }} />
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
          <button onClick={() => setPayTarget(null)} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Annuler</button>
          <button onClick={handlePay} disabled={saving || !Number(payForm.amount)} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E", opacity: saving || !Number(payForm.amount) ? 0.5 : 1 }}>
            {saving ? "..." : "Confirmer paiement"}
          </button>
        </div>
      </Modal>

      {/* Backfill modal */}
      <Modal open={backfillOpen} onClose={() => setBackfillOpen(false)} title="Backfill telegram_id" width={600}>
        {backfillLoading && !backfillData && (
          <div style={{ padding: 30, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
            <Loader2 size={18} style={{ animation: "spin 1s linear infinite", marginBottom: 8 }} /><br />
            Resolution via userbot en cours...
          </div>
        )}
        {backfillData && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
              <span style={{ color: "var(--text-muted)" }}>Total: <strong style={{ color: "var(--text)" }}>{backfillData.summary.total_broken}</strong></span>
              <span style={{ color: "#22C55E" }}>Resolvable: <strong>{backfillData.summary.would_backfill}</strong></span>
              <span style={{ color: "var(--text-dim)" }}>Skipped: <strong>{backfillData.summary.would_skip}</strong></span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", fontSize: 10, textTransform: "uppercase", color: "var(--text-muted)", letterSpacing: "0.05em" }}>
                  <th style={{ textAlign: "left", padding: "6px 8px" }}>Player</th>
                  <th style={{ textAlign: "center", padding: "6px 8px" }}>Method</th>
                  <th style={{ textAlign: "center", padding: "6px 8px" }}>Status</th>
                  <th style={{ textAlign: "left", padding: "6px 8px" }}>telegram_id / reason</th>
                </tr>
              </thead>
              <tbody>
                {backfillData.results.map(r => (
                  <tr key={r.player_id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "8px", fontWeight: 600 }}>{r.full_name}</td>
                    <td style={{ padding: "8px", textAlign: "center" }}>
                      {r.method && (
                        <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: r.method === "handle" ? "rgba(59,130,246,0.12)" : "rgba(139,92,246,0.12)", color: r.method === "handle" ? "#3B82F6" : "#8B5CF6" }}>
                          {r.method === "handle" ? "@handle" : "group"}
                        </span>
                      )}
                      {!r.method && <span style={{ color: "var(--text-dim)" }}>-</span>}
                    </td>
                    <td style={{ padding: "8px", textAlign: "center" }}>
                      <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: r.status === "backfilled" ? "rgba(34,197,94,0.12)" : r.status === "would_backfill" ? "rgba(245,158,11,0.12)" : "rgba(156,163,175,0.12)", color: r.status === "backfilled" ? "#22C55E" : r.status === "would_backfill" ? "#F59E0B" : "#9CA3AF" }}>
                        {r.status === "backfilled" ? "done" : r.status === "would_backfill" ? "ready" : "skip"}
                      </span>
                    </td>
                    <td style={{ padding: "8px", fontSize: 11, color: r.new_telegram_id ? "#22C55E" : "var(--text-dim)" }}>
                      {r.new_telegram_id ? r.new_telegram_id : r.reason ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 6 }}>
              <button onClick={() => setBackfillOpen(false)} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Fermer</button>
              {backfillData.dry_run && backfillData.summary.would_backfill > 0 && (
                <button onClick={applyBackfill} disabled={backfillLoading} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: backfillLoading ? "wait" : "pointer", background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E", opacity: backfillLoading ? 0.5 : 1 }}>
                  {backfillLoading ? "..." : `Appliquer (${backfillData.summary.would_backfill})`}
                </button>
              )}
              {!backfillData.dry_run && (
                <span style={{ fontSize: 12, color: "#22C55E", fontWeight: 600, alignSelf: "center" }}>
                  {backfillData.summary.would_backfill} backfilled
                </span>
              )}
            </div>
          </div>
        )}
      </Modal>

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
