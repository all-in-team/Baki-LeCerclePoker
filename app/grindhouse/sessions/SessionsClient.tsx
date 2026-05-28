"use client";
import { useState } from "react";
import { Plus, Trash2, ChevronLeft, ChevronRight } from "lucide-react";

const GAME_BADGES: Record<string, { short: string; bg: string; color: string }> = {
  TELE: { short: "AK", bg: "rgba(212,175,55,0.15)", color: "#D4AF37" },
  KKPOKER: { short: "KK", bg: "rgba(59,130,246,0.15)", color: "#3B82F6" },
  A5POKER: { short: "A5", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
  Wepoker: { short: "WE", bg: "rgba(139,92,246,0.15)", color: "#8B5CF6" },
  ClubGG: { short: "CG", bg: "rgba(234,179,8,0.15)", color: "#EAB308" },
};

interface Session { id: number; player_id: number; game_id: number; session_date: string; duration_hours: number; net_result_usdt: number; notes: string | null; player_name: string; game_name: string; }
interface Grinder { player_id: number; name: string }
interface Game { id: number; name: string }

function shiftDate(d: string, days: number) { const dt = new Date(d + "T12:00:00Z"); dt.setUTCDate(dt.getUTCDate() + days); return dt.toISOString().slice(0, 10); }
const fmt = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pnlColor = (n: number) => n >= 0 ? "var(--green)" : "#f87171";
const pnlSign = (n: number) => (n >= 0 ? "+" : "") + fmt(n);

export default function SessionsClient({ initialSessions, initialDate, grinders, games }: { initialSessions: Session[]; initialDate: string; grinders: Grinder[]; games: Game[] }) {
  const [sessions, setSessions] = useState<Session[]>(initialSessions);
  const [date, setDate] = useState(initialDate);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ player_id: 0, game_id: 0, duration_hours: "", net_result_usdt: "", notes: "" });
  const [saving, setSaving] = useState(false);

  async function fetchDay(d: string) { setDate(d); setLoading(true); try { const r = await fetch(`/api/grindhouse-sessions?date=${d}`); if (r.ok) setSessions(await r.json()); } finally { setLoading(false); } }

  async function addSession() {
    if (!form.player_id || !form.game_id || !form.duration_hours || form.net_result_usdt === "") return;
    setSaving(true);
    try {
      const r = await fetch("/api/grindhouse-sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player_id: form.player_id, game_id: form.game_id, session_date: date, duration_hours: Number(form.duration_hours), net_result_usdt: Number(form.net_result_usdt), notes: form.notes || null }) });
      if (r.ok) { const created = await r.json(); setSessions(prev => [created, ...prev]); setForm({ ...form, duration_hours: "", net_result_usdt: "", notes: "" }); }
    } finally { setSaving(false); }
  }

  async function del(id: number) { if (!confirm("Supprimer ?")) return; await fetch(`/api/grindhouse-sessions/${id}`, { method: "DELETE" }); setSessions(prev => prev.filter(s => s.id !== id)); }

  const totalHours = sessions.reduce((s, r) => s + r.duration_hours, 0);
  const totalPnl = sessions.reduce((s, r) => s + r.net_result_usdt, 0);
  const byGame = new Map<string, { hours: number; pnl: number }>();
  sessions.forEach(s => { const e = byGame.get(s.game_name) ?? { hours: 0, pnl: 0 }; e.hours += s.duration_hours; e.pnl += s.net_result_usdt; byGame.set(s.game_name, e); });

  const inputStyle: React.CSSProperties = { padding: "7px 10px", borderRadius: 7, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" };

  return (
    <div style={{ padding: "0 28px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <button onClick={() => fetchDay(shiftDate(date, -1))} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "6px 8px", color: "var(--text-muted)", display: "flex" }}><ChevronLeft size={16} /></button>
        <input type="date" value={date} onChange={e => fetchDay(e.target.value)} style={{ ...inputStyle, fontWeight: 600, fontSize: 14 }} />
        <button onClick={() => fetchDay(shiftDate(date, 1))} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "6px 8px", color: "var(--text-muted)", display: "flex" }}><ChevronRight size={16} /></button>
        <button onClick={() => fetchDay(new Date().toISOString().slice(0, 10))} style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}>Aujourd'hui</button>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
        <select value={form.player_id} onChange={e => setForm({ ...form, player_id: Number(e.target.value) })} style={{ ...inputStyle, width: 160 }} disabled={grinders.length === 0}><option value={0}>{grinders.length === 0 ? "Ajoute un grinder" : "Grinder..."}</option>{grinders.map(g => <option key={g.player_id} value={g.player_id}>{g.name}</option>)}</select>
        <select value={form.game_id} onChange={e => setForm({ ...form, game_id: Number(e.target.value) })} style={{ ...inputStyle, width: 130 }}><option value={0}>Game...</option>{games.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
        <input type="number" step="0.5" min="0" placeholder="Heures" value={form.duration_hours} onChange={e => setForm({ ...form, duration_hours: e.target.value })} style={{ ...inputStyle, width: 80 }} />
        <input type="number" step="0.01" placeholder="P&L USDT" value={form.net_result_usdt} onChange={e => setForm({ ...form, net_result_usdt: e.target.value })} style={{ ...inputStyle, width: 110 }} />
        <input type="text" placeholder="Notes..." value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} style={{ ...inputStyle, width: 150 }} />
        <button onClick={addSession} disabled={saving || !form.player_id || !form.game_id || !form.duration_hours || form.net_result_usdt === ""} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E", opacity: saving || !form.player_id || !form.game_id || !form.duration_hours || form.net_result_usdt === "" ? 0.4 : 1 }}><Plus size={14} /> Ajouter</button>
      </div>
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 24 }}>
        {loading ? <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)" }}>Chargement...</div> : sessions.length === 0 ? <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Aucune session le {date}</div> : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr style={{ borderBottom: "1px solid var(--border)" }}>{["Grinder", "Game", "Heures", "P&L", "Notes", ""].map((h, i) => (<th key={i} style={{ padding: "10px 16px", textAlign: i >= 2 && i <= 3 ? "right" : "left", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{h}</th>))}</tr></thead>
          <tbody>{sessions.map(s => { const gb = GAME_BADGES[s.game_name] ?? { short: s.game_name.slice(0, 2), bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" }; return (<tr key={s.id} style={{ borderBottom: "1px solid var(--border)" }}><td style={{ padding: "10px 16px", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{s.player_name}</td><td style={{ padding: "10px 16px" }}><span style={{ background: gb.bg, color: gb.color, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{gb.short}</span></td><td style={{ padding: "10px 16px", textAlign: "right", fontSize: 13, color: "var(--text-muted)" }}>{s.duration_hours}h</td><td style={{ padding: "10px 16px", textAlign: "right", fontSize: 13, fontWeight: 600, color: pnlColor(s.net_result_usdt) }}>{pnlSign(s.net_result_usdt)}</td><td style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-dim)" }}>{s.notes ?? "—"}</td><td style={{ padding: "10px 16px", textAlign: "center" }}><button onClick={() => del(s.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 2, display: "inline-flex" }} onMouseEnter={e => (e.currentTarget.style.color = "#f87171")} onMouseLeave={e => (e.currentTarget.style.color = "var(--text-dim)")}><Trash2 size={14} /></button></td></tr>); })}</tbody></table>
        )}
      </div>
      {sessions.length > 0 && (<div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
        <div style={{ padding: "12px 18px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 8 }}><div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>Total heures</div><div style={{ fontSize: 18, fontWeight: 700 }}>{totalHours.toFixed(1)}h</div></div>
        <div style={{ padding: "12px 18px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 8 }}><div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>Total P&L</div><div style={{ fontSize: 18, fontWeight: 700, color: pnlColor(totalPnl) }}>{pnlSign(totalPnl)} USDT</div></div>
        {[...byGame.entries()].map(([name, v]) => { const gb = GAME_BADGES[name] ?? { short: name.slice(0, 2), bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" }; return (<div key={name} style={{ padding: "12px 18px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 8 }}><div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}><span style={{ background: gb.bg, color: gb.color, padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{gb.short}</span><span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)" }}>{v.hours.toFixed(1)}h</span></div><div style={{ fontSize: 15, fontWeight: 700, color: pnlColor(v.pnl) }}>{pnlSign(v.pnl)}</div></div>); })}
      </div>)}
    </div>
  );
}
