"use client";
import { useState } from "react";
import { DollarSign, Check, Trash2 } from "lucide-react";

interface Preview { player_id: number; player_name: string; sessions_pnl: number; attributed_grind_fees: number; pool_net: number; grinder_share: number; sessions_count: number; total_hours: number }
interface Settlement { id: number; player_id: number; player_name: string; period_start: string; period_end: string; grinder_share: number; status: string }

function monday() { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
function sunday() { const d = new Date(monday() + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 6); return d.toISOString().slice(0, 10); }
function firstOfMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; }
const fmt = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pnlColor = (n: number) => n >= 0 ? "var(--green)" : "#f87171";
const pnlSign = (n: number) => (n >= 0 ? "+" : "") + fmt(n);

export default function SettlementsClient() {
  const [from, setFrom] = useState(monday());
  const [to, setTo] = useState(sunday());
  const [preview, setPreview] = useState<Preview[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [loading, setLoading] = useState(false);

  async function compute() { setLoading(true); try { const [p, h] = await Promise.all([fetch(`/api/grindhouse-settlements?preview=1&from=${from}&to=${to}`), fetch(`/api/grindhouse-settlements?from=${from}&to=${to}`)]); if (p.ok) setPreview(await p.json()); if (h.ok) setSettlements(await h.json()); } finally { setLoading(false); } }
  async function create(pid: number) { await fetch("/api/grindhouse-settlements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player_id: pid, period_start: from, period_end: to }) }); compute(); }
  async function markPaid(id: number) { await fetch(`/api/grindhouse-settlements/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "paid" }) }); compute(); }
  async function del(id: number) { if (!confirm("Supprimer ?")) return; await fetch(`/api/grindhouse-settlements/${id}`, { method: "DELETE" }); compute(); }

  const inputStyle: React.CSSProperties = { padding: "7px 10px", borderRadius: 7, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" };

  return (
    <div style={{ padding: "0 28px" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inputStyle} />
        <span style={{ color: "var(--text-dim)" }}>→</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inputStyle} />
        <button onClick={() => { setFrom(monday()); setTo(sunday()); }} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Cette semaine</button>
        <button onClick={() => { setFrom(firstOfMonth()); setTo(new Date().toISOString().slice(0, 10)); }} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Ce mois</button>
        <button onClick={compute} style={{ padding: "7px 16px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}>Calculer</button>
      </div>
      {loading ? <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)" }}>Calcul...</div> : preview.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
          {preview.map(p => (
            <div key={p.player_id} style={{ padding: "16px 20px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}><span style={{ fontWeight: 700, fontSize: 14 }}>{p.player_name}</span><span style={{ fontSize: 11, color: "var(--text-dim)" }}>{p.sessions_count} sessions · {p.total_hours.toFixed(1)}h</span></div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12, fontSize: 12 }}>
                <div><span style={{ color: "var(--text-dim)" }}>Sessions P&L</span><div style={{ fontWeight: 600, color: pnlColor(p.sessions_pnl) }}>{pnlSign(p.sessions_pnl)}</div></div>
                <div><span style={{ color: "var(--text-dim)" }}>Frais grind</span><div style={{ fontWeight: 600, color: "#f87171" }}>-{fmt(p.attributed_grind_fees)}</div></div>
                <div><span style={{ color: "var(--text-dim)" }}>Pool net</span><div style={{ fontWeight: 600, color: pnlColor(p.pool_net) }}>{pnlSign(p.pool_net)}</div></div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: "rgba(34,197,94,0.06)", borderRadius: 8, border: "1px solid rgba(34,197,94,0.2)" }}>
                <div><span style={{ fontSize: 11, color: "var(--text-dim)" }}>Part grinder (50%)</span><div style={{ fontSize: 20, fontWeight: 700, color: pnlColor(p.grinder_share) }}>{pnlSign(p.grinder_share)} USDT</div></div>
                <button onClick={() => create(p.player_id)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 16px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}><DollarSign size={14} /> Enregistrer</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {settlements.length > 0 && (<div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 24 }}>
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>Historique</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr style={{ borderBottom: "1px solid var(--border)" }}>{["Grinder", "Période", "Part", "Statut", ""].map((h, i) => (<th key={i} style={{ padding: "8px 16px", textAlign: i === 2 ? "right" : "left", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" }}>{h}</th>))}</tr></thead>
        <tbody>{settlements.map(s => (<tr key={s.id} style={{ borderBottom: "1px solid var(--border)" }}><td style={{ padding: "8px 16px", fontSize: 12, fontWeight: 600 }}>{s.player_name}</td><td style={{ padding: "8px 16px", fontSize: 11, color: "var(--text-dim)" }}>{s.period_start} → {s.period_end}</td><td style={{ padding: "8px 16px", textAlign: "right", fontSize: 13, fontWeight: 600, color: pnlColor(s.grinder_share) }}>{pnlSign(s.grinder_share)}</td><td style={{ padding: "8px 16px" }}>{s.status === "paid" ? <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: "rgba(16,185,129,0.15)", color: "#10B981" }}>payé</span> : <button onClick={() => markPaid(s.id)} style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, cursor: "pointer", background: "rgba(234,179,8,0.15)", border: "1px solid rgba(234,179,8,0.3)", color: "#EAB308" }}><Check size={10} /> Marquer payé</button>}</td><td style={{ padding: "8px 16px" }}><button onClick={() => del(s.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 2, display: "inline-flex" }}><Trash2 size={12} /></button></td></tr>))}</tbody></table>
      </div>)}
    </div>
  );
}
