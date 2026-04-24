"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowDownLeft, ArrowUpRight, Trash2, Plus, X } from "lucide-react";
import StatCard from "@/components/StatCard";
import Badge from "@/components/Badge";
import Btn from "@/components/Btn";
import Modal from "@/components/Modal";
import WalletChartsWrapper from "@/app/wallets/WalletChartsWrapper";

interface Player {
  id: number; name: string; status: string; action_pct: number;
  tron_address: string | null; telegram_handle: string | null;
}

interface Tx {
  id: number; type: "deposit" | "withdrawal"; amount: number;
  currency: string; tx_date: string; app_name: string; note: string | null;
}

interface Assignment {
  id: number; app_id: number; app_name: string; club_name: string | null;
  deal_value: number; status: string; joined_at: string;
}

interface App { id: number; name: string; club_name: string | null; deal_value: number; }

interface Stats { deposited: number; withdrawn: number; net: number; myPnl: number; }

function fmt(n: number) {
  const abs = Math.abs(n);
  const s = abs >= 1000 ? (abs / 1000).toFixed(2) + "k" : abs.toFixed(2);
  return (n < 0 ? "−" : n > 0 ? "+" : "") + s;
}

const STATUS_COLOR: Record<string, "green" | "gray" | "red"> = {
  active: "green", inactive: "gray", churned: "red",
};

