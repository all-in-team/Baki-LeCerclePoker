"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, Plus, Trash2, Wallet, TrendingUp, TrendingDown, RefreshCw } from "lucide-react";
import StatCard from "@/components/StatCard";
import Badge from "@/components/Badge";
import Btn from "@/components/Btn";
import Modal from "@/components/Modal";
import WalletChartsWrapper from "./WalletChartsWrapper";

interface PlayerSummary {
  id: number;
  name: string;
  action_pct: number;
  total_deposited: number;
  total_withdrawn: number;
  net: number;
  my_pnl: number;
}

interface WalletTx {
  id: number;
  player_id: number;
  app_id: number;
  type: "deposit" | "withdrawal";
  amount: number;
  currency: string;
  note: string | null;
  tx_date: string;
  player_name: string;
  app_name: string;
}

interface Player { id: number; name: string; action_pct: number; tron_address?: string | null; tron_app_id?: number | null; }
interface App { id: number; name: string; }
interface KPIs { total_deposited: number; total_withdrawn: number; total_net: number; my_total_pnl: number; }

const BLANK_FORM = {
  player_id: "",
  app_id: "",
  type: "deposit" as "deposit" | "withdrawal",
  amount: "",
  currency: "USDT",
  note: "",
  tx_date: new Date().toISOString().slice(0, 10),
};

function fmt(n: number, prefix = true) {
  const abs = Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!prefix) return abs;
  return (n >= 0 ? "+" : "−") + abs;
}

function fmtKpi(n: number) {
  const abs = Math.abs(n);
  const str = abs >= 1000 ? (abs / 1000).toFixed(1) + "k" : abs.toFixed(2);
  return (n < 0 ? "−" : "") + str;
}

