"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import Modal from "./Modal";
import Btn from "./Btn";

interface Extra {
  id: number;
  game_key: string;
  type: "win" | "fee";
  amount: number;
  currency: string;
  description: string | null;
  recorded_at: string;
  recorded_by: string | null;
  notes: string | null;
}

const CURRENCY_MAP: Record<string, string> = { akpoker: "USDT", wepoker: "CNY", kkpoker: "USDT", a5poker: "USDT", aks: "USDT", nutspk: "USDT", okpoker: "USDT", jvip: "USDT" };

function fmt(n: number, currency: string) {
  return Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + currency;
}

export default function AgencyExtras({ gameKey }: { gameKey: "akpoker" | "wepoker" | "kkpoker" | "a5poker" | "aks" | "nutspk" | "okpoker" | "jvip" }) {
  const currency = CURRENCY_MAP[gameKey];
  const [extras, setExtras] = useState<Extra[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ type: "win" as "win" | "fee", amount: "", description: "", notes: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams({ game_key: gameKey });
    if (!showAll) {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      params.set("from", d.toISOString().slice(0, 10));
    }
    fetch(`/api/agency-extras?${params}`).then(r => r.json()).then(data => {
      if (Array.isArray(data)) setExtras(data);
    });
  }, [gameKey, showAll]);

  useEffect(() => { load(); }, [load]);

  const totalWins = extras.filter(e => e.type === "win").reduce((s, e) => s + e.amount, 0);
  const totalFees = extras.filter(e => e.type === "fee").reduce((s, e) => s + e.amount, 0);
  const net = totalWins - totalFees;

  function openAdd() {
    setEditId(null);
    setForm({ type: "win", amount: "", description: "", notes: "" });
    setModalOpen(true);
  }
  function openEdit(e: Extra) {
    setEditId(e.id);
    setForm({ type: e.type, amount: String(e.amount), description: e.description ?? "", notes: e.notes ?? "" });
    setModalOpen(true);
  }

  async function save() {
    const amt = parseFloat(form.amount);
    if (!amt || amt <= 0) return;
    setBusy(true);
    try {
      if (editId) {
        await fetch(`/api/agency-extras/${editId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: amt, description: form.description || null, notes: form.notes || null }),
        });
      } else {
        await fetch("/api/agency-extras", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ game_key: gameKey, type: form.type, amount: amt, description: form.description || null, notes: form.notes || null }),
        });
      }
      setModalOpen(false);
      load();
    } finally { setBusy(false); }
  }

  async function del(id: number) {
    if (!confirm("Supprimer cet extra ?")) return;
    await fetch(`/api/agency-extras/${id}`, { method: "DELETE" });
    load();
  }

  const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 };
  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "8px 10px", background: "var(--bg-base)", border: "1px solid var(--border)",
    borderRadius: 6, color: "var(--text)", fontSize: 13, outline: "none", boxSizing: "border-box",
  };

  return (
    <div style={{ padding: "24px 28px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Extras agency</h3>
        <Btn onClick={openAdd} style={{ gap: 6, fontSize: 12 }}><Plus size={14} /> Add extra</Btn>
      </div>

      {extras.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12, display: "flex", gap: 16 }}>
          <span>Wins: <b style={{ color: "var(--green)" }}>+{fmt(totalWins, currency)}</b></span>
          <span>Fees: <b style={{ color: "var(--red)" }}>-{fmt(totalFees, currency)}</b></span>
          <span>Net: <b style={{ color: net >= 0 ? "var(--green)" : "var(--red)" }}>{net >= 0 ? "+" : "-"}{fmt(Math.abs(net), currency)}</b></span>
        </div>
      )}

      {extras.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Aucun extra enregistré</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <th style={{ textAlign: "left", padding: "8px 6px", color: "var(--text-muted)", fontWeight: 600 }}>Date</th>
              <th style={{ textAlign: "left", padding: "8px 6px", color: "var(--text-muted)", fontWeight: 600 }}>Type</th>
              <th style={{ textAlign: "right", padding: "8px 6px", color: "var(--text-muted)", fontWeight: 600 }}>Montant</th>
              <th style={{ textAlign: "left", padding: "8px 6px", color: "var(--text-muted)", fontWeight: 600 }}>Description</th>
              <th style={{ textAlign: "right", padding: "8px 6px", color: "var(--text-muted)", fontWeight: 600 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {extras.map(e => (
              <tr key={e.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 6px", color: "var(--text-muted)" }}>{e.recorded_at.slice(0, 10)}</td>
                <td style={{ padding: "8px 6px" }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                    background: e.type === "win" ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)",
                    color: e.type === "win" ? "#10B981" : "#EF4444",
                  }}>
                    {e.type === "win" ? "WIN" : "FEE"}
                  </span>
                </td>
                <td style={{ padding: "8px 6px", textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums", color: e.type === "win" ? "var(--green)" : "var(--red)" }}>
                  {e.type === "win" ? "+" : "-"}{fmt(e.amount, currency)}
                </td>
                <td style={{ padding: "8px 6px", color: "var(--text)" }}>{e.description ?? "-"}</td>
                <td style={{ padding: "8px 6px", textAlign: "right", display: "flex", gap: 4, justifyContent: "flex-end" }}>
                  <button onClick={() => openEdit(e)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4 }}><Pencil size={13} /></button>
                  <button onClick={() => del(e.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--red)", padding: 4 }}><Trash2 size={13} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ marginTop: 8, textAlign: "center" }}>
        <button onClick={() => setShowAll(!showAll)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 11 }}>
          {showAll ? "30 derniers jours" : "Tout afficher"}
        </button>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editId ? "Modifier extra" : "Ajouter un extra"}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {!editId && (
            <div>
              <div style={labelStyle}>Type</div>
              <div style={{ display: "flex", gap: 8 }}>
                {(["win", "fee"] as const).map(t => (
                  <button key={t} onClick={() => setForm(f => ({ ...f, type: t }))} style={{
                    flex: 1, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)", cursor: "pointer",
                    background: form.type === t ? (t === "win" ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)") : "var(--bg-base)",
                    color: form.type === t ? (t === "win" ? "#10B981" : "#EF4444") : "var(--text-muted)",
                    fontWeight: form.type === t ? 700 : 400, fontSize: 13,
                  }}>
                    {t === "win" ? "⊕ Extra Win" : "⊖ Extra Fee"}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <div style={labelStyle}>Montant ({currency})</div>
            <input type="number" min="0" step="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} style={inputStyle} placeholder="0.00" />
          </div>
          <div>
            <div style={labelStyle}>Description</div>
            <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} style={inputStyle} placeholder="Rakeback bonus, Achat diamants..." />
          </div>
          <div>
            <div style={labelStyle}>Notes (optionnel)</div>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} style={{ ...inputStyle, resize: "vertical" }} />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <Btn onClick={() => setModalOpen(false)} style={{ background: "var(--bg-base)" }}>Annuler</Btn>
            <Btn onClick={save} disabled={busy || !form.amount || parseFloat(form.amount) <= 0}>{busy ? "..." : "Enregistrer"}</Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}
