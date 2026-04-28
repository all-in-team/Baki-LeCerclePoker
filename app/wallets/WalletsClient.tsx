"use client";

import { Fragment, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Plus, Trash2, Wallet, TrendingUp, RefreshCw, Settings2, ExternalLink, Save, X, Pencil, ChevronDown, ChevronRight } from "lucide-react";
import StatCard from "@/components/StatCard";
import Btn from "@/components/Btn";
import Modal from "@/components/Modal";
import WalletChartsWrapper from "./WalletChartsWrapper";

interface PlayerGameRow {
  deal_id: number;
  player_id: number; player_name: string;
  game_id: number; game_name: string;
  action_pct: number; rakeback_pct: number;
  total_deposited: number; total_withdrawn: number; net: number; my_pnl: number;
}

interface WalletTx {
  id: number; player_id: number; game_id: number | null;
  type: "deposit" | "withdrawal"; amount: number; currency: string;
  note: string | null; tx_date: string; player_name: string; game_name: string;
  tron_tx_hash: string | null; counterparty_address: string | null;
}

interface Player { id: number; name: string; tron_address?: string | null; tele_wallet_cashout?: string | null; }
interface Game { id: number; name: string; }
interface KPIs { total_deposited: number; total_withdrawn: number; total_net: number; my_total_pnl: number; }

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
  initialSummary, kpis, initialTransactions, players, games, cashoutsByPlayer = {},
}: {
  initialSummary: PlayerGameRow[];
  kpis: KPIs;
  initialTransactions: WalletTx[];
  players: Player[];
  games: Game[];
  cashoutsByPlayer?: Record<number, { id: number; address: string; label: string | null }[]>;
}) {
  const [syncing, setSyncing] = useState(false);
  const [addPlayerModal, setAddPlayerModal] = useState(false);
  const [addPlayerBusy, setAddPlayerBusy] = useState(false);
  const [selectedPlayerId, setSelectedPlayerId] = useState("");
  const [newPlayer, setNewPlayer] = useState({
    name: "", telegram_handle: "", action_pct: "40", rakeback_pct: "0",
    wallet_game: "", wallet_cashout: "",
  });
  const isNewPlayer = selectedPlayerId === "__new__";
  const [syncResult, setSyncResult] = useState<{ imported: number; mode?: string; results: { player: string; imported: number; deposits: number; withdrawals: number; total_fetched?: number; skipped?: number; error?: string }[] } | null>(null);
  const [walletModal, setWalletModal] = useState(false);
  const [teleConfig, setTeleConfig] = useState<{ id: number; name: string; wallet_game: string | null; wallet_cashout: string | null }[]>([]);
  const [editingWallet, setEditingWallet] = useState<number | null>(null);
  const [editWalletVals, setEditWalletVals] = useState({ wallet_game: "", wallet_cashout: "" });
  const [walletMere, setWalletMere] = useState<string | null>(null);
  const [editingAction, setEditingAction] = useState<number | null>(null);
  const [actionVal, setActionVal] = useState("");
  const [editingRb, setEditingRb] = useState<number | null>(null);
  const [rbVal, setRbVal] = useState("");
  const [expandedWallet, setExpandedWallet] = useState<number | null>(null);
  const [walletInlineVals, setWalletInlineVals] = useState<{ wallet_game: string; cashouts: string[] }>({ wallet_game: "", cashouts: [""] });
  const [expandedTx, setExpandedTx] = useState<number | null>(null);

  async function openWalletConfig(focusPlayerId?: number) {
    const [playersRes, settingsRes] = await Promise.all([
      fetch("/api/players").then(r => r.json()),
      fetch("/api/settings").then(r => r.json()),
    ]);
    const cfg = playersRes.map((p: any) => ({ id: p.id, name: p.name, wallet_game: p.tron_address ?? null, wallet_cashout: p.tele_wallet_cashout ?? null }));
    setTeleConfig(cfg);
    setWalletMere(settingsRes.tele_wallet_mere ?? null);
    if (focusPlayerId !== undefined) {
      const target = cfg.find((p: any) => p.id === focusPlayerId);
      if (target) {
        setEditingWallet(focusPlayerId);
        setEditWalletVals({ wallet_game: target.wallet_game ?? "", wallet_cashout: target.wallet_cashout ?? "" });
      }
    }
    setWalletModal(true);
  }

  async function saveAction(dealId: number) {
    const v = Number(actionVal);
    if (isNaN(v) || v < 0 || v > 100) {
      alert("Action % doit être un nombre entre 0 et 100");
      return;
    }
    const res = await fetch(`/api/games/deals/${dealId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action_pct: v }),
    });
    if (res.ok) window.location.reload();
  }

  async function saveRb(dealId: number) {
    const v = Number(rbVal);
    if (isNaN(v) || v < 0 || v > 100) {
      alert("RB % doit être un nombre entre 0 et 100");
      return;
    }
    const res = await fetch(`/api/games/deals/${dealId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rakeback_pct: v }),
    });
    if (res.ok) window.location.reload();
  }

  function openInlineWallet(p: Player) {
    setExpandedWallet(p.id);
    const existing = cashoutsByPlayer[p.id]?.map(c => c.address) ?? [];
    setWalletInlineVals({
      wallet_game: p.tron_address ?? "",
      cashouts: existing.length > 0 ? existing : [""],
    });
  }

  async function saveInlineWallet(playerId: number) {
    const game = walletInlineVals.wallet_game.trim();
    // 1) wallet_game (legacy column on players)
    await fetch(`/api/players/${playerId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tron_address: game || null }),
    });
    // 2) cashouts (new multi-table; mirrors first to legacy tele_wallet_cashout)
    const cashoutPayload = walletInlineVals.cashouts
      .map(a => ({ address: a.trim() }))
      .filter(a => a.address.length > 0);
    const res = await fetch(`/api/players/${playerId}/cashouts`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: cashoutPayload }),
    });
    if (res.ok) window.location.reload();
  }

  async function saveWallet(playerId: number) {
    const game = editWalletVals.wallet_game.trim();
    const cashout = editWalletVals.wallet_cashout.trim();
    await fetch(`/api/players/${playerId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tron_address: game || null, tele_wallet_cashout: cashout || null }),
    });
    setTeleConfig(cfg => cfg.map(p => p.id === playerId
      ? { ...p, wallet_game: game || null, wallet_cashout: cashout || null }
      : p
    ));
    setEditingWallet(null);
  }

  async function syncWallets() {
    setSyncing(true); setSyncResult(null);
    try {
      const res = await fetch("/api/wallets/sync", { method: "POST" });
      const data = await res.json();
      setSyncResult(data);
      if (data.imported > 0) setTimeout(() => window.location.reload(), 1200);
    } finally { setSyncing(false); }
  }

  async function deleteDeal(dealId: number, playerName: string) {
    if (!confirm(`Retirer "${playerName}" de TELE AKPOKER ?\n\nLes transactions existantes restent en base.`)) return;
    await fetch(`/api/games/deals/${dealId}`, { method: "DELETE" });
    window.location.reload();
  }

  function onSelectPlayer(id: string) {
    setSelectedPlayerId(id);
    if (!id || id === "__new__") {
      setNewPlayer(np => ({ ...np, wallet_game: "", wallet_cashout: "" }));
      return;
    }
    const p = players.find(x => x.id === Number(id));
    if (p) {
      setNewPlayer(np => ({
        ...np,
        wallet_game: p.tron_address ?? "",
        wallet_cashout: p.tele_wallet_cashout ?? "",
      }));
    }
  }

  async function addNewPlayer() {
    const teleGame = games.find(g => g.name === "TELE");
    if (!teleGame) { alert("TELE game introuvable — contacte l'admin"); return; }
    const action = Number(newPlayer.action_pct);
    const rb = Number(newPlayer.rakeback_pct);
    if (isNaN(action) || action < 0 || action > 100) { alert("Action % invalide"); return; }
    if (isNaN(rb) || rb < 0 || rb > 100) { alert("RB % invalide"); return; }

    let playerId: number;

    setAddPlayerBusy(true);
    try {
      if (!isNewPlayer) {
        if (!selectedPlayerId) { alert("Sélectionne un joueur"); return; }
        playerId = Number(selectedPlayerId);
      } else {
        if (!newPlayer.name.trim()) { alert("Nom requis"); return; }
        const contact = newPlayer.telegram_handle.trim();
        if (!contact) { alert("Telegram handle ou numéro requis pour l'intégration au bot"); return; }
        // Phone if starts with + or contains only digits/spaces; otherwise handle
        const isPhone = /^\+/.test(contact) || /^[\d\s-]+$/.test(contact);
        const body: Record<string, unknown> = { name: newPlayer.name.trim(), tier: "A" };
        if (isPhone) {
          body.telegram_phone = contact.replace(/[\s-]/g, "");
        } else {
          body.telegram_handle = contact.replace(/^@/, "");
        }
        const playerRes = await fetch("/api/players", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!playerRes.ok) { alert("Erreur création joueur"); return; }
        const json = await playerRes.json();
        playerId = json.id;
      }

      if (newPlayer.wallet_game.trim()) {
        await fetch(`/api/players/${playerId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tron_address: newPlayer.wallet_game.trim() }),
        });
      }
      if (newPlayer.wallet_cashout.trim()) {
        await fetch(`/api/players/${playerId}/cashouts`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ addresses: [{ address: newPlayer.wallet_cashout.trim() }] }),
        });
      }
      await fetch("/api/games/deals", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_id: playerId, game_id: teleGame.id, action_pct: action, rakeback_pct: rb }),
      });
      window.location.reload();
    } finally {
      setAddPlayerBusy(false);
    }
  }

  const myPnlAccent: "green" | "red" | "neutral" = kpis.my_total_pnl > 0 ? "green" : kpis.my_total_pnl < 0 ? "red" : "neutral";
  const netAccent: "green" | "red" | "neutral" = kpis.total_net > 0 ? "green" : kpis.total_net < 0 ? "red" : "neutral";

  // One row per player (defensive — in practice each player has at most one TELE deal)
  const summaryByPlayer = Object.values(
    initialSummary.reduce<Record<number, PlayerGameRow>>((acc, r) => {
      if (!acc[r.player_id]) {
        acc[r.player_id] = { ...r };
      } else {
        acc[r.player_id].total_deposited += r.total_deposited;
        acc[r.player_id].total_withdrawn += r.total_withdrawn;
        acc[r.player_id].net += r.net;
        acc[r.player_id].my_pnl += r.my_pnl;
      }
      return acc;
    }, {})
  ).sort((a, b) => b.my_pnl - a.my_pnl);

  // Aggregate per player for charts
  const chartData = summaryByPlayer.map(r => ({
    id: r.player_id, name: r.player_name, action_pct: r.action_pct,
    total_deposited: r.total_deposited, total_withdrawn: r.total_withdrawn, net: r.net, my_pnl: r.my_pnl,
  }));

  // Scope transactions to only the players currently in the TELE table
  const listedPlayerIds = new Set(summaryByPlayer.map(r => r.player_id));
  const scopedTransactions = initialTransactions.filter(t => listedPlayerIds.has(t.player_id));

  return (
    <>
      {/* Sync TELE */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        <Btn variant="secondary" onClick={syncWallets} disabled={syncing}>
          <RefreshCw size={14} style={{ animation: syncing ? "spin 1s linear infinite" : "none" }} />
          {syncing ? "Sync en cours…" : "Sync TELE"}
        </Btn>
        <Btn variant="secondary" onClick={() => openWalletConfig()}>
          <Settings2 size={14} /> Config Wallets
        </Btn>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Scanne la blockchain pour les wallets TELE</span>
        {syncResult && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 6, background: syncResult.imported > 0 ? "rgba(34,197,94,0.12)" : "rgba(136,136,160,0.10)", color: syncResult.imported > 0 ? "var(--green)" : "var(--text-muted)" }}>
              {syncResult.imported > 0 ? `+${syncResult.imported} importés` : "Déjà à jour"}
              {syncResult.mode && <span style={{ fontWeight: 400, marginLeft: 6 }}>· {syncResult.mode === "3-wallet" ? "mode précis" : "mode direction"}</span>}
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

      {/* Summary — one row per player */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 28 }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Joueurs TELE AKPOKER</span>
          <Btn variant="primary" size="sm" onClick={() => setAddPlayerModal(true)}>
            <Plus size={14} /> Ajouter joueur
          </Btn>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Joueur", "Net P&L", "Agency P&L", "Action %", "RB %", "Wallet", ""].map((h, i) => (
                  <th key={i} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summaryByPlayer.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
                  Aucun joueur TELE — ajoute un deal TELE à un joueur depuis son profil
                </td></tr>
              ) : summaryByPlayer.map(row => {
                const netC = row.net > 0 ? "var(--green)" : row.net < 0 ? "#f87171" : "var(--text-muted)";
                const myC = row.my_pnl > 0 ? "var(--green)" : row.my_pnl < 0 ? "#f87171" : "var(--text-muted)";
                const isEditingAction = editingAction === row.deal_id;
                const isEditingRb = editingRb === row.deal_id;
                const isExpanded = expandedWallet === row.player_id;
                const isTxOpen = expandedTx === row.player_id;
                const player = players.find(p => p.id === row.player_id);
                const walletGame = player?.tron_address ?? null;
                const playerTxs = scopedTransactions.filter(t => t.player_id === row.player_id);
                const rowOpen = isExpanded || isTxOpen;
                return (
                  <Fragment key={row.player_id}>
                  <tr style={{ borderBottom: rowOpen ? "none" : "1px solid var(--border)" }}>
                    <td style={{ padding: "12px 16px" }}>
                      <button
                        onClick={() => setExpandedTx(isTxOpen ? null : row.player_id)}
                        style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: 0, background: "transparent", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--text)" }}
                        onMouseEnter={e => (e.currentTarget.style.color = "var(--green)")}
                        onMouseLeave={e => (e.currentTarget.style.color = "var(--text)")}>
                        {isTxOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {row.player_name}
                      </button>
                    </td>
                    <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: netC }}>{row.net === 0 ? "—" : fmt(row.net)}</td>
                    <td style={{ padding: "12px 16px", fontSize: 14, fontWeight: 700, color: myC }}>{row.my_pnl === 0 ? "—" : fmt(row.my_pnl)}</td>
                    <td style={{ padding: "12px 16px" }}>
                      {isEditingAction ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <input
                            type="number" min="0" max="100" step="0.5"
                            value={actionVal}
                            onChange={e => setActionVal(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter") saveAction(row.deal_id);
                              if (e.key === "Escape") setEditingAction(null);
                            }}
                            autoFocus
                            style={{ width: 64, padding: "4px 7px", fontSize: 12, fontWeight: 600, background: "var(--bg-elevated)", border: "1px solid var(--gold)", borderRadius: 4, color: "var(--gold)", outline: "none" }}
                          />
                          <button onClick={() => saveAction(row.deal_id)} style={{ display: "flex", alignItems: "center", padding: 4, borderRadius: 4, background: "rgba(34,197,94,0.12)", color: "var(--green)", border: "1px solid rgba(34,197,94,0.3)", cursor: "pointer" }}><Save size={12} /></button>
                          <button onClick={() => setEditingAction(null)} style={{ display: "flex", alignItems: "center", padding: 4, borderRadius: 4, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}><X size={12} /></button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setEditingAction(row.deal_id); setActionVal(String(row.action_pct)); }}
                          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 5, background: "transparent", border: "1px solid transparent", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--gold)" }}
                          onMouseEnter={e => (e.currentTarget.style.borderColor = "var(--border)")}
                          onMouseLeave={e => (e.currentTarget.style.borderColor = "transparent")}>
                          {row.action_pct}%
                          <Pencil size={11} style={{ color: "var(--text-dim)" }} />
                        </button>
                      )}
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      {isEditingRb ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <input
                            type="number" min="0" max="100" step="0.5"
                            value={rbVal}
                            onChange={e => setRbVal(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter") saveRb(row.deal_id);
                              if (e.key === "Escape") setEditingRb(null);
                            }}
                            autoFocus
                            style={{ width: 64, padding: "4px 7px", fontSize: 12, fontWeight: 600, background: "var(--bg-elevated)", border: "1px solid #38bdf8", borderRadius: 4, color: "#38bdf8", outline: "none" }}
                          />
                          <button onClick={() => saveRb(row.deal_id)} style={{ display: "flex", alignItems: "center", padding: 4, borderRadius: 4, background: "rgba(34,197,94,0.12)", color: "var(--green)", border: "1px solid rgba(34,197,94,0.3)", cursor: "pointer" }}><Save size={12} /></button>
                          <button onClick={() => setEditingRb(null)} style={{ display: "flex", alignItems: "center", padding: 4, borderRadius: 4, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}><X size={12} /></button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setEditingRb(row.deal_id); setRbVal(String(row.rakeback_pct)); }}
                          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 5, background: "transparent", border: "1px solid transparent", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#38bdf8" }}
                          onMouseEnter={e => (e.currentTarget.style.borderColor = "var(--border)")}
                          onMouseLeave={e => (e.currentTarget.style.borderColor = "transparent")}>
                          {row.rakeback_pct}%
                          <Pencil size={11} style={{ color: "var(--text-dim)" }} />
                        </button>
                      )}
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <button
                        onClick={() => isExpanded ? setExpandedWallet(null) : (player && openInlineWallet(player))}
                        style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 5, background: "transparent", border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600, color: walletGame ? "#38bdf8" : "var(--text-dim)" }}
                        onMouseEnter={e => (e.currentTarget.style.borderColor = "var(--border)")}
                        onMouseLeave={e => (e.currentTarget.style.borderColor = "transparent")}>
                        {walletGame ? `${walletGame.slice(0, 6)}…${walletGame.slice(-6)}` : "Non configuré"}
                        <Pencil size={11} style={{ color: "var(--text-dim)" }} />
                      </button>
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <Btn size="sm" variant="danger" onClick={() => deleteDeal(row.deal_id, row.player_name)}><Trash2 size={13} /></Btn>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}>
                      <td colSpan={7} style={{ padding: "16px 20px" }}>
                        <div style={{ marginBottom: 12 }}>
                          <label style={{ fontSize: 10, fontWeight: 700, color: "#38bdf8", textTransform: "uppercase", display: "block", marginBottom: 4, letterSpacing: "0.06em" }}>Wallet Game (TRC20)</label>
                          <input
                            value={walletInlineVals.wallet_game}
                            onChange={e => setWalletInlineVals(v => ({ ...v, wallet_game: e.target.value }))}
                            placeholder="TXxxx…" spellCheck={false}
                            style={{ width: "100%", maxWidth: 480, padding: "8px 10px", borderRadius: 6, fontSize: 12, fontFamily: "monospace", background: "var(--bg-elevated)", color: "var(--text)", border: "1px solid #38bdf840", outline: "none", boxSizing: "border-box" }}
                          />
                        </div>
                        <div style={{ marginBottom: 12 }}>
                          <label style={{ fontSize: 10, fontWeight: 700, color: "#fb923c", textTransform: "uppercase", display: "block", marginBottom: 6, letterSpacing: "0.06em" }}>Wallets Cashout (multiple)</label>
                          {walletInlineVals.cashouts.map((addr, idx) => (
                            <div key={idx} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                              <input
                                value={addr}
                                onChange={e => setWalletInlineVals(v => ({ ...v, cashouts: v.cashouts.map((c, i) => i === idx ? e.target.value : c) }))}
                                placeholder="TXxxx… (Binance, perso, etc.)" spellCheck={false}
                                style={{ flex: 1, maxWidth: 480, padding: "8px 10px", borderRadius: 6, fontSize: 12, fontFamily: "monospace", background: "var(--bg-elevated)", color: "var(--text)", border: "1px solid #fb923c40", outline: "none", boxSizing: "border-box" }}
                              />
                              <button
                                onClick={() => setWalletInlineVals(v => ({ ...v, cashouts: v.cashouts.length === 1 ? [""] : v.cashouts.filter((_, i) => i !== idx) }))}
                                title="Retirer cette adresse"
                                style={{ display: "flex", alignItems: "center", padding: 6, borderRadius: 5, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}>
                                <X size={13} />
                              </button>
                            </div>
                          ))}
                          <button
                            onClick={() => setWalletInlineVals(v => ({ ...v, cashouts: [...v.cashouts, ""] }))}
                            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 5, fontSize: 11, fontWeight: 600, background: "rgba(251,146,60,0.12)", color: "#fb923c", border: "1px dashed #fb923c60", cursor: "pointer", marginTop: 2 }}>
                            <Plus size={11} /> Ajouter une adresse cashout
                          </button>
                        </div>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <button onClick={() => setExpandedWallet(null)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}>
                            <X size={13} /> Annuler
                          </button>
                          <button onClick={() => saveInlineWallet(row.player_id)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "rgba(34,197,94,0.12)", color: "var(--green)", border: "1px solid rgba(34,197,94,0.3)", cursor: "pointer", whiteSpace: "nowrap" }}>
                            <Save size={13} /> Enregistrer
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                  {isTxOpen && (
                    <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}>
                      <td colSpan={7} style={{ padding: "12px 20px" }}>
                        {playerTxs.length === 0 ? (
                          <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "12px 0", textAlign: "center" }}>
                            Aucune transaction pour {row.player_name}
                          </div>
                        ) : (
                          <div>
                            <div style={{ display: "grid", gridTemplateColumns: "100px 110px 120px 1fr 60px", gap: 12, padding: "6px 0 8px", borderBottom: "1px solid var(--border)", fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                              <span>Date</span><span>Type</span><span style={{ textAlign: "right" }}>Montant</span><span>Wallet</span><span style={{ textAlign: "right" }}>Tx</span>
                            </div>
                            {playerTxs.map(tx => {
                              const isDeposit = tx.type === "deposit";
                              const cp = tx.counterparty_address;
                              const cpShort = cp ? `${cp.slice(0, 6)}…${cp.slice(-6)}` : "—";
                              const cpLabel = isDeposit ? "De" : "Vers";
                              return (
                                <div key={tx.id} style={{ display: "grid", gridTemplateColumns: "100px 110px 120px 1fr 60px", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
                                  <span style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{tx.tx_date}</span>
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                                    {isDeposit ? <ArrowDownLeft size={13} color="#f87171" /> : <ArrowUpRight size={13} color="var(--green)" />}
                                    <span style={{ fontSize: 12, fontWeight: 600, color: isDeposit ? "#f87171" : "var(--green)" }}>
                                      {isDeposit ? "Dépôt (in)" : "Retrait (out)"}
                                    </span>
                                  </span>
                                  <span style={{ fontSize: 13, fontWeight: 700, textAlign: "right", whiteSpace: "nowrap", color: isDeposit ? "#f87171" : "var(--green)" }}>
                                    {isDeposit ? "−" : "+"}{tx.amount.toLocaleString("fr-FR", { minimumFractionDigits: 2 })} {tx.currency}
                                  </span>
                                  <span style={{ fontSize: 11, display: "inline-flex", alignItems: "center", gap: 4, overflow: "hidden", whiteSpace: "nowrap" }}>
                                    <span style={{ color: "var(--text-dim)", fontSize: 10, fontWeight: 600 }}>{cpLabel}</span>
                                    {cp ? (
                                      <a href={`https://tronscan.org/#/address/${cp}`} target="_blank" rel="noopener noreferrer"
                                         title={cp}
                                         style={{ display: "inline-flex", alignItems: "center", gap: 3, fontFamily: "monospace", color: "#38bdf8", textDecoration: "none" }}
                                         onMouseEnter={e => (e.currentTarget.style.textDecoration = "underline")}
                                         onMouseLeave={e => (e.currentTarget.style.textDecoration = "none")}>
                                        {cpShort}
                                        <ExternalLink size={10} style={{ opacity: 0.7 }} />
                                      </a>
                                    ) : (
                                      <span style={{ color: "var(--text-dim)" }}>—</span>
                                    )}
                                  </span>
                                  <span style={{ textAlign: "right" }}>
                                    {tx.tron_tx_hash ? (
                                      <a href={`https://tronscan.org/#/transaction/${tx.tron_tx_hash}`} target="_blank" rel="noopener noreferrer"
                                         title={`Voir tx ${tx.tron_tx_hash.slice(0, 12)}…`}
                                         style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--text-muted)", fontSize: 11, textDecoration: "none" }}
                                         onMouseEnter={e => (e.currentTarget.style.color = "#38bdf8")}
                                         onMouseLeave={e => (e.currentTarget.style.color = "var(--text-muted)")}>
                                        <ExternalLink size={11} />
                                      </a>
                                    ) : (
                                      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{tx.note ?? "—"}</span>
                                    )}
                                  </span>
                                </div>
                              );
                            })}
                            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8, textAlign: "right" }}>
                              {playerTxs.length} transaction{playerTxs.length > 1 ? "s" : ""}
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Charts */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 28 }}>
        <WalletChartsWrapper data={chartData} transactions={scopedTransactions as any} />
      </div>

      {/* Add Player Modal */}
      <Modal open={addPlayerModal} onClose={() => setAddPlayerModal(false)} title="Ajouter un joueur TELE AKPOKER">
        <Field label="Joueur *">
          <select value={selectedPlayerId} onChange={e => onSelectPlayer(e.target.value)}>
            <option value="">Sélectionne un joueur…</option>
            {players
              .filter(p => !listedPlayerIds.has(p.id))
              .map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
            <option value="__new__">+ Nouveau joueur (pas dans le CRM)</option>
          </select>
        </Field>

        {isNewPlayer && (
          <>
            <Field label="Nom *">
              <input value={newPlayer.name} onChange={e => setNewPlayer(p => ({ ...p, name: e.target.value }))} placeholder="ex: Jean Dupont" />
            </Field>
            <Field label="Telegram handle ou numéro *">
              <input value={newPlayer.telegram_handle} onChange={e => setNewPlayer(p => ({ ...p, telegram_handle: e.target.value }))} placeholder="@username  ou  +33616882326" spellCheck={false} />
            </Field>
          </>
        )}

        {selectedPlayerId && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Action % *">
                <input type="number" min="0" max="100" step="0.5" value={newPlayer.action_pct} onChange={e => setNewPlayer(p => ({ ...p, action_pct: e.target.value }))} />
              </Field>
              <Field label="RB %">
                <input type="number" min="0" max="100" step="0.5" value={newPlayer.rakeback_pct} onChange={e => setNewPlayer(p => ({ ...p, rakeback_pct: e.target.value }))} />
              </Field>
            </div>
            <Field label="Wallet Game (TRC20)">
              <input value={newPlayer.wallet_game} onChange={e => setNewPlayer(p => ({ ...p, wallet_game: e.target.value }))} placeholder="TXxxx… (optionnel)" spellCheck={false} style={{ fontFamily: "monospace", fontSize: 12 }} />
            </Field>
            <Field label="Wallet Cashout">
              <input value={newPlayer.wallet_cashout} onChange={e => setNewPlayer(p => ({ ...p, wallet_cashout: e.target.value }))} placeholder="TXxxx… (optionnel)" spellCheck={false} style={{ fontFamily: "monospace", fontSize: 12 }} />
            </Field>
          </>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
          <Btn variant="secondary" onClick={() => setAddPlayerModal(false)}>Annuler</Btn>
          <Btn variant="primary"
            disabled={addPlayerBusy || !selectedPlayerId || (isNewPlayer && (!newPlayer.name.trim() || !newPlayer.telegram_handle.trim()))}
            onClick={addNewPlayer}>
            {addPlayerBusy ? "Enregistrement…" : isNewPlayer ? "Créer le joueur" : "Lier à TELE AKPOKER"}
          </Btn>
        </div>
      </Modal>

      {/* Config Wallets Modal */}
      <Modal open={walletModal} onClose={() => { setWalletModal(false); setEditingWallet(null); }} title="Config Wallets TELE">
        {/* WALLET MERE */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>WALLET MÈRE (global)</div>
          <div style={{ background: "var(--bg-surface)", border: "1px solid rgba(74,222,128,0.3)", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, fontFamily: "monospace", color: walletMere ? "#4ade80" : "var(--text-dim)", flex: 1 }}>
              {walletMere ? `${walletMere.slice(0, 8)}…${walletMere.slice(-8)}` : "Non configurée — aller dans Settings"}
            </span>
            {walletMere && (
              <a href={`https://tronscan.org/#/address/${walletMere}`} target="_blank" rel="noopener noreferrer" style={{ color: "#4ade80", display: "flex", alignItems: "center" }}>
                <ExternalLink size={13} />
              </a>
            )}
          </div>
        </div>

        {/* Per-player wallets */}
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>Wallets par joueur</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 400, overflowY: "auto" }}>
          {teleConfig.map(p => {
            const isEditing = editingWallet === p.id;
            return (
              <div key={p.id} style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: isEditing ? 12 : 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{p.name}</span>
                  {!isEditing && (
                    <button onClick={() => { setEditingWallet(p.id); setEditWalletVals({ wallet_game: p.wallet_game ?? "", wallet_cashout: p.wallet_cashout ?? "" }); }}
                      style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 5, padding: "4px 10px", cursor: "pointer" }}>
                      Modifier
                    </button>
                  )}
                </div>
                {!isEditing && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#38bdf8", marginBottom: 3, textTransform: "uppercase" }}>WALLET GAME</div>
                      {p.wallet_game ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 11, fontFamily: "monospace", color: "var(--text-muted)" }}>{p.wallet_game.slice(0, 6)}…{p.wallet_game.slice(-6)}</span>
                          <a href={`https://tronscan.org/#/address/${p.wallet_game}`} target="_blank" rel="noopener noreferrer" style={{ color: "#38bdf8" }}><ExternalLink size={11} /></a>
                        </div>
                      ) : <span style={{ fontSize: 11, color: "var(--text-dim)" }}>—</span>}
                    </div>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#fb923c", marginBottom: 3, textTransform: "uppercase" }}>WALLET CASHOUT</div>
                      {p.wallet_cashout ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 11, fontFamily: "monospace", color: "var(--text-muted)" }}>{p.wallet_cashout.slice(0, 6)}…{p.wallet_cashout.slice(-6)}</span>
                          <a href={`https://tronscan.org/#/address/${p.wallet_cashout}`} target="_blank" rel="noopener noreferrer" style={{ color: "#fb923c" }}><ExternalLink size={11} /></a>
                        </div>
                      ) : <span style={{ fontSize: 11, color: "#f87171" }}>Manquant</span>}
                    </div>
                  </div>
                )}
                {isEditing && (
                  <div>
                    <div style={{ marginBottom: 10 }}>
                      <label style={{ fontSize: 10, fontWeight: 700, color: "#38bdf8", textTransform: "uppercase", display: "block", marginBottom: 4 }}>WALLET GAME</label>
                      <input value={editWalletVals.wallet_game} onChange={e => setEditWalletVals(v => ({ ...v, wallet_game: e.target.value }))}
                        placeholder="TXxxx… (adresse TRC20)" spellCheck={false}
                        style={{ width: "100%", padding: "8px 10px", borderRadius: 6, fontSize: 12, fontFamily: "monospace", background: "var(--bg-elevated)", color: "var(--text)", border: "1px solid #38bdf840", outline: "none", boxSizing: "border-box" }} />
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <label style={{ fontSize: 10, fontWeight: 700, color: "#fb923c", textTransform: "uppercase", display: "block", marginBottom: 4 }}>WALLET CASHOUT</label>
                      <input value={editWalletVals.wallet_cashout} onChange={e => setEditWalletVals(v => ({ ...v, wallet_cashout: e.target.value }))}
                        placeholder="TXxxx… (Binance TRC20 ou perso)" spellCheck={false}
                        style={{ width: "100%", padding: "8px 10px", borderRadius: 6, fontSize: 12, fontFamily: "monospace", background: "var(--bg-elevated)", color: "var(--text)", border: "1px solid #fb923c40", outline: "none", boxSizing: "border-box" }} />
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => saveWallet(p.id)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "rgba(34,197,94,0.12)", color: "var(--green)", border: "1px solid rgba(34,197,94,0.3)", cursor: "pointer" }}>
                        <Save size={13} /> Enregistrer
                      </button>
                      <button onClick={() => setEditingWallet(null)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}>
                        <X size={13} /> Annuler
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
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
