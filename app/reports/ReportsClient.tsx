"use client";

import { useState } from "react";
import Btn from "@/components/Btn";
import Badge from "@/components/Badge";
import Modal from "@/components/Modal";
import { Plus, FileText, ChevronDown, ChevronUp } from "lucide-react";

interface Report {
  id: number;
  app_id: number;
  app_name: string;
  period_label: string;
  period_start: string;
  period_end: string;
  entry_count: number;
  total_net: number;
  imported_at: string;
}

interface App { id: number; name: string; deal_type: string; deal_value: number; currency: string }
interface Player { id: number; name: string }

interface Entry {
  player_id: string;
  gross_amount: string;
  player_cut: string;
  my_net: string;
  notes: string;
}

const BLANK_REPORT = {
  app_id: "",
  period_label: "",
  period_start: "",
  period_end: "",
  raw_content: "",
};

const BLANK_ENTRY: Entry = { player_id: "", gross_amount: "", player_cut: "", my_net: "", notes: "" };

function fmt(n: number) { return `€${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(2)}`; }

export default function ReportsClient({
  initialReports, apps, players,
}: {
  initialReports: Report[];
  apps: App[];
  players: Player[];
}) {
  const [reports, setReports] = useState(initialReports);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState(BLANK_REPORT);
  const [entries, setEntries] = useState<Entry[]>([{ ...BLANK_ENTRY }]);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  function addEntry() { setEntries(e => [...e, { ...BLANK_ENTRY }]); }
  function removeEntry(i: number) { setEntries(e => e.filter((_, j) => j !== i)); }
  function updateEntry(i: number, field: keyof Entry, value: string) {
    setEntries(e => e.map((row, j) => j === i ? { ...row, [field]: value } : row));
  }

  function autoNet(i: number, field: "gross_amount" | "player_cut", value: string) {
    updateEntry(i, field, value);
    const entry = entries[i];
    const gross = field === "gross_amount" ? Number(value) : Number(entry.gross_amount);
    const cut = field === "player_cut" ? Number(value) : Number(entry.player_cut);
    if (!isNaN(gross) && !isNaN(cut)) {
      updateEntry(i, "my_net", String((gross - cut).toFixed(2)));
    }
  }

  async function submit() {
    setBusy(true);
    const payload = {
      ...form,
      app_id: Number(form.app_id),
      entries: entries.filter(e => e.gross_amount).map(e => ({
        player_id: e.player_id ? Number(e.player_id) : null,
        gross_amount: Number(e.gross_amount),
        player_cut: Number(e.player_cut || 0),
        my_net: Number(e.my_net),
        notes: e.notes || null,
      })),
    };
    const res = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (res.ok) { window.location.reload(); }
    setBusy(false);
  }

  const selectedApp = apps.find(a => a.id === Number(form.app_id));

  return (
    <>
      <div style={{ marginBottom: 20 }}>
        <Btn variant="primary" onClick={() => { setForm(BLANK_REPORT); setEntries([{ ...BLANK_ENTRY }]); setModal(true); }}>
          <Plus size={15} /> Import Report
        </Btn>
      </div>

      {reports.length === 0 ? (
        <div style={{ textAlign: "center", color: "var(--text-dim)", padding: 64, background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 13 }}>
          No reports imported yet. Import your first affiliate report.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {reports.map(r => (
            <div key={r.id} style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
              <div
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", cursor: "pointer" }}
                onClick={() => setExpanded(expanded === r.id ? null : r.id)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <FileText size={16} style={{ color: "var(--text-muted)" }} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{r.app_name} — {r.period_label}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                      {r.period_start} → {r.period_end} · Imported {r.imported_at.slice(0, 10)}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ color: r.total_net >= 0 ? "var(--green)" : "#f87171", fontWeight: 700 }}>{fmt(r.total_net)}</div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{r.entry_count} entries</div>
                  </div>
                  {expanded === r.id ? <ChevronUp size={16} style={{ color: "var(--text-dim)" }} /> : <ChevronDown size={16} style={{ color: "var(--text-dim)" }} />}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title="Import Report" width={680}>
        <Field label="App *">
          <select value={form.app_id} onChange={e => setForm(f => ({ ...f, app_id: e.target.value }))}>
            <option value="">Select app…</option>
            {apps.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
          <Field label="Period Label *">
            <input value={form.period_label} onChange={e => setForm(f => ({ ...f, period_label: e.target.value }))} placeholder="e.g. May 2025 W1" />
          </Field>
          <Field label="Period Start *">
            <input type="date" value={form.period_start} onChange={e => setForm(f => ({ ...f, period_start: e.target.value }))} />
          </Field>
          <Field label="Period End *">
            <input type="date" value={form.period_end} onChange={e => setForm(f => ({ ...f, period_end: e.target.value }))} />
          </Field>
        </div>

        <Field label="Raw Report Content (optional)">
          <textarea value={form.raw_content} onChange={e => setForm(f => ({ ...f, raw_content: e.target.value }))} rows={4} placeholder="Paste raw CSV or text from the app report…" style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12 }} />
        </Field>

        {/* Accounting entries */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16, marginTop: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Accounting Entries
            </span>
            <Btn size="sm" variant="secondary" onClick={addEntry}><Plus size={12} /> Row</Btn>
          </div>

          {entries.map((entry, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr auto", gap: 8, marginBottom: 8, alignItems: "center" }}>
              <select value={entry.player_id} onChange={e => updateEntry(i, "player_id", e.target.value)}>
                <option value="">No player / aggregate</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input type="number" step="0.01" placeholder="Gross" value={entry.gross_amount}
                onChange={e => autoNet(i, "gross_amount", e.target.value)} />
              <input type="number" step="0.01" placeholder="Player cut" value={entry.player_cut}
                onChange={e => autoNet(i, "player_cut", e.target.value)} />
              <input type="number" step="0.01" placeholder="My net" value={entry.my_net}
                onChange={e => updateEntry(i, "my_net", e.target.value)}
                style={{ color: "var(--green)", fontWeight: 600 }} />
              <Btn size="sm" variant="danger" onClick={() => removeEntry(i)} disabled={entries.length === 1}>×</Btn>
            </div>
          ))}

          {selectedApp && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
              Deal: {selectedApp.deal_type} {selectedApp.deal_type !== "flat" ? `${selectedApp.deal_value}%` : `${selectedApp.currency} ${selectedApp.deal_value}`}
              {" — "}My net = gross − player cut
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
          <Btn variant="secondary" onClick={() => setModal(false)}>Cancel</Btn>
          <Btn variant="primary"
            disabled={!form.app_id || !form.period_label || !form.period_start || !form.period_end || busy}
            onClick={submit}>
            {busy ? "Importing…" : "Import Report"}
          </Btn>
        </div>
      </Modal>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>
        {label}
      </label>
      {children}
    </div>
  );
}
