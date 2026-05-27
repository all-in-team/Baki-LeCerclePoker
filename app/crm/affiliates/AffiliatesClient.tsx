"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, XCircle, DollarSign, Loader2, AlertTriangle } from "lucide-react";
import Modal from "@/components/Modal";
import AffiliateDetailDrawer from "./AffiliateDetailDrawer";

const GAME_BADGES: Record<string, { short: string; bg: string; color: string }> = {
  TELE:    { short: "AK", bg: "rgba(212,175,55,0.15)", color: "#D4AF37" },
  KKPOKER: { short: "KK", bg: "rgba(59,130,246,0.15)", color: "#3B82F6" },
  A5POKER: { short: "A5", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
  Wepoker: { short: "WE", bg: "rgba(139,92,246,0.15)", color: "#8B5CF6" },
  Xpoker:  { short: "XP", bg: "rgba(236,72,153,0.15)", color: "#EC4899" },
  ClubGG:  { short: "CG", bg: "rgba(234,179,8,0.15)",  color: "#EAB308" },
};

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  active: { bg: "rgba(16,185,129,0.15)", color: "#10B981" },
  paused: { bg: "rgba(234,179,8,0.15)", color: "#EAB308" },
  terminated: { bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" },
};

interface Player { id: number; name: string; telegram_handle: string | null; }
interface Game { id: number; name: string; }
interface Rel {
  id: number; affiliate_player_id: number; referred_player_id: number; origin_game_id: number;
  affiliate_name: string; affiliate_handle: string | null;
  referred_name: string; referred_handle: string | null;
  origin_game_name: string; start_date: string; status: string;
  disclosed_action_pct: number | null; disclosed_rakeback_pct: number | null; disclosed_insurance_pct: number | null;
  exclude_agency_extras: number; notes: string | null; created_at: string;
}

interface Props {
  relationships: Rel[];
  players: Player[];
  activeGames: Game[];
  existingReferredIds: number[];
}

const emptyForm = () => ({
  affiliate_player_id: 0, referred_player_id: 0, origin_game_id: 0,
  start_date: new Date().toISOString().slice(0, 10),
  disclosed_action_pct: "", disclosed_rakeback_pct: "", disclosed_insurance_pct: "",
  exclude_agency_extras: true, notes: "", status: "active",
});

// ── Payouts types ────────────────────────────────────────
interface GameBreakdown {
  game_id: number; game_name: string; rate: number; rate_label: string;
  agency_pnl_lifetime: number; earned_lifetime: number; paid_lifetime: number; due_now: number;
}
interface CommissionResult {
  relationship_id: number;
  affiliate: { id: number; name: string; telegram_handle: string | null };
  referred: { id: number; name: string; telegram_handle: string | null };
  breakdown: GameBreakdown[];
  total_due_now: number; total_earned_lifetime: number; total_paid_lifetime: number;
}
interface AffiliateGroup {
  affiliate: { id: number; name: string; telegram_handle: string | null };
  total_due: number;
  relationships: CommissionResult[];
}

type Tab = "relations" | "payouts";

function lastMonday(): string {
  const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function lastSunday(): string {
  const d = new Date(lastMonday()); d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
}

interface EnrichedRel extends Rel {
  games?: { game_id: number; game_name: string; rate_label: string; agency_pnl_disclosed: number; due_now: number }[];
  total_due_now?: number; total_paid_lifetime?: number; last_paid_at?: string | null;
  breakdown?: GameBreakdown[];
}

interface HealthData {
  pending_leads_no_relationship: number;
  relationships_no_origin: number;
  relationships_no_referred_player: number;
  orphan_payments: number;
}

export default function AffiliatesClient({ relationships, players, activeGames, existingReferredIds }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("relations");
  const [createOpen, setCreateOpen] = useState(false);
  const [editRel, setEditRel] = useState<Rel | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [searchAff, setSearchAff] = useState("");
  const [searchRef, setSearchRef] = useState("");

  // Enriched relations from API
  const [enrichedRels, setEnrichedRels] = useState<EnrichedRel[]>([]);
  const [enrichedLoading, setEnrichedLoading] = useState(false);

  // Health
  const [health, setHealth] = useState<HealthData | null>(null);

  // Drawer
  const [drawerRel, setDrawerRel] = useState<EnrichedRel | null>(null);

  const loadEnriched = useCallback(async () => {
    setEnrichedLoading(true);
    try {
      const [relsRes, healthRes] = await Promise.all([
        fetch("/api/affiliate-relationships"),
        fetch("/api/affiliate-health"),
      ]);
      if (relsRes.ok) setEnrichedRels(await relsRes.json());
      if (healthRes.ok) setHealth(await healthRes.json());
    } finally { setEnrichedLoading(false); }
  }, []);

  useEffect(() => { if (tab === "relations") loadEnriched(); }, [tab, loadEnriched]);

  // Payouts state
  const [payouts, setPayouts] = useState<AffiliateGroup[]>([]);
  const [payoutsLoading, setPayoutsLoading] = useState(false);
  const [payTarget, setPayTarget] = useState<{ relId: number; gameId: number; gameName: string; due: number; affName: string; refName: string } | null>(null);
  const [payForm, setPayForm] = useState({ amount: "", tx_hash: "", notes: "", week_start: lastMonday(), week_end: lastSunday() });

  const loadPayouts = useCallback(async () => {
    setPayoutsLoading(true);
    try {
      const res = await fetch("/api/affiliate-payouts");
      if (res.ok) setPayouts(await res.json());
    } finally { setPayoutsLoading(false); }
  }, []);

  useEffect(() => { if (tab === "payouts") loadPayouts(); }, [tab, loadPayouts]);

  function openPay(relId: number, gameId: number, gameName: string, due: number, affName: string, refName: string) {
    setPayTarget({ relId, gameId, gameName, due, affName, refName });
    setPayForm({ amount: due.toFixed(2), tx_hash: "", notes: "", week_start: lastMonday(), week_end: lastSunday() });
  }

  async function handlePay() {
    if (!payTarget) return;
    setSaving(true);
    try {
      const res = await fetch("/api/affiliate-payments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          relationship_id: payTarget.relId, game_id: payTarget.gameId,
          amount_usdt: Number(payForm.amount),
          week_start_date: payForm.week_start, week_end_date: payForm.week_end,
          tx_hash: payForm.tx_hash || null, notes: payForm.notes || null,
        }),
      });
      if (!res.ok) { const d = await res.json(); alert(d.error ?? "Erreur"); return; }
      setPayTarget(null);
      loadPayouts();
      loadEnriched();
    } catch (e: any) { alert(e.message); } finally { setSaving(false); }
  }

  function openCreate() {
    setForm(emptyForm());
    setSearchAff(""); setSearchRef("");
    setCreateOpen(true);
  }

  function openEdit(r: Rel) {
    setEditRel(r);
    setForm({
      affiliate_player_id: r.affiliate_player_id, referred_player_id: r.referred_player_id, origin_game_id: r.origin_game_id,
      start_date: r.start_date, status: r.status,
      disclosed_action_pct: r.disclosed_action_pct != null ? String(r.disclosed_action_pct) : "",
      disclosed_rakeback_pct: r.disclosed_rakeback_pct != null ? String(r.disclosed_rakeback_pct) : "",
      disclosed_insurance_pct: r.disclosed_insurance_pct != null ? String(r.disclosed_insurance_pct) : "",
      exclude_agency_extras: !!r.exclude_agency_extras,
      notes: r.notes ?? "",
    });
  }

  async function handleCreate() {
    if (!form.affiliate_player_id || !form.referred_player_id || !form.origin_game_id) return;
    setSaving(true);
    try {
      const res = await fetch("/api/affiliate-relationships", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          disclosed_action_pct: form.disclosed_action_pct ? Number(form.disclosed_action_pct) : null,
          disclosed_rakeback_pct: form.disclosed_rakeback_pct ? Number(form.disclosed_rakeback_pct) : null,
          disclosed_insurance_pct: form.disclosed_insurance_pct ? Number(form.disclosed_insurance_pct) : null,
          exclude_agency_extras: form.exclude_agency_extras ? 1 : 0,
        }),
      });
      if (!res.ok) { const d = await res.json(); alert(d.error ?? "Erreur"); return; }
      setCreateOpen(false); router.refresh();
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
          disclosed_action_pct: form.disclosed_action_pct ? Number(form.disclosed_action_pct) : null,
          disclosed_rakeback_pct: form.disclosed_rakeback_pct ? Number(form.disclosed_rakeback_pct) : null,
          disclosed_insurance_pct: form.disclosed_insurance_pct ? Number(form.disclosed_insurance_pct) : null,
          exclude_agency_extras: form.exclude_agency_extras ? 1 : 0,
          notes: form.notes || null,
        }),
      });
      setEditRel(null); router.refresh();
    } catch (e: any) { alert(e.message); } finally { setSaving(false); }
  }

  async function terminate(id: number) {
    if (!confirm("Terminer cette relation affiliate ?")) return;
    await fetch(`/api/affiliate-relationships/${id}`, { method: "DELETE" });
    router.refresh();
  }

  const playerName = (id: number) => players.find(p => p.id === id)?.name ?? `#${id}`;

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
        <div style={{ padding: "10px 12px", background: "var(--bg-surface)", borderRadius: 8, border: "1px solid var(--border)" }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 8 }}>Disclosed rates (optionnel)</label>
          <div style={{ display: "flex", gap: 10 }}>
            {(["disclosed_action_pct", "disclosed_rakeback_pct", "disclosed_insurance_pct"] as const).map(k => (
              <div key={k} style={{ flex: 1 }}>
                <label style={{ fontSize: 10, color: "var(--text-dim)", display: "block", marginBottom: 3 }}>{k.replace("disclosed_", "").replace("_pct", " %")}</label>
                <input type="number" step="0.01" min={0} max={100} value={(form as any)[k]} onChange={e => setForm({ ...form, [k]: e.target.value })} placeholder="Réel"
                  style={{ width: "100%", padding: "6px 8px", borderRadius: 6, fontSize: 12, background: "var(--bg-raised)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", textAlign: "center", boxSizing: "border-box" }} />
              </div>
            ))}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12, color: "var(--text-muted)", cursor: "pointer" }}>
            <input type="checkbox" checked={form.exclude_agency_extras} onChange={e => setForm({ ...form, exclude_agency_extras: e.target.checked })} />
            Exclude agency extras du calcul commission
          </label>
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>Notes</label>
          <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2}
            style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", resize: "vertical", boxSizing: "border-box" }} />
        </div>
      </div>
    );
  }

  const tabStyle = (t: Tab) => ({
    padding: "7px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer" as const,
    background: tab === t ? "rgba(255,255,255,0.08)" : "transparent",
    border: tab === t ? "1px solid var(--border)" : "1px solid transparent",
    color: tab === t ? "var(--text)" : "var(--text-dim)",
  });

  const fmt = (n: number) => n.toFixed(2);

  const RATE_LABEL_STYLE: Record<string, { bg: string; color: string }> = {
    origin: { bg: "rgba(212,175,55,0.15)", color: "#D4AF37" },
    "grâce": { bg: "rgba(34,197,94,0.12)", color: "#22C55E" },
    passif: { bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" },
  };

  function renderHealthBanner() {
    if (!health) return null;
    const { pending_leads_no_relationship: plnr, relationships_no_origin: rno, relationships_no_referred_player: rnrp, orphan_payments: op } = health;
    if (plnr === 0 && rno === 0 && rnrp === 0 && op === 0) return null;
    const isRed = plnr > 0 || rnrp > 0 || op > 0;
    const msgs: string[] = [];
    if (rno > 0) msgs.push(`${rno} relation(s) en attente de leur premier deal`);
    if (plnr > 0) msgs.push(`${plnr} lead(s) converti(s) sans relationship`);
    if (rnrp > 0) msgs.push(`${rnrp} relationship(s) sans player`);
    if (op > 0) msgs.push(`${op} paiement(s) orphelin(s)`);
    return (
      <div style={{ padding: "10px 14px", borderRadius: 8, marginBottom: 14, display: "flex", alignItems: "center", gap: 8, fontSize: 12, background: isRed ? "rgba(239,68,68,0.08)" : "rgba(234,179,8,0.08)", border: `1px solid ${isRed ? "rgba(239,68,68,0.3)" : "rgba(234,179,8,0.3)"}`, color: isRed ? "#EF4444" : "#EAB308" }}>
        <AlertTriangle size={14} /> {msgs.join(" · ")}
      </div>
    );
  }

  function renderRelationsTab() {
    const rels = enrichedRels.length > 0 ? enrichedRels : relationships.map(r => ({ ...r, games: [], total_due_now: 0, total_paid_lifetime: 0, last_paid_at: null } as EnrichedRel));

    return (
      <>
        {renderHealthBanner()}
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
          <button onClick={openCreate} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}>
            <Plus size={14} /> Créer relation
          </button>
        </div>
        {enrichedLoading && <div style={{ textAlign: "center", padding: 12, color: "var(--text-dim)", fontSize: 12 }}>Chargement...</div>}
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              <th style={{ textAlign: "left", padding: "8px" }}>Affiliate</th>
              <th style={{ textAlign: "left", padding: "8px" }}>Referred</th>
              <th style={{ textAlign: "center", padding: "8px" }}>Games</th>
              <th style={{ textAlign: "right", padding: "8px" }}>Commission due</th>
              <th style={{ textAlign: "center", padding: "8px" }}>Last paid</th>
              <th style={{ textAlign: "center", padding: "8px" }}>Status</th>
              <th style={{ textAlign: "center", padding: "8px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rels.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 24, textAlign: "center", color: "var(--text-dim)" }}>Aucune relation affiliate</td></tr>
            )}
            {rels.map(r => {
              const st = STATUS_STYLE[r.status] ?? STATUS_STYLE.terminated;
              const affName = (r as any).affiliate?.name ?? r.affiliate_name;
              const affHandle = (r as any).affiliate?.telegram_handle ?? r.affiliate_handle;
              const refName = (r as any).referred?.name ?? r.referred_name;
              const refHandle = (r as any).referred?.telegram_handle ?? r.referred_handle;
              const games = r.games ?? [];
              return (
                <tr key={r.id} onClick={() => setDrawerRel(r)} style={{ borderBottom: "1px solid var(--border)", cursor: "pointer", opacity: r.status === "terminated" ? 0.5 : 1 }}>
                  <td style={{ padding: "10px 8px" }}>
                    <span style={{ fontWeight: 600, color: "var(--text)" }}>{affName}</span>
                    {affHandle && <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 6 }}>@{affHandle}</span>}
                  </td>
                  <td style={{ padding: "10px 8px" }}>
                    <span style={{ fontWeight: 600, color: "var(--text)" }}>{refName}</span>
                    {refHandle && <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 6 }}>@{refHandle}</span>}
                  </td>
                  <td style={{ textAlign: "center", padding: "10px 8px" }}>
                    <div style={{ display: "flex", gap: 4, justifyContent: "center", flexWrap: "wrap" }}>
                      {games.map(g => {
                        const gb = GAME_BADGES[g.game_name] ?? { short: g.game_name.slice(0, 2), bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" };
                        const rl = RATE_LABEL_STYLE[g.rate_label] ?? RATE_LABEL_STYLE.passif;
                        return (
                          <div key={g.game_id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                            <span style={{ background: gb.bg, color: gb.color, padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{gb.short}</span>
                            <span style={{ fontSize: 8, color: rl.color }}>{g.rate_label}</span>
                          </div>
                        );
                      })}
                      {games.length === 0 && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>—</span>}
                    </div>
                  </td>
                  <td style={{ textAlign: "right", padding: "10px 8px", fontWeight: 600, color: (r.total_due_now ?? 0) > 0 ? "#22C55E" : "var(--text-dim)" }}>
                    {(r.total_due_now ?? 0) > 0 ? `${fmt(r.total_due_now!)} USDT` : "—"}
                  </td>
                  <td style={{ textAlign: "center", padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                    {r.last_paid_at ? r.last_paid_at.slice(0, 10) : "—"}
                  </td>
                  <td style={{ textAlign: "center", padding: "10px 8px" }}>
                    <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: st.bg, color: st.color }}>{r.status}</span>
                  </td>
                  <td style={{ textAlign: "center", padding: "10px 8px" }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: "flex", justifyContent: "center", gap: 6 }}>
                      <button onClick={() => openEdit(r)} title="Edit" style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "4px 6px", color: "var(--text-muted)", display: "flex", alignItems: "center" }}><Pencil size={13} /></button>
                      {r.status !== "terminated" && (
                        <button onClick={() => terminate(r.id)} title="Terminer" style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "4px 6px", color: "var(--text-muted)", display: "flex", alignItems: "center" }}><XCircle size={13} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Drawer */}
        {drawerRel && (
          <AffiliateDetailDrawer
            rel={{
              ...drawerRel,
              games: drawerRel.games ?? [],
              total_due_now: drawerRel.total_due_now ?? 0,
              total_paid_lifetime: drawerRel.total_paid_lifetime ?? 0,
              last_paid_at: drawerRel.last_paid_at ?? null,
              affiliate: (drawerRel as any).affiliate ?? { id: drawerRel.affiliate_player_id, name: drawerRel.affiliate_name, telegram_handle: drawerRel.affiliate_handle },
              referred: (drawerRel as any).referred ?? { id: drawerRel.referred_player_id, name: drawerRel.referred_name, telegram_handle: drawerRel.referred_handle },
              origin_game: (drawerRel as any).origin_game ?? { id: drawerRel.origin_game_id, name: drawerRel.origin_game_name },
            }}
            breakdown={drawerRel.breakdown ?? []}
            onClose={() => setDrawerRel(null)}
            onPay={(gameId, gameName, due) => {
              const aff = (drawerRel as any).affiliate?.name ?? drawerRel.affiliate_name;
              const ref = (drawerRel as any).referred?.name ?? drawerRel.referred_name;
              openPay(drawerRel.id, gameId, gameName, due, aff, ref);
            }}
            onEdit={() => { openEdit(drawerRel); setDrawerRel(null); }}
          />
        )}
      </>
    );
  }

  function renderPayoutsTab() {
    if (payoutsLoading) return <div style={{ padding: 40, textAlign: "center", color: "var(--text-dim)" }}><Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} /> Calcul en cours...</div>;
    if (payouts.length === 0) return <div style={{ padding: 40, textAlign: "center", color: "var(--text-dim)" }}>Aucun paiement en attente</div>;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {payouts.map(group => (
          <div key={group.affiliate.id} style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
            {/* Affiliate header */}
            <div style={{ padding: "12px 16px", background: "var(--bg-surface)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>{group.affiliate.name}</span>
                {group.affiliate.telegram_handle && <span style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: 8 }}>@{group.affiliate.telegram_handle}</span>}
              </div>
              <span style={{ fontWeight: 700, fontSize: 15, color: "#22C55E" }}>{fmt(group.total_due)} USDT</span>
            </div>
            {/* Relationship rows */}
            {group.relationships.map(rel => (
              <div key={rel.relationship_id}>
                {rel.breakdown.filter(b => b.due_now > 0 || b.earned_lifetime > 0).map(b => {
                  const gb = GAME_BADGES[b.game_name] ?? { short: b.game_name.slice(0, 2), bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" };
                  const rateLabel = b.rate_label === "origin" ? "origin" : b.rate_label === "grâce" ? "grâce 30j" : "passif";
                  return (
                    <div key={`${rel.relationship_id}-${b.game_id}`} style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, fontSize: 12 }}>
                      <span style={{ fontWeight: 600, color: "var(--text)", minWidth: 100 }}>{rel.referred.name}</span>
                      <span style={{ background: gb.bg, color: gb.color, padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{gb.short}</span>
                      <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: "rgba(139,92,246,0.12)", color: "#8B5CF6" }}>{rateLabel}</span>
                      <span style={{ color: "var(--text-muted)" }}>agency={fmt(b.agency_pnl_lifetime)}</span>
                      <span style={{ color: "var(--text-muted)" }}>rate={Math.round(b.rate * 100)}%</span>
                      <span style={{ color: "var(--text-muted)" }}>earned={fmt(b.earned_lifetime)}</span>
                      <span style={{ color: "var(--text-muted)" }}>paid={fmt(b.paid_lifetime)}</span>
                      <span style={{ fontWeight: 700, color: b.due_now > 0 ? "#22C55E" : "var(--text-dim)" }}>due={fmt(b.due_now)}</span>
                      {b.due_now > 0 && (
                        <button onClick={() => openPay(rel.relationship_id, b.game_id, b.game_name, b.due_now, group.affiliate.name, rel.referred.name)}
                          style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}>
                          <DollarSign size={12} /> Pay
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ padding: "0 28px" }}>
      {/* Tab toggle */}
      <div style={{ display: "flex", gap: 4, marginBottom: 18, background: "var(--bg-surface)", borderRadius: 8, padding: 3, width: "fit-content", border: "1px solid var(--border)" }}>
        <button onClick={() => setTab("relations")} style={tabStyle("relations")}>Relations</button>
        <button onClick={() => setTab("payouts")} style={tabStyle("payouts")}>Pending Payouts</button>
      </div>

      {tab === "relations" ? renderRelationsTab() : renderPayoutsTab()}

      {/* Create modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Créer relation affiliate" width={520}>
        {renderFormFields(false)}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
          <button onClick={() => setCreateOpen(false)} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Annuler</button>
          <button onClick={handleCreate} disabled={saving || !form.affiliate_player_id || !form.referred_player_id || !form.origin_game_id} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E", opacity: saving || !form.affiliate_player_id || !form.referred_player_id || !form.origin_game_id ? 0.5 : 1 }}>
            {saving ? "..." : "Créer"}
          </button>
        </div>
      </Modal>

      {/* Edit modal */}
      <Modal open={!!editRel} onClose={() => setEditRel(null)} title={`Edit — ${editRel?.affiliate_name ?? ""} → ${editRel?.referred_name ?? ""}`} width={520}>
        {renderFormFields(true)}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
          <button onClick={() => setEditRel(null)} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Annuler</button>
          <button onClick={handleEdit} disabled={saving} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E", opacity: saving ? 0.5 : 1 }}>
            {saving ? "..." : "Sauvegarder"}
          </button>
        </div>
      </Modal>

      {/* Pay modal */}
      <Modal open={!!payTarget} onClose={() => setPayTarget(null)} title={`Payer — ${payTarget?.affName ?? ""} (${payTarget?.refName ?? ""} · ${payTarget?.gameName ?? ""})`} width={440}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
