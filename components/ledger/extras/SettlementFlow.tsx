"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Scale, Lock, Unlock, BadgeCheck, AlertTriangle, ArrowDownLeft, ArrowUpRight, ExternalLink,
} from "lucide-react";
import Btn from "@/components/Btn";
import Modal from "@/components/Modal";

/**
 * Ledger extra — manual settlement flow for one player: week chips → tx
 * checkbox selection → "Régler la sélection" → recap modal → Lock, plus the
 * player's locked/paid settlements (pay / unlock).
 *
 * Extracted VERBATIM from app/a5poker/pnl/A5SettlementClient.tsx (the design
 * Baki validated for manual settlements). All money math stays server-side in
 * lib/manual-settlement-engine.ts via the server actions passed as props;
 * this component only displays what preview/lock return.
 *
 * READ-ONLY MODE (shadow routes): pass ONLY `previewAction` (pure computation,
 * zero writes) and leave lockAction/markPaidAction/unlockAction undefined —
 * the Lock / Marquer réglé / Délock buttons render disabled with an explicit
 * "écriture désactivée" notice. The write actions are simply not wired.
 */

const TRONSCAN_TX = "https://tronscan.org/#/transaction/";

export interface AvailableTx { id: number; tx_datetime: string; tx_date: string; type: "deposit" | "withdrawal"; amount: number; currency: string; source: string | null; tron_tx_hash?: string | null }
export interface SettlementRow {
  id: number; player_id: number; player_name: string; net_selected_usdt: number;
  action_pct_applied: number; amount_due_usdt: number; status: "locked" | "paid";
  tx_hash: string | null; notes: string | null; locked_at: string; paid_at: string | null;
  created_at: string; tx_count: number;
}
export interface SettlementPreview {
  ok: boolean; error?: string; tx_count: number; period_start: string | null; period_end: string | null;
  total_deposited_usdt: number; total_withdrawn_usdt: number; net_selected_usdt: number;
  action_pct: number; amount_due_usdt: number;
}

