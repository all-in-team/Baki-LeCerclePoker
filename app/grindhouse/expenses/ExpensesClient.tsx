"use client";
import { useState } from "react";
import { Plus, Trash2, ChevronLeft, ChevronRight } from "lucide-react";

interface Expense { id: number; date: string; amount_usdt: number; type: string; player_id: number | null; player_name: string | null; description: string | null }
interface Grinder { player_id: number; name: string }

function shiftDate(d: string, days: number) { const dt = new Date(d + "T12:00:00Z"); dt.setUTCDate(dt.getUTCDate() + days); return dt.toISOString().slice(0, 10); }
const fmt = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function ExpensesClient({ initialExpenses, initialDate, grinders }: { initialExpenses: Expense[]; initialDate: string; grinders: Grinder[] }) {
  const [expenses, setExpenses] = useState<Expense[]>(initialExpenses);
  const [date, setDate] = useState(initialDate);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ amount: "", type: "grind", player_id: 0, description: "" });
  const [saving, setSaving] = useState(false);

  async function fetchDay(d: string) { setDate(d); setLoading(true); try { const r = await fetch(`/api/grindhouse-expenses?from=${d}&to=${d}`); if (r.ok) setExpenses(await r.json()); } finally { setLoading(false); } }

  async function add() {
    if (!form.amount) return; setSaving(true);
    try {
      const r = await fetch("/api/grindhouse-expenses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date, amount_usdt: Number(form.amount), type: form.type, player_id: form.player_id || null, description: form.description || null }) });
      if (r.ok) { const created = await r.json(); setExpenses(prev => [created, ...prev]); setForm({ ...form, amount: "", description: "" }); }
    } finally { setSaving(false); }
  }

  async function del(id: number) { if (!confirm("Supprimer ?")) return; await fetch(`/api/grindhouse-expenses/${id}`, { method: "DELETE" }); setExpenses(prev => prev.filter(e => e.id !== id)); }

  const inputStyle: React.CSSProperties = { padding: "7px 10px", borderRadius: 7, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" };
  const TYPE_STYLE: Record<string, { bg: string; color: string }> = { grind: { bg: "rgba(59,130,246,0.15)", color: "#3B82F6" }, resto: { bg: "rgba(245,158,11,0.15)", color: "#F59E0B" }, autre: { bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" } };

  return (
    <div style={{ padding: "0 28px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <button onClick={() => fetchDay(shiftDate(date, -1))} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "6px 8px", color: "var(--text-muted)", display: "flex" }}><ChevronLeft size={16} /></button>
        <input type="date" value={date} onChange={e => fetchDay(e.target.value)} style={{ ...inputStyle, fontWeight: 600, fontSize: 14 }} />
        <button onClick={() => fetchDay(shiftDate(date, 1))} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "6px 8px", color: "var(--text-muted)", display: "flex" }}><ChevronRight size={16} /></button>
        <button onClick={() => fetchDay(new Date().toISOString().slice(0, 10))} style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}>Aujourd'hui</button>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
        <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} style={{ ...inputStyle, width: 110 }}><option value="grind">Grind</option><option value="resto">Resto</option><option value="autre">Autre</option></select>
        {form.type === "grind" && (<select value={form.player_id} onChange={e => setForm({ ...form, player_id: Number(e.target.value) })} style={{ ...inputStyle, width: 160 }}><option value={0}>Agence (général)</option>{grinders.map(g => <option key={g.player_id} value={g.player_id}>{g.name}</option>)}</select>)}
        <input type="number" step="0.01" min="0" placeholder="Montant USDT" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} style={{ ...inputStyle, width: 120 }} />
        <input type="text" placeholder="Description..." value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} style={{ ...inputStyle, width: 180 }} />
        <button onClick={add} disabled={saving || !form.amount} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E", opacity: saving || !form.amount ? 0.4 : 1 }}><Plus size={14} /> Ajouter</button>
      </div>
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 24 }}>
        {loading ? <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)" }}>Chargement...</div> : expenses.length === 0 ? <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Aucun frais le {date}</div> : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr style={{ borderBottom: "1px solid var(--border)" }}>{["Date", "Type", "Grinder", "Montant", "Description", ""].map((h, i) => (<th key={i} style={{ padding: "10px 16px", textAlign: i === 3 ? "right" : "left", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{h}</th>))}</tr></thead>
          <tbody>{expenses.map(e => { const ts = TYPE_STYLE[e.type] ?? TYPE_STYLE.autre; return (<tr key={e.id} style={{ borderBottom: "1px solid var(--border)" }}><td style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)" }}>{e.date}</td><td style={{ padding: "10px 16px" }}><span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: ts.bg, color: ts.color }}>{e.type}</span></td><td style={{ padding: "10px 16px", fontSize: 12, color: "var(--text)" }}>{e.player_name ?? "Agence"}</td><td style={{ padding: "10px 16px", textAlign: "right", fontSize: 13, fontWeight: 600, color: "#f87171" }}>-{fmt(e.amount_usdt)}</td><td style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-dim)" }}>{e.description ?? "—"}</td><td style={{ padding: "10px 16px", textAlign: "center" }}><button onClick={() => del(e.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 2, display: "inline-flex" }} onMouseEnter={ex => (ex.currentTarget.style.color = "#f87171")} onMouseLeave={ex => (ex.currentTarget.style.color = "var(--text-dim)")}><Trash2 size={14} /></button></td></tr>); })}</tbody></table>
        )}
      </div>
    </div>
  );
}
