"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, XCircle } from "lucide-react";
import Modal from "@/components/Modal";

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

export default function AffiliatesClient({ relationships, players, activeGames, existingReferredIds }: Props) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editRel, setEditRel] = useState<Rel | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [searchAff, setSearchAff] = useState("");
  const [searchRef, setSearchRef] = useState("");

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

  return (
    <div style={{ padding: "0 28px" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <button onClick={openCreate} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}>
          <Plus size={14} /> Créer relation
        </button>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            <th style={{ textAlign: "left", padding: "8px" }}>Affiliate</th>
            <th style={{ textAlign: "left", padding: "8px" }}>Referred</th>
            <th style={{ textAlign: "center", padding: "8px" }}>Game</th>
            <th style={{ textAlign: "center", padding: "8px" }}>Start</th>
            <th style={{ textAlign: "center", padding: "8px" }}>Status</th>
            <th style={{ textAlign: "center", padding: "8px" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {relationships.length === 0 && (
            <tr><td colSpan={6} style={{ padding: 24, textAlign: "center", color: "var(--text-dim)" }}>Aucune relation affiliate</td></tr>
          )}
          {relationships.map(r => {
            const gb = GAME_BADGES[r.origin_game_name] ?? { short: r.origin_game_name.slice(0, 2), bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" };
            const st = STATUS_STYLE[r.status] ?? STATUS_STYLE.terminated;
            return (
              <tr key={r.id} style={{ borderBottom: "1px solid var(--border)", opacity: r.status === "terminated" ? 0.5 : 1 }}>
                <td style={{ padding: "10px 8px" }}>
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>{r.affiliate_name}</span>
                  {r.affiliate_handle && <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 6 }}>@{r.affiliate_handle}</span>}
                </td>
                <td style={{ padding: "10px 8px" }}>
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>{r.referred_name}</span>
                  {r.referred_handle && <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 6 }}>@{r.referred_handle}</span>}
                </td>
                <td style={{ textAlign: "center", padding: "10px 8px" }}>
                  <span style={{ background: gb.bg, color: gb.color, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{gb.short}</span>
                </td>
                <td style={{ textAlign: "center", padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>{r.start_date}</td>
                <td style={{ textAlign: "center", padding: "10px 8px" }}>
                  <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: st.bg, color: st.color }}>{r.status}</span>
                </td>
                <td style={{ textAlign: "center", padding: "10px 8px" }}>
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
    </div>
  );
}
