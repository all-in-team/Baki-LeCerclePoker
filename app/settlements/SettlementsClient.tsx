"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  runSettlement,
  lockWeekAction,
  unlockWeekAction,
  validatePlayerAction,
  excludeTransaction,
  includeTransaction,
  removeOverrideAction,
  getTransactionsForSettlement,
  getAvailableTransactionsAction,
} from "./actions";

interface SettlementRow {
  id: number;
  week_start: string;
  player_id: number;
  player_name: string;
  status: string;
  pnl_player: number | null;
  pnl_operator: number | null;
  action_pct_snapshot: number | null;
  lock_anchor_tx_id: number | null;
  lock_anchor_datetime: string | null;
  locked_at: string | null;
  locked_by: string | null;
  manual_close_amount: number | null;
  note: string | null;
  override_count: number;
}

interface TxRow {
  id: number;
  tx_datetime: string;
  type: "deposit" | "withdrawal";
  amount: number;
  source: string | null;
  tron_tx_hash: string | null;
  is_override: boolean;
  override_action?: "include";
}

interface Period {
  id: number;
  week_start: string;
  week_end: string;
  status: string;
  computed_at: string | null;
  locked_at: string | null;
}

interface Props {
  weekStart: string;
  weekEnd: string;
  period: Period | null;
  rows: SettlementRow[];
  rangeLabel: string;
  weeks: { isoWeek: string; label: string }[];
}

