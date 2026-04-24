"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, Plus, Trash2, Wallet, TrendingUp, RefreshCw } from "lucide-react";
import StatCard from "@/components/StatCard";
import Badge from "@/components/Badge";
import Btn from "@/components/Btn";
import Modal from "@/components/Modal";
import WalletChartsWrapper from "./WalletChartsWrapper";

interface PlayerGameRow {
  player_id: number; player_name: string;
  game_id: number; game_name: string;
  action_pct: number; rakeback_pct: number;
  total_deposited: number; total_withdrawn: number; net: number; my_pnl: number;
}

interface WalletTx {
  id: number; player_id: number; game_id: number | null;
  type: "deposit" | "withdrawal"; amount: number; currency: string;
  note: string | null; tx_date: string; player_name: string; game_name: string;
}

interface Player { id: number; name: string; }
interface Game { id: number; name: string; }
interface KPIs { total_deposited: number; total_withdrawn: number; total_net: number; my_total_pnl: number; }

const BLANK_FORM = {
  player_id: "", game_id: "",
  type: "deposit" as "deposit" | "withdrawal",
  amount: "", currency: "USDT", note: "",
  tx_date: new Date().toISOString().slice(0, 10),
};

const GAME_COLOR: Record<string, string> = {
  TELE: "#a78bfa", Wepoker: "#38bdf8", Xpoker: "#fb923c", ClubGG: "#4ade80",
};

function fmt(n: number) {
  const abs = Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n >= 0 ? "+" : "−") + abs;
}
function fmtKpi(n: number) {
  const abs = Math.abs(n);
  return (n < 0 ? "−" : "") + (abs >= 1000 ? (abs / 1000).toFixed(1) + "k" : abs.toFixed(2));
}

