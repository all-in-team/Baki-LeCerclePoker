"use client";

import { useState } from "react";
import { ExternalLink, CheckCircle, AlertCircle, Edit2, X, Save, RefreshCw } from "lucide-react";
import Btn from "@/components/Btn";

const TRONSCAN = "https://tronscan.org/#/address/";

function short(addr: string | null) {
  if (!addr) return null;
  return addr.slice(0, 6) + "…" + addr.slice(-6);
}
function fmt(n: number) {
  return (n >= 0 ? "+" : "−") + Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface Player {
  id: number; name: string;
  wallet_game: string | null; wallet_cashout: string | null;
  deal_id: number; action_pct: number; rakeback_pct: number; start_date: string | null;
  total_deposited: number; total_withdrawn: number; net: number; my_pnl: number;
  tx_count: number; last_tx: string | null;
}

function WalletCell({ addr, color, missing }: { addr: string | null; color: string; missing?: string }) {
  if (!addr) return (
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <AlertCircle size={12} color="#f87171" />
      <span style={{ fontSize: 11, color: "#f87171" }}>{missing ?? "Non configuré"}</span>
    </div>
  );
  return (
    <a href={TRONSCAN + addr} target="_blank" rel="noreferrer" title={addr}
      style={{ display: "inline-flex", alignItems: "center", gap: 5, textDecoration: "none" }}>
      <CheckCircle size={12} color={color} />
      <span style={{ fontSize: 12, fontFamily: "monospace", color, fontWeight: 600 }}>{short(addr)}</span>
      <ExternalLink size={10} color={color} style={{ opacity: 0.7 }} />
    </a>
  );
}

export default function TELEClient({ players: initial, walletMere }: { players: Player[]; walletMere: string | null }) {
  const [players, setPlayers] = useState(initial);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<any>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [editVals, setEditVals] = useState({ wallet_game: "", wallet_cashout: "", start_date: "" });

  async function sync() {
    setSyncing(true); setSyncResult(null);
    const res = await fetch("/api/wallets/sync", { method: "POST" });
    const data = await res.json();
    setSyncResult(data);
    setSyncing(false);
    if (data.imported > 0) setTimeout(() => window.location.reload(), 1000);
  }

  function startEdit(p: Player) {
    setEditing(p.id);
    setEditVals({ wallet_game: p.wallet_game ?? "", wallet_cashout: p.wallet_cashout ?? "", start_date: p.start_date ?? "" });
  }

  async function saveEdit(p: Player) {
    const newStartDate = editVals.start_date || null;
    await Promise.all([
      fetch(`/api/players/${p.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tron_address: editVals.wallet_game || null,
          tele_wallet_cashout: editVals.wallet_cashout || null,
        }),
      }),
      newStartDate !== p.start_date
        ? fetch(`/api/games/deals/${p.deal_id}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ start_date: newStartDate }),
          })
        : Promise.resolve(),
    ]);
    setPlayers(ps => ps.map(pl => pl.id === p.id
      ? { ...pl, wallet_game: editVals.wallet_game || null, wallet_cashout: editVals.wallet_cashout || null, start_date: newStartDate }
      : pl
    ));
    setEditing(null);
  }

  const totalPnl       = players.reduce((s, p) => s + p.my_pnl, 0);
  const totalDeposited = players.reduce((s, p) => s + p.total_deposited, 0);
  const totalWithdrawn = players.reduce((s, p) => s + p.total_withdrawn, 0);
  const missingCashout = players.filter(p => p.wallet_game && !p.wallet_cashout).length;

  return (
    <>
      {/* WALLET MERE + Sync */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#4ade80", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>WALLET MÈRE (global)</div>
          {walletMere ? (
            <a href={TRONSCAN + walletMere} target="_blank" rel="noreferrer"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none" }}>
              <CheckCircle size={12} color="#4ade80" />
              <span style={{ fontSize: 12, fontFamily: "monospace", color: "#4ade80", fontWeight: 600 }}>{walletMere}</span>
              <ExternalLink size={10} color="#4ade80" />
            </a>
          ) : (
            <span style={{ fontSize: 12, color: "#f87171" }}>Non configuré — Settings</span>
          )}
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          {missingCashout > 0 && (
            <span style={{ fontSize: 11, color: "#fb923c", background: "rgba(251,146,60,0.10)", border: "1px solid rgba(251,146,60,0.25)", padding: "4px 10px", borderRadius: 6 }}>
              ⚠️ {missingCashout} joueur{missingCashout > 1 ? "s" : ""} sans WALLET CASHOUT — cashouts non trackés
            </span>
          )}
          <Btn variant="secondary" onClick={sync} disabled={syncing}>
            <RefreshCw size={13} style={{ animation: syncing ? "spin 1s linear infinite" : "none" }} />
            {syncing ? "Sync…" : "Sync TELE"}
          </Btn>
          {syncResult && (
            <div style={{ fontSize: 11, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontWeight: 600, color: syncResult.imported > 0 ? "var(--green)" : "var(--text-muted)" }}>
                {syncResult.imported > 0 ? `+${syncResult.imported} importés (${syncResult.deposits}↓ ${syncResult.cashouts}↑)` : "Déjà à jour"}
              </span>
              {syncResult.results?.filter((r: any) => r.error).map((r: any) => (
                <span key={r.player} style={{ color: "#f87171" }}>{r.player}: {r.error}</span>
              ))}
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 20 }}>
        {[
          { label: "Total Déposé", value: totalDeposited.toFixed(2) + " USDT", color: "#f87171" },
          { label: "Total Cashout", value: totalWithdrawn.toFixed(2) + " USDT", color: "var(--green)" },
          { label: "Mon P&L Total", value: fmt(totalPnl) + " USDT", color: totalPnl >= 0 ? "var(--green)" : "#f87171" },
        ].map(k => (
          <div key={k.label} style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 18px" }}>
            <div style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>{k.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Players table */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{players.length} joueur{players.length !== 1 ? "s" : ""} sur TELE</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Joueur", "WALLET GAME", "WALLET CASHOUT", "Action %", "Début", "Déposé", "Cashout", "Mon P&L", "Tx", "Dernière TX", ""].map(h => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {players.length === 0 ? (
                <tr><td colSpan={11} style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
                  Aucun joueur sur TELE — ajoute un deal TELE depuis le CRM.
                </td></tr>
              ) : players.map((p, i) => {
                const isEditing = editing === p.id;
                const pnlColor = p.my_pnl > 0 ? "var(--green)" : p.my_pnl < 0 ? "#f87171" : "var(--text-muted)";
                return (
                  <tr key={p.id} style={{ borderBottom: i < players.length - 1 ? "1px solid var(--border)" : "none", background: isEditing ? "rgba(167,139,250,0.04)" : "transparent" }}>
                    <td style={{ padding: "12px 14px", fontSize: 13, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap" }}>{p.name}</td>

                    <td style={{ padding: "12px 14px" }}>
                      {isEditing ? (
                        <input value={editVals.wallet_game} onChange={e => setEditVals(v => ({ ...v, wallet_game: e.target.value }))}
                          placeholder="TXxxx..."
                          style={{ width: 160, padding: "5px 8px", fontSize: 11, fontFamily: "monospace", background: "var(--bg-elevated)", border: "1px solid #38bdf8", borderRadius: 6, color: "#38bdf8" }} />
                      ) : (
                        <WalletCell addr={p.wallet_game} color="#38bdf8" missing="Pas de Wallet Game" />
                      )}
                    </td>

                    <td style={{ padding: "12px 14px" }}>
                      {isEditing ? (
                        <input value={editVals.wallet_cashout} onChange={e => setEditVals(v => ({ ...v, wallet_cashout: e.target.value }))}
                          placeholder="TXxxx... (Binance TRC20 ou perso)"
                          style={{ width: 200, padding: "5px 8px", fontSize: 11, fontFamily: "monospace", background: "var(--bg-elevated)", border: "1px solid #fb923c", borderRadius: 6, color: "#fb923c" }} />
                      ) : (
                        <WalletCell addr={p.wallet_cashout} color="#fb923c" missing="À configurer" />
                      )}
                    </td>

                    <td style={{ padding: "12px 14px", fontSize: 12, color: "var(--gold)", fontWeight: 700, whiteSpace: "nowrap" }}>
                      {p.action_pct}%{p.rakeback_pct > 0 ? ` · ${p.rakeback_pct}% RB` : ""}
                    </td>
                    <td style={{ padding: "12px 14px", whiteSpace: "nowrap" }}>
                      {isEditing ? (
                        <input type="date" value={editVals.start_date}
                          onChange={e => setEditVals(v => ({ ...v, start_date: e.target.value }))}
                          style={{ padding: "5px 8px", fontSize: 11, background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" }} />
                      ) : (
                        <span style={{ fontSize: 11, color: p.start_date ? "var(--text)" : "var(--text-dim)" }}>
                          {p.start_date ?? "—"}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "12px 14px", fontSize: 12, color: "#f87171", whiteSpace: "nowrap" }}>{p.total_deposited.toFixed(2)}</td>
                    <td style={{ padding: "12px 14px", fontSize: 12, color: "var(--green)", whiteSpace: "nowrap" }}>{p.total_withdrawn.toFixed(2)}</td>
                    <td style={{ padding: "12px 14px", fontSize: 13, fontWeight: 700, color: pnlColor, whiteSpace: "nowrap" }}>{fmt(p.my_pnl)}</td>
                    <td style={{ padding: "12px 14px", fontSize: 12, color: "var(--text-dim)" }}>{p.tx_count}</td>
                    <td style={{ padding: "12px 14px", fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{p.last_tx ?? "—"}</td>

                    <td style={{ padding: "12px 14px" }}>
                      {isEditing ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => saveEdit(p)} style={{ background: "rgba(34,197,94,0.12)", border: "none", borderRadius: 5, padding: "5px 8px", cursor: "pointer", color: "var(--green)", display: "flex", alignItems: "center" }}>
                            <Save size={13} />
                          </button>
                          <button onClick={() => setEditing(null)} style={{ background: "var(--bg-elevated)", border: "none", borderRadius: 5, padding: "5px 8px", cursor: "pointer", color: "var(--text-muted)", display: "flex", alignItems: "center" }}>
                            <X size={13} />
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => startEdit(p)}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 4, display: "flex", alignItems: "center" }}
                          onMouseEnter={e => (e.currentTarget.style.color = "#fb923c")}
                          onMouseLeave={e => (e.currentTarget.style.color = "var(--text-dim)")}>
                          <Edit2 size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 16, marginTop: 14, flexWrap: "wrap" }}>
        {[
          { color: "#38bdf8", label: "WALLET GAME", desc: "Adresse in-app — dépôts entrants" },
          { color: "#fb923c", label: "WALLET CASHOUT", desc: "Adresse fixe du joueur — Binance TRC20 ou wallet perso — cashouts entrants" },
          { color: "#4ade80", label: "WALLET MÈRE", desc: "Tréso app — source de tous les cashouts" },
        ].map(({ color, label, desc }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, color: "var(--text-dim)" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
            <strong style={{ color }}>{label}</strong> — {desc}
          </div>
        ))}
      </div>
    </>
  );
}
