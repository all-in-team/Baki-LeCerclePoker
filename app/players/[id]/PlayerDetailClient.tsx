"use client";

import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Trash2, Plus, X } from "lucide-react";
import StatCard from "@/components/StatCard";
import Btn from "@/components/Btn";
import Modal from "@/components/Modal";
import WalletChartsWrapper from "@/app/akpoker/pnl/WalletChartsWrapper";

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
  start_date: string | null;
}

interface Game { id: number; name: string; }
interface Stats { deposited: number; withdrawn: number; net: number; my_pnl: number; }
interface GameId { id: number; game_id: number; game_name: string; external_id: string; }

const GAME_COLOR: Record<string, string> = {
  TELE: "#a78bfa", Wepoker: "#38bdf8", Xpoker: "#fb923c", ClubGG: "#4ade80",
};

function fmt(n: number) {
  const abs = Math.abs(n);
  const s = abs >= 1000 ? (abs / 1000).toFixed(2) + "k" : abs.toFixed(2);
  return (n < 0 ? "−" : n > 0 ? "+" : "") + s;
}

const DEAL_DEFAULTS = { action_pct: "50", rakeback_pct: "0", start_date: "" };

export default function PlayerDetailClient({ player, transactions, gameDeals: initialDeals, allGames, stats, gameIds: initialGameIds }: {
  player: Player; transactions: Tx[]; gameDeals: GameDeal[]; allGames: Game[]; stats: Stats;
  gameIds: GameId[];
}) {
  const netAccent = stats.net > 0 ? "green" : stats.net < 0 ? "red" : "neutral";
  const myAccent = stats.my_pnl > 0 ? "green" : stats.my_pnl < 0 ? "red" : "neutral";
  const [deals, setDeals] = useState(initialDeals);
  const [gameIds, setGameIds] = useState(initialGameIds);
  const [addModal, setAddModal] = useState(false);
  const [selectedGame, setSelectedGame] = useState("");
  const [dealForm, setDealForm] = useState(DEAL_DEFAULTS);
  const [tronAddress, setTronAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [newIdDraft, setNewIdDraft] = useState("");
  const [expandedGame, setExpandedGame] = useState<number | null>(null);

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
        start_date: dealForm.start_date || null,
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
    const res = await fetch(`/api/games/deals/${dealId}`, { method: "DELETE" });
    // L'API refuse NEXAPOKER en 409. Sans ce test, l'écran retirait la ligne alors que le
    // deal était toujours en base : l'écran mentait sur une écriture qui n'a pas eu lieu.
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      alert(j?.error ?? "Suppression refusée.");
      return;
    }
    setDeals(d => d.filter(x => x.id !== dealId));
  }

  async function addGameId(gameId: number) {
    const val = newIdDraft.trim();
    if (!val) return;
    const res = await fetch(`/api/players/${player.id}/game-ids`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game_id: gameId, external_id: val }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const gameName = allGames.find(g => g.id === gameId)?.name ?? "";
    setGameIds(ids => [...ids, { id: data.id, game_id: gameId, game_name: gameName, external_id: val }]);
    setNewIdDraft("");
  }

  async function removeGameId(rowId: number) {
    await fetch(`/api/players/${player.id}/game-ids`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game_id_row_id: rowId }),
    });
    setGameIds(ids => ids.filter(x => x.id !== rowId));
  }

  async function updateDeal(dealId: number, field: string, value: unknown) {
    const res = await fetch(`/api/games/deals/${dealId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    // Idem : sur un 409 NEXAPOKER, afficher la nouvelle valeur ferait croire que la borne
    // start_date a bougé — or c'est elle qui borne dix requêtes d'argent.
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      alert(j?.error ?? "Modification refusée.");
      return;
    }
    setDeals(ds => ds.map(d => d.id === dealId ? { ...d, [field]: value } : d));
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
      {/* Flux wallet — lifetime, toutes games. L'en-tête d'identité et le total agence
          faisant référence sont au-dessus (rendus par la page). */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 28, marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
          Flux wallet · lifetime
        </span>
        {avgActionPct !== null && (
          <span style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: "auto" }}>
            Action moy. : <strong style={{ color: "var(--gold)" }}>{avgActionPct}%</strong>
          </span>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 10 }}>
        <StatCard label="Total Déposé" value={fmt(stats.deposited) + " USDT"} sub="Envoyé au poker app" accent="neutral" icon={<ArrowDownLeft size={18} />} />
        <StatCard label="Total Retiré" value={fmt(stats.withdrawn) + " USDT"} sub="Encaissé" accent="gold" icon={<ArrowUpRight size={18} />} />
        <StatCard label="Net P&L Joueur" value={fmt(stats.net) + " USDT"} sub="Retraits − Dépôts" accent={netAccent} />
      </div>
      {/* my_pnl vient de getPlayerWalletStats : action appliquée aux SEULS mouvements wallet
          (ni rakeback, ni reports, ni grindhouse).
          ⚠️ Les deux chiffres n'ont PAS le même périmètre de games : l'Agency cut vient de
          getPlayerPnLAllGames, borné à AGENCY_GAMES (queries.ts) — NEXAPOKER n'y est pas.
          my_pnl, lui, joint wallet_transactions sans filtre de game et inclut donc NEXA.
          Les désigner l'un comme « référence » de l'autre serait faux : on dit le périmètre. */}
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 28 }}>
        Part action sur ces flux wallet :{" "}
        <strong style={{ color: myAccent === "green" ? "var(--green)" : myAccent === "red" ? "#EF4444" : "var(--text-muted)" }}>
          {fmt(stats.my_pnl)} USDT
        </strong>
        {" — "}toutes games confondues (NEXAPOKER compris), hors rakeback / reports / grindhouse.
        Périmètre différent de l'Agency cut ci-dessus, qui ne couvre pas NEXAPOKER : les deux
        ne s'additionnent pas et ne se recoupent pas.
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
          <div style={{ display: "flex", flexDirection: "column" }}>
            {deals.map(d => {
              const gc = GAME_COLOR[d.game_name] ?? "var(--text-muted)";
              const ids = gameIds.filter(gi => gi.game_id === d.game_id);
              const isOpen = expandedGame === d.game_id;
              return (
                <div key={d.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  {/* Clickable game row */}
                  <div
                    onClick={() => { setExpandedGame(isOpen ? null : d.game_id); setNewIdDraft(""); }}
                    style={{ padding: "14px 20px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer", userSelect: "none", transition: "background 0.1s", background: isOpen ? `${gc}08` : "transparent" }}
                    onMouseEnter={e => (e.currentTarget.style.background = `${gc}0d`)}
                    onMouseLeave={e => (e.currentTarget.style.background = isOpen ? `${gc}08` : "transparent")}
                  >
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: gc, flexShrink: 0 }} />
                    <span style={{ fontSize: 13, fontWeight: 700, color: gc, minWidth: 68 }}>{d.game_name}</span>
                    <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                      Action <span style={{ color: "var(--gold)", fontWeight: 600 }}>{d.action_pct}%</span>
                      {d.rakeback_pct > 0 && <> · RB <span style={{ color: "var(--green)", fontWeight: 600 }}>{d.rakeback_pct}%</span></>}
                      {d.start_date && <> · Début <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{d.start_date}</span></>}
                      {/* Sur NEXAPOKER cette ligne est un CACHE de la période courante : la
                          vérité est historisée par période dans nexa_player_action_shares, et
                          le RB n'est pas mirroité du tout (il vaudrait 0 à tort). L'API refuse
                          l'édition ; il faut aussi que l'écran cesse de la présenter comme un fait. */}
                      {d.game_name.toUpperCase() === "NEXAPOKER" && (
                        <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>
                          {" "}· période courante — historisé sur la page NEXAPOKER
                        </span>
                      )}
                    </span>
                    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
                      {ids.length > 0
                        ? <span style={{ fontSize: 11, fontWeight: 600, color: gc, background: `${gc}18`, padding: "2px 7px", borderRadius: 10 }}>{ids.length} compte{ids.length > 1 ? "s" : ""}</span>
                        : <span style={{ fontSize: 11, color: "var(--text-dim)" }}>0 compte</span>
                      }
                      <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{isOpen ? "▲" : "▼"}</span>
                      <button onClick={e => { e.stopPropagation(); removeDeal(d.id); }}
                        style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: "var(--text-dim)", display: "flex", alignItems: "center" }}>
                        <X size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Expanded: IDs + add */}
                  {isOpen && (
                    <div style={{ padding: "12px 20px 16px 36px", background: "var(--bg-surface)", borderTop: `1px solid ${gc}25` }}>
                      {/* Start date */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                        <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", whiteSpace: "nowrap" }}>Date de début</label>
                        <input type="date" value={d.start_date ?? ""}
                          onChange={e => updateDeal(d.id, "start_date", e.target.value || null)}
                          style={{ padding: "5px 8px", borderRadius: 6, fontSize: 12, background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text)", outline: "none" }} />
                        {d.start_date && (
                          <button onClick={() => updateDeal(d.id, "start_date", null)}
                            style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: "var(--text-dim)", display: "flex", alignItems: "center", fontSize: 11 }}>
                            <X size={10} />
                          </button>
                        )}
                        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>Rapports avant cette date ignorés</span>
                      </div>
                      {/* ID badges */}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                        {ids.length === 0 && (
                          <span style={{ fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>Aucun compte enregistré</span>
                        )}
                        {ids.map(gi => (
                          <div key={gi.id} style={{ display: "flex", alignItems: "center", gap: 6, background: `${gc}14`, border: `1px solid ${gc}35`, borderRadius: 7, padding: "5px 10px" }}>
                            <span style={{ fontSize: 12, fontFamily: "monospace", color: gc, fontWeight: 600 }}>{gi.external_id}</span>
                            <button onClick={() => removeGameId(gi.id)}
                              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "var(--text-dim)", display: "flex", lineHeight: 1 }}>
                              <X size={10} />
                            </button>
                          </div>
                        ))}
                      </div>
                      {/* Add row */}
                      <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                        <input autoFocus
                          value={newIdDraft}
                          onChange={e => setNewIdDraft(e.target.value)}
                          onKeyDown={e => e.key === "Enter" && addGameId(d.game_id)}
                          placeholder={`Ajouter un ID ${d.game_name}…`}
                          style={{ flex: 1, padding: "7px 10px", borderRadius: 7, fontSize: 12, fontFamily: "monospace", background: "var(--bg-elevated)", border: `1px solid ${gc}45`, color: "var(--text)", outline: "none" }} />
                        <button onClick={() => addGameId(d.game_id)}
                          style={{ padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, background: `${gc}20`, border: `1px solid ${gc}50`, color: gc, cursor: "pointer", whiteSpace: "nowrap" }}>
                          + Ajouter
                        </button>
                      </div>
                    </div>
                  )}
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

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>Date de début</label>
              <input type="date" value={dealForm.start_date}
                onChange={e => setDealForm(f => ({ ...f, start_date: e.target.value }))}
                style={{ width: "100%", padding: "9px 12px", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 7, color: "var(--text)", fontSize: 14, boxSizing: "border-box" }} />
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                Les rapports avant cette date ne seront pas comptés pour ce joueur
              </div>
            </div>

            {isTele && (
              <div style={{ marginBottom: 16, padding: "12px 14px", background: "rgba(212,175,55,0.08)", border: "1px solid rgba(212,175,55,0.25)", borderRadius: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--gold)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                  TELE — Wallet Game
                </div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                  Adresse TRC20 du compte TELE *
                </label>
                <input value={tronAddress} onChange={e => setTronAddress(e.target.value.trim())} placeholder="TXxx..." autoFocus
                  style={{ width: "100%", padding: "9px 12px", background: "var(--bg-elevated)", border: "1px solid rgba(212,175,55,0.4)", borderRadius: 7, color: "var(--text)", fontSize: 13, boxSizing: "border-box" }} />
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>
                  Le WALLET CASHOUT se configure dans la vue TELE.
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
                    {/* Sens agence (règle universelle, Baki 2026-07-25) : un dépôt arrive
                        chez nous → vert + · un retrait part de la wallet mère → rouge −. */}
                    <td style={{ padding: "11px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {isOut ? <ArrowUpRight size={14} color="#f87171" /> : <ArrowDownLeft size={14} color="var(--green)" />}
                        <span style={{ fontSize: 12, fontWeight: 600, color: isOut ? "#f87171" : "var(--green)" }}>
                          {isOut ? "Retrait" : "Dépôt"}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: "11px 16px", fontSize: 13, fontWeight: 700, color: isOut ? "#f87171" : "var(--green)", whiteSpace: "nowrap" }}>
                      {isOut ? "−" : "+"}{tx.amount.toLocaleString("fr-FR", { minimumFractionDigits: 2 })} {tx.currency}
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