export default function WalletsClient({
  initialSummary, kpis, initialTransactions, players, games,
}: {
  initialSummary: PlayerGameRow[];
  kpis: KPIs;
  initialTransactions: WalletTx[];
  players: Player[];
  games: Game[];
}) {
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState(BLANK_FORM);
  const [busy, setBusy] = useState(false);
  const [filterPlayer, setFilterPlayer] = useState("");
  const [filterGame, setFilterGame] = useState("");
  const [filterType, setFilterType] = useState<"" | "deposit" | "withdrawal">("");
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ imported: number; results: { player: string; imported: number; deposits: number; withdrawals: number; error?: string }[] } | null>(null);

  async function syncWallets() {
    setSyncing(true); setSyncResult(null);
    try {
      const res = await fetch("/api/wallets/sync", { method: "POST" });
      const data = await res.json();
      setSyncResult(data);
      if (data.imported > 0) setTimeout(() => window.location.reload(), 1200);
    } finally { setSyncing(false); }
  }

  async function addTx() {
    setBusy(true);
    const res = await fetch("/api/wallets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, amount: Number(form.amount), player_id: Number(form.player_id), game_id: Number(form.game_id) }),
    });
    if (res.ok) window.location.reload();
    setBusy(false);
  }

  async function deleteTx(id: number) {
    if (!confirm("Supprimer cette transaction ?")) return;
    await fetch(`/api/wallets/${id}`, { method: "DELETE" });
    window.location.reload();
  }

  const filtered = initialTransactions.filter(t => {
    if (filterPlayer && String(t.player_id) !== filterPlayer) return false;
    if (filterGame && String(t.game_id) !== filterGame) return false;
    if (filterType && t.type !== filterType) return false;
    return true;
  });

  const myPnlAccent: "green" | "red" | "neutral" = kpis.my_total_pnl > 0 ? "green" : kpis.my_total_pnl < 0 ? "red" : "neutral";
  const netAccent: "green" | "red" | "neutral" = kpis.total_net > 0 ? "green" : kpis.total_net < 0 ? "red" : "neutral";

  // Aggregate per player for charts
  const chartData = Object.values(initialSummary.reduce((acc, r) => {
    if (!acc[r.player_id]) acc[r.player_id] = { id: r.player_id, name: r.player_name, action_pct: r.action_pct, total_deposited: 0, total_withdrawn: 0, net: 0, my_pnl: 0 };
    acc[r.player_id].total_deposited += r.total_deposited;
    acc[r.player_id].total_withdrawn += r.total_withdrawn;
    acc[r.player_id].net += r.net;
    acc[r.player_id].my_pnl += r.my_pnl;
    return acc;
  }, {} as Record<number, any>));

  return (
    <>
      {/* Sync TELE */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        <Btn variant="secondary" onClick={syncWallets} disabled={syncing}>
          <RefreshCw size={14} style={{ animation: syncing ? "spin 1s linear infinite" : "none" }} />
          {syncing ? "Sync en cours…" : "Sync TELE"}
        </Btn>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Scanne la blockchain pour les wallets TELE</span>
        {syncResult && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 6, background: syncResult.imported > 0 ? "rgba(34,197,94,0.12)" : "rgba(136,136,160,0.10)", color: syncResult.imported > 0 ? "var(--green)" : "var(--text-muted)" }}>
              {syncResult.imported > 0 ? `+${syncResult.imported} importés` : "Déjà à jour"}
            </span>
            {syncResult.results.filter(r => r.error).map(r => (
              <span key={r.player} style={{ fontSize: 11, color: "#f87171" }}>{r.player}: {r.error}</span>
            ))}
          </div>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 28 }}>
        <StatCard label="Total Deposited" value={fmtKpi(kpis.total_deposited) + " USDT"} sub="Tous joueurs / games" accent="gold" icon={<ArrowDownLeft size={18} />} />
        <StatCard label="Total Withdrawn" value={fmtKpi(kpis.total_withdrawn) + " USDT"} sub="Tous joueurs / games" accent="gold" icon={<ArrowUpRight size={18} />} />
        <StatCard label="Players Net P&L" value={(kpis.total_net >= 0 ? "+" : "−") + fmtKpi(Math.abs(kpis.total_net)) + " USDT"} sub="Retraits − Dépôts" accent={netAccent} icon={<TrendingUp size={18} />} />
        <StatCard label="Mon Total P&L" value={(kpis.my_total_pnl >= 0 ? "+" : "−") + fmtKpi(Math.abs(kpis.my_total_pnl)) + " USDT"} sub="Ma part selon chaque deal" accent={myPnlAccent} icon={<Wallet size={18} />} />
      </div>

      {/* Summary — per player × game */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 28 }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Résumé par joueur & game</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Joueur", "Game", "Deposited", "Withdrawn", "Net P&L", "Action %", "RB %", "Mon P&L", "Status"].map(h => (
                  <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {initialSummary.length === 0 ? (
                <tr><td colSpan={9} style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
                  Aucune donnée — ajoute des joueurs à une game depuis leur profil
                </td></tr>
              ) : initialSummary.map(row => {
                const netC = row.net > 0 ? "var(--green)" : row.net < 0 ? "#f87171" : "var(--text-muted)";
                const myC = row.my_pnl > 0 ? "var(--green)" : row.my_pnl < 0 ? "#f87171" : "var(--text-muted)";
                const gc = GAME_COLOR[row.game_name] ?? "var(--text-muted)";
                return (
                  <tr key={`${row.player_id}-${row.game_id}`} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "12px 16px" }}>
                      <Link href={`/players/${row.player_id}`} style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", textDecoration: "none" }}
                        onMouseEnter={e => (e.currentTarget.style.color = "var(--green)")}
                        onMouseLeave={e => (e.currentTarget.style.color = "var(--text)")}>
                        {row.player_name}
                      </Link>
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: gc, background: gc + "18", padding: "3px 8px", borderRadius: 5 }}>{row.game_name}</span>
                    </td>
                    <td style={{ padding: "12px 16px", fontSize: 13, color: "var(--text-muted)" }}>{row.total_deposited.toFixed(2)}</td>
                    <td style={{ padding: "12px 16px", fontSize: 13, color: "var(--text-muted)" }}>{row.total_withdrawn.toFixed(2)}</td>
                    <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: netC }}>{row.net === 0 ? "—" : fmt(row.net)}</td>
                    <td style={{ padding: "12px 16px", fontSize: 13, color: "var(--gold)", fontWeight: 600 }}>{row.action_pct}%</td>
                    <td style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)" }}>{row.rakeback_pct}%</td>
                    <td style={{ padding: "12px 16px", fontSize: 14, fontWeight: 700, color: myC }}>{row.my_pnl === 0 ? "—" : fmt(row.my_pnl)}</td>
                    <td style={{ padding: "12px 16px" }}>
                      <Badge label={row.net > 0 ? "Winning" : row.net < 0 ? "Losing" : "Flat"} color={row.net > 0 ? "green" : row.net < 0 ? "red" : "gray"} />
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
        <WalletChartsWrapper data={chartData} transactions={initialTransactions as any} />
      </div>

      {/* Transaction Log */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginRight: "auto" }}>Transaction Log</span>
          <select value={filterPlayer} onChange={e => setFilterPlayer(e.target.value)}
            style={{ fontSize: 12, padding: "5px 10px", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)" }}>
            <option value="">Tous les joueurs</option>
            {players.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
          </select>
          <select value={filterGame} onChange={e => setFilterGame(e.target.value)}
            style={{ fontSize: 12, padding: "5px 10px", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)" }}>
            <option value="">Toutes games</option>
            {games.map(g => <option key={g.id} value={String(g.id)}>{g.name}</option>)}
          </select>
          <div style={{ display: "flex", gap: 4 }}>
            {(["", "deposit", "withdrawal"] as const).map(t => (
              <button key={t} onClick={() => setFilterType(t)} style={{ fontSize: 11, fontWeight: 600, padding: "5px 10px", borderRadius: 6, cursor: "pointer", border: "none", background: filterType === t ? "var(--bg-elevated)" : "transparent", color: filterType === t ? "var(--text)" : "var(--text-dim)" }}>
                {t === "" ? "Tous" : t === "deposit" ? "Dépôt" : "Retrait"}
              </button>
            ))}
          </div>
          <Btn variant="primary" onClick={() => { setForm(BLANK_FORM); setModal(true); }}>
            <Plus size={14} /> Ajouter
          </Btn>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Date", "Joueur", "Game", "Type", "Montant", "Note", ""].map((h, i) => (
                  <th key={i} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Aucune transaction</td></tr>
              ) : filtered.map(tx => {
                const isDeposit = tx.type === "deposit";
                const gc = GAME_COLOR[tx.game_name] ?? "var(--text-muted)";
                return (
                  <tr key={tx.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "11px 16px", fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{tx.tx_date}</td>
                    <td style={{ padding: "11px 16px", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{tx.player_name}</td>
                    <td style={{ padding: "11px 16px" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: gc, background: gc + "18", padding: "2px 7px", borderRadius: 4 }}>{tx.game_name}</span>
                    </td>
                    <td style={{ padding: "11px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {isDeposit ? <ArrowDownLeft size={14} color="#f87171" /> : <ArrowUpRight size={14} color="var(--green)" />}
                        <span style={{ fontSize: 12, fontWeight: 600, color: isDeposit ? "#f87171" : "var(--green)" }}>
                          {isDeposit ? "Dépôt" : "Retrait"}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: "11px 16px", fontSize: 13, fontWeight: 700, whiteSpace: "nowrap" }}>
                      <span style={{ color: isDeposit ? "#f87171" : "var(--green)" }}>{isDeposit ? "−" : "+"}</span>
                      {" "}{tx.amount.toLocaleString("fr-FR", { minimumFractionDigits: 2 })} {tx.currency}
                    </td>
                    <td style={{ padding: "11px 16px", fontSize: 12, color: "var(--text-muted)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {tx.note ?? <span style={{ color: "var(--text-dim)" }}>—</span>}
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
      <Modal open={modal} onClose={() => setModal(false)} title="Ajouter une transaction">
        <Field label="Joueur *">
          <select value={form.player_id} onChange={e => setForm(f => ({ ...f, player_id: e.target.value }))}>
            <option value="">Choisir un joueur…</option>
            {players.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Game *">
          <select value={form.game_id} onChange={e => setForm(f => ({ ...f, game_id: e.target.value }))}>
            <option value="">Choisir une game…</option>
            {games.map(g => <option key={g.id} value={String(g.id)}>{g.name}</option>)}
          </select>
        </Field>
        <Field label="Type *">
          <div style={{ display: "flex", gap: 8 }}>
            {(["deposit", "withdrawal"] as const).map(t => (
              <button key={t} onClick={() => setForm(f => ({ ...f, type: t }))} style={{
                flex: 1, padding: "10px", borderRadius: 7, cursor: "pointer", fontWeight: 600, fontSize: 13,
                border: form.type === t ? `1px solid ${t === "deposit" ? "#f87171" : "var(--green)"}` : "1px solid var(--border)",
                background: form.type === t ? (t === "deposit" ? "rgba(248,113,113,0.10)" : "rgba(34,197,94,0.10)") : "var(--bg-elevated)",
                color: form.type === t ? (t === "deposit" ? "#f87171" : "var(--green)") : "var(--text-muted)",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              }}>
                {t === "deposit" ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
                {t === "deposit" ? "Dépôt" : "Retrait"}
              </button>
            ))}
          </div>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Montant *">
            <input type="number" min="0" step="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="ex: 2000" />
          </Field>
          <Field label="Devise">
            <select value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
              <option value="USDT">USDT</option>
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
              <option value="RMB">RMB</option>
            </select>
          </Field>
        </div>
        <Field label="Date *">
          <input type="date" value={form.tx_date} onChange={e => setForm(f => ({ ...f, tx_date: e.target.value }))} />
        </Field>
        <Field label="Note">
          <input value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="Optionnel" />
        </Field>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
          <Btn variant="secondary" onClick={() => setModal(false)}>Annuler</Btn>
          <Btn variant="primary" disabled={!form.player_id || !form.game_id || !form.amount || !form.tx_date || busy} onClick={addTx}>
            {busy ? "Enregistrement…" : "Ajouter"}
          </Btn>
        </div>
      </Modal>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</label>
      {children}
    </div>
  );
}
