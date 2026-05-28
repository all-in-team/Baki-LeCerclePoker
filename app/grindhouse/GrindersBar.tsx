"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Search } from "lucide-react";

interface Grinder { player_id: number; name: string; telegram_handle: string | null }
interface Player { id: number; name: string; telegram_handle: string | null }

export default function GrindersBar({ initialGrinders, allPlayers }: { initialGrinders: Grinder[]; allPlayers: Player[] }) {
  const router = useRouter();
  const [list, setList] = useState<Grinder[]>(initialGrinders);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const ids = new Set(list.map(g => g.player_id));
  const avail = allPlayers.filter(p => !ids.has(p.id) && (!search || p.name.toLowerCase().includes(search.toLowerCase())));

  async function add(pid: number) {
    const r = await fetch("/api/grindhouse-grinders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player_id: pid }) });
    if (r.ok) { const g = await r.json(); setList(prev => [...prev, g].sort((a, b) => a.name.localeCompare(b.name))); setOpen(false); setSearch(""); router.refresh(); }
  }
  async function remove(pid: number, name: string) {
    if (!confirm(`Retirer ${name} ?`)) return;
    await fetch(`/api/grindhouse-grinders/${pid}`, { method: "DELETE" });
    setList(prev => prev.filter(g => g.player_id !== pid));
    router.refresh();
  }

  const inputStyle: React.CSSProperties = { padding: "7px 10px", borderRadius: 7, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" };

  return (
    <div style={{ marginBottom: 20, padding: "14px 18px", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Grinders ({list.length})</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {list.length === 0 && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Aucun grinder.</span>}
        {list.map(g => (
          <div key={g.player_id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 20, background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.25)", fontSize: 12, fontWeight: 600, color: "#22C55E" }}>
            {g.name}
            <button onClick={() => remove(g.player_id, g.name)} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(34,197,94,0.5)", padding: 0, display: "flex" }} onMouseEnter={e => (e.currentTarget.style.color = "#f87171")} onMouseLeave={e => (e.currentTarget.style.color = "rgba(34,197,94,0.5)")}><X size={12} /></button>
          </div>
        ))}
        <div style={{ position: "relative" }}>
          <button onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 12px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer", background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}><Plus size={12} /> Ajouter</button>
          {open && (
            <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, width: 220, background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 8, zIndex: 20, boxShadow: "0 4px 12px rgba(0,0,0,0.3)" }}>
              <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 6 }}>
                <Search size={12} style={{ color: "var(--text-dim)" }} />
                <input autoFocus placeholder="Chercher..." value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, border: "none", background: "transparent", padding: "4px 0", flex: 1 }} />
              </div>
              <div style={{ maxHeight: 160, overflowY: "auto" }}>
                {avail.slice(0, 12).map(p => (<button key={p.id} onClick={() => add(p.id)} style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", fontSize: 12, cursor: "pointer", border: "none", borderBottom: "1px solid var(--border)", background: "transparent", color: "var(--text)" }}>{p.name}</button>))}
                {avail.length === 0 && <div style={{ padding: 10, fontSize: 11, color: "var(--text-dim)", textAlign: "center" }}>Aucun</div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
