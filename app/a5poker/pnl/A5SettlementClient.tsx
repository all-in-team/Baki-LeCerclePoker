"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Wallet, RefreshCw, Settings2, ExternalLink, Plus, X, Save, Scale, Lock, Unlock,
  BadgeCheck, AlertTriangle, ArrowDownLeft, ArrowUpRight, TrendingUp, CalendarDays,
} from "lucide-react";
import StatCard from "@/components/StatCard";
import Btn from "@/components/Btn";
import Modal from "@/components/Modal";
import NetPnlChart from "../../akpoker/pnl/NetPnlChart";
import { previewAction, lockAction, markPaidAction, unlockAction } from "./actions";

const TRONSCAN = "https://tronscan.org/#/address/";
const TRONSCAN_TX = "https://tronscan.org/#/transaction/";

interface Row {
  player_id: number; player_name: string; action_pct: number; start_date: string | null;
  deposited: number; withdrawn: number; net: number; my_pnl: number;
}
interface KPIs { total_deposited: number; total_withdrawn: number; total_net: number; my_total_pnl: number; }
interface Addr { id: number; address: string; label: string | null; }
interface WalletMere { id: number; address: string; label: string | null; }
interface AvailableTx { id: number; tx_datetime: string; tx_date: string; type: "deposit" | "withdrawal"; amount: number; currency: string; source: string | null; }
interface SettlementRow {
  id: number; player_id: number; player_name: string; net_selected_usdt: number;
  action_pct_applied: number; amount_due_usdt: number; status: "locked" | "paid";
  tx_hash: string | null; notes: string | null; locked_at: string; paid_at: string | null;
  created_at: string; tx_count: number;
}
interface Preview {
  ok: boolean; error?: string; tx_count: number; period_start: string | null; period_end: string | null;
  total_deposited_usdt: number; total_withdrawn_usdt: number; net_selected_usdt: number;
  action_pct: number; amount_due_usdt: number;
}

function fmt(n: number): string { return Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function signed(n: number): string { return (n >= 0 ? "+" : "−") + fmt(n); }
function fmtKpi(n: number): string { const a = Math.abs(n); return (n < 0 ? "−" : "") + (a >= 1000 ? (a / 1000).toFixed(1) + "k" : a.toFixed(2)); }
function fmtDate(s: string | null): string { if (!s) return "—"; return new Date(s).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" }); }
function fmtDM(d: Date): string { return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" }); }
function dueLabel(due: number): { text: string; color: string } {
  if (Math.abs(due) < 0.005) return { text: "Rien à verser", color: "var(--text-dim)" };
  if (due > 0) return { text: `Cercle verse ${fmt(due)} USDT`, color: "#EF4444" };
  return { text: `Joueur verse ${fmt(due)} USDT`, color: "#10B981" };
}

// ISO week (Monday-anchored, UTC) info for a YYYY-MM-DD(...) timestamp. Display-only grouping.
function weekInfo(ts: string): { key: string; label: string } {
  const [y, m, d] = ts.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay() || 7;
  const monday = new Date(dt); monday.setUTCDate(dt.getUTCDate() - (dow - 1));
  const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6);
  const thu = new Date(monday); thu.setUTCDate(monday.getUTCDate() + 3);
  const firstThu = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4));
  const firstThuDow = firstThu.getUTCDay() || 7;
  const week1Mon = new Date(firstThu); week1Mon.setUTCDate(firstThu.getUTCDate() - (firstThuDow - 1));
  const weekNum = Math.round((monday.getTime() - week1Mon.getTime()) / (7 * 86400000)) + 1;
  return { key: monday.toISOString().slice(0, 10), label: `W${weekNum} · ${fmtDM(monday)}–${fmtDM(sunday)}` };
}

const PERIODS = [
  { key: "7d", label: "7 jours" },
  { key: "30d", label: "30 jours" },
  { key: "lifetime", label: "Lifetime" },
] as const;