export default function PlayerDetailClient({ player, transactions, assignments: initialAssignments, allApps, stats }: {
  player: Player; transactions: Tx[]; assignments: Assignment[]; allApps: App[]; stats: Stats;
}) {
  const netAccent = stats.net > 0 ? "green" : stats.net < 0 ? "red" : "neutral";
  const myAccent = stats.myPnl > 0 ? "green" : stats.myPnl < 0 ? "red" : "neutral";
  const [assignments, setAssignments] = useState(initialAssignments);
  const [addModal, setAddModal] = useState(false);
  const [selectedApp, setSelectedApp] = useState("");
  const [tronAddress, setTronAddress] = useState("");
  const [busy, setBusy] = useState(false);

  const assignedAppIds = new Set(assignments.map(a => a.app_id));
  const availableApps = allApps.filter(a => !assignedAppIds.has(a.id));
  const selectedAppObj = allApps.find(a => String(a.id) === selectedApp);
  const isTele = selectedAppObj?.name?.toLowerCase() === "tele";

  async function addToClub() {
    if (!selectedApp) return;
    if (isTele && !tronAddress.trim()) return;
    setBusy(true);
    await fetch("/api/assignments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ player_id: player.id, app_id: Number(selectedApp) }),
    });
    if (isTele && tronAddress.trim()) {
      await fetch(`/api/players/${player.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tron_address: tronAddress.trim(), tron_app_id: Number(selectedApp) }),
      });
    }
    setBusy(false);
    setAddModal(false);
    setSelectedApp("");
    setTronAddress("");
    window.location.reload();
  }

  async function removeFromClub(assignmentId: number) {
    if (!confirm("Retirer ce joueur du club ?")) return;
    await fetch(`/api/assignments/${assignmentId}`, { method: "DELETE" });
    setAssignments(a => a.filter(x => x.id !== assignmentId));
  }

  async function deleteTx(id: number) {
    if (!confirm("Supprimer cette transaction ?")) return;
    await fetch(`/api/wallets/${id}`, { method: "DELETE" });
    window.location.reload();
  }

  // Shape needed by WalletChartsWrapper
  const summaryForChart = [{
    id: player.id,
    name: player.name,
    action_pct: player.action_pct,
    total_deposited: stats.deposited,
    total_withdrawn: stats.withdrawn,
    net: stats.net,
    my_pnl: stats.myPnl,
  }];

  return (
    <>
      {/* Back + player meta */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
        <Link href="/players" style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>
          <ArrowLeft size={14} /> Retour
        </Link>
        <div style={{ width: 1, height: 16, background: "var(--border)" }} />
        <Badge label={player.status} color={STATUS_COLOR[player.status] ?? "gray"} />
        {player.telegram_handle && (
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>@{player.telegram_handle.replace(/^@/, "")}</span>
        )}
        <span style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: "auto" }}>
          Action : <strong style={{ color: "var(--gold)" }}>{player.action_pct}%</strong>
        </span>
      </div>

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 28 }}>
        <StatCard label="Total Déposé" value={fmt(stats.deposited) + " USDT"} sub="Envoyé au poker app" accent="neutral" icon={<ArrowDownLeft size={18} />} />
        <StatCard label="Total Retiré" value={fmt(stats.withdrawn) + " USDT"} sub="Encaissé par le joueur" accent="gold" icon={<ArrowUpRight size={18} />} />
        <StatCard label="Net P&L Joueur" value={fmt(stats.net) + " USDT"} sub="Retraits − Dépôts" accent={netAccent} />
        <StatCard label={`Mon ${player.action_pct}%`} value={fmt(stats.myPnl) + " USDT"} sub="Ta part du résultat" accent={myAccent} />
      </div>

      {/* Clubs */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 24 }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Clubs ({assignments.length})</span>
          <Btn size="sm" variant="primary" onClick={() => { setSelectedApp(""); setAddModal(true); }}>
            <Plus size={13} /> Ajouter
          </Btn>
        </div>
        {assignments.length === 0 ? (
          <div style={{ padding: "24px 20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
            Pas encore dans un club
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: 16 }}>
            {assignments.map(a => (
              <div key={a.id} style={{
                display: "flex", alignItems: "center", gap: 8,
                background: "var(--bg-elevated)", border: "1px solid var(--border)",
                borderRadius: 8, padding: "8px 12px",
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                    {a.club_name || a.app_name}
                  </div>
                  {a.club_name && (
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{a.app_name}</div>
                  )}
                </div>
                <span style={{ fontSize: 11, color: "var(--green)", fontWeight: 600, marginLeft: 4 }}>
                  {a.deal_value}%
                </span>
                <button onClick={() => removeFromClub(a.id)} style={{
                  background: "none", border: "none", cursor: "pointer", padding: 2,
                  color: "var(--text-dim)", display: "flex", alignItems: "center",
                  marginLeft: 2,
                }}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add to club modal */}
      <Modal open={addModal} onClose={() => setAddModal(false)} title="Ajouter à un club">
        {availableApps.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Ce joueur est déjà dans tous les clubs.</p>
        ) : (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                Club
              </label>
              <select value={selectedApp} onChange={e => { setSelectedApp(e.target.value); setTronAddress(""); }}>
                <option value="">Choisir un club…</option>
                {availableApps.map(a => (
                  <option key={a.id} value={String(a.id)}>
                    {a.club_name ? `${a.club_name} (${a.name})` : a.name} — {a.deal_value}% rakeback
                  </option>
                ))}
              </select>
            </div>
            {isTele && (
              <div style={{ marginBottom: 16, padding: "12px 14px", background: "rgba(212,175,55,0.08)", border: "1px solid rgba(212,175,55,0.25)", borderRadius: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--gold)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                  TELE WT — Wallet requis
                </div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                  Adresse Tron (TRC20) *
                </label>
                <input
                  value={tronAddress}
                  onChange={e => setTronAddress(e.target.value.trim())}
                  placeholder="TXxx..."
                  autoFocus
                />
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>
                  Nécessaire pour tracker les résultats automatiquement.
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setAddModal(false)}>Annuler</Btn>
              <Btn variant="primary" disabled={!selectedApp || (isTele && !tronAddress.trim()) || busy} onClick={addToClub}>
                {busy ? "Ajout…" : "Ajouter"}
              </Btn>
            </div>
          </>
        )}
      </Modal>

      {/* Charts */}
      {transactions.length === 0 ? (
        <div style={{
          background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10,
          padding: 48, textAlign: "center", color: "var(--text-dim)", fontSize: 13, marginBottom: 28,
        }}>
          Aucune transaction — configure l'adresse Tron et clique <strong style={{ color: "var(--text-muted)" }}>Sync Wallets</strong>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 28 }}>
          <WalletChartsWrapper data={summaryForChart} transactions={transactions as any} />
        </div>
      )}

      {/* Transaction log */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Transactions ({transactions.length})</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Date", "App", "Type", "Montant", "Note", ""].map((h, i) => (
                  <th key={i} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {transactions.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 32, textAlign: "center", color: "var(--text-dim)" }}>Aucune transaction</td></tr>
              ) : transactions.map(tx => {
                const isOut = tx.type === "withdrawal";
                return (
                  <tr key={tx.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "11px 16px", fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{tx.tx_date}</td>
                    <td style={{ padding: "11px 16px", fontSize: 12, color: "var(--text-muted)" }}>{tx.app_name}</td>
                    <td style={{ padding: "11px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {isOut
                          ? <ArrowUpRight size={14} color="var(--green)" />
                          : <ArrowDownLeft size={14} color="#f87171" />}
                        <span style={{ fontSize: 12, fontWeight: 600, color: isOut ? "var(--green)" : "#f87171" }}>
                          {isOut ? "Retrait" : "Dépôt"}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: "11px 16px", fontSize: 13, fontWeight: 700, color: isOut ? "var(--green)" : "#f87171", whiteSpace: "nowrap" }}>
                      {isOut ? "+" : "−"}{tx.amount.toLocaleString("fr-FR", { minimumFractionDigits: 2 })} {tx.currency}
                    </td>
                    <td style={{ padding: "11px 16px", fontSize: 12, color: "var(--text-muted)" }}>
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
    </>
  );
}
