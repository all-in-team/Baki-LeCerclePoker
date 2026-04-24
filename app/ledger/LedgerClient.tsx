"use client";

import { useState, useMemo } from "react";
import Modal from "@/components/Modal";
import Badge from "@/components/Badge";
import Btn from "@/components/Btn";
import { Plus, Trash2, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownLeft } from "lucide-react";

interface Tx {
  id: number;
  player_id: number | null;
  player_name: string | null;
  direction: "in" | "out";
  amount: number;
  currency: string;
  note: string | null;
  tx_date: string;
  created_at: string;
}

interface Player { id: number; name: string }

const BLANK = {
  player_id: "",
  direction: "in" as "in" | "out",
  amount: "",
  currency: "EUR",
  note: "",
  tx_date: new Date().toISOString().slice(0, 10),
};

function fmt(amount: number, currency: string) {
  const sym = currency === "EUR" ? "€" : currency === "USD" ? "$" : currency === "GBP" ? "£" : currency;
  return `${sym}${amount.toFixed(2)}`;
}

export default function LedgerClient({ initialTxs, players }: { initialTxs: Tx[]; players: Player[] }) {
  const [txs, setTxs] = useState(initialTxs);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [filterPlayer, setFilterPlayer] = useState("");
  const [filterDir, setFilterDir] = useState("");

  const filtered = txs.filter(t => {
    if (filterPlayer && String(t.player_id) !== filterPlayer) return false;
    if (filterDir && t.direction !== filterDir) return false;
    return true;
  });

  const stats = useMemo(() => {
    const inTotal = txs.filter(t => t.direction === "in").reduce((s, t) => s + t.amount, 0);
    const outTotal = txs.filter(t => t.direction === "out").reduce((s, t) => s + t.amount, 0);
    return { inTotal, outTotal, balance: inTotal - outTotal };
  }, [txs]);

  async function submit() {
    setBusy(true);
    const res = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, player_id: form.player_id ? Number(form.player_id) : null, amount: Number(form.amount) }),
    });
    if (res.ok) {
      const { id } = await res.json();
      const player = players.find(p => p.id === Number(form.player_id));
      const newTx: Tx = {
        id,
        player_id: form.player_id ? Number(form.player_id) : null,
        player_name: player?.name ?? null,
        direction: form.direction,
        amount: Number(form.amount),
        currency: form.currency,
        note: form.note || null,
        tx_date: form.tx_date,
        created_at: new Date().toISOString(),
      };
      setTxs(t => [newTx, ...t]);
      setModal(false);
      setForm(BLANK);
    }
    setBusy(false);
  }

  async function del(id: number) {
    if (!confirm("Delete this transaction?")) return;
    await fetch(`/api/ledger/${id}`, { method: "DELETE" });
    setTxs(t => t.filter(x => x.id !== id));
  }

  return (
    <>
      {/* Stats bar */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 16px" }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Total In</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "var(--green)" }}>+€{stats.inTotal.toFixed(2)}</div>
        </div>
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 16px" }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Total Out</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#f87171" }}>-€{stats.outTotal.toFixed(2)}</div>
        </div>
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 16px" }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Net Balance</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: stats.balance >= 0 ? "var(--green)" : "#f87171" }}>
            {stats.balance >= 0 ? "+" : ""}€{stats.balance.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Filters + add */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
        <select value={filterPlayer} onChange={e => setFilterPlayer(e.target.value)} style={{ width: 180 }}>
          <option value="">All players</option>
          {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={filterDir} onChange={e => setFilterDir(e.target.value)} style={{ width: 120 }}>
          <option value="">Both directions</option>
          <option value="in">Received (in)</option>
          <option value="out">Sent (out)</option>
        </select>
        <Btn variant="primary" onClick={() => { setForm(BLANK); setModal(true); }}>
          <Plus size={15} /> Log Transaction
        </Btn>
      </div>

      {/* Table */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Dir</th>
              <th>Player</th>
              <th>Amount</th>
              <th>Note</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--text-dim)", padding: 32 }}>
                No transactions yet
              </td></tr>
            )}
            {filtered.map(t => (
              <tr key={t.id}>
                <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{t.tx_date}</td>
                <td>
                  {t.direction === "in"
                    ? <span style={{ color: "var(--green)", display: "flex", alignItems: "center", gap: 4 }}><ArrowDownLeft size={13} /> In</span>
                    : <span style={{ color: "#f87171", display: "flex", alignItems: "center", gap: 4 }}><ArrowUpRight size={13} /> Out</span>}
                </td>
                <td style={{ color: t.player_name ? "var(--text)" : "var(--text-dim)" }}>
                  {t.player_name ?? "—"}
                </td>
                <td style={{ fontWeight: 700, color: t.direction === "in" ? "var(--green)" : "#f87171" }}>
                  {t.direction === "in" ? "+" : "-"}{fmt(t.amount, t.currency)}
                </td>
                <td style={{ color: "var(--text-muted)", fontSize: 12, maxWidth: 280 }}>
                  {t.note ?? <span style={{ color: "var(--text-dim)" }}>—</span>}
                </td>
                <td>
                  <Btn size="sm" variant="danger" onClick={() => del(t.id)}><Trash2 size={13} /></Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      <Modal open={modal} onClose={() => setModal(false)} title="Log Transaction">
        <Field label="Date *">
          <input type="date" value={form.tx_date} onChange={e => setForm(f => ({ ...f, tx_date: e.target.value }))} />
        </Field>
        <Field label="Direction *">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {(["in", "out"] as const).map(d => (
              <button key={d} onClick={() => setForm(f => ({ ...f, direction: d }))} style={{
                padding: "10px",
                border: `2px solid ${form.direction === d ? (d === "in" ? "var(--green)" : "#f87171") : "var(--border)"}`,
                borderRadius: 8,
                background: form.direction === d ? (d === "in" ? "rgba(34,197,94,0.12)" : "rgba(248,113,113,0.12)") : "var(--bg-elevated)",
                color: form.direction === d ? (d === "in" ? "var(--green)" : "#f87171") : "var(--text-muted)",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}>
                {d === "in" ? <><ArrowDownLeft size={14} /> Received</> : <><ArrowUpRight size={14} /> Sent</>}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Player">
          <select value={form.player_id} onChange={e => setForm(f => ({ ...f, player_id: e.target.value }))}>
            <option value="">No specific player</option>
            {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
          <Field label="Amount *">
            <input type="number" min="0" step="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0.00" />
          </Field>
          <Field label="Currency">
            <select value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
              <option value="USDT">USDT</option>
              <option value="GBP">GBP</option>
            </select>
          </Field>
        </div>
        <Field label="Note">
          <input value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="e.g. Weekly cut — GGPoker May W2" />
        </Field>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
          <Btn variant="secondary" onClick={() => setModal(false)}>Cancel</Btn>
          <Btn variant="primary" disabled={!form.amount || !form.tx_date || busy} onClick={submit}>
            {busy ? "Saving…" : "Log Transaction"}
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
