"use client";

import { useState, Fragment } from "react";
import { useRouter } from "next/navigation";
import { Check, Scale, AlertTriangle, CalendarClock, RefreshCw, Settings2, ExternalLink, Plus, X, Save, Wallet } from "lucide-react";
import Modal from "@/components/Modal";
import Btn from "@/components/Btn";
import { saveMainsAction, previewSettlementAction, settleCycleAction } from "./actions";

const TRONSCAN = "https://tronscan.org/#/address/";

interface Row {
  player_id: number;
  player_name: string;
  start_date: string;
  cycle_start: string;
  cycle_end_incl: string;
  settle_date: string;
  due: boolean;
  days_overdue: number;
  resultat_periode: number;
  mains: number;
  c: number;
  t: number;
  reglement: number;
  condition_30k_applied: boolean;
  operator_pnl: number;
}
type HistoryRow = Row & { settled_at: string | null };
type WalletMere = { id: number; address: string; label: string | null; status?: string };
type Addr = { id: number; address: string; label: string | null };

interface Cycle {
  player_start_date: string; cycle_index: number; cycle_start: string;
  cycle_end_incl: string; settle_date: string; start_iso: string; end_iso: string;
  due: boolean; days_overdue: number;
}
interface Preview {
  ok: boolean; error?: string; player_id: number; cycle?: Cycle;
  resultat_periode?: number; mains?: number; c?: number; t?: number;
  reglement?: number; condition_30k_applied?: boolean; operator_pnl?: number;
}

function fmt(n: number): string {
  return Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function signed(n: number): string {
  return (n >= 0 ? "+" : "−") + fmt(n);
}
function fmtDate(key: string): string {
  if (!key) return "—";
  return new Date(key + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function reglementLabel(reglement: number): { text: string; color: string } {
  if (Math.abs(reglement) < 0.005) return { text: "Aucun mouvement", color: "var(--text-dim)" };
  if (reglement > 0) return { text: `Cercle verse ${fmt(reglement)} USDT`, color: "#EF4444" };
  return { text: `Joueur verse ${fmt(reglement)} USDT`, color: "#10B981" };
}

function ConditionBadge({ row }: { row: { mains: number; condition_30k_applied: boolean } }) {
  if (row.condition_30k_applied) {
    return <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "rgba(239,68,68,0.15)", color: "#EF4444", whiteSpace: "nowrap" }}>⚠️ &lt;30k — non couvert</span>;
  }
  if (row.mains >= 30000) {
    return <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "rgba(16,185,129,0.15)", color: "#10B981", whiteSpace: "nowrap" }}>✓ 30k OK</span>;
  }
  return <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "rgba(245,197,24,0.15)", color: "#F5C518", whiteSpace: "nowrap" }}>&lt;30k</span>;
}

function StatusBadge({ due, days_overdue }: { due: boolean; days_overdue: number }) {
  if (due && days_overdue > 0) {
    return <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "rgba(239,68,68,0.15)", color: "#EF4444", whiteSpace: "nowrap" }}>En retard ({days_overdue}j)</span>;
  }
  if (due) {
    return <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "rgba(245,197,24,0.15)", color: "#F5C518", whiteSpace: "nowrap" }}>À régler</span>;
  }
  return <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "rgba(136,136,160,0.15)", color: "var(--text-muted)", whiteSpace: "nowrap" }}>En cours</span>;
}

