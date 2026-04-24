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
  id: number; name: string; status: string;
  tron_address: string | null; telegram_handle: string | null;
}

interface Tx {
  id: number; type: "deposit" | "withdrawal"; amount: number;
  currency: string; tx_date: string; game_name: string; note: string | null;
}

interface GameDeal {
  id: number; game_id: number; game_name: string;
  action_pct: number; rakeback_pct: number;
}

interface Game { id: number; name: string; }
interface Stats { deposited: number; withdrawn: number; net: number; my_pnl: number; }

const GAME_COLOR: Record<string, string> = {
  TELE: "#a78bfa", Wepoker: "#38bdf8", Xpoker: "#fb923c", ClubGG: "#4ade80",
};

function fmt(n: number) {
  const abs = Math.abs(n);
  const s = abs >= 1000 ? (abs / 1000).toFixed(2) + "k" : abs.toFixed(2);
  return (n < 0 ? "−" : n > 0 ? "+" : "") + s;
}

const STATUS_COLOR: Record<string, "green" | "gray" | "red"> = {
  active: "green", inactive: "gray", churned: "red",
};

const DEAL_DEFAULTS = { action_pct: "50", rakeback_pct: "0" };

export default function PlayerDetailClient({ player, transactions, gameDeals: initialDeals, allGames, stats }: {
  player: Player; transactions: Tx[]; gameDeals: GameDeal[]; allGames: Game[]; stats: Stats;
}) {
  const netAccent = stats.net > 0 ? "green" : stats.net < 0 ? "red" : "neutral";
  const myAccent = stats.my_pnl > 0 ? "green" : stats.my_pnl < 0 ? "red" : "neutral";
  const [deals, setDeals] = useState(initialDeals);
  const [addModal, setAddModal] = useState(false);
  const [selectedGame, setSelectedGame] = useState("");
  const [dealForm, setDealForm] = useState(DEAL_DEFAULTS);
  const [tronAddress, setTronAddress] = useState("");
  const [busy, setBusy] = useState(false);

  const assignedGameIds = new Set(deals.map(d => d.game_id));
  const availableGames = allGames.filter(g => !assignedGameIds.has(g.id));
  const selectedGameObj = allGames.find(g => String(g.id) === selectedGame);
  const isTele = selectedGameObj?.name === "TELE";

  async function addDeal() {
    if (!selectedGame) return;
    if (isTele && !tronAddress.trim()) return;
    setBusy(true);
    await fetch("/api/games/deals", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        player_id: player.id, game_id: Number(selectedGame),
        action_pct: Number(dealForm.action_pct), rakeback_pct: Number(dealForm.rakeback_pct),
      }),
    });
    if (isTele && tronAddress.trim()) {
      await fetch(`/api/players/${player.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tron_address: tronAddress.trim() }),
      });
    }
    setBusy(false);
    setAddModal(false);
    setSelectedGame("");
    setDealForm(DEAL_DEFAULTS);
    setTronAddress("");
    window.location.reload();
  }

  async function removeDeal(dealId: number) {
    if (!confirm("Retirer cette game ?")) return;
    await fetch(`/api/games/deals/${dealId}`, { method: "DELETE" });
    setDeals(d => d.filter(x => x.id !== dealId));
  }

  async function deleteTx(id: number) {
    if (!confirm("Supprimer cette transaction ?")) return;
    await fetch(`/api/wallets/${id}`, { method: "DELETE" });
    window.location.reload();
  }

  const summaryForChart = [{
    id: player.id, name: player.name,
    action_pct: deals[0]?.action_pct ?? 50,
    total_deposited: stats.deposited, total_withdrawn: stats.withdrawn,
    net: stats.net, my_pnl: stats.my_pnl,
  }];

  // Average action pct across deals for display
  const avgActionPct = deals.length > 0
    ? Math.round(deals.reduce((s, d) => s + d.action_pct, 0) / deals.length)
    : null;

  return (
    <>
      {/* Back + meta */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
        <Link href="/players" style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>
          <ArrowLeft size={14} /> Retour
        </Link>
        <div style={{ width: 1, height: 16, background: "var(--border)" }} />
        <Badge label={player.status} color={STATUS_COLOR[player.status] ?? "gray"} />
        {player.telegram_handle && (
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>@{player.telegram_handle.replace(/^@/, "")}</span>
        )}
        {avgActionPct !== null && (
          <span style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: "auto" }}>
            Action moy. : <strong style={{ color: "var(--gold)" }}>{avgActionPct}%</strong>
          </span>
        )}
      </div>

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 28 }}>
        <StatCard label="Total Déposé" value={fmt(stats.deposited) + " USDT"} sub="Envoyé au poker app" accent="neutral" icon={<ArrowDownLeft size={18} />} />
        <StatCard label="Total Retiré" value={fmt(stats.withdrawn) + " USDT"} sub="Encaissé" accent="gold" icon={<ArrowUpRight size={18} />} />
        <StatCard label="Net P&L Joueur" value={fmt(stats.net) + " USDT"} sub="Retraits − Dépôts" accent={netAccent} />
        <StatCard label="Mon P&L" value={fmt(stats.my_pnl) + " USDT"} sub="Ma part selon le deal" accent={myAccent} />
      </div>

      {/* Games section */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 24 }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Games & Deals ({deals.length})</span>
          {availableGames.length > 0 && (
            <Btn size="sm" variant="primary" onClick={() => { setSelectedGame(""); setDealForm(DEAL_DEFAULTS); setAddModal(true); }}>
              <Plus size={13} /> Ajouter
            </Btn>
          )}
        </div>
        {deals.length === 0 ? (
          <div style={{ padding: "24px 20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
            Pas encore sur une game
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: 16 }}>
            {deals.map(d => {
              const gc = GAME_COLOR[d.game_name] ?? "var(--text-muted)";
              return (
                <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--bg-elevated)", border: `1px solid ${gc}30`, borderRadius: 10, padding: "10px 14px" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: gc }}>{d.game_name}</div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
                      Action <span style={{ color: "var(--gold)", fontWeight: 600 }}>{d.action_pct}%</span>
                      {d.rakeback_pct > 0 && <> · RB <span style={{ color: "var(--green)", fontWeight: 600 }}>{d.rakeback_pct}%</span></>}
                    </div>
                  </div>
                  <button onClick={() => removeDeal(d.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: "var(--text-dim)", display: "flex", alignItems: "center" }}>
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add game modal */}
      <Modal open={addModal} onClose={() => setAddModal(false)} title="Ajouter à une game">
        {availableGames.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Ce joueur est déjà sur toutes les games.</p>
        ) : (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>Game</label>
              <select value={selectedGame} onChange={e => { setSelectedGame(e.target.value); setTronAddress(""); }}
                style={{ width: "100%", padding: "9px 12px", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 7, color: "var(--text)", fontSize: 14 }}>
                <option value="">Choisir…</option>
                {availableGames.map(g => <option key={g.id} value={String(g.id)}>{g.name}</option>)}
              </select>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>Action %</label>
                <input type="number" min="0" max="100" step="1" value={dealForm.action_pct}
                  onChange={e => setDealForm(f => ({ ...f, action_pct: e.target.value }))}
                  placeholder="50"
                  style={{ width: "100%", padding: "9px 12px", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 7, color: "var(--gold)", fontSize: 14, fontWeight: 600, boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>Rakeback %</label>
                <input type="number" min="0" max="100" step="1" value={dealForm.rakeback_pct}
                  onChange={e => setDealForm(f => ({ ...f, rakeback_pct: e.target.value }))}
                  placeholder="0"
                  style={{ width: "100%", padding: "9px 12px", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 7, color: "var(--green)", fontSize: 14, fontWeight: 600, boxSizing: "border-box" }} />
              </div>
            </div>

            {isTele && (
              <div style={{ marginBottom: 16, padding: "12px 14px", background: "rgba(212,175,55,0.08)", border: "1px solid rgba(212,175,55,0.25)", borderRadius: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--gold)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                  TELE — Wallet requis pour le tracking
                </div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                  Adresse Tron (TRC20) *
                </label>
                <input value={tronAddress} onChange={e => setTronAddress(e.target.value.trim())} placeholder="TXxx..." autoFocus
                  style={{ width: "100%", padding: "9px 12px", background: "var(--bg-elevated)", border: "1px solid rgba(212,175,55,0.4)", borderRadius: 7, color: "var(--text)", fontSize: 13, boxSizing: "border-box" }} />
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>
                  Nécessaire pour le sync blockchain automatique.
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setAddModal(false)}>Annuler</Btn>
              <Btn variant="primary" disabled={!selectedGame || !dealForm.action_pct || (isTele && !tronAddress.trim()) || busy} onClick={addDeal}>
                {busy ? "Ajout…" : "Ajouter"}
              </Btn>
            </div>
          </>
        )}
      </Modal>

      {/* Charts */}
      {transactions.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 28 }}>
          <WalletChartsWrapper data={summaryForChart} transactions={transactions as any} />
        </div>
      )}

      {/* Transaction log */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Transactions ({transactions.length})</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Date", "Game", "Type", "Montant", "Note", ""].map((h, i) => (
                  <th key={i} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {transactions.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 32, textAlign: "center", color: "var(--text-dim)" }}>Aucune transaction</td></tr>
              ) : transactions.map(tx => {
                const isOut = tx.type === "withdrawal";
                const gc = GAME_COLOR[tx.game_name] ?? "var(--text-muted)";
                return (
                  <tr key={tx.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "11px 16px", fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{tx.tx_date}</td>
                    <td style={{ padding: "11px 16px" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: gc, background: gc + "18", padding: "2px 7px", borderRadius: 4 }}>{tx.game_name}</span>
                    </td>
                    <td style={{ padding: "11px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {isOut ? <ArrowUpRight size={14} color="var(--green)" /> : <ArrowDownLeft size={14} color="#f87171" />}
                        <span style={{ fontSize: 12, fontWeight: 600, color: isOut ? "var(--green)" : "#f87171" }}>
                          {isOut ? "Retrait" : "Dépôt"}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: "11px 16px", fontSize: 13, fontWeight: 700, color: isOut ? "var(--green)" : "#f87171", whiteSpace: "nowrap" }}>
                      {isOut ? "+" : "−"}{tx.amount.toLocaleString("fr-FR", { minimumFractionDigits: 2 })} {tx.currency}
                    </td>
                    <td style={{ padding: "11px 16px", fontSize: 12, color: "var(--text-muted)" }}>
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
    </>
  );
}