function fmt(n: number): string { return Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function signed(n: number): string { return (n >= 0 ? "+" : "−") + fmt(n); }
function fmtDate(s: string | null): string { if (!s) return "—"; return new Date(s).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" }); }
function fmtDM(d: Date): string { return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" }); }
/**
 * Due display: signed amount + color only (green = en ta faveur, rouge = tu
 * dois) — the word "verse" is banned from ALL renderings including tooltips
 * (Baki: crée du flou; tooltips resurfaced it on hover). The payment direction
 * stays in `hint` (tooltip) and as a discreet arrow in the recap.
 * Sign convention unchanged: positive = sortie, le Cercle paie le joueur.
 */
export function dueLabel(due: number): { text: string; color: string; hint: string } {
  if (Math.abs(due) < 0.005) return { text: "0,00 USDT", color: "var(--text-dim)", hint: "Solde nul — rien à payer" };
  if (due > 0) return { text: `${signed(due)} USDT`, color: "#EF4444", hint: "Sortie — le Cercle paie le joueur" };
  return { text: `${signed(due)} USDT`, color: "#10B981", hint: "Entrée — le joueur paie le Cercle" };
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

const ghostMini: React.CSSProperties = { padding: "4px 9px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" };

function RecapLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ color: "var(--text)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

export default function SettlementFlow({
  playerId, playerName, avail, settlements,
  previewAction, lockAction, markPaidAction, unlockAction,
  gameId,
  readOnlyNotice = "Shadow — écriture désactivée",
}: {
  playerId: number;
  playerName: string;
  avail: AvailableTx[];
  settlements: SettlementRow[];
  previewAction: (playerId: number, txIds: number[]) => Promise<SettlementPreview>;
  lockAction?: (playerId: number, txIds: number[]) => Promise<{ ok: boolean; error?: string }>;
  markPaidAction?: (settlementId: number, txHash?: string) => Promise<{ ok: boolean; error?: string }>;
  unlockAction?: (settlementId: number) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Game the manual-tx form writes to (canonical game on merged pages, e.g.
   * A5POKER for A5NUTS). Undefined or read-only mode → the form is hidden.
   */
  gameId?: number;
  readOnlyNotice?: string;
}) {
  const router = useRouter();
  const readOnly = !lockAction;
  const canAddManualTx = !readOnly && gameId !== undefined;

  // distinct weeks present in this player's unsettled tx (ascending)
  const weekMap = new Map<string, string>();
  for (const tx of avail) { const w = weekInfo(tx.tx_datetime ?? tx.tx_date); if (!weekMap.has(w.key)) weekMap.set(w.key, w.label); }
  const weeks = [...weekMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, label]) => ({ key, label }));

  const [curWeek, setCurWeek] = useState<string | undefined>(weeks.length > 0 ? weeks[weeks.length - 1].key : undefined);
  // The most recent week's tx come pre-checked (weekly settle = 1 click less);
  // the recap/preview before Lock stays the safety gate on what's selected.
  const [sel, setSel] = useState<Set<number>>(() => {
    const def = weeks.length > 0 ? weeks[weeks.length - 1].key : undefined;
    return def ? new Set(avail.filter(t => weekInfo(t.tx_datetime ?? t.tx_date).key === def).map(t => t.id)) : new Set();
  });
  const [recap, setRecap] = useState<{ ids: number[]; preview: SettlementPreview | null } | null>(null);
  const [settleBusy, setSettleBusy] = useState(false);
  const [payHash, setPayHash] = useState<Record<number, string>>({});
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [manualTx, setManualTx] = useState({ type: "deposit" as "deposit" | "withdrawal", amount: "", date: new Date().toISOString().slice(0, 10) });
  const [manualBusy, setManualBusy] = useState(false);

  // Manual tx add/delete — thin calls to the existing /api/wallets endpoints
  // (insertWalletTransaction stamps source='manual'; DELETE refuses non-manual
  // rows). No money math here (invariant #2).
  async function addManualTx() {
    if (!canAddManualTx) return;
    const amt = Number(manualTx.amount);
    if (!Number.isFinite(amt) || amt <= 0) { alert("Montant invalide."); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(manualTx.date)) { alert("Date invalide."); return; }
    setManualBusy(true);
    try {
      const res = await fetch("/api/wallets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_id: playerId, game_id: gameId, type: manualTx.type, amount: amt, currency: "USDT", note: "manuel", tx_date: manualTx.date }),
      });
      if (!res.ok) { alert("Erreur lors de l'ajout de la transaction."); return; }
      setManualTx(v => ({ ...v, amount: "" }));
      router.refresh();
    } finally { setManualBusy(false); }
  }

  async function deleteManualTx(txId: number) {
    if (readOnly) return;
    if (!confirm("Supprimer cette transaction manuelle ?")) return;
    setManualBusy(true);
    try {
      const res = await fetch(`/api/wallets/${txId}`, { method: "DELETE" });
      if (!res.ok) { alert("Suppression refusée (seules les tx manuelles sont supprimables)."); return; }
      setSel(prev => { const set = new Set(prev); set.delete(txId); return set; });
      router.refresh();
    } finally { setManualBusy(false); }
  }

  function toggleTx(txId: number) {
    setSel(prev => { const set = new Set(prev); if (set.has(txId)) set.delete(txId); else set.add(txId); return set; });
  }

  async function openRecap() {
    const ids = [...sel];
    if (ids.length === 0) { alert("Sélectionne au moins une transaction."); return; }
    setSettleBusy(true);
    setRecap({ ids, preview: null });
    try { const preview = await previewAction(playerId, ids); setRecap({ ids, preview }); }
    finally { setSettleBusy(false); }
  }

  async function confirmLock() {
    if (!recap?.preview?.ok || !lockAction) return;
    setSettleBusy(true);
    try {
      const res = await lockAction(playerId, recap.ids);
      if (!res.ok) alert(res.error ?? "Erreur lock");
      setSel(new Set());
      setRecap(null);
      router.refresh();
    } finally { setSettleBusy(false); }
  }

  async function pay(settlementId: number) {
    if (!markPaidAction) return;
    setRowBusy(settlementId);
    try { const res = await markPaidAction(settlementId, payHash[settlementId]?.trim() || undefined); if (!res.ok) { alert(res.error ?? "Erreur"); return; } router.refresh(); }
    finally { setRowBusy(null); }
  }
  async function unlock(settlementId: number) {
    if (!unlockAction) return;
    if (!confirm("Délock ce règlement ? Les transactions redeviennent sélectionnables.")) return;
    setRowBusy(settlementId);
    try { const res = await unlockAction(settlementId); if (!res.ok) { alert(res.error ?? "Erreur"); return; } router.refresh(); }
    finally { setRowBusy(null); }
  }

  const disabledBtn: React.CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
        <Scale size={13} color="#F5C518" /> Règlement manuel — choisis les transactions à régler
        {readOnly && <span style={{ fontSize: 10, fontWeight: 700, color: "#c084fc", background: "rgba(168,85,247,0.10)", border: "1px solid rgba(168,85,247,0.35)", padding: "1px 8px", borderRadius: 10, textTransform: "none", letterSpacing: 0 }}>{readOnlyNotice} — le récap (preview) est calculé en vrai, le Lock est désactivé</span>}
      </div>

      {avail.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }}>Aucune transaction à régler (tout est settled).</div>
      ) : (
        <>
          {/* Week chips (visual anchor) */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {weeks.map(w => (
              <button key={w.key} onClick={() => setCurWeek(w.key)} style={{
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
              <button onClick={() => setSel(new Set(avail.map(t => t.id)))} style={ghostMini}>Tout cocher</button>
              <button onClick={() => setSel(new Set())} style={ghostMini}>Tout décocher</button>
              {curWeek && <button onClick={() => setSel(new Set(avail.filter(t => weekInfo(t.tx_datetime ?? t.tx_date).key === curWeek).map(t => t.id)))} style={ghostMini}>Cocher la semaine</button>}
            </div>
            <div style={{ maxHeight: 360, overflowY: "auto" }}>
              {avail.map(tx => {
                const isDep = tx.type === "deposit";
                const checked = sel.has(tx.id);
                const inWeek = curWeek && weekInfo(tx.tx_datetime ?? tx.tx_date).key === curWeek;
                return (
                  <div key={tx.id} onClick={() => toggleTx(tx.id)} style={{
                    display: "grid", gridTemplateColumns: "32px 120px 140px 1fr 40px 26px", gap: 12, alignItems: "center", padding: "9px 12px", cursor: "pointer",
                    background: checked ? "rgba(34,197,94,0.10)" : "transparent",
                    borderBottom: "1px solid var(--border)",
                    borderLeft: inWeek ? "3px solid #F5C518" : "3px solid transparent",
                  }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleTx(tx.id)} onClick={e => e.stopPropagation()} style={{ cursor: "pointer", accentColor: "#10B981" }} />
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{(tx.tx_datetime ?? tx.tx_date).slice(0, 10)}</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: isDep ? "#f87171" : "var(--green)", fontWeight: 600, fontSize: 12 }}>{isDep ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}{isDep ? "Dépôt" : "Retrait"}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: isDep ? "#f87171" : "var(--green)" }}>{isDep ? "−" : "+"}{fmt(tx.amount)} {tx.currency}</span>
                    <span style={{ textAlign: "center", fontSize: 13 }}>
                      {tx.source === "sync" && tx.tron_tx_hash ? (
                        // Link to the on-chain transfer — stopPropagation so the click
                        // opens Tronscan without toggling the row's checkbox.
                        <a href={TRONSCAN_TX + tx.tron_tx_hash} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                          title={`Voir le transfert ${tx.tron_tx_hash.slice(0, 12)}… sur Tronscan`} style={{ textDecoration: "none" }}>🔗</a>
                      ) : (
                        <span title={tx.source ?? "?"}>{tx.source === "sync" ? "🔗" : tx.source === "manual" ? "✍️" : "⚠️"}</span>
                      )}
                    </span>
                    <span style={{ textAlign: "center" }}>
                      {tx.source === "manual" && !readOnly && (
                        <button onClick={e => { e.stopPropagation(); deleteManualTx(tx.id); }} disabled={manualBusy} title="Supprimer cette tx manuelle"
                          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, padding: 0, opacity: 0.7 }}>🗑</button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderTop: "1px solid var(--border)" }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{sel.size} sélectionnée{sel.size > 1 ? "s" : ""}</span>
              <div style={{ flex: 1 }} />
              <Btn variant="primary" onClick={openRecap} disabled={settleBusy || sel.size === 0} style={{ fontSize: 12, gap: 6, padding: "8px 16px" }}>
                <Scale size={14} /> Régler la sélection ({sel.size})
              </Btn>
            </div>
          </div>
        </>
      )}

      {/* Manual tx entry — restores the TELEClient feature lost in the LedgerShell
          migration. Writes through POST /api/wallets (source='manual'). */}
      {canAddManualTx && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "10px 12px", border: "1px dashed var(--border)", borderRadius: 10, background: "var(--bg-base)", marginBottom: 12 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>➕ Tx manuelle</span>
          <select value={manualTx.type} onChange={e => setManualTx(v => ({ ...v, type: e.target.value as "deposit" | "withdrawal" }))}
            style={{ padding: "6px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--bg-elevated)", border: "1px solid var(--border)", color: manualTx.type === "deposit" ? "#f87171" : "var(--green)", cursor: "pointer" }}>
            <option value="deposit">Dépôt</option>
            <option value="withdrawal">Retrait</option>
          </select>
          <input type="number" min="0" step="0.01" value={manualTx.amount} onChange={e => setManualTx(v => ({ ...v, amount: e.target.value }))} placeholder="Montant USDT"
            style={{ width: 130, padding: "6px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text)", outline: "none" }} />
          <input type="date" value={manualTx.date} onChange={e => setManualTx(v => ({ ...v, date: e.target.value }))}
            style={{ padding: "6px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text)", outline: "none", colorScheme: "dark" }} />
          <Btn variant="secondary" onClick={addManualTx} disabled={manualBusy || !manualTx.amount} style={{ fontSize: 12, padding: "6px 12px" }}>
            {manualBusy ? "…" : "Ajouter"}
          </Btn>
        </div>
      )}

      {/* Player's settlements */}
      {settlements.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Règlements du joueur</div>
          {settlements.map(s => {
            const reg = dueLabel(s.amount_due_usdt);
            const isLocked = s.status === "locked";
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 10px", borderRadius: 6, marginBottom: 6, background: "var(--bg-base)", border: `1px solid ${isLocked ? "rgba(245,197,24,0.25)" : "var(--border)"}` }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: isLocked ? "#F5C518" : "#10B981" }}>{isLocked ? <Lock size={12} /> : <BadgeCheck size={12} />}{isLocked ? "Locked" : "Réglé"}</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{s.tx_count} tx · {fmtDate(isLocked ? s.locked_at : s.paid_at)}</span>
                <span title={reg.hint} style={{ fontSize: 12, fontWeight: 600, color: reg.color, cursor: "help" }}>{reg.text}</span>
                <div style={{ flex: 1 }} />
                {isLocked ? (
                  <>
                    <input value={payHash[s.id] ?? ""} onChange={e => setPayHash(h => ({ ...h, [s.id]: e.target.value }))} disabled={readOnly} placeholder="tx_hash (option.)" spellCheck={false} style={{ width: 150, padding: "5px 8px", borderRadius: 6, fontSize: 11, fontFamily: "monospace", background: "var(--bg-elevated)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", ...(readOnly ? { opacity: 0.45 } : {}) }} />
                    <button onClick={() => pay(s.id)} disabled={readOnly || rowBusy === s.id} title={readOnly ? readOnlyNotice : undefined} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "rgba(34,197,94,0.12)", color: "var(--green)", border: "1px solid rgba(34,197,94,0.3)", cursor: "pointer", ...(readOnly ? disabledBtn : {}) }}><BadgeCheck size={12} /> Marquer réglé</button>
                    <button onClick={() => unlock(s.id)} disabled={readOnly || rowBusy === s.id} title={readOnly ? readOnlyNotice : "Délock"} style={{ display: "inline-flex", alignItems: "center", padding: "6px 8px", borderRadius: 6, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer", ...(readOnly ? disabledBtn : {}) }}><Unlock size={12} /></button>
                  </>
                ) : (
                  s.tx_hash ? <a href={TRONSCAN_TX + s.tx_hash} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#38bdf8", textDecoration: "none", fontSize: 11, fontFamily: "monospace" }}>{s.tx_hash.slice(0, 8)}…<ExternalLink size={10} /></a> : <span style={{ fontSize: 11, color: "var(--text-dim)" }}>—</span>
                )}
              </div>
            );
          })}
        </div>
      )}

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
                  <b>{playerName}</b> · {recap.preview.tx_count} transaction{recap.preview.tx_count > 1 ? "s" : ""}
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
                  {(() => {
                    const due = recap.preview.amount_due_usdt;
                    const reg = dueLabel(due);
                    return (
                      // Money-critical: the payment direction must stay readable before
                      // Lock without the sentence — discreet arrow (↗ = sortie du Cercle,
                      // ↘ = entrée) + tooltip carry it alongside the color.
                      <div title={reg.hint} style={{ fontSize: 18, fontWeight: 700, color: reg.color, display: "inline-flex", alignItems: "center", gap: 6, cursor: "help" }}>
                        {Math.abs(due) >= 0.005 && (due > 0 ? <ArrowUpRight size={15} /> : <ArrowDownLeft size={15} />)}
                        {reg.text}
                      </div>
                    );
                  })()}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Après lock, ces {recap.preview.tx_count} transactions sont figées (settled) et ne pourront plus entrer dans un autre règlement.</div>
                {readOnly && (
                  <div style={{ padding: "8px 12px", borderRadius: 8, background: "rgba(168,85,247,0.10)", border: "1px solid rgba(168,85,247,0.35)", fontSize: 12, color: "#c084fc", fontWeight: 600 }}>
                    {readOnlyNotice} — ce récap est calculé sur la vraie data, mais le Lock est impossible depuis le shadow.
                  </div>
                )}
              </>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <Btn variant="secondary" onClick={() => setRecap(null)}>Annuler</Btn>
              {recap.preview?.ok && (
                readOnly
                  ? <span title={readOnlyNotice}><Btn variant="primary" disabled style={disabledBtn}><Lock size={14} /> Lock (désactivé)</Btn></span>
                  : <Btn variant="primary" onClick={confirmLock} disabled={settleBusy}><Lock size={14} /> {settleBusy ? "…" : "Lock"}</Btn>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
