"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, ChevronLeft, ChevronRight, X, Search, Check, DollarSign } from "lucide-react";

const GAME_BADGES: Record<string, { short: string; bg: string; color: string }> = {
  TELE: { short: "AK", bg: "rgba(212,175,55,0.15)", color: "#D4AF37" },
  KKPOKER: { short: "KK", bg: "rgba(59,130,246,0.15)", color: "#3B82F6" },
  A5POKER: { short: "A5", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
  Wepoker: { short: "WE", bg: "rgba(139,92,246,0.15)", color: "#8B5CF6" },
  ClubGG: { short: "CG", bg: "rgba(234,179,8,0.15)", color: "#EAB308" },
};

type Tab = "sessions" | "expenses" | "settlements" | "profitability";

interface Session { id: number; player_id: number; game_id: number; session_date: string; duration_hours: number; net_result_usdt: number; notes: string | null; player_name: string; game_name: string; }
interface Grinder { player_id: number; name: string; telegram_handle: string | null; status: string; deal_percentage: number }
interface Player { id: number; name: string; telegram_handle: string | null }
interface Game { id: number; name: string }
interface Expense { id: number; date: string; amount_usdt: number; type: string; player_id: number | null; player_name: string | null; description: string | null; }
interface Settlement { id: number; player_id: number; player_name: string; period_start: string; period_end: string; sessions_pnl: number; attributed_grind_fees: number; pool_net: number; grinder_share: number; status: string; paid_at: string | null; }
interface SettlementPreview { player_id: number; player_name: string; sessions_pnl: number; attributed_grind_fees: number; pool_net: number; grinder_share: number; sessions_count: number; total_hours: number; }
interface ProfitData { total_sessions_pnl: number; total_grind_fees_attributed: number; total_pool_net: number; total_grinder_share: number; agency_brute: number; general_grind_fees: number; resto_fees: number; autre_fees: number; agency_net: number; total_hours: number; breakdown: any[]; }

interface Props { initialSessions: Session[]; initialDate: string; grinders: Grinder[]; allPlayers: Player[]; games: Game[]; }

function shiftDate(d: string, days: number): string { const dt = new Date(d + "T12:00:00Z"); dt.setUTCDate(dt.getUTCDate() + days); return dt.toISOString().slice(0, 10); }
function monday(): string { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
function sunday(): string { return shiftDate(monday(), 6); }
function firstOfMonth(): string { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; }
const fmt = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pnlColor = (n: number) => n >= 0 ? "var(--green)" : "#f87171";
const pnlSign = (n: number) => (n >= 0 ? "+" : "") + fmt(n);

export default function GrindhouseClient({ initialSessions, initialDate, grinders: initGrinders, allPlayers, games }: Props) {
  const [tab, setTab] = useState<Tab>("sessions");
  const [sessions, setSessions] = useState<Session[]>(initialSessions);
  const [grinderList, setGrinderList] = useState<Grinder[]>(initGrinders);
  const [date, setDate] = useState(initialDate);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ player_id: 0, game_id: 0, duration_hours: "", net_result_usdt: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [addGrinderOpen, setAddGrinderOpen] = useState(false);
  const [grinderSearch, setGrinderSearch] = useState("");

  // Expenses state
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expDate, setExpDate] = useState(initialDate);
  const [expForm, setExpForm] = useState({ date: initialDate, amount: "", type: "grind" as string, player_id: 0, description: "" });
  const [expLoading, setExpLoading] = useState(false);

  // Settlements state
  const [settFrom, setSettFrom] = useState(monday());
  const [settTo, setSettTo] = useState(sunday());
  const [settPreview, setSettPreview] = useState<SettlementPreview[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [settLoading, setSettLoading] = useState(false);

  // Profitability state
  const [profFrom, setProfFrom] = useState(monday());
  const [profTo, setProfTo] = useState(sunday());
  const [profData, setProfData] = useState<ProfitData | null>(null);
  const [profLoading, setProfLoading] = useState(false);

  const grinderIds = new Set(grinderList.map(g => g.player_id));
  const availablePlayers = allPlayers.filter(p => !grinderIds.has(p.id));
  const filteredAvail = availablePlayers.filter(p => !grinderSearch || p.name.toLowerCase().includes(grinderSearch.toLowerCase()) || (p.telegram_handle ?? "").toLowerCase().includes(grinderSearch.toLowerCase()));

  // Fetch helpers
  async function fetchSessions(d: string) { setDate(d); setLoading(true); try { const r = await fetch(`/api/grindhouse-sessions?date=${d}`); if (r.ok) setSessions(await r.json()); } finally { setLoading(false); } }
  async function fetchExpenses(d: string) { setExpDate(d); setExpLoading(true); try { const r = await fetch(`/api/grindhouse-expenses?from=${d}&to=${d}`); if (r.ok) setExpenses(await r.json()); } finally { setExpLoading(false); } }

  useEffect(() => { if (tab === "expenses") fetchExpenses(expDate); }, [tab]);

  // Grinder management
  async function addGrinder(pid: number) { const r = await fetch("/api/grindhouse-grinders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player_id: pid }) }); if (r.ok) { const g = await r.json(); setGrinderList(prev => [...prev, g].sort((a, b) => a.name.localeCompare(b.name))); setAddGrinderOpen(false); setGrinderSearch(""); } }
  async function removeGrinder(pid: number, name: string) { if (!confirm(`Retirer ${name} ?`)) return; await fetch(`/api/grindhouse-grinders/${pid}`, { method: "DELETE" }); setGrinderList(prev => prev.filter(g => g.player_id !== pid)); }

  // Session CRUD
  async function addSession() { if (!form.player_id || !form.game_id || !form.duration_hours || form.net_result_usdt === "") return; setSaving(true); try { const r = await fetch("/api/grindhouse-sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player_id: form.player_id, game_id: form.game_id, session_date: date, duration_hours: Number(form.duration_hours), net_result_usdt: Number(form.net_result_usdt), notes: form.notes || null }) }); if (r.ok) { const created = await r.json(); setSessions(prev => [created, ...prev]); setForm({ ...form, duration_hours: "", net_result_usdt: "", notes: "" }); } } finally { setSaving(false); } }
  async function deleteSession(id: number) { if (!confirm("Supprimer ?")) return; await fetch(`/api/grindhouse-sessions/${id}`, { method: "DELETE" }); setSessions(prev => prev.filter(s => s.id !== id)); }

  // Expense CRUD
  async function addExpense() { if (!expForm.amount || !expForm.type) return; setSaving(true); try { const r = await fetch("/api/grindhouse-expenses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: expForm.date, amount_usdt: Number(expForm.amount), type: expForm.type, player_id: expForm.player_id || null, description: expForm.description || null }) }); if (r.ok) { const created = await r.json(); setExpenses(prev => [created, ...prev]); setExpForm({ ...expForm, amount: "", description: "" }); } } finally { setSaving(false); } }
  async function deleteExpense(id: number) { if (!confirm("Supprimer ?")) return; await fetch(`/api/grindhouse-expenses/${id}`, { method: "DELETE" }); setExpenses(prev => prev.filter(e => e.id !== id)); }

  // Settlements
  async function computeSettlements() { setSettLoading(true); try { const [prev, hist] = await Promise.all([fetch(`/api/grindhouse-settlements?preview=1&from=${settFrom}&to=${settTo}`), fetch(`/api/grindhouse-settlements?from=${settFrom}&to=${settTo}`)]); if (prev.ok) setSettPreview(await prev.json()); if (hist.ok) setSettlements(await hist.json()); } finally { setSettLoading(false); } }
  async function createSettlement(pid: number) { await fetch("/api/grindhouse-settlements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player_id: pid, period_start: settFrom, period_end: settTo }) }); computeSettlements(); }
  async function markPaid(id: number) { await fetch(`/api/grindhouse-settlements/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "paid" }) }); computeSettlements(); }
  async function deleteSettlement(id: number) { if (!confirm("Supprimer ?")) return; await fetch(`/api/grindhouse-settlements/${id}`, { method: "DELETE" }); computeSettlements(); }

  // Profitability
  async function fetchProfit() { setProfLoading(true); try { const r = await fetch(`/api/grindhouse-profitability?from=${profFrom}&to=${profTo}`); if (r.ok) setProfData(await r.json()); } finally { setProfLoading(false); } }

  const inputStyle: React.CSSProperties = { padding: "7px 10px", borderRadius: 7, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" };
  const tabStyle = (t: Tab): React.CSSProperties => ({ padding: "7px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer", background: tab === t ? "rgba(255,255,255,0.08)" : "transparent", border: tab === t ? "1px solid var(--border)" : "1px solid transparent", color: tab === t ? "var(--text)" : "var(--text-dim)" });

  // Summary computations
  const totalHours = sessions.reduce((s, r) => s + r.duration_hours, 0);
  const totalPnl = sessions.reduce((s, r) => s + r.net_result_usdt, 0);
  const byGame = new Map<string, { hours: number; pnl: number }>();
  sessions.forEach(s => { const e = byGame.get(s.game_name) ?? { hours: 0, pnl: 0 }; e.hours += s.duration_hours; e.pnl += s.net_result_usdt; byGame.set(s.game_name, e); });

  return (
    <div style={{ padding: "0 28px" }}>
      {/* Grinders */}
      <div style={{ marginBottom: 20, padding: "14px 18px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Grinders ({grinderList.length})</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {grinderList.length === 0 && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Aucun grinder.</span>}
          {grinderList.map(g => (
            <div key={g.player_id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 20, background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.25)", fontSize: 12, fontWeight: 600, color: "#22C55E" }}>
              {g.name}
              <button onClick={() => removeGrinder(g.player_id, g.name)} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(34,197,94,0.5)", padding: 0, display: "flex" }} onMouseEnter={e => (e.currentTarget.style.color = "#f87171")} onMouseLeave={e => (e.currentTarget.style.color = "rgba(34,197,94,0.5)")}><X size={12} /></button>
            </div>
          ))}
          <div style={{ position: "relative" }}>
            <button onClick={() => setAddGrinderOpen(!addGrinderOpen)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 12px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer", background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}><Plus size={12} /> Ajouter</button>
            {addGrinderOpen && (
              <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, width: 220, background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 8, zIndex: 20, boxShadow: "0 4px 12px rgba(0,0,0,0.3)" }}>
                <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 6 }}>
                  <Search size={12} style={{ color: "var(--text-dim)" }} />
                  <input autoFocus placeholder="Chercher..." value={grinderSearch} onChange={e => setGrinderSearch(e.target.value)} style={{ ...inputStyle, border: "none", background: "transparent", padding: "4px 0", flex: 1 }} />
                </div>
                <div style={{ maxHeight: 160, overflowY: "auto" }}>
                  {filteredAvail.slice(0, 12).map(p => (<button key={p.id} onClick={() => addGrinder(p.id)} style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", fontSize: 12, cursor: "pointer", border: "none", borderBottom: "1px solid var(--border)", background: "transparent", color: "var(--text)" }}>{p.name}</button>))}
                  {filteredAvail.length === 0 && <div style={{ padding: 10, fontSize: 11, color: "var(--text-dim)", textAlign: "center" }}>Aucun</div>}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, background: "var(--bg-surface)", borderRadius: 8, padding: 3, width: "fit-content", border: "1px solid var(--border)" }}>
        {(["sessions", "expenses", "settlements", "profitability"] as Tab[]).map(t => (<button key={t} onClick={() => setTab(t)} style={tabStyle(t)}>{t === "sessions" ? "Sessions" : t === "expenses" ? "Frais" : t === "settlements" ? "Settlements" : "Rentabilité"}</button>))}
      </div>

      {/* ════ SESSIONS TAB ════ */}
      {tab === "sessions" && (<>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <button onClick={() => fetchSessions(shiftDate(date, -1))} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "6px 8px", color: "var(--text-muted)", display: "flex" }}><ChevronLeft size={16} /></button>
          <input type="date" value={date} onChange={e => fetchSessions(e.target.value)} style={{ ...inputStyle, fontWeight: 600, fontSize: 14 }} />
          <button onClick={() => fetchSessions(shiftDate(date, 1))} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "6px 8px", color: "var(--text-muted)", display: "flex" }}><ChevronRight size={16} /></button>
          <button onClick={() => fetchSessions(new Date().toISOString().slice(0, 10))} style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}>Aujourd'hui</button>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
          <select value={form.player_id} onChange={e => setForm({ ...form, player_id: Number(e.target.value) })} style={{ ...inputStyle, width: 160 }} disabled={grinderList.length === 0}><option value={0}>{grinderList.length === 0 ? "Ajoute un grinder" : "Grinder..."}</option>{grinderList.map(g => <option key={g.player_id} value={g.player_id}>{g.name}</option>)}</select>
          <select value={form.game_id} onChange={e => setForm({ ...form, game_id: Number(e.target.value) })} style={{ ...inputStyle, width: 130 }}><option value={0}>Game...</option>{games.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
          <input type="number" step="0.5" min="0" placeholder="Heures" value={form.duration_hours} onChange={e => setForm({ ...form, duration_hours: e.target.value })} style={{ ...inputStyle, width: 80 }} />
          <input type="number" step="0.01" placeholder="P&L USDT" value={form.net_result_usdt} onChange={e => setForm({ ...form, net_result_usdt: e.target.value })} style={{ ...inputStyle, width: 110 }} />
          <input type="text" placeholder="Notes..." value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} style={{ ...inputStyle, width: 150 }} />
          <button onClick={addSession} disabled={saving || !form.player_id || !form.game_id || !form.duration_hours || form.net_result_usdt === ""} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E", opacity: saving || !form.player_id || !form.game_id || !form.duration_hours || form.net_result_usdt === "" ? 0.4 : 1 }}><Plus size={14} /> Ajouter</button>
        </div>
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 24 }}>
          {loading ? <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Chargement...</div> : sessions.length === 0 ? <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Aucune session le {date}</div> : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr style={{ borderBottom: "1px solid var(--border)" }}>{["Grinder", "Game", "Heures", "P&L USDT", "Notes", ""].map((h, i) => (<th key={i} style={{ padding: "10px 16px", textAlign: i >= 2 && i <= 3 ? "right" : "left", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{h}</th>))}</tr></thead>
            <tbody>{sessions.map(s => { const gb = GAME_BADGES[s.game_name] ?? { short: s.game_name.slice(0, 2), bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" }; return (<tr key={s.id} style={{ borderBottom: "1px solid var(--border)" }}><td style={{ padding: "10px 16px", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{s.player_name}</td><td style={{ padding: "10px 16px" }}><span style={{ background: gb.bg, color: gb.color, padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{gb.short}</span></td><td style={{ padding: "10px 16px", textAlign: "right", fontSize: 13, color: "var(--text-muted)" }}>{s.duration_hours}h</td><td style={{ padding: "10px 16px", textAlign: "right", fontSize: 13, fontWeight: 600, color: pnlColor(s.net_result_usdt) }}>{pnlSign(s.net_result_usdt)}</td><td style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-dim)" }}>{s.notes ?? "—"}</td><td style={{ padding: "10px 16px", textAlign: "center" }}><button onClick={() => deleteSession(s.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 2, display: "inline-flex" }} onMouseEnter={e => (e.currentTarget.style.color = "#f87171")} onMouseLeave={e => (e.currentTarget.style.color = "var(--text-dim)")}><Trash2 size={14} /></button></td></tr>); })}</tbody></table>
          )}
        </div>
        {sessions.length > 0 && (<div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
          <div style={{ padding: "12px 18px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 8 }}><div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>Total heures</div><div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)" }}>{totalHours.toFixed(1)}h</div></div>
          <div style={{ padding: "12px 18px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 8 }}><div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>Total P&L</div><div style={{ fontSize: 18, fontWeight: 700, color: pnlColor(totalPnl) }}>{pnlSign(totalPnl)} USDT</div></div>
          {[...byGame.entries()].map(([name, v]) => { const gb = GAME_BADGES[name] ?? { short: name.slice(0, 2), bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" }; return (<div key={name} style={{ padding: "12px 18px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 8 }}><div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}><span style={{ background: gb.bg, color: gb.color, padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{gb.short}</span><span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)" }}>{v.hours.toFixed(1)}h</span></div><div style={{ fontSize: 15, fontWeight: 700, color: pnlColor(v.pnl) }}>{pnlSign(v.pnl)}</div></div>); })}
        </div>)}
      </>)}

      {/* ════ EXPENSES TAB ════ */}
      {tab === "expenses" && (<>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <button onClick={() => fetchExpenses(shiftDate(expDate, -1))} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "6px 8px", color: "var(--text-muted)", display: "flex" }}><ChevronLeft size={16} /></button>
          <input type="date" value={expDate} onChange={e => fetchExpenses(e.target.value)} style={{ ...inputStyle, fontWeight: 600, fontSize: 14 }} />
          <button onClick={() => fetchExpenses(shiftDate(expDate, 1))} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "6px 8px", color: "var(--text-muted)", display: "flex" }}><ChevronRight size={16} /></button>
          <button onClick={() => fetchExpenses(new Date().toISOString().slice(0, 10))} style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}>Aujourd'hui</button>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
          <select value={expForm.type} onChange={e => setExpForm({ ...expForm, type: e.target.value })} style={{ ...inputStyle, width: 110 }}><option value="grind">Grind</option><option value="resto">Resto</option><option value="autre">Autre</option></select>
          {expForm.type === "grind" && (<select value={expForm.player_id} onChange={e => setExpForm({ ...expForm, player_id: Number(e.target.value) })} style={{ ...inputStyle, width: 160 }}><option value={0}>Agence (général)</option>{grinderList.map(g => <option key={g.player_id} value={g.player_id}>{g.name}</option>)}</select>)}
          <input type="number" step="0.01" min="0" placeholder="Montant USDT" value={expForm.amount} onChange={e => setExpForm({ ...expForm, amount: e.target.value })} style={{ ...inputStyle, width: 120 }} />
          <input type="text" placeholder="Description..." value={expForm.description} onChange={e => setExpForm({ ...expForm, description: e.target.value })} style={{ ...inputStyle, width: 180 }} />
          <button onClick={addExpense} disabled={saving || !expForm.amount} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E", opacity: saving || !expForm.amount ? 0.4 : 1 }}><Plus size={14} /> Ajouter</button>
        </div>
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 24 }}>
          {expLoading ? <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)" }}>Chargement...</div> : expenses.length === 0 ? <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Aucun frais le {expDate}</div> : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr style={{ borderBottom: "1px solid var(--border)" }}>{["Date", "Type", "Grinder", "Montant", "Description", ""].map((h, i) => (<th key={i} style={{ padding: "10px 16px", textAlign: i === 3 ? "right" : "left", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{h}</th>))}</tr></thead>
            <tbody>{expenses.map(e => (<tr key={e.id} style={{ borderBottom: "1px solid var(--border)" }}><td style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)" }}>{e.date}</td><td style={{ padding: "10px 16px" }}><span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: e.type === "grind" ? "rgba(59,130,246,0.15)" : e.type === "resto" ? "rgba(245,158,11,0.15)" : "rgba(156,163,175,0.15)", color: e.type === "grind" ? "#3B82F6" : e.type === "resto" ? "#F59E0B" : "#9CA3AF" }}>{e.type}</span></td><td style={{ padding: "10px 16px", fontSize: 12, color: "var(--text)" }}>{e.player_name ?? "Agence"}</td><td style={{ padding: "10px 16px", textAlign: "right", fontSize: 13, fontWeight: 600, color: "#f87171" }}>-{fmt(e.amount_usdt)}</td><td style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-dim)" }}>{e.description ?? "—"}</td><td style={{ padding: "10px 16px", textAlign: "center" }}><button onClick={() => deleteExpense(e.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 2, display: "inline-flex" }} onMouseEnter={ex => (ex.currentTarget.style.color = "#f87171")} onMouseLeave={ex => (ex.currentTarget.style.color = "var(--text-dim)")}><Trash2 size={14} /></button></td></tr>))}</tbody></table>
          )}
        </div>
      </>)}

      {/* ════ SETTLEMENTS TAB ════ */}
      {tab === "settlements" && (<>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
          <input type="date" value={settFrom} onChange={e => setSettFrom(e.target.value)} style={inputStyle} />
          <span style={{ color: "var(--text-dim)" }}>→</span>
          <input type="date" value={settTo} onChange={e => setSettTo(e.target.value)} style={inputStyle} />
          <button onClick={() => { setSettFrom(monday()); setSettTo(sunday()); }} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Cette semaine</button>
          <button onClick={() => { setSettFrom(firstOfMonth()); setSettTo(new Date().toISOString().slice(0, 10)); }} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Ce mois</button>
          <button onClick={computeSettlements} style={{ padding: "7px 16px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}>Calculer</button>
        </div>
        {settLoading ? <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)" }}>Calcul...</div> : settPreview.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
            {settPreview.map(p => (
              <div key={p.player_id} style={{ padding: "16px 20px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{p.player_name}</span>
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{p.sessions_count} sessions · {p.total_hours.toFixed(1)}h</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12, fontSize: 12 }}>
                  <div><span style={{ color: "var(--text-dim)" }}>Sessions P&L</span><div style={{ fontWeight: 600, color: pnlColor(p.sessions_pnl) }}>{pnlSign(p.sessions_pnl)}</div></div>
                  <div><span style={{ color: "var(--text-dim)" }}>Frais grind</span><div style={{ fontWeight: 600, color: "#f87171" }}>-{fmt(p.attributed_grind_fees)}</div></div>
                  <div><span style={{ color: "var(--text-dim)" }}>Pool net</span><div style={{ fontWeight: 600, color: pnlColor(p.pool_net) }}>{pnlSign(p.pool_net)}</div></div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: "rgba(34,197,94,0.06)", borderRadius: 8, border: "1px solid rgba(34,197,94,0.2)" }}>
                  <div><span style={{ fontSize: 11, color: "var(--text-dim)" }}>Part grinder (50%)</span><div style={{ fontSize: 20, fontWeight: 700, color: pnlColor(p.grinder_share) }}>{pnlSign(p.grinder_share)} USDT</div></div>
                  <button onClick={() => createSettlement(p.player_id)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 16px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}><DollarSign size={14} /> Enregistrer</button>
                </div>
              </div>
            ))}
          </div>
        )}
        {settlements.length > 0 && (<div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 24 }}>
          <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>Historique</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr style={{ borderBottom: "1px solid var(--border)" }}>{["Grinder", "Période", "Part", "Statut", ""].map((h, i) => (<th key={i} style={{ padding: "8px 16px", textAlign: i === 2 ? "right" : "left", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" }}>{h}</th>))}</tr></thead>
          <tbody>{settlements.map(s => (<tr key={s.id} style={{ borderBottom: "1px solid var(--border)" }}><td style={{ padding: "8px 16px", fontSize: 12, fontWeight: 600 }}>{s.player_name}</td><td style={{ padding: "8px 16px", fontSize: 11, color: "var(--text-dim)" }}>{s.period_start} → {s.period_end}</td><td style={{ padding: "8px 16px", textAlign: "right", fontSize: 13, fontWeight: 600, color: pnlColor(s.grinder_share) }}>{pnlSign(s.grinder_share)}</td><td style={{ padding: "8px 16px" }}>{s.status === "paid" ? <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: "rgba(16,185,129,0.15)", color: "#10B981" }}>payé</span> : <button onClick={() => markPaid(s.id)} style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, cursor: "pointer", background: "rgba(234,179,8,0.15)", border: "1px solid rgba(234,179,8,0.3)", color: "#EAB308" }}><Check size={10} /> Marquer payé</button>}</td><td style={{ padding: "8px 16px" }}><button onClick={() => deleteSettlement(s.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 2, display: "inline-flex" }}><Trash2 size={12} /></button></td></tr>))}</tbody></table>
        </div>)}
      </>)}

      {/* ════ PROFITABILITY TAB ════ */}
      {tab === "profitability" && (<>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
          <input type="date" value={profFrom} onChange={e => setProfFrom(e.target.value)} style={inputStyle} />
          <span style={{ color: "var(--text-dim)" }}>→</span>
          <input type="date" value={profTo} onChange={e => setProfTo(e.target.value)} style={inputStyle} />
          <button onClick={() => { setProfFrom(monday()); setProfTo(sunday()); }} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Cette semaine</button>
          <button onClick={() => { setProfFrom(firstOfMonth()); setProfTo(new Date().toISOString().slice(0, 10)); }} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Ce mois</button>
          <button onClick={fetchProfit} style={{ padding: "7px 16px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}>Calculer</button>
        </div>
        {profLoading ? <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)" }}>Calcul...</div> : profData && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ padding: "20px 24px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 16 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}><span>Production brute (sessions)</span><span style={{ fontWeight: 600, color: pnlColor(profData.total_sessions_pnl) }}>{pnlSign(profData.total_sessions_pnl)}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--text-dim)" }}>- Frais grind attribués</span><span style={{ color: "#f87171" }}>-{fmt(profData.total_grind_fees_attributed)}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 8, fontWeight: 600 }}><span>= Pool net</span><span style={{ color: pnlColor(profData.total_pool_net) }}>{pnlSign(profData.total_pool_net)}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--text-dim)" }}>- Part grinders (50%)</span><span style={{ color: "#f87171" }}>-{fmt(Math.abs(profData.total_grinder_share))}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600 }}><span>= Part agence brute</span><span style={{ color: pnlColor(profData.agency_brute) }}>{pnlSign(profData.agency_brute)}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--text-dim)" }}>- Frais grind généraux</span><span style={{ color: "#f87171" }}>-{fmt(profData.general_grind_fees)}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--text-dim)" }}>- Frais resto</span><span style={{ color: "#f87171" }}>-{fmt(profData.resto_fees)}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--text-dim)" }}>- Frais autres</span><span style={{ color: "#f87171" }}>-{fmt(profData.autre_fees)}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between", borderTop: "2px solid var(--border)", paddingTop: 10, marginTop: 4 }}><span style={{ fontSize: 15, fontWeight: 700 }}>Rentabilité nette agence</span><span style={{ fontSize: 20, fontWeight: 700, color: pnlColor(profData.agency_net) }}>{pnlSign(profData.agency_net)} USDT</span></div>
              </div>
            </div>
            {profData.breakdown.length > 0 && (<div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
              <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>Par grinder</div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr style={{ borderBottom: "1px solid var(--border)" }}>{["Grinder", "Heures", "P&L", "Frais", "Part grinder", "Part agence"].map((h, i) => (<th key={i} style={{ padding: "8px 12px", textAlign: i >= 1 ? "right" : "left", fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" }}>{h}</th>))}</tr></thead>
              <tbody>{profData.breakdown.map((b: any) => (<tr key={b.player_id} style={{ borderBottom: "1px solid var(--border)" }}><td style={{ padding: "8px 12px", fontSize: 12, fontWeight: 600 }}>{b.name}</td><td style={{ padding: "8px 12px", textAlign: "right", fontSize: 12, color: "var(--text-muted)" }}>{b.hours.toFixed(1)}h</td><td style={{ padding: "8px 12px", textAlign: "right", fontSize: 12, fontWeight: 600, color: pnlColor(b.sessions_pnl) }}>{pnlSign(b.sessions_pnl)}</td><td style={{ padding: "8px 12px", textAlign: "right", fontSize: 12, color: "#f87171" }}>-{fmt(b.grind_fees)}</td><td style={{ padding: "8px 12px", textAlign: "right", fontSize: 12, fontWeight: 600, color: pnlColor(b.grinder_share) }}>{pnlSign(b.grinder_share)}</td><td style={{ padding: "8px 12px", textAlign: "right", fontSize: 12, fontWeight: 600, color: pnlColor(b.agency_share) }}>{pnlSign(b.agency_share)}</td></tr>))}</tbody></table>
            </div>)}
          </div>
        )}
      </>)}
    </div>
  );
}
