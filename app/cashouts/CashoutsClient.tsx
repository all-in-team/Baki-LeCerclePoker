"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, CheckCircle, DollarSign, XCircle, Clock, CreditCard } from "lucide-react";
import Btn from "@/components/Btn";
import Badge from "@/components/Badge";

interface Player { id: number; name: string }
interface Cashout {
  id: number; player_id: number; player_name: string;
  amount: number; currency: string; status: string;
  note: string | null; created_at: string; approved_at: string | null; paid_at: string | null;
}

type Filter = "all" | "pending" | "approved" | "paid" | "cancelled";

const STATUS_BADGE: Record<string, { label: string; color: "gold" | "green" | "blue" | "red" | "gray" }> = {
  pending: { label: "En attente", color: "gold" },
  approved: { label: "Approuvé", color: "blue" },
  paid: { label: "Payé", color: "green" },
  cancelled: { label: "Annulé", color: "red" },
};

function fmtDate(iso: string) {
  const d = new Date(iso + "Z");
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function CashoutsClient({ players }: { players: Player[] }) {
  const [cashouts, setCashouts] = useState<Cashout[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [showForm, setShowForm] = useState(false);
  const [formPlayer, setFormPlayer] = useState<number>(0);
  const [formAmount, setFormAmount] = useState("");
  const [formNote, setFormNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState<number | null>(null);

  const load = useCallback(async () => {
    const url = filter === "all" ? "/api/cashouts" : `/api/cashouts?status=${filter}`;
    const data = await fetch(url, { cache: "no-store" }).then(r => r.json());
    setCashouts(data);
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!formPlayer || !formAmount || parseFloat(formAmount) <= 0) return;
    setSaving(true);
    await fetch("/api/cashouts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ player_id: formPlayer, amount: parseFloat(formAmount), note: formNote || null }),
    });
    setSaving(false);
    setShowForm(false);
    setFormPlayer(0);
    setFormAmount("");
    setFormNote("");
    load();
  }

  async function act(id: number, status: "approved" | "paid" | "cancelled") {
    setActing(id);
    await fetch("/api/cashouts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    setActing(null);
    load();
  }

  const pendingCount = cashouts.filter(c => c.status === "pending").length;
  const pendingTotal = cashouts.filter(c => c.status === "pending").reduce((s, c) => s + c.amount, 0);

  return (
    <div style={{ maxWidth: 900 }}>
      {/* KPI bar */}
      <div style={{ display: "flex", gap: 16, marginBottom: 24 }}>
        {[
          { label: "En attente", value: pendingCount, sub: `${pendingTotal.toFixed(2)} USDT`, color: "#eab308", icon: Clock },
          { label: "Approuvés", value: cashouts.filter(c => c.status === "approved").length, sub: null, color: "#60a5fa", icon: CheckCircle },
          { label: "Payés", value: cashouts.filter(c => c.status === "paid").length, sub: null, color: "var(--green)", icon: CreditCard },
        ].map(({ label, value, sub, color, icon: Icon }) => (
          <div key={label} style={{
            flex: 1, background: "var(--bg-raised)", border: "1px solid var(--border)",
            borderRadius: 10, padding: "14px 18px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <Icon size={14} color={color} />
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" }}>{label}</span>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
            {sub && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>{sub}</div>}
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 6 }}>
          {(["all", "pending", "approved", "paid", "cancelled"] as Filter[]).map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: filter === f ? 600 : 400,
              background: filter === f ? "var(--bg-elevated)" : "transparent",
              color: filter === f ? "var(--text)" : "var(--text-muted)",
              border: filter === f ? "1px solid var(--border)" : "1px solid transparent",
              cursor: "pointer",
            }}>
              {f === "all" ? "Tous" : STATUS_BADGE[f]?.label ?? f}
            </button>
          ))}
        </div>
        <Btn variant="primary" onClick={() => setShowForm(!showForm)}>
          <Plus size={14} /> Nouveau cashout
        </Btn>
      </div>

      {/* Create form */}
      {showForm && (
        <div style={{
          background: "var(--bg-raised)", border: "1px solid var(--border)",
          borderRadius: 10, padding: 20, marginBottom: 20,
        }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 140px 1fr", gap: 14, alignItems: "end" }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>Joueur</label>
              <select
                value={formPlayer}
                onChange={e => setFormPlayer(Number(e.target.value))}
                style={{
                  width: "100%", padding: "8px 10px", borderRadius: 7, fontSize: 13,
                  background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)",
                }}
              >
                <option value={0}>Choisir un joueur</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>Montant (USDT)</label>
              <input
                type="number" min="0" step="0.01" value={formAmount}
                onChange={e => setFormAmount(e.target.value)}
                placeholder="0.00"
                style={{
                  width: "100%", padding: "8px 10px", borderRadius: 7, fontSize: 13,
                  background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", boxSizing: "border-box",
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>Note (optionnel)</label>
              <input
                type="text" value={formNote}
                onChange={e => setFormNote(e.target.value)}
                placeholder="Raison du cashout..."
                style={{
                  width: "100%", padding: "8px 10px", borderRadius: 7, fontSize: 13,
                  background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", boxSizing: "border-box",
                }}
              />
            </div>
          </div>
          <div style={{ marginTop: 14, display: "flex", gap: 10 }}>
            <Btn variant="primary" onClick={create} disabled={saving || !formPlayer || !formAmount}>
              {saving ? "Enregistrement..." : "Créer le cashout"}
            </Btn>
            <Btn variant="ghost" onClick={() => setShowForm(false)}>Annuler</Btn>
          </div>
        </div>
      )}

      {/* Table */}
      {cashouts.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--text-dim)" }}>Aucun cashout</div>
      ) : (
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Joueur", "Montant", "Statut", "Date", "Actions"].map(h => (
                  <th key={h} style={{
                    padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "var(--text-muted)",
                    textTransform: "uppercase", letterSpacing: "0.07em", textAlign: "left",
                    background: "var(--bg-surface)", borderBottom: "1px solid var(--border)",
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cashouts.map(c => {
                const sb = STATUS_BADGE[c.status] ?? { label: c.status, color: "gray" as const };
                return (
                  <tr key={c.id}>
                    <td style={{ padding: "11px 14px", fontSize: 13, borderTop: "1px solid var(--border)" }}>
                      <span style={{ fontWeight: 600, color: "var(--text)" }}>{c.player_name}</span>
                      {c.note && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>{c.note}</div>}
                    </td>
                    <td style={{ padding: "11px 14px", fontSize: 13, fontWeight: 600, borderTop: "1px solid var(--border)", color: "var(--text)" }}>
                      {c.amount.toFixed(2)} {c.currency}
                    </td>
                    <td style={{ padding: "11px 14px", borderTop: "1px solid var(--border)" }}>
                      <Badge label={sb.label} color={sb.color} />
                    </td>
                    <td style={{ padding: "11px 14px", fontSize: 12, color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
                      {fmtDate(c.created_at)}
                      {c.approved_at && <div style={{ fontSize: 10, color: "var(--text-dim)" }}>Approuvé {fmtDate(c.approved_at)}</div>}
                      {c.paid_at && <div style={{ fontSize: 10, color: "var(--text-dim)" }}>Payé {fmtDate(c.paid_at)}</div>}
                    </td>
                    <td style={{ padding: "11px 14px", borderTop: "1px solid var(--border)" }}>
                      <div style={{ display: "flex", gap: 6 }}>
                        {c.status === "pending" && (
                          <>
                            <Btn size="sm" variant="primary" onClick={() => act(c.id, "approved")} disabled={acting === c.id}>
                              <CheckCircle size={12} /> Approuver
                            </Btn>
                            <Btn size="sm" variant="danger" onClick={() => act(c.id, "cancelled")} disabled={acting === c.id}>
                              <XCircle size={12} />
                            </Btn>
                          </>
                        )}
                        {c.status === "approved" && (
                          <>
                            <Btn size="sm" variant="primary" onClick={() => act(c.id, "paid")} disabled={acting === c.id}>
                              <DollarSign size={12} /> Marquer payé
                            </Btn>
                            <Btn size="sm" variant="danger" onClick={() => act(c.id, "cancelled")} disabled={acting === c.id}>
                              <XCircle size={12} />
                            </Btn>
                          </>
                        )}
                        {(c.status === "paid" || c.status === "cancelled") && (
                          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