export default function QqpkStakingClient({
  rows, history, gameId, walletMeres = [], cashoutsByPlayer = {}, gameWalletsByPlayer = {},
}: {
  rows: Row[]; history: HistoryRow[]; gameId: number;
  walletMeres?: WalletMere[];
  cashoutsByPlayer?: Record<number, Addr[]>;
  gameWalletsByPlayer?: Record<number, Addr[]>;
}) {
  const router = useRouter();
  const [mainsEdits, setMainsEdits] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [recap, setRecap] = useState<{ player: Row; preview: Preview } | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Wallet management
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ imported: number; results?: { player: string; imported: number; error?: string }[] } | null>(null);
  const [expandedWallet, setExpandedWallet] = useState<number | null>(null);
  const [walletInlineVals, setWalletInlineVals] = useState<{ game_wallets: string[]; cashouts: string[] }>({ game_wallets: [""], cashouts: [""] });
  const [savingWallet, setSavingWallet] = useState(false);

  const nbDue = rows.filter((r) => r.due).length;
  const makeupEnCours = rows.filter((r) => r.t > 0).reduce((s, r) => s + r.t, 0);
  const nbJoueurs = rows.length;

  async function saveMains(pid: number) {
    const raw = mainsEdits[pid];
    if (raw === undefined) return;
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0) { alert("Mains: entier ≥ 0 requis."); return; }
    setBusy(pid);
    try {
      const res = await saveMainsAction(pid, n);
      if (!res.ok) { alert(res.error ?? "Erreur"); return; }
      setMainsEdits((m) => { const c = { ...m }; delete c[pid]; return c; });
      router.refresh();
    } finally { setBusy(null); }
  }

  async function openRecap(player: Row) {
    setBusy(player.player_id);
    try {
      const preview = (await previewSettlementAction(player.player_id)) as Preview;
      setRecap({ player, preview });
    } finally { setBusy(null); }
  }

  async function confirmSettle() {
    if (!recap) return;
    setConfirming(true);
    try {
      const res = await settleCycleAction(recap.player.player_id);
      if (!res.ok) { alert(res.error ?? "Erreur règlement"); return; }
      setRecap(null);
      router.refresh();
    } finally { setConfirming(false); }
  }

  // ── Wallet sync (game_name=QQPK) — same endpoint as the other game pages ──
  async function syncWallets() {
    setSyncing(true); setSyncResult(null);
    try {
      const res = await fetch("/api/wallets/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ game_name: "QQPK" }) });
      const data = await res.json();
      if (!res.ok) { alert(data.error ?? "Erreur sync"); return; }
      setSyncResult(data);
      if (data.imported > 0) setTimeout(() => router.refresh(), 1200);
    } finally { setSyncing(false); }
  }

  function openInlineWallet(pid: number) {
    if (expandedWallet === pid) { setExpandedWallet(null); return; }
    const existingCashouts = (cashoutsByPlayer[pid] ?? []).map((c) => c.address);
    const existingGameWallets = (gameWalletsByPlayer[pid] ?? []).map((c) => c.address);
    setWalletInlineVals({
      game_wallets: existingGameWallets.length > 0 ? existingGameWallets : [""],
      cashouts: existingCashouts.length > 0 ? existingCashouts : [""],
    });
    setExpandedWallet(pid);
  }

  async function saveInlineWallet(pid: number) {
    setSavingWallet(true);
    try {
      const gamePayload = walletInlineVals.game_wallets.map((a) => ({ address: a.trim() })).filter((a) => a.address.length > 0);
      await fetch(`/api/players/${pid}/game-wallets`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addresses: gamePayload, game_id: gameId }) });
      const cashoutPayload = walletInlineVals.cashouts.map((a) => ({ address: a.trim() })).filter((a) => a.address.length > 0);
      const res = await fetch(`/api/players/${pid}/cashouts`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addresses: cashoutPayload, game_id: gameId }) });
      if (res.ok) { setExpandedWallet(null); router.refresh(); }
      else { const err = await res.json().catch(() => null); alert(err?.error ?? "Erreur sauvegarde wallets"); }
    } finally { setSavingWallet(false); }
  }

  const th: React.CSSProperties = { textAlign: "right", padding: "8px 10px", color: "var(--text-muted)", fontWeight: 600, fontSize: 11, whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "10px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 12 };
  const COLS = 11;

  return (
    <div style={{ padding: "8px 28px 40px" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* ── Wallet action bar ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "10px 0 16px" }}>
        <Btn variant="secondary" onClick={syncWallets} disabled={syncing}>
          <RefreshCw size={14} style={{ animation: syncing ? "spin 1s linear infinite" : "none" }} />
          {syncing ? "Sync en cours…" : "Sync Wallets"}
        </Btn>
        <a href="/settings" style={{ textDecoration: "none" }}>
          <Btn variant="secondary"><Settings2 size={14} /> Config Wallets</Btn>
        </a>
        {syncResult && (
          <span style={{ fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 6, background: syncResult.imported > 0 ? "rgba(34,197,94,0.12)" : "rgba(136,136,160,0.10)", color: syncResult.imported > 0 ? "var(--green)" : "var(--text-muted)" }}>
            {syncResult.imported > 0 ? `+${syncResult.imported} importés` : "Déjà à jour"}
          </span>
        )}
        {syncResult?.results?.filter((r) => r.error).map((r, i) => (
          <span key={i} style={{ fontSize: 11, color: "#EF4444" }}>{r.player}: {r.error}</span>
        ))}
      </div>

      {/* ── Wallet mères banner ── */}
      {walletMeres.length > 0 ? (
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#4ade80", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            WALLET{walletMeres.length > 1 ? "S" : ""} MÈRE{walletMeres.length > 1 ? "S" : ""} QQPK
          </div>
          {walletMeres.map((wm) => (
            <a key={wm.id} href={TRONSCAN + wm.address} target="_blank" rel="noreferrer"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none", padding: "4px 10px", background: "rgba(74,222,128,0.08)", borderRadius: 6, border: "1px solid rgba(74,222,128,0.2)" }}>
              <span style={{ fontSize: 11, fontFamily: "monospace", color: "#4ade80", fontWeight: 600 }}>
                {wm.label ? `${wm.label}: ` : ""}{wm.address.slice(0, 6)}…{wm.address.slice(-6)}
              </span>
              <ExternalLink size={10} color="#4ade80" />
            </a>
          ))}
        </div>
      ) : (
        <div style={{ background: "rgba(245,197,24,0.06)", border: "1px solid rgba(245,197,24,0.2)", borderRadius: 10, padding: "10px 16px", marginBottom: 20, fontSize: 12, color: "var(--text-muted)" }}>
          ⚠️ Aucune wallet mère QQPK configurée — les retraits ne seront pas détectés au sync. Configure-la dans <a href="/settings" style={{ color: "#F5C518" }}>Settings → Config Wallets</a>.
        </div>
      )}

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 22 }}>
        <Card label="Cycles à régler" value={String(nbDue)} color={nbDue > 0 ? "#F5C518" : "var(--text)"} hint="Joueurs dont le cycle est échu" />
        <Card label="Makeup en cours" value={`${fmt(makeupEnCours)} USDT`} color="#F5C518" hint="Σ T (>0) — couverture Cercle projetée" />
        <Card label="Joueurs QQPK" value={String(nbJoueurs)} color="var(--text)" hint="Joueurs avec un cycle QQPK" />
      </div>

      <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
          Cycles actifs (roulant par joueur · reset sec)
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Aucun joueur QQPK (pas de deal/onboarding QQPK).</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1040 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ ...th, textAlign: "left" }}>Joueur</th>
                  <th style={{ ...th, textAlign: "left" }}>Cycle</th>
                  <th style={{ ...th, textAlign: "left" }}>Échéance</th>
                  <th style={{ ...th, textAlign: "center" }}>Statut</th>
                  <th style={th}>Résultat</th>
                  <th style={th}>Mains</th>
                  <th style={th}>C</th>
                  <th style={th}>T</th>
                  <th style={{ ...th, textAlign: "left", paddingLeft: 16 }}>Règlement</th>
                  <th style={{ ...th, textAlign: "center" }}>30k</th>
                  <th style={{ ...th, textAlign: "center" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const reg = reglementLabel(r.reglement);
                  const edited = mainsEdits[r.player_id] !== undefined && parseInt(mainsEdits[r.player_id] || "0", 10) !== r.mains;
                  const gw = gameWalletsByPlayer[r.player_id] ?? [];
                  const co = cashoutsByPlayer[r.player_id] ?? [];
                  const walletCount = gw.length + co.length;
                  const isWalletOpen = expandedWallet === r.player_id;
                  return (
                    <Fragment key={r.player_id}>
                      <tr style={{ borderBottom: isWalletOpen ? "none" : "1px solid var(--border)", background: r.due ? "rgba(245,197,24,0.04)" : undefined }}>
                        <td style={{ ...td, textAlign: "left", fontWeight: 600, color: "var(--text)" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                            <button
                              onClick={() => openInlineWallet(r.player_id)}
                              title="Voir / configurer les wallets"
                              style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "3px 6px", borderRadius: 5, cursor: "pointer",
                                background: isWalletOpen ? "rgba(56,189,248,0.15)" : (walletCount === 0 ? "rgba(239,68,68,0.12)" : "var(--bg-base)"),
                                border: `1px solid ${isWalletOpen ? "#38bdf8" : (walletCount === 0 ? "#EF444440" : "var(--border)")}`,
                                color: walletCount === 0 ? "#EF4444" : "var(--text-muted)" }}>
                              <Wallet size={12} />
                              <span style={{ fontSize: 10, fontWeight: 700 }}>{walletCount === 0 ? "0" : walletCount}</span>
                            </button>
                            <span>{r.player_name}</span>
                          </span>
                          <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 400, marginTop: 2 }}>début {fmtDate(r.start_date)}</div>
                        </td>
                        <td style={{ ...td, textAlign: "left", color: "var(--text-muted)", fontSize: 11, whiteSpace: "nowrap" }}>
                          {fmtDate(r.cycle_start)} → {fmtDate(r.cycle_end_incl)}
                        </td>
                        <td style={{ ...td, textAlign: "left", fontSize: 11, color: r.due ? "#F5C518" : "var(--text)", whiteSpace: "nowrap" }}>
                          <CalendarClock size={11} style={{ display: "inline", marginRight: 4, verticalAlign: "-1px" }} />{fmtDate(r.settle_date)}
                        </td>
                        <td style={{ ...td, textAlign: "center" }}><StatusBadge due={r.due} days_overdue={r.days_overdue} /></td>
                        <td style={{ ...td, color: r.resultat_periode >= 0 ? "#10B981" : "#EF4444", fontWeight: 600 }}>{signed(r.resultat_periode)}</td>
                        <td style={td}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                            <input
                              type="number" min={0} step={1}
                              value={mainsEdits[r.player_id] ?? String(r.mains)}
                              onChange={(e) => setMainsEdits((m) => ({ ...m, [r.player_id]: e.target.value }))}
                              style={{ width: 90, padding: "5px 8px", borderRadius: 6, fontSize: 12, textAlign: "right", background: "var(--bg-base)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", fontVariantNumeric: "tabular-nums" }}
                            />
                            {edited && (
                              <button onClick={() => saveMains(r.player_id)} disabled={busy === r.player_id} title="Enregistrer les mains" style={{ background: "rgba(16,185,129,0.15)", border: "none", borderRadius: 6, cursor: "pointer", color: "#10B981", padding: "5px 6px", display: "inline-flex" }}>
                                <Check size={13} />
                              </button>
                            )}
                          </span>
                        </td>
                        <td style={{ ...td, color: r.c >= 0 ? "var(--text)" : "#EF4444" }}>{signed(r.c)}</td>
                        <td style={{ ...td, color: r.t > 0 ? "#F5C518" : "var(--text-muted)" }}>{signed(r.t)}</td>
                        <td style={{ padding: "10px 10px 10px 16px", textAlign: "left", fontSize: 12, fontWeight: 600, color: reg.color, whiteSpace: "nowrap" }}>{reg.text}</td>
                        <td style={{ ...td, textAlign: "center" }}><ConditionBadge row={r} /></td>
                        <td style={{ ...td, textAlign: "center" }}>
                          <Btn onClick={() => openRecap(r)} disabled={busy === r.player_id} style={{ fontSize: 11, gap: 5, padding: "6px 10px" }}>
                            <Scale size={13} /> Régler
                          </Btn>
                        </td>
                      </tr>
                      {isWalletOpen && (
                        <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}>
                          <td colSpan={COLS} style={{ padding: "16px 20px" }}>
                            <div style={{ marginBottom: 12 }}>
                              <label style={{ fontSize: 10, fontWeight: 700, color: "#38bdf8", textTransform: "uppercase", display: "block", marginBottom: 6, letterSpacing: "0.06em" }}>Wallets dépôt QQPK (game)</label>
                              {walletInlineVals.game_wallets.map((addr, idx) => (
                                <div key={idx} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                                  <input value={addr} onChange={(e) => setWalletInlineVals((v) => ({ ...v, game_wallets: v.game_wallets.map((c, i) => i === idx ? e.target.value : c) }))} placeholder="TXxxx… (adresse TRC20)" spellCheck={false} style={{ flex: 1, maxWidth: 480, padding: "8px 10px", borderRadius: 6, fontSize: 12, fontFamily: "monospace", background: "var(--bg-elevated)", color: "var(--text)", border: "1px solid #38bdf840", outline: "none", boxSizing: "border-box" }} />
                                  <button onClick={() => setWalletInlineVals((v) => ({ ...v, game_wallets: v.game_wallets.length === 1 ? [""] : v.game_wallets.filter((_, i) => i !== idx) }))} title="Retirer" style={{ display: "flex", alignItems: "center", padding: 6, borderRadius: 5, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}><X size={13} /></button>
                                </div>
                              ))}
                              <button onClick={() => setWalletInlineVals((v) => ({ ...v, game_wallets: [...v.game_wallets, ""] }))} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 5, fontSize: 11, fontWeight: 600, background: "rgba(56,189,248,0.12)", color: "#38bdf8", border: "1px dashed #38bdf860", cursor: "pointer", marginTop: 2 }}><Plus size={11} /> Ajouter un wallet dépôt</button>
                            </div>
                            <div style={{ marginBottom: 12 }}>
                              <label style={{ fontSize: 10, fontWeight: 700, color: "#fb923c", textTransform: "uppercase", display: "block", marginBottom: 6, letterSpacing: "0.06em" }}>Wallets retrait / cashout</label>
                              {walletInlineVals.cashouts.map((addr, idx) => (
                                <div key={idx} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                                  <input value={addr} onChange={(e) => setWalletInlineVals((v) => ({ ...v, cashouts: v.cashouts.map((c, i) => i === idx ? e.target.value : c) }))} placeholder="TXxxx… (Binance, perso, etc.)" spellCheck={false} style={{ flex: 1, maxWidth: 480, padding: "8px 10px", borderRadius: 6, fontSize: 12, fontFamily: "monospace", background: "var(--bg-elevated)", color: "var(--text)", border: "1px solid #fb923c40", outline: "none", boxSizing: "border-box" }} />
                                  <button onClick={() => setWalletInlineVals((v) => ({ ...v, cashouts: v.cashouts.length === 1 ? [""] : v.cashouts.filter((_, i) => i !== idx) }))} title="Retirer" style={{ display: "flex", alignItems: "center", padding: 6, borderRadius: 5, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}><X size={13} /></button>
                                </div>
                              ))}
                              <button onClick={() => setWalletInlineVals((v) => ({ ...v, cashouts: [...v.cashouts, ""] }))} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 5, fontSize: 11, fontWeight: 600, background: "rgba(251,146,60,0.12)", color: "#fb923c", border: "1px dashed #fb923c60", cursor: "pointer", marginTop: 2 }}><Plus size={11} /> Ajouter une adresse cashout</button>
                            </div>
                            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                              <button onClick={() => setExpandedWallet(null)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}><X size={13} /> Annuler</button>
                              <button onClick={() => saveInlineWallet(r.player_id)} disabled={savingWallet} style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "rgba(34,197,94,0.12)", color: "var(--green)", border: "1px solid rgba(34,197,94,0.3)", cursor: "pointer", whiteSpace: "nowrap" }}><Save size={13} /> {savingWallet ? "..." : "Enregistrer"}</button>
                            </div>
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

      {/* History */}
      {history.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 12 }}>Historique des cycles réglés</h3>
          <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 12, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ ...th, textAlign: "left" }}>Joueur</th>
                  <th style={{ ...th, textAlign: "left" }}>Cycle</th>
                  <th style={th}>Résultat</th>
                  <th style={th}>Mains</th>
                  <th style={th}>C final</th>
                  <th style={th}>T final</th>
                  <th style={{ ...th, textAlign: "left", paddingLeft: 16 }}>Règlement</th>
                  <th style={{ ...th, textAlign: "center" }}>30k</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => {
                  const reg = reglementLabel(h.reglement);
                  return (
                    <tr key={`${h.player_id}-${h.cycle_start}`} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ ...td, textAlign: "left", fontWeight: 600, color: "var(--text)" }}>{h.player_name}</td>
                      <td style={{ ...td, textAlign: "left", color: "var(--text-muted)", fontSize: 11, whiteSpace: "nowrap" }}>{fmtDate(h.cycle_start)} → {fmtDate(h.cycle_end_incl)}</td>
                      <td style={{ ...td, color: h.resultat_periode >= 0 ? "#10B981" : "#EF4444" }}>{signed(h.resultat_periode)}</td>
                      <td style={td}>{h.mains.toLocaleString("fr-FR")}</td>
                      <td style={td}>{signed(h.c)}</td>
                      <td style={td}>{signed(h.t)}</td>
                      <td style={{ padding: "10px 10px 10px 16px", textAlign: "left", fontSize: 12, fontWeight: 600, color: reg.color, whiteSpace: "nowrap" }}>{reg.text}</td>
                      <td style={{ ...td, textAlign: "center" }}><ConditionBadge row={h} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recap modal */}
      <Modal open={!!recap} onClose={() => setRecap(null)} title="Régler le cycle — récapitulatif">
        {recap && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {!recap.preview.ok ? (
              <div style={{ padding: 14, borderRadius: 8, background: "rgba(239,68,68,0.1)", color: "#EF4444", fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
                <AlertTriangle size={16} /> {recap.preview.error ?? "Impossible de régler ce cycle."}
              </div>
            ) : (
              <>
                <div style={{ fontSize: 13, color: "var(--text)" }}>
                  <b>{recap.player.player_name}</b> · cycle <b>{fmtDate(recap.preview.cycle!.cycle_start)} → {fmtDate(recap.preview.cycle!.cycle_end_incl)}</b>
                  <span style={{ color: "var(--text-dim)" }}> (échéance {fmtDate(recap.preview.cycle!.settle_date)})</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 12 }}>
                  <RecapLine label="Résultat (net cycle)" value={`${signed(recap.preview.resultat_periode ?? 0)} USDT`} />
                  <RecapLine label="Mains" value={(recap.preview.mains ?? 0).toLocaleString("fr-FR")} />
                  <RecapLine label="C (cycle)" value={signed(recap.preview.c ?? 0)} />
                  <RecapLine label="T (position)" value={signed(recap.preview.t ?? 0)} />
                </div>
                <div style={{ padding: 14, borderRadius: 8, background: "var(--bg-base)", border: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Règlement</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: reglementLabel(recap.preview.reglement ?? 0).color }}>
                    {reglementLabel(recap.preview.reglement ?? 0).text}
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", marginRight: 6 }}>Condition 30k :</span>
                    <ConditionBadge row={{ mains: recap.preview.mains ?? 0, condition_30k_applied: !!recap.preview.condition_30k_applied }} />
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  Reset sec : une fois réglé, le cycle devient immuable et le suivant repart à C=0/T=0 (aucun carry).
                </div>
              </>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <Btn onClick={() => setRecap(null)} style={{ background: "var(--bg-base)" }}>Annuler</Btn>
              {recap.preview.ok && (
                <Btn variant="primary" onClick={confirmSettle} disabled={confirming}>{confirming ? "..." : "Confirmer le règlement"}</Btn>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Card({ label, value, color, hint }: { label: string; value: string; color: string; hint: string }) {
  return (
    <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>{hint}</div>
    </div>
  );
}

function RecapLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ color: "var(--text)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}