export default function WalletsClient({
  initialSummary, kpis, initialTransactions, players, apps,
}: {
  initialSummary: PlayerSummary[];
  kpis: KPIs;
  initialTransactions: WalletTx[];
  players: Player[];
  apps: App[];
}) {
  const [transactions, setTransactions] = useState(initialTransactions);
  const [summary, setSummary] = useState(initialSummary);
  const [currentKpis, setCurrentKpis] = useState(kpis);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState(BLANK_FORM);
  const [busy, setBusy] = useState(false);
  const [filterPlayer, setFilterPlayer] = useState("");
  const [filterType, setFilterType] = useState<"" | "deposit" | "withdrawal">("");
  const [actionEdits, setActionEdits] = useState<Record<number, string>>({});
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ imported: number; results: { player: string; imported: number; deposits: number; withdrawals: number; error?: string }[] } | null>(null);

  async function syncWallets() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/wallets/sync", { method: "POST" });
      const data = await res.json();
      setSyncResult(data);
      if (data.imported > 0) setTimeout(() => window.location.reload(), 1200);
    } finally {
      setSyncing(false);
    }
  }

  async function addTx() {
    setBusy(true);
    const res = await fetch("/api/wallets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, amount: Number(form.amount), player_id: Number(form.player_id), app_id: Number(form.app_id) }),
    });
    if (res.ok) { window.location.reload(); }
    setBusy(false);
  }

  async function deleteTx(id: number) {
    if (!confirm("Delete this transaction?")) return;
    await fetch(`/api/wallets/${id}`, { method: "DELETE" });
    window.location.reload();
  }

  async function saveActionPct(playerId: number) {
    const val = actionEdits[playerId];
    if (val === undefined) return;
    const pct = parseFloat(val);
    if (isNaN(pct) || pct < 0 || pct > 100) return;
    await fetch(`/api/players/${playerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action_pct: pct }),
    });
    window.location.reload();
  }

  const filtered = transactions.filter(t => {
    if (filterPlayer && String(t.player_id) !== filterPlayer) return false;
    if (filterType && t.type !== filterType) return false;
    return true;
  });

  const myPnlAccent: "green" | "red" | "neutral" =
    currentKpis.my_total_pnl > 0 ? "green" : currentKpis.my_total_pnl < 0 ? "red" : "neutral";
  const netAccent: "green" | "red" | "neutral" =
    currentKpis.total_net > 0 ? "green" : currentKpis.total_net < 0 ? "red" : "neutral";

  return (
    <>
      {/* Sync bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        <Btn variant="secondary" onClick={syncWallets} disabled={syncing}>
          <RefreshCw size={14} style={{ animation: syncing ? "spin 1s linear infinite" : "none" }} />
          {syncing ? "Syncing blockchain…" : "Sync Wallets"}
        </Btn>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          Reads TronScan USDT transactions for all players with a Tron address set
        </span>
        {syncResult && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{
              fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 6,
              background: syncResult.imported > 0 ? "rgba(34,197,94,0.12)" : "rgba(136,136,160,0.10)",
              color: syncResult.imported > 0 ? "var(--green)" : "var(--text-muted)",
            }}>
              {syncResult.imported > 0 ? `+${syncResult.imported} imported` : "Already up to date"}
            </span>
            {syncResult.imported > 0 && syncResult.results.filter(r => r.imported > 0).map(r => (
              <span key={r.player} style={{ fontSize: 11, color: "var(--text-muted)" }}>
                <strong style={{ color: "var(--text)" }}>{r.player}</strong>
                {" — "}
                <span style={{ color: "#f87171" }}>{r.deposits} dépôt{r.deposits !== 1 ? "s" : ""}</span>
                {" (reçu sur wallet) · "}
                <span style={{ color: "var(--green)" }}>{r.withdrawals} retrait{r.withdrawals !== 1 ? "s" : ""}</span>
                {" (envoyé depuis wallet)"}
              </span>
            ))}
            {syncResult.results.filter(r => r.error).map(r => (
              <span key={r.player} style={{ fontSize: 11, color: "#f87171" }}>{r.player}: {r.error}</span>
            ))}
          </div>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* KPI Row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 28 }}>
        <StatCard
          label="Total Deposited"
          value={fmtKpi(currentKpis.total_deposited) + " USDT"}
          sub="All players combined"
          accent="gold"
          icon={<ArrowDownLeft size={18} />}
        />
        <StatCard
          label="Total Withdrawn"
          value={fmtKpi(currentKpis.total_withdrawn) + " USDT"}
          sub="All players combined"
          accent="gold"
          icon={<ArrowUpRight size={18} />}
        />
        <StatCard
          label="Players Net P&L"
          value={(currentKpis.total_net >= 0 ? "+" : "−") + fmtKpi(currentKpis.total_net) + " USDT"}
          sub="Withdrawals minus deposits"
          accent={netAccent}
          icon={<TrendingUp size={18} />}
        />
        <StatCard
          label="My Total P&L"
          value={(currentKpis.my_total_pnl >= 0 ? "+" : "−") + fmtKpi(Math.abs(currentKpis.my_total_pnl)) + " USDT"}
          sub="Your % cut across all players"
          accent={myPnlAccent}
          icon={<Wallet size={18} />}
        />
      </div>

      {/* Player Summary Table */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 28 }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Per-Player Summary</span>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>My % is editable — press Enter or click away to save</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Player", "Deposited", "Withdrawn", "Net P&L", "My %", "My P&L", "Status", "Auto-sync"].map(h => (
                  <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
                    No wallet data yet
                  </td>
                </tr>
              ) : summary.map(p => {
                const netColor = p.net > 0 ? "var(--green)" : p.net < 0 ? "#f87171" : "var(--text-muted)";
                const myColor = p.my_pnl > 0 ? "var(--green)" : p.my_pnl < 0 ? "#f87171" : "var(--text-muted)";
                const status = p.net > 0 ? "Winning" : p.net < 0 ? "Losing" : "Flat";
                const statusColor = p.net > 0 ? "green" : p.net < 0 ? "red" : "gray";
                const pctVal = actionEdits[p.id] !== undefined ? actionEdits[p.id] : String(p.action_pct);
                const playerFull = players.find(pl => pl.id === p.id);

                return (
                  <tr key={p.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "12px 16px" }}>
                      <Link href={`/players/${p.id}`} style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", textDecoration: "none" }}
                        onMouseEnter={e => (e.currentTarget.style.color = "var(--green)")}
                        onMouseLeave={e => (e.currentTarget.style.color = "var(--text)")}>
                        {p.name}
                      </Link>
                    </td>
                    <td style={{ padding: "12px 16px", fontSize: 13, color: "var(--text-muted)" }}>{fmt(p.total_deposited, false)} USDT</td>
                    <td style={{ padding: "12px 16px", fontSize: 13, color: "var(--text-muted)" }}>{fmt(p.total_withdrawn, false)} USDT</td>
                    <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: netColor }}>
                      {p.net === 0 ? "—" : (p.net > 0 ? "+" : "−") + fmt(Math.abs(p.net), false) + " USDT"}
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="1"
                          value={pctVal}
                          onChange={e => setActionEdits(a => ({ ...a, [p.id]: e.target.value }))}
                          onBlur={() => saveActionPct(p.id)}
                          onKeyDown={e => { if (e.key === "Enter") saveActionPct(p.id); }}
                          style={{
                            width: 54, padding: "4px 6px", fontSize: 13, fontWeight: 600,
                            background: "var(--bg-elevated)", border: "1px solid var(--border)",
                            borderRadius: 5, color: "var(--gold)", textAlign: "center",
                          }}
                        />
                        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>%</span>
                      </div>
                    </td>
                    <td style={{ padding: "12px 16px", fontSize: 14, fontWeight: 700, color: myColor }}>
                      {p.my_pnl === 0 ? "—" : (p.my_pnl > 0 ? "+" : "−") + fmt(Math.abs(p.my_pnl), false) + " USDT"}
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <Badge label={status} color={statusColor as "green" | "red" | "gray"} />
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      {playerFull?.tron_address
                        ? <Badge label="Active" color="green" />
                        : <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Not set</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Charts */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 28 }}>
        <WalletChartsWrapper data={summary} transactions={transactions} />
      </div>

      {/* Transaction Log */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginRight: "auto" }}>Transaction Log</span>

          {/* Filter by player */}
          <select
            value={filterPlayer}
            onChange={e => setFilterPlayer(e.target.value)}
            style={{ fontSize: 12, padding: "5px 10px", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)" }}
          >
            <option value="">All Players</option>
            {players.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
          </select>

          {/* Filter by type */}
          <div style={{ display: "flex", gap: 4 }}>
            {(["", "deposit", "withdrawal"] as const).map(t => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                style={{
                  fontSize: 11, fontWeight: 600, padding: "5px 10px", borderRadius: 6, cursor: "pointer", border: "none",
                  background: filterType === t ? "var(--bg-elevated)" : "transparent",
                  color: filterType === t ? "var(--text)" : "var(--text-dim)",
                  textTransform: "capitalize",
                }}
              >
                {t === "" ? "All" : t}
              </button>
            ))}
          </div>

          <Btn variant="primary" onClick={() => { setForm(BLANK_FORM); setModal(true); }}>
            <Plus size={14} /> Add Transaction
          </Btn>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Date", "Player", "App", "Type", "Amount", "Note", ""].map((h, i) => (
                  <th key={i} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
                    No transactions yet
                  </td>
                </tr>
              ) : filtered.map(tx => {
                const isIn = tx.type === "deposit";
                return (
                  <tr key={tx.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "11px 16px", fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{tx.tx_date}</td>
                    <td style={{ padding: "11px 16px", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{tx.player_name}</td>
                    <td style={{ padding: "11px 16px", fontSize: 12, color: "var(--text-muted)" }}>{tx.app_name}</td>
                    <td style={{ padding: "11px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {isIn
                          ? <ArrowDownLeft size={14} color="#22c55e" />
                          : <ArrowUpRight size={14} color="#f87171" />}
                        <span style={{ fontSize: 12, fontWeight: 600, color: isIn ? "var(--green)" : "#f87171", textTransform: "capitalize" }}>
                          {tx.type}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: "11px 16px", fontSize: 13, fontWeight: 700, color: isIn ? "var(--text-muted)" : "var(--text)", whiteSpace: "nowrap" }}>
                      <span style={{ color: isIn ? "#f87171" : "var(--green)" }}>{isIn ? "−" : "+"}</span>
                      {" "}{tx.amount.toLocaleString("fr-FR", { minimumFractionDigits: 2 })} {tx.currency}
                    </td>
                    <td style={{ padding: "11px 16px", fontSize: 12, color: "var(--text-muted)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {tx.note || <span style={{ color: "var(--text-dim)" }}>—</span>}
                    </td>
                    <td style={{ padding: "11px 16px" }}>
                      <Btn size="sm" variant="danger" onClick={() => deleteTx(tx.id)}><Trash2 size={13} /></Btn>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Transaction Modal */}
      <Modal open={modal} onClose={() => setModal(false)} title="Add Wallet Transaction">
        <Field label="Player *">
          <select value={form.player_id} onChange={e => setForm(f => ({ ...f, player_id: e.target.value }))}>
            <option value="">Select player…</option>
            {players.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="App *">
          <select value={form.app_id} onChange={e => setForm(f => ({ ...f, app_id: e.target.value }))}>
            <option value="">Select app…</option>
            {apps.map(a => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Type *">
          <div style={{ display: "flex", gap: 8 }}>
            {(["deposit", "withdrawal"] as const).map(t => (
              <button
                key={t}
                onClick={() => setForm(f => ({ ...f, type: t }))}
                style={{
                  flex: 1, padding: "10px", borderRadius: 7, cursor: "pointer", fontWeight: 600, fontSize: 13,
                  border: form.type === t
                    ? `1px solid ${t === "deposit" ? "#f87171" : "var(--green)"}`
                    : "1px solid var(--border)",
                  background: form.type === t
                    ? t === "deposit" ? "rgba(248,113,113,0.10)" : "rgba(34,197,94,0.10)"
                    : "var(--bg-elevated)",
                  color: form.type === t
                    ? t === "deposit" ? "#f87171" : "var(--green)"
                    : "var(--text-muted)",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                }}
              >
                {t === "deposit" ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Amount *">
            <input type="number" min="0" step="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="e.g. 500" />
          </Field>
          <Field label="Currency">
            <select value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
              <option value="USDT">USDT</option>
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
            </select>
          </Field>
        </div>
        <Field label="Date *">
          <input type="date" value={form.tx_date} onChange={e => setForm(f => ({ ...f, tx_date: e.target.value }))} />
        </Field>
        <Field label="Note">
          <input value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="Optional" />
        </Field>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
          <Btn variant="secondary" onClick={() => setModal(false)}>Cancel</Btn>
          <Btn
            variant="primary"
            disabled={!form.player_id || !form.app_id || !form.amount || !form.tx_date || busy}
            onClick={addTx}
          >
            {busy ? "Saving…" : "Add Transaction"}
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
