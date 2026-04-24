"use client";

import { useState } from "react";
import Modal from "@/components/Modal";
import Btn from "@/components/Btn";
import { Plus, Trash2, Pencil } from "lucide-react";

interface PokerApp {
  id: number;
  name: string;
  deal_type: "rakeback" | "revenue_share" | "flat";
  deal_value: number;
  currency: string;
  payout_schedule: string;
  club_id: string | null;
  club_name: string | null;
  notes: string | null;
  player_count: number;
  created_at: string;
}


const BLANK = { name: "", deal_value: "", currency: "EUR", payout_schedule: "monthly", club_id: "", club_name: "", notes: "" };

export default function AppsClient({ initialApps }: { initialApps: PokerApp[] }) {
  const [apps, setApps] = useState(initialApps);
  const [modal, setModal] = useState<"add" | "edit" | null>(null);
  const [editing, setEditing] = useState<PokerApp | null>(null);
  const [form, setForm] = useState<typeof BLANK>(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openAdd() { setForm(BLANK); setError(null); setModal("add"); }
  function openEdit(a: PokerApp) {
    setEditing(a);
    setForm({ name: a.name, deal_value: String(a.deal_value), currency: a.currency, payout_schedule: a.payout_schedule, club_id: a.club_id ?? "", club_name: a.club_name ?? "", notes: a.notes ?? "" });
    setModal("edit");
  }
  function closeModal() { setModal(null); setEditing(null); setError(null); }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const url = modal === "add" ? "/api/apps" : `/api/apps/${editing!.id}`;
      const method = modal === "add" ? "POST" : "PATCH";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, deal_value: Number(form.deal_value) }) });
      if (res.ok) { window.location.reload(); return; }
      const data = await res.json().catch(() => ({}));
      setError(data.error || `Erreur ${res.status}`);
    } catch (e) {
      setError("Erreur réseau");
    }
    setBusy(false);
  }

  async function del(id: number) {
    if (!confirm("Delete this app? All associated data will be affected.")) return;
    await fetch(`/api/apps/${id}`, { method: "DELETE" });
    setApps(a => a.filter(x => x.id !== id));
  }

  return (
    <>
      <div style={{ marginBottom: 20 }}>
        <Btn variant="primary" onClick={openAdd}><Plus size={15} /> Add App</Btn>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
        {apps.length === 0 && (
          <div style={{ gridColumn: "1/-1", textAlign: "center", color: "var(--text-dim)", padding: 48, fontSize: 13 }}>
            No apps yet — add your first poker platform
          </div>
        )}
        {apps.map(a => (
          <div key={a.id} style={{
            background: "var(--bg-raised)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: 20,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text)", marginBottom: 3 }}>{a.club_name || a.name}</div>
                {a.club_name && <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>{a.name}</div>}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Btn size="sm" variant="ghost" onClick={() => openEdit(a)}><Pencil size={13} /></Btn>
                <Btn size="sm" variant="danger" onClick={() => del(a.id)}><Trash2 size={13} /></Btn>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 13 }}>
              <div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>Deal</div>
                <div style={{ color: "var(--green)", fontWeight: 600 }}>{a.deal_value}% Rakeback</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>Payout</div>
                <div style={{ color: "var(--text-muted)" }}>{a.payout_schedule}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>Currency</div>
                <div style={{ color: "var(--text-muted)" }}>{a.currency}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>Players</div>
                <div style={{ color: a.player_count > 0 ? "var(--text)" : "var(--text-dim)" }}>{a.player_count} active</div>
              </div>
              {a.club_id && (
                <div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>Club ID</div>
                  <div style={{ color: "var(--text-muted)" }}>{a.club_id}</div>
                </div>
              )}
            </div>

            {a.notes && (
              <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-muted)", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                {a.notes}
              </div>
            )}
          </div>
        ))}
      </div>

      <Modal open={modal !== null} onClose={closeModal} title={modal === "add" ? "Add Poker App" : "Edit App"}>
        <Field label="App Name *">
          <select value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}>
            <option value="">Select app…</option>
            <option value="ClubGG">ClubGG</option>
            <option value="Wepoker">Wepoker</option>
            <option value="Tele">Tele</option>
            <option value="Xpoker">Xpoker</option>
          </select>
        </Field>
        <Field label="Club Name">
          <input value={form.club_name} onChange={e => setForm(f => ({ ...f, club_name: e.target.value }))} placeholder="Nom du club" />
        </Field>
        <Field label="Club ID">
          <input value={form.club_id} onChange={e => setForm(f => ({ ...f, club_id: e.target.value }))} placeholder="e.g. 12345" />
        </Field>
        <Field label="% Rakeback">
          <input type="number" min="0" step="0.01" value={form.deal_value} onChange={e => setForm(f => ({ ...f, deal_value: e.target.value }))} placeholder="e.g. 35" />
        </Field>
        <Field label="Currency">
          <select value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
            <option value="EUR">EUR</option>
            <option value="USD">USD</option>
            <option value="GBP">GBP</option>
            <option value="USDT">USDT</option>
            <option value="RMB">RMB</option>
          </select>
        </Field>
        <Field label="Payout Schedule">
          <select value={form.payout_schedule} onChange={e => setForm(f => ({ ...f, payout_schedule: e.target.value }))}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Bi-Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="on-demand">On Demand</option>
          </select>
        </Field>
        <Field label="Notes">
          <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Optional" style={{ resize: "vertical" }} />
        </Field>
        {error && (
          <div style={{ marginBottom: 12, padding: "10px 14px", background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", borderRadius: 7, fontSize: 13, color: "#f87171" }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
          <Btn variant="secondary" onClick={closeModal}>Cancel</Btn>
          <Btn variant="primary" disabled={!form.name.trim() || form.deal_value === "" || busy} onClick={submit}>
            {busy ? "Saving…" : modal === "add" ? "Add App" : "Save Changes"}
          </Btn>
        </div>
      </Modal>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>
        {label}
      </label>
      {children}
    </div>
  );
}