export default function A5SettlementClient({
  rows, kpis, netSeries = [],
  availableByPlayer = {}, settlementsByPlayer = {},
  cashoutsByPlayer = {}, gameWalletsByPlayer = {}, walletMeres = [], gameId,
  activeFilter = "lifetime", rangeLabel = "Lifetime", basePath = "/a5poker/pnl",
}: {
  rows: Row[]; kpis: KPIs; netSeries?: { day: string; cumulative_net: number }[];
  availableByPlayer?: Record<number, AvailableTx[]>;
  settlementsByPlayer?: Record<number, SettlementRow[]>;
  cashoutsByPlayer?: Record<number, Addr[]>;
  gameWalletsByPlayer?: Record<number, Addr[]>;
  walletMeres?: WalletMere[]; gameId: number;
  activeFilter?: string; rangeLabel?: string; basePath?: string;
}) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ imported: number; results?: { player: string; imported: number; error?: string }[] } | null>(null);
  const [walletOpen, setWalletOpen] = useState<number | null>(null);   // 💼 wallet editor
  const [settleOpen, setSettleOpen] = useState<number | null>(null);   // Régler flow
  const [activeWeek, setActiveWeek] = useState<Record<number, string>>({});
  const [walletInlineVals, setWalletInlineVals] = useState<{ game_wallets: string[]; cashouts: string[] }>({ game_wallets: [""], cashouts: [""] });
  const [savingWallet, setSavingWallet] = useState(false);
  const [settleSel, setSettleSel] = useState<Record<number, Set<number>>>({});
  const [recap, setRecap] = useState<{ playerId: number; playerName: string; ids: number[]; preview: Preview | null } | null>(null);
  const [settleBusy, setSettleBusy] = useState(false);
  const [payHash, setPayHash] = useState<Record<number, string>>({});
  const [rowBusy, setRowBusy] = useState<number | null>(null);

  const netAccent: "green" | "red" | "neutral" = kpis.total_net > 0 ? "green" : kpis.total_net < 0 ? "red" : "neutral";
  const myAccent: "gold" | "red" = kpis.my_total_pnl >= 0 ? "gold" : "red";

  function navigate(filter: string) { router.push(filter === "lifetime" ? basePath : `${basePath}?filter=${filter}`); }

  async function syncWallets() {
    setSyncing(true); setSyncResult(null);
    try {
      const res = await fetch("/api/wallets/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ game_name: "A5POKER" }) });
      const data = await res.json();
      if (!res.ok) { alert(data.error ?? "Erreur sync"); return; }
      setSyncResult(data);
      if (data.imported > 0) setTimeout(() => router.refresh(), 1200);
    } finally { setSyncing(false); }
  }

  // 💼 — wallets ONLY
  function toggleWallet(pid: number) {
    if (walletOpen === pid) { setWalletOpen(null); return; }
    const existingCashouts = (cashoutsByPlayer[pid] ?? []).map(c => c.address);
    const existingGameWallets = (gameWalletsByPlayer[pid] ?? []).map(c => c.address);
    setWalletInlineVals({
      game_wallets: existingGameWallets.length > 0 ? existingGameWallets : [""],
      cashouts: existingCashouts.length > 0 ? existingCashouts : [""],
    });
    setWalletOpen(pid);
  }

  // Régler — settlement flow ONLY
  function toggleSettle(pid: number, weeks: { key: string }[]) {
    if (settleOpen === pid) { setSettleOpen(null); return; }
    setSettleOpen(pid);
    // default highlight = most recent week
    if (weeks.length > 0 && !activeWeek[pid]) setActiveWeek(w => ({ ...w, [pid]: weeks[weeks.length - 1].key }));
  }

  async function saveInlineWallet(pid: number) {
    setSavingWallet(true);
    try {
      const gamePayload = walletInlineVals.game_wallets.map(a => ({ address: a.trim() })).filter(a => a.address.length > 0);
      await fetch(`/api/players/${pid}/game-wallets`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addresses: gamePayload, game_id: gameId }) });
      const cashoutPayload = walletInlineVals.cashouts.map(a => ({ address: a.trim() })).filter(a => a.address.length > 0);
      const res = await fetch(`/api/players/${pid}/cashouts`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addresses: cashoutPayload, game_id: gameId }) });
      if (res.ok) { router.refresh(); } else { const err = await res.json().catch(() => null); alert(err?.error ?? "Erreur sauvegarde wallets"); }
    } finally { setSavingWallet(false); }
  }

  function toggleTx(pid: number, txId: number) {
    setSettleSel(prev => { const set = new Set(prev[pid] ?? []); if (set.has(txId)) set.delete(txId); else set.add(txId); return { ...prev, [pid]: set }; });
  }

  async function openRecap(pid: number, name: string) {
    const ids = [...(settleSel[pid] ?? [])];
    if (ids.length === 0) { alert("Sélectionne au moins une transaction."); return; }
    setSettleBusy(true);
    setRecap({ playerId: pid, playerName: name, ids, preview: null });
    try { const preview = (await previewAction(pid, ids)) as Preview; setRecap({ playerId: pid, playerName: name, ids, preview }); }
    finally { setSettleBusy(false); }
  }

  async function confirmLock() {
    if (!recap?.preview?.ok) return;
    setSettleBusy(true);
    try {
      const res = await lockAction(recap.playerId, recap.ids);
      if (!res.ok) alert(res.error ?? "Erreur lock");
      setSettleSel(prev => ({ ...prev, [recap.playerId]: new Set() }));
      setRecap(null);
      router.refresh();
    } finally { setSettleBusy(false); }
  }

  async function pay(settlementId: number) {
    setRowBusy(settlementId);
    try { const res = await markPaidAction(settlementId, payHash[settlementId]?.trim() || undefined); if (!res.ok) { alert(res.error ?? "Erreur"); return; } router.refresh(); }
    finally { setRowBusy(null); }
  }
  async function unlock(settlementId: number) {
    if (!confirm("Délock ce règlement ? Les transactions redeviennent sélectionnables.")) return;
    setRowBusy(settlementId);
    try { const res = await unlockAction(settlementId); if (!res.ok) { alert(res.error ?? "Erreur"); return; } router.refresh(); }
    finally { setRowBusy(null); }
  }

  const th: React.CSSProperties = { textAlign: "right", padding: "10px 12px", color: "var(--text-muted)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "12px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 13 };
  const COLS = 6;

  const nbToSettle = rows.filter(r => (availableByPlayer[r.player_id]?.length ?? 0) > 0).length;
  const nbLocked = Object.values(settlementsByPlayer).flat().filter(s => s.status === "locked").length;

  return (
    <div style={{ padding: "8px 28px 40px" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Period filter + wallet action bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "10px 0 16px" }}>
        <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
          {PERIODS.map(p => (
            <button key={p.key} onClick={() => navigate(p.key)} style={{
              padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: "none",
              background: activeFilter === p.key ? "rgba(34,197,94,0.14)" : "transparent",
              color: activeFilter === p.key ? "var(--green)" : "var(--text-muted)",
            }}>{p.label}</button>
          ))}
        </div>
        <div style={{ width: 1, height: 20, background: "var(--border)" }} />
        <Btn variant="secondary" onClick={syncWallets} disabled={syncing}>
          <RefreshCw size={14} style={{ animation: syncing ? "spin 1s linear infinite" : "none" }} />
          {syncing ? "Sync en cours…" : "Sync Wallets"}
        </Btn>
        <a href="/settings" style={{ textDecoration: "none" }}><Btn variant="secondary"><Settings2 size={14} /> Config Wallets</Btn></a>
        {syncResult && (
          <span style={{ fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 6, background: syncResult.imported > 0 ? "rgba(34,197,94,0.12)" : "rgba(136,136,160,0.10)", color: syncResult.imported > 0 ? "var(--green)" : "var(--text-muted)" }}>
            {syncResult.imported > 0 ? `+${syncResult.imported} importés` : "Déjà à jour"}
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", display: "inline-flex", alignItems: "center", gap: 6 }}><CalendarDays size={12} /> {rangeLabel}</span>
      </div>

      {/* Wallet mère banner */}
      {walletMeres.length > 0 ? (
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#4ade80", textTransform: "uppercase", letterSpacing: "0.08em" }}>WALLET{walletMeres.length > 1 ? "S" : ""} MÈRE{walletMeres.length > 1 ? "S" : ""} A5POKER</div>
          {walletMeres.map(wm => (
            <a key={wm.id} href={TRONSCAN + wm.address} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none", padding: "4px 10px", background: "rgba(74,222,128,0.08)", borderRadius: 6, border: "1px solid rgba(74,222,128,0.2)" }}>
              <span style={{ fontSize: 11, fontFamily: "monospace", color: "#4ade80", fontWeight: 600 }}>{wm.label ? `${wm.label}: ` : ""}{wm.address.slice(0, 6)}…{wm.address.slice(-6)}</span>
              <ExternalLink size={10} color="#4ade80" />
            </a>
          ))}
        </div>
      ) : (
        <div style={{ background: "rgba(245,197,24,0.06)", border: "1px solid rgba(245,197,24,0.2)", borderRadius: 10, padding: "10px 16px", marginBottom: 20, fontSize: 12, color: "var(--text-muted)" }}>
          ⚠️ Aucune wallet mère A5POKER configurée — les retraits ne seront pas détectés au sync. Configure-la dans <a href="/settings" style={{ color: "#F5C518" }}>Settings → Config Wallets</a>.
        </div>
      )}

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 22 }}>
        <StatCard label="Total Deposited" value={fmtKpi(kpis.total_deposited) + " USDT"} sub="Tous joueurs" accent="neutral" icon={<ArrowDownLeft size={18} />} />
        <StatCard label="Total Withdrawn" value={fmtKpi(kpis.total_withdrawn) + " USDT"} sub="Tous joueurs" accent="neutral" icon={<ArrowUpRight size={18} />} />
        <StatCard label="Players Net P&L" value={(kpis.total_net >= 0 ? "+" : "−") + fmtKpi(Math.abs(kpis.total_net)) + " USDT"} sub="Retraits − Dépôts" accent={netAccent} icon={<TrendingUp size={18} />} />
        <StatCard label="Mon Total P&L" value={(kpis.my_total_pnl >= 0 ? "+" : "−") + fmtKpi(Math.abs(kpis.my_total_pnl)) + " USDT"} sub="Ma part selon chaque deal" accent={myAccent} icon={<Wallet size={18} />} />
      </div>

      {/* P&L curve */}
      <NetPnlChart series={netSeries} cardNet={kpis.total_net} currency="USDT" rangeLabel={rangeLabel} />

      {/* Players table */}
      <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", marginTop: 24 }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", fontSize: 13, fontWeight: 700, color: "var(--text)", display: "flex", alignItems: "center", gap: 12 }}>
          <span>Joueurs A5POKER</span>
          {nbToSettle > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: "#F5C518", background: "rgba(245,197,24,0.12)", border: "1px solid rgba(245,197,24,0.3)", padding: "2px 8px", borderRadius: 10 }}>{nbToSettle} à régler</span>}
          {nbLocked > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: "#10B981", background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.3)", padding: "2px 8px", borderRadius: 10 }}>{nbLocked} à payer</span>}
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Aucun joueur A5POKER (pas de deal).</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ ...th, textAlign: "left" }}>Joueur</th>
                  <th style={th}>Net P&L</th>
                  <th style={th}>Mon P&L</th>
                  <th style={th}>Action %</th>
                  <th style={{ ...th, textAlign: "left" }}>Début</th>
                  <th style={{ ...th, textAlign: "center" }}>Règlement</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const gw = gameWalletsByPlayer[r.player_id] ?? [];
                  const co = cashoutsByPlayer[r.player_id] ?? [];
                  const walletCount = gw.length + co.length;
                  const isWalletOpen = walletOpen === r.player_id;
                  const isSettleOpen = settleOpen === r.player_id;
                  const avail = availableByPlayer[r.player_id] ?? [];
                  const pSettlements = settlementsByPlayer[r.player_id] ?? [];
                  const lockedN = pSettlements.filter(s => s.status === "locked").length;
                  const sel = settleSel[r.player_id] ?? new Set<number>();
                  const netC = r.net > 0 ? "var(--green)" : r.net < 0 ? "#f87171" : "var(--text-dim)";
                  const myC = r.my_pnl > 0 ? "var(--green)" : r.my_pnl < 0 ? "#f87171" : "var(--text-dim)";
                  // distinct weeks present in this player's unsettled tx (ascending)
                  const weekMap = new Map<string, string>();
                  for (const tx of avail) { const w = weekInfo(tx.tx_datetime ?? tx.tx_date); if (!weekMap.has(w.key)) weekMap.set(w.key, w.label); }
                  const weeks = [...weekMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, label]) => ({ key, label }));
                  const curWeek = activeWeek[r.player_id];
                  const rowOpen = isWalletOpen || isSettleOpen;
                  return (
                    <Fragment key={r.player_id}>
                      <tr style={{ borderBottom: rowOpen ? "none" : "1px solid var(--border)", background: avail.length > 0 ? "rgba(245,197,24,0.04)" : undefined }}>
                        <td style={{ ...td, textAlign: "left", fontWeight: 600, color: "var(--text)" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                            <button
                              onClick={() => toggleWallet(r.player_id)}
                              title="Voir / éditer les wallets du joueur"
                              style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "3px 6px", borderRadius: 5, cursor: "pointer",
                                background: isWalletOpen ? "rgba(56,189,248,0.15)" : (walletCount === 0 ? "rgba(239,68,68,0.12)" : "var(--bg-base)"),
                                border: `1px solid ${isWalletOpen ? "#38bdf8" : (walletCount === 0 ? "#EF444440" : "var(--border)")}`,
                                color: walletCount === 0 ? "#EF4444" : "var(--text-muted)" }}>
                              <Wallet size={12} />
                              <span style={{ fontSize: 10, fontWeight: 700 }}>{walletCount === 0 ? "0" : walletCount}</span>
                            </button>
                            <span>{r.player_name}</span>
                            {avail.length > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: "#F5C518", background: "rgba(245,197,24,0.12)", border: "1px solid rgba(245,197,24,0.3)", padding: "1px 7px", borderRadius: 10 }}>{avail.length} à régler</span>}
                            {lockedN > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: "#10B981", background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.3)", padding: "1px 7px", borderRadius: 10 }}>{lockedN} à payer</span>}
                          </span>
                        </td>
                        <td style={{ ...td, color: netC, fontWeight: 600 }}>{r.net === 0 ? "—" : fmt(r.net)}</td>
                        <td style={{ ...td, color: myC, fontWeight: 700 }}>{r.my_pnl === 0 ? "—" : fmt(r.my_pnl)}</td>
                        <td style={td}>{r.action_pct}%</td>
                        <td style={{ ...td, textAlign: "left", color: "var(--text-muted)", fontSize: 11 }}>{fmtDate(r.start_date)}</td>
                        <td style={{ ...td, textAlign: "center" }}>
                          <Btn variant={isSettleOpen ? "secondary" : "primary"} onClick={() => toggleSettle(r.player_id, weeks)} style={{ fontSize: 11, gap: 5, padding: "6px 12px" }}>
                            <Scale size={13} /> {isSettleOpen ? "Fermer" : "Régler"}
                          </Btn>
                        </td>
                      </tr>

                      {/* 💼 WALLETS dropdown — wallets only */}
                      {isWalletOpen && (
                        <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}>
                          <td colSpan={COLS} style={{ padding: "16px 20px" }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}><Wallet size={13} color="#38bdf8" /> Wallets du joueur</div>
                            <div style={{ marginBottom: 12 }}>
                              <label style={{ fontSize: 10, fontWeight: 700, color: "#38bdf8", textTransform: "uppercase", display: "block", marginBottom: 6, letterSpacing: "0.06em" }}>Wallets dépôt A5POKER (game)</label>
                              {walletInlineVals.game_wallets.map((addr, idx) => (
                                <div key={idx} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                                  <input value={addr} onChange={e => setWalletInlineVals(v => ({ ...v, game_wallets: v.game_wallets.map((c, i) => i === idx ? e.target.value : c) }))} placeholder="TXxxx… (adresse TRC20)" spellCheck={false} style={{ flex: 1, maxWidth: 520, padding: "8px 10px", borderRadius: 6, fontSize: 12, fontFamily: "monospace", background: "var(--bg-elevated)", color: "var(--text)", border: "1px solid #38bdf840", outline: "none", boxSizing: "border-box" }} />
                                  <button onClick={() => setWalletInlineVals(v => ({ ...v, game_wallets: v.game_wallets.length === 1 ? [""] : v.game_wallets.filter((_, i) => i !== idx) }))} title="Retirer" style={{ display: "flex", alignItems: "center", padding: 6, borderRadius: 5, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}><X size={13} /></button>
                                </div>
                              ))}
                              <button onClick={() => setWalletInlineVals(v => ({ ...v, game_wallets: [...v.game_wallets, ""] }))} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 5, fontSize: 11, fontWeight: 600, background: "rgba(56,189,248,0.12)", color: "#38bdf8", border: "1px dashed #38bdf860", cursor: "pointer", marginTop: 2 }}><Plus size={11} /> Ajouter un wallet dépôt</button>
                            </div>
                            <div style={{ marginBottom: 12 }}>
                              <label style={{ fontSize: 10, fontWeight: 700, color: "#fb923c", textTransform: "uppercase", display: "block", marginBottom: 6, letterSpacing: "0.06em" }}>Wallets retrait / cashout</label>
                              {walletInlineVals.cashouts.map((addr, idx) => (
                                <div key={idx} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                                  <input value={addr} onChange={e => setWalletInlineVals(v => ({ ...v, cashouts: v.cashouts.map((c, i) => i === idx ? e.target.value : c) }))} placeholder="TXxxx… (Binance, perso, etc.)" spellCheck={false} style={{ flex: 1, maxWidth: 520, padding: "8px 10px", borderRadius: 6, fontSize: 12, fontFamily: "monospace", background: "var(--bg-elevated)", color: "var(--text)", border: "1px solid #fb923c40", outline: "none", boxSizing: "border-box" }} />
                                  <button onClick={() => setWalletInlineVals(v => ({ ...v, cashouts: v.cashouts.length === 1 ? [""] : v.cashouts.filter((_, i) => i !== idx) }))} title="Retirer" style={{ display: "flex", alignItems: "center", padding: 6, borderRadius: 5, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}><X size={13} /></button>
                                </div>
                              ))}
                              <button onClick={() => setWalletInlineVals(v => ({ ...v, cashouts: [...v.cashouts, ""] }))} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 5, fontSize: 11, fontWeight: 600, background: "rgba(251,146,60,0.12)", color: "#fb923c", border: "1px dashed #fb923c60", cursor: "pointer", marginTop: 2 }}><Plus size={11} /> Ajouter une adresse cashout</button>
                            </div>
                            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                              <button onClick={() => setWalletOpen(null)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}><X size={13} /> Fermer</button>
                              <button onClick={() => saveInlineWallet(r.player_id)} disabled={savingWallet} style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "rgba(34,197,94,0.12)", color: "var(--green)", border: "1px solid rgba(34,197,94,0.3)", cursor: "pointer", whiteSpace: "nowrap" }}><Save size={13} /> {savingWallet ? "..." : "Enregistrer les wallets"}</button>
                            </div>
                          </td>
                        </tr>
                      )}

                      {/* RÉGLER dropdown — settlement flow (weeks + large panel + lock + history) */}
                      {isSettleOpen && (
                        <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}>
                          <td colSpan={COLS} style={{ padding: "16px 20px" }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}><Scale size={13} color="#F5C518" /> Règlement manuel — choisis les transactions à régler</div>

                            {avail.length === 0 ? (
                              <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }}>Aucune transaction à régler (tout est settled).</div>
                            ) : (
                              <>
                                {/* Week chips (visual anchor) */}
                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                                  {weeks.map(w => (
                                    <button key={w.key} onClick={() => setActiveWeek(a => ({ ...a, [r.player_id]: w.key }))} style={{
                                      padding: "5px 11px", borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: "pointer",
                                      border: `1px solid ${curWeek === w.key ? "#F5C518" : "var(--border)"}`,
                                      background: curWeek === w.key ? "rgba(245,197,24,0.15)" : "var(--bg-base)",
                                      color: curWeek === w.key ? "#F5C518" : "var(--text-muted)", whiteSpace: "nowrap",
                                    }}>{w.label}</button>
                                  ))}
                                </div>

                                {/* Large panel: ALL unsettled tx, the active week highlighted */}
                                <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-base)", marginBottom: 12 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
                                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Toutes les transactions non réglées ({avail.length}) — la semaine choisie est surlignée</span>
                                    <div style={{ flex: 1 }} />
                                    <button onClick={() => setSettleSel(prev => ({ ...prev, [r.player_id]: new Set(avail.map(t => t.id)) }))} style={ghostMini}>Tout cocher</button>
                                    <button onClick={() => setSettleSel(prev => ({ ...prev, [r.player_id]: new Set() }))} style={ghostMini}>Tout décocher</button>
                                    {curWeek && <button onClick={() => setSettleSel(prev => ({ ...prev, [r.player_id]: new Set(avail.filter(t => weekInfo(t.tx_datetime ?? t.tx_date).key === curWeek).map(t => t.id)) }))} style={ghostMini}>Cocher la semaine</button>}
                                  </div>
                                  <div style={{ maxHeight: 360, overflowY: "auto" }}>
                                    {avail.map(tx => {
                                      const isDep = tx.type === "deposit";
                                      const checked = sel.has(tx.id);
                                      const inWeek = curWeek && weekInfo(tx.tx_datetime ?? tx.tx_date).key === curWeek;
                                      return (
                                        <div key={tx.id} onClick={() => toggleTx(r.player_id, tx.id)} style={{
                                          display: "grid", gridTemplateColumns: "32px 120px 140px 1fr 40px", gap: 12, alignItems: "center", padding: "9px 12px", cursor: "pointer",
                                          background: checked ? "rgba(34,197,94,0.10)" : "transparent",
                                          borderBottom: "1px solid var(--border)",
                                          borderLeft: inWeek ? "3px solid #F5C518" : "3px solid transparent",
                                        }}>
                                          <input type="checkbox" checked={checked} onChange={() => toggleTx(r.player_id, tx.id)} onClick={e => e.stopPropagation()} style={{ cursor: "pointer", accentColor: "#10B981" }} />
                                          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{(tx.tx_datetime ?? tx.tx_date).slice(0, 10)}</span>
                                          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: isDep ? "#f87171" : "var(--green)", fontWeight: 600, fontSize: 12 }}>{isDep ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}{isDep ? "Dépôt" : "Retrait"}</span>
                                          <span style={{ fontSize: 13, fontWeight: 700, color: isDep ? "#f87171" : "var(--green)" }}>{isDep ? "−" : "+"}{fmt(tx.amount)} {tx.currency}</span>
                                          <span style={{ textAlign: "center", fontSize: 13 }} title={tx.source ?? "?"}>{tx.source === "sync" ? "🔗" : tx.source === "manual" ? "✍️" : "⚠️"}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderTop: "1px solid var(--border)" }}>
                                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{sel.size} sélectionnée{sel.size > 1 ? "s" : ""}</span>
                                    <div style={{ flex: 1 }} />
                                    <Btn variant="primary" onClick={() => openRecap(r.player_id, r.player_name)} disabled={settleBusy || sel.size === 0} style={{ fontSize: 12, gap: 6, padding: "8px 16px" }}>
                                      <Scale size={14} /> Régler la sélection ({sel.size})
                                    </Btn>
                                  </div>
                                </div>
                              </>
                            )}

                            {/* Player's settlements */}
                            {pSettlements.length > 0 && (
                              <div style={{ marginTop: 4 }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Règlements du joueur</div>
                                {pSettlements.map(s => {
                                  const reg = dueLabel(s.amount_due_usdt);
                                  const isLocked = s.status === "locked";
                                  return (
                                    <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 10px", borderRadius: 6, marginBottom: 6, background: "var(--bg-base)", border: `1px solid ${isLocked ? "rgba(245,197,24,0.25)" : "var(--border)"}` }}>
                                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: isLocked ? "#F5C518" : "#10B981" }}>{isLocked ? <Lock size={12} /> : <BadgeCheck size={12} />}{isLocked ? "Locked" : "Réglé"}</span>
                                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{s.tx_count} tx · {fmtDate(isLocked ? s.locked_at : s.paid_at)}</span>
                                      <span style={{ fontSize: 12, fontWeight: 600, color: reg.color }}>{reg.text}</span>
                                      <div style={{ flex: 1 }} />
                                      {isLocked ? (
                                        <>
                                          <input value={payHash[s.id] ?? ""} onChange={e => setPayHash(h => ({ ...h, [s.id]: e.target.value }))} placeholder="tx_hash (option.)" spellCheck={false} style={{ width: 150, padding: "5px 8px", borderRadius: 6, fontSize: 11, fontFamily: "monospace", background: "var(--bg-elevated)", color: "var(--text)", border: "1px solid var(--border)", outline: "none" }} />
                                          <button onClick={() => pay(s.id)} disabled={rowBusy === s.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "rgba(34,197,94,0.12)", color: "var(--green)", border: "1px solid rgba(34,197,94,0.3)", cursor: "pointer" }}><BadgeCheck size={12} /> Marquer réglé</button>
                                          <button onClick={() => unlock(s.id)} disabled={rowBusy === s.id} title="Délock" style={{ display: "inline-flex", alignItems: "center", padding: "6px 8px", borderRadius: 6, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}><Unlock size={12} /></button>
                                        </>
                                      ) : (
                                        s.tx_hash ? <a href={TRONSCAN_TX + s.tx_hash} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#38bdf8", textDecoration: "none", fontSize: 11, fontFamily: "monospace" }}>{s.tx_hash.slice(0, 8)}…<ExternalLink size={10} /></a> : <span style={{ fontSize: 11, color: "var(--text-dim)" }}>—</span>
                                      )}
                                    </div>
                                  );
                                })}
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
        )}
      </div>

      {/* Recap modal */}
      <Modal open={!!recap} onClose={() => setRecap(null)} title="Régler la sélection — récapitulatif">
        {recap && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {!recap.preview ? (
              <div style={{ padding: 14, color: "var(--text-muted)", fontSize: 13 }}>Calcul…</div>
            ) : !recap.preview.ok ? (
              <div style={{ padding: 14, borderRadius: 8, background: "rgba(239,68,68,0.1)", color: "#EF4444", fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
                <AlertTriangle size={16} /> {recap.preview.error ?? "Impossible de régler cette sélection."}
              </div>
            ) : (
              <>
                <div style={{ fontSize: 13, color: "var(--text)" }}>
                  <b>{recap.playerName}</b> · {recap.preview.tx_count} transaction{recap.preview.tx_count > 1 ? "s" : ""}
                  <span style={{ color: "var(--text-dim)" }}> · {fmtDate(recap.preview.period_start)} → {fmtDate(recap.preview.period_end)}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 12 }}>
                  <RecapLine label="Total dépôts" value={`${fmt(recap.preview.total_deposited_usdt)} USDT`} />
                  <RecapLine label="Total retraits" value={`${fmt(recap.preview.total_withdrawn_usdt)} USDT`} />
                  <RecapLine label="Net (retraits − dépôts)" value={`${signed(recap.preview.net_selected_usdt)} USDT`} />
                  <RecapLine label="Action %" value={`${recap.preview.action_pct}%`} />
                </div>
                <div style={{ padding: 14, borderRadius: 8, background: "var(--bg-base)", border: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Montant dû (net × action%)</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: dueLabel(recap.preview.amount_due_usdt).color }}>{dueLabel(recap.preview.amount_due_usdt).text}</div>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{signed(recap.preview.amount_due_usdt)} USDT</div>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Après lock, ces {recap.preview.tx_count} transactions sont figées (settled) et ne pourront plus entrer dans un autre règlement.</div>
              </>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <Btn variant="secondary" onClick={() => setRecap(null)}>Annuler</Btn>
              {recap.preview?.ok && (<Btn variant="primary" onClick={confirmLock} disabled={settleBusy}><Lock size={14} /> {settleBusy ? "…" : "Lock"}</Btn>)}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

const ghostMini: React.CSSProperties = { padding: "4px 9px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" };

function RecapLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ color: "var(--text)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}