export default function SettlementsClient({ weekStart, weekEnd, period, rows, rangeLabel, weeks }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [txList, setTxList] = useState<TxRow[]>([]);
  const [availableTxs, setAvailableTxs] = useState<TxRow[] | null>(null);
  const [manualAmounts, setManualAmounts] = useState<Record<number, string>>({});

  const isLocked = period?.status === "locked";

  const autoSettled = rows.filter(r => r.status === "auto_settled");
  const pendingManual = rows.filter(r => r.status === "pending_manual");
  const settled = rows.filter(r => r.status === "settled" || r.status === "carry_over");
  const allEditable = [...autoSettled, ...pendingManual];
  const canLock = period && !isLocked && pendingManual.length === 0 && rows.filter(r => r.status === "conflict").length === 0;

  async function handleCompute() {
    setLoading("compute");
    try {
      const result = await runSettlement(weekStart, false);
      if (result.needs_confirm) {
        if (confirm(`Recomputing will discard ${result.override_count} edit(s) for this week. Continue?`)) {
          await runSettlement(weekStart, true);
        } else {
          setLoading(null);
          return;
        }
      }
      startTransition(() => router.refresh());
    } catch (e: any) {
      alert(e.message || "Error computing week");
    } finally {
      setLoading(null);
    }
  }

  async function handleLock() {
    if (!confirm("Lock this week? Settlements become immutable after lock.")) return;
    setLoading("lock");
    try {
      const result = await lockWeekAction(weekStart);
      if (!result.ok) { alert(result.error); return; }
      startTransition(() => router.refresh());
    } catch (e: any) {
      alert(e.message || "Error locking week");
    } finally {
      setLoading(null);
    }
  }

  async function handleUnlock() {
    if (!confirm("Unlock this week? Settlement rows return to editable state. Audit trail preserved.")) return;
    setLoading("unlock");
    try {
      const result = await unlockWeekAction(weekStart);
      if (!result.ok) { alert(result.error); return; }
      startTransition(() => router.refresh());
    } catch (e: any) {
      alert(e.message || "Error unlocking week");
    } finally {
      setLoading(null);
    }
  }

  async function handleValidate(playerId: number, action: "carry_over" | "manual_close", payload?: { amount?: number }) {
    setLoading(`validate-${playerId}`);
    try {
      const result = await validatePlayerAction(playerId, weekStart, action, payload);
      if (!result.ok) { alert(result.error); return; }
      startTransition(() => router.refresh());
    } catch (e: any) {
      alert(e.message || "Error");
    } finally {
      setLoading(null);
    }
  }

  async function toggleExpand(row: SettlementRow) {
    if (expandedRow === row.id) {
      setExpandedRow(null);
      setTxList([]);
      setAvailableTxs(null);
      return;
    }
    setExpandedRow(row.id);
    setAvailableTxs(null);
    const txs = await getTransactionsForSettlement(row.id);
    setTxList(txs);
  }

  async function handleExclude(settlementId: number, txId: number) {
    setLoading(`exclude-${txId}`);
    try {
      await excludeTransaction(settlementId, txId);
      const txs = await getTransactionsForSettlement(settlementId);
      setTxList(txs);
      startTransition(() => router.refresh());
    } finally {
      setLoading(null);
    }
  }

  async function handleRemoveOverride(settlementId: number, txId: number) {
    setLoading(`undo-${txId}`);
    try {
      await removeOverrideAction(settlementId, txId);
      const txs = await getTransactionsForSettlement(settlementId);
      setTxList(txs);
      startTransition(() => router.refresh());
    } finally {
      setLoading(null);
    }
  }

  async function openAddModal(playerId: number, settlementId: number) {
    const txs = await getAvailableTransactionsAction(playerId, weekStart, settlementId);
    setAvailableTxs(txs);
  }

  async function handleInclude(settlementId: number, txId: number) {
    setLoading(`include-${txId}`);
    try {
      await includeTransaction(settlementId, txId);
      const txs = await getTransactionsForSettlement(settlementId);
      setTxList(txs);
      setAvailableTxs(null);
      startTransition(() => router.refresh());
    } finally {
      setLoading(null);
    }
  }

  function fmt(n: number | null) {
    if (n === null) return "—";
    return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
  }

  function fmtDate(iso: string | null) {
    if (!iso) return "—";
    return iso.replace("T", " ").replace("Z", "").slice(0, 16);
  }

  function statusEmoji(s: string) {
    switch (s) {
      case "auto_settled": return "🟢";
      case "pending_manual": return "🟡";
      case "carry_over": return "⏭️";
      case "settled": return "✅";
      default: return "🔴";
    }
  }

  return (
    <div style={{ padding: "0 28px 40px" }}>
      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <select
          value={weekStart}
          onChange={e => { setExpandedRow(null); router.push(`/settlements?week=${e.target.value}`); }}
          style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-raised)", color: "var(--text)", fontSize: 13 }}
        >
          {weeks.map(w => (
            <option key={w.isoWeek} value={w.isoWeek}>{w.label}</option>
          ))}
        </select>
        <span style={{ fontSize: 14, color: "var(--text-muted)" }}>{rangeLabel}</span>

        {isLocked && (
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ background: "rgba(34,197,94,0.15)", color: "var(--green)", padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
              {"🔒"} Locked {period?.locked_at ? `on ${fmtDate(period.locked_at)}` : ""}
            </span>
            <button
              onClick={handleUnlock}
              disabled={loading !== null}
              title="Unlock this week for editing"
              style={{ padding: "5px 8px", borderRadius: 5, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}
            >
              {"🔓"} Unlock
            </button>
          </div>
        )}

        {!isLocked && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {period && pendingManual.length > 0 && (
              <span style={{ background: "rgba(234,179,8,0.15)", color: "var(--gold)", padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center" }}>
                {"🟡"} {pendingManual.length} pending
              </span>
            )}
            <button
              onClick={handleCompute}
              disabled={loading !== null || isPending}
              style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: "var(--gold)", color: "#000", fontWeight: 600, fontSize: 13, cursor: loading ? "wait" : "pointer" }}
            >
              {loading === "compute" ? "Computing..." : period ? "Recompute" : "Compute week"}
            </button>
            {canLock && (
              <button
                onClick={handleLock}
                disabled={loading !== null}
                style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: "var(--green)", color: "#000", fontWeight: 600, fontSize: 13, cursor: "pointer" }}
              >
                Lock week
              </button>
            )}
          </div>
        )}
      </div>

      {rows.length === 0 && !loading && (
        <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>
          No settlement data for this week. Click &quot;Compute week&quot; to run the engine.
        </div>
      )}

      {/* Editable rows (auto_settled + pending_manual) */}
      {allEditable.length > 0 && (
        <Section title={`Players (${allEditable.length})`} color="var(--text)" emoji="">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
                <th style={{ width: 30, padding: "6px 4px" }}></th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Player</th>
                <th style={{ textAlign: "center", padding: "6px 8px" }}>Status</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>Wallet PnL</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>Action %</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>Op. PnL</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Anchor</th>
                <th style={{ textAlign: "center", padding: "6px 8px" }}>Edits</th>
              </tr>
            </thead>
            <tbody>
              {allEditable.map(row => (
                <PlayerRow
                  key={row.id}
                  row={row}
                  isExpanded={expandedRow === row.id}
                  isLocked={false}
                  txList={expandedRow === row.id ? txList : []}
                  availableTxs={expandedRow === row.id ? availableTxs : null}
                  loading={loading}
                  manualAmount={manualAmounts[row.player_id] || ""}
                  onToggleExpand={() => toggleExpand(row)}
                  onExclude={(txId) => handleExclude(row.id, txId)}
                  onRemoveOverride={(txId) => handleRemoveOverride(row.id, txId)}
                  onInclude={(txId) => handleInclude(row.id, txId)}
                  onOpenAdd={() => openAddModal(row.player_id, row.id)}
                  onCloseAdd={() => setAvailableTxs(null)}
                  onValidate={(action, payload) => handleValidate(row.player_id, action, payload)}
                  onManualAmountChange={(v) => setManualAmounts(prev => ({ ...prev, [row.player_id]: v }))}
                  fmt={fmt}
                  fmtDate={fmtDate}
                  statusEmoji={statusEmoji}
                />
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* Locked / terminal rows */}
      {settled.length > 0 && (
        <Section title={`Locked (${settled.length})`} color="var(--green)" emoji={"✅"}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Player</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>Wallet PnL</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>Action %</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>Op. PnL</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Locked</th>
              </tr>
            </thead>
            <tbody>
              {settled.map(row => (
                <tr key={row.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px", fontWeight: 500 }}>
                    {statusEmoji(row.status)} {row.player_name}
                  </td>
                  <td style={{ padding: "8px", textAlign: "right", color: (row.pnl_player ?? 0) >= 0 ? "var(--green)" : "#ef4444" }}>{fmt(row.pnl_player)} USDT</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>{row.action_pct_snapshot}%</td>
                  <td style={{ padding: "8px", textAlign: "right", color: (row.pnl_operator ?? 0) >= 0 ? "var(--green)" : "#ef4444" }}>{fmt(row.pnl_operator)} USDT</td>
                  <td style={{ padding: "8px", fontSize: 11, color: "var(--text-muted)" }}>{row.locked_by ?? "—"} {fmtDate(row.locked_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </div>
  );
}

// ── PlayerRow component ──────────────────────────────────

function PlayerRow({ row, isExpanded, isLocked, txList, availableTxs, loading, manualAmount, onToggleExpand, onExclude, onRemoveOverride, onInclude, onOpenAdd, onCloseAdd, onValidate, onManualAmountChange, fmt, fmtDate, statusEmoji }: {
  row: SettlementRow;
  isExpanded: boolean;
  isLocked: boolean;
  txList: TxRow[];
  availableTxs: TxRow[] | null;
  loading: string | null;
  manualAmount: string;
  onToggleExpand: () => void;
  onExclude: (txId: number) => void;
  onRemoveOverride: (txId: number) => void;
  onInclude: (txId: number) => void;
  onOpenAdd: () => void;
  onCloseAdd: () => void;
  onValidate: (action: "carry_over" | "manual_close", payload?: { amount?: number }) => void;
  onManualAmountChange: (v: string) => void;
  fmt: (n: number | null) => string;
  fmtDate: (s: string | null) => string;
  statusEmoji: (s: string) => string;
}) {
  return (
    <>
      <tr
        style={{ borderBottom: "1px solid var(--border)", cursor: "pointer" }}
        onClick={onToggleExpand}
      >
        <td style={{ padding: "8px 4px", textAlign: "center", fontSize: 11 }}>
          {isExpanded ? "▼" : "▶"}
        </td>
        <td style={{ padding: "8px", fontWeight: 500 }}>
          {row.player_name}
        </td>
        <td style={{ padding: "8px", textAlign: "center" }}>
          {statusEmoji(row.status)}
        </td>
        <td style={{ padding: "8px", textAlign: "right", color: (row.pnl_player ?? 0) >= 0 ? "var(--green)" : "#ef4444" }}>
          {fmt(row.pnl_player)} USDT
        </td>
        <td style={{ padding: "8px", textAlign: "right" }}>
          {row.action_pct_snapshot}%
        </td>
        <td style={{ padding: "8px", textAlign: "right", color: (row.pnl_operator ?? 0) >= 0 ? "var(--green)" : "#ef4444" }}>
          {fmt(row.pnl_operator)} USDT
        </td>
        <td style={{ padding: "8px", fontSize: 11, color: "var(--text-muted)" }}>
          {fmtDate(row.lock_anchor_datetime)}
        </td>
        <td style={{ padding: "8px", textAlign: "center" }}>
          {row.override_count > 0 && (
            <span style={{ background: "rgba(234,179,8,0.2)", color: "var(--gold)", padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
              {row.override_count} edit{row.override_count > 1 ? "s" : ""}
            </span>
          )}
        </td>
      </tr>

      {isExpanded && (
        <tr>
          <td colSpan={8} style={{ padding: "0 8px 16px 40px", background: "var(--bg-raised)" }}>
            {/* Transaction list */}
            {txList.length > 0 && (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 8 }}>
                <thead>
                  <tr style={{ color: "var(--text-muted)", fontSize: 10, textTransform: "uppercase" as const }}>
                    <th style={{ textAlign: "left", padding: "4px 6px" }}>Datetime</th>
                    <th style={{ textAlign: "left", padding: "4px 6px" }}>Type</th>
                    <th style={{ textAlign: "right", padding: "4px 6px" }}>Amount</th>
                    <th style={{ textAlign: "left", padding: "4px 6px" }}>Source</th>
                    <th style={{ padding: "4px 6px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {txList.map(tx => (
                    <tr key={tx.id} style={{ borderBottom: "1px solid var(--border)", opacity: tx.is_override ? 0.85 : 1 }}>
                      <td style={{ padding: "5px 6px", fontSize: 11 }}>{fmtDate(tx.tx_datetime)}</td>
                      <td style={{ padding: "5px 6px" }}>
                        <span style={{ color: tx.type === "deposit" ? "#ef4444" : "var(--green)" }}>
                          {tx.type === "deposit" ? "↓ dep" : "↑ wdr"}
                        </span>
                        {tx.is_override && (
                          <span style={{ marginLeft: 6, background: "rgba(59,130,246,0.15)", color: "#3b82f6", padding: "1px 4px", borderRadius: 3, fontSize: 9 }}>
                            added
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "5px 6px", textAlign: "right", fontFamily: "monospace" }}>{tx.amount.toFixed(2)}</td>
                      <td style={{ padding: "5px 6px", fontSize: 11, color: "var(--text-muted)" }}>{tx.source ?? "—"}</td>
                      <td style={{ padding: "5px 6px", textAlign: "right" }}>
                        {!isLocked && (
                          tx.is_override ? (
                            <button
                              onClick={(e) => { e.stopPropagation(); onRemoveOverride(tx.id); }}
                              disabled={loading !== null}
                              style={{ padding: "2px 6px", borderRadius: 3, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", fontSize: 10, cursor: "pointer" }}
                            >
                              Undo
                            </button>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); onExclude(tx.id); }}
                              disabled={loading !== null}
                              style={{ padding: "2px 6px", borderRadius: 3, border: "none", background: "rgba(239,68,68,0.15)", color: "#ef4444", fontSize: 10, cursor: "pointer" }}
                            >
                              Remove
                            </button>
                          )
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {txList.length === 0 && (
              <div style={{ padding: "12px 0", fontSize: 12, color: "var(--text-muted)" }}>No transactions in this settlement.</div>
            )}

            {/* Add transaction button / modal */}
            {!isLocked && (
              <div style={{ marginTop: 10 }}>
                {availableTxs === null ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); onOpenAdd(); }}
                    style={{ padding: "5px 10px", borderRadius: 5, border: "1px dashed var(--border)", background: "transparent", color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}
                  >
                    + Add transaction
                  </button>
                ) : (
                  <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12, background: "var(--bg)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>Available transactions ({availableTxs.length})</span>
                      <button onClick={(e) => { e.stopPropagation(); onCloseAdd(); }} style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>{"✕"}</button>
                    </div>
                    {availableTxs.length === 0 && (
                      <div style={{ fontSize: 11, color: "var(--text-muted)", padding: 8 }}>No other transactions found for this player.</div>
                    )}
                    {availableTxs.length > 0 && (
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                        <tbody>
                          {availableTxs.slice(0, 20).map(tx => (
                            <tr key={tx.id} style={{ borderBottom: "1px solid var(--border)" }}>
                              <td style={{ padding: "4px 6px" }}>{fmtDate(tx.tx_datetime)}</td>
                              <td style={{ padding: "4px 6px", color: tx.type === "deposit" ? "#ef4444" : "var(--green)" }}>
                                {tx.type === "deposit" ? "↓ dep" : "↑ wdr"}
                              </td>
                              <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "monospace" }}>{tx.amount.toFixed(2)}</td>
                              <td style={{ padding: "4px 6px", textAlign: "right" }}>
                                <button
                                  onClick={(e) => { e.stopPropagation(); onInclude(tx.id); }}
                                  disabled={loading !== null}
                                  style={{ padding: "2px 8px", borderRadius: 3, border: "none", background: "rgba(59,130,246,0.15)", color: "#3b82f6", fontSize: 10, fontWeight: 600, cursor: "pointer" }}
                                >
                                  Add
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Pending manual controls */}
            {!isLocked && row.status === "pending_manual" && (
              <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                <button
                  onClick={(e) => { e.stopPropagation(); onValidate("carry_over"); }}
                  disabled={loading !== null}
                  style={{ padding: "5px 10px", borderRadius: 5, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 12, cursor: "pointer" }}
                >
                  Carry over
                </button>
                <input
                  type="number" placeholder="Amount USDT"
                  value={manualAmount}
                  onClick={(e) => e.stopPropagation()}
                  onChange={e => onManualAmountChange(e.target.value)}
                  style={{ width: 100, padding: "5px 8px", borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 12 }}
                />
                <button
                  onClick={(e) => { e.stopPropagation(); onValidate("manual_close", { amount: parseFloat(manualAmount || "0") }); }}
                  disabled={loading !== null}
                  style={{ padding: "5px 10px", borderRadius: 5, border: "none", background: "var(--gold)", color: "#000", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                >
                  Manual close
                </button>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function Section({ title, color, emoji, children }: { title: string; color: string; emoji: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 28, background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px" }}>
      <h3 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600, color }}>{emoji}{emoji ? " " : ""}{title}</h3>
      {children}
    </div>
  );
}
