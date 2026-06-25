"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Scale, Check, AlertTriangle, Lock, Unlock, BadgeCheck, ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import Modal from "@/components/Modal";
import Btn from "@/components/Btn";
import { previewAction, lockAction, markPaidAction, unlockAction } from "./actions";

const TRONSCAN_TX = "https://tronscan.org/#/transaction/";

export interface AvailableTx {
  id: number; tx_datetime: string; tx_date: string;
  type: "deposit" | "withdrawal"; amount: number; currency: string; source: string | null;
}
export interface PlayerSettlementData {
  player_id: number; player_name: string; action_pct: number; available: AvailableTx[];
}
export interface SettlementRow {
  id: number; player_id: number; player_name: string;
  net_selected_usdt: number; action_pct_applied: number; amount_due_usdt: number;
  status: "locked" | "paid"; tx_hash: string | null; notes: string | null;
  locked_at: string; paid_at: string | null; created_at: string; tx_count: number;
}
interface Preview {
  ok: boolean; error?: string; tx_count: number;
  period_start: string | null; period_end: string | null;
  total_deposited_usdt: number; total_withdrawn_usdt: number;
  net_selected_usdt: number; action_pct: number; amount_due_usdt: number;
}

function fmt(n: number): string {
  return Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function signed(n: number): string {
  return (n >= 0 ? "+" : "−") + fmt(n);
}
function fmtDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" });
}
// règlement label: due > 0 → Cercle verse au joueur ; due < 0 → joueur verse au Cercle
function dueLabel(due: number): { text: string; color: string } {
  if (Math.abs(due) < 0.005) return { text: "Rien à verser", color: "var(--text-dim)" };
  if (due > 0) return { text: `Cercle verse ${fmt(due)} USDT`, color: "#EF4444" };
  return { text: `Joueur verse ${fmt(due)} USDT`, color: "#10B981" };
}

export default function A5ManualSettlement({
  players, history,
}: {
  players: PlayerSettlementData[];
  history: SettlementRow[];
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [selected, setSelected] = useState<Record<number, Set<number>>>({});
  const [recap, setRecap] = useState<{ player: PlayerSettlementData; ids: number[]; preview: Preview | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [payHash, setPayHash] = useState<Record<number, string>>({});
  const [rowBusy, setRowBusy] = useState<number | null>(null);

  const locked = history.filter(h => h.status === "locked");
  const paid = history.filter(h => h.status === "paid");
  const playersToSettle = players.filter(p => p.available.length > 0);

  function toggle(playerId: number, txId: number) {
    setSelected(prev => {
      const set = new Set(prev[playerId] ?? []);
      if (set.has(txId)) set.delete(txId); else set.add(txId);
      return { ...prev, [playerId]: set };
    });
  }
  function selectAll(p: PlayerSettlementData) {
    setSelected(prev => ({ ...prev, [p.player_id]: new Set(p.available.map(t => t.id)) }));
  }
  function clearSel(playerId: number) {
    setSelected(prev => ({ ...prev, [playerId]: new Set() }));
  }

  async function openRecap(p: PlayerSettlementData) {
    const ids = [...(selected[p.player_id] ?? [])];
    if (ids.length === 0) { alert("Sélectionne au moins une transaction."); return; }
    setBusy(true);
    setRecap({ player: p, ids, preview: null });
    try {
      const preview = (await previewAction(p.player_id, ids)) as Preview;
      setRecap({ player: p, ids, preview });
    } finally { setBusy(false); }
  }

  async function confirmLock() {
    if (!recap?.preview?.ok) return;
    setBusy(true);
    try {
      const res = await lockAction(recap.player.player_id, recap.ids);
      if (!res.ok) {
        // A tx may have been settled elsewhere between preview and lock → refresh to drop stale state.
        alert(res.error ?? "Erreur lock");
        setRecap(null);
        clearSel(recap.player.player_id);
        router.refresh();
        return;
      }
      setRecap(null);
      clearSel(recap.player.player_id);
      router.refresh();
    } finally { setBusy(false); }
  }

  async function pay(settlementId: number) {
    setRowBusy(settlementId);
    try {
      const res = await markPaidAction(settlementId, payHash[settlementId]?.trim() || undefined);
      if (!res.ok) { alert(res.error ?? "Erreur paiement"); return; }
      router.refresh();
    } finally { setRowBusy(null); }
  }

  async function unlock(settlementId: number) {
    if (!confirm("Délock ce règlement ? Les transactions redeviennent sélectionnables.")) return;
    setRowBusy(settlementId);
    try {
      const res = await unlockAction(settlementId);
      if (!res.ok) { alert(res.error ?? "Erreur délock"); return; }
      router.refresh();
    } finally { setRowBusy(null); }
  }

  const th: React.CSSProperties = { textAlign: "right", padding: "8px 10px", color: "var(--text-muted)", fontWeight: 600, fontSize: 11, whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "10px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 12 };

  return (
    <div style={{ padding: "8px 28px 40px" }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>Règlements manuels</h2>
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 18 }}>
        Sélectionne les transactions à régler (1ère → dernière), vérifie le récap, puis lock. Une tx réglée ne peut plus entrer dans un autre règlement.
      </div>

      {/* ── À régler — par joueur ── */}
      <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", marginBottom: 24 }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
          À régler — transactions disponibles ({playersToSettle.length} joueur{playersToSettle.length > 1 ? "s" : ""})
        </div>
        {playersToSettle.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
            Aucune transaction à régler — tout est settled ou pas encore de tx A5POKER.
          </div>
        ) : playersToSettle.map(p => {
          const sel = selected[p.player_id] ?? new Set<number>();
          const isOpen = expanded === p.player_id;
          return (
            <div key={p.player_id} style={{ borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", cursor: "pointer" }} onClick={() => setExpanded(isOpen ? null : p.player_id)}>
                {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", flex: 1 }}>{p.player_name}</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{p.available.length} tx dispo · action {p.action_pct}%</span>
                {sel.size > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--green)", background: "rgba(34,197,94,0.12)", padding: "2px 8px", borderRadius: 5 }}>{sel.size} sélectionnée{sel.size > 1 ? "s" : ""}</span>
                )}
              </div>
              {isOpen && (
                <div style={{ padding: "0 16px 16px", background: "var(--bg-base)" }}>
                  <div style={{ display: "flex", gap: 8, padding: "8px 0", alignItems: "center" }}>
                    <button onClick={() => selectAll(p)} style={ghostBtn}>Tout cocher</button>
                    <button onClick={() => clearSel(p.player_id)} style={ghostBtn}>Tout décocher</button>
                    <div style={{ flex: 1 }} />
                    <Btn onClick={() => openRecap(p)} disabled={busy || sel.size === 0} style={{ fontSize: 12, gap: 6, padding: "7px 14px" }}>
                      <Scale size={14} /> Régler la sélection ({sel.size})
                    </Btn>
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--border)" }}>
                        <th style={{ ...th, textAlign: "center", width: 36 }}></th>
                        <th style={{ ...th, textAlign: "left" }}>Date</th>
                        <th style={{ ...th, textAlign: "left" }}>Type</th>
                        <th style={th}>Montant</th>
                        <th style={{ ...th, textAlign: "center" }}>Src</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.available.map(tx => {
                        const isDep = tx.type === "deposit";
                        const checked = sel.has(tx.id);
                        return (
                          <tr key={tx.id} style={{ borderBottom: "1px solid var(--border)", background: checked ? "rgba(34,197,94,0.06)" : undefined, cursor: "pointer" }} onClick={() => toggle(p.player_id, tx.id)}>
                            <td style={{ ...td, textAlign: "center" }}>
                              <input type="checkbox" checked={checked} onChange={() => toggle(p.player_id, tx.id)} onClick={e => e.stopPropagation()} style={{ cursor: "pointer", accentColor: "#10B981" }} />
                            </td>
                            <td style={{ ...td, textAlign: "left", color: "var(--text-muted)" }}>{(tx.tx_datetime ?? tx.tx_date).slice(0, 10)}</td>
                            <td style={{ ...td, textAlign: "left" }}>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: isDep ? "#f87171" : "var(--green)", fontWeight: 600 }}>
                                {isDep ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}{isDep ? "Dépôt" : "Retrait"}
                              </span>
                            </td>
                            <td style={{ ...td, color: isDep ? "#f87171" : "var(--green)", fontWeight: 700 }}>{isDep ? "−" : "+"}{fmt(tx.amount)} {tx.currency}</td>
                            <td style={{ ...td, textAlign: "center" }} title={tx.source ?? "?"}>{tx.source === "sync" ? "🔗" : tx.source === "manual" ? "✍️" : "⚠️"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Règlements en cours (locked, pas encore payés) ── */}
      {locked.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: "#F5C518", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
            <Lock size={14} /> En attente de paiement ({locked.length})
          </h3>
          <div style={{ background: "var(--bg-surface)", border: "1px solid rgba(245,197,24,0.25)", borderRadius: 12, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ ...th, textAlign: "left" }}>Joueur</th>
                  <th style={{ ...th, textAlign: "left" }}>Locké le</th>
                  <th style={th}>Nb tx</th>
                  <th style={th}>Net</th>
                  <th style={th}>Action%</th>
                  <th style={{ ...th, textAlign: "left", paddingLeft: 16 }}>Règlement</th>
                  <th style={{ ...th, textAlign: "right", minWidth: 280 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {locked.map(s => {
                  const reg = dueLabel(s.amount_due_usdt);
                  return (
                    <tr key={s.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ ...td, textAlign: "left", fontWeight: 600, color: "var(--text)" }}>{s.player_name}</td>
                      <td style={{ ...td, textAlign: "left", color: "var(--text-muted)", fontSize: 11 }}>{fmtDate(s.locked_at)}</td>
                      <td style={td}>{s.tx_count}</td>
                      <td style={{ ...td, color: s.net_selected_usdt >= 0 ? "#10B981" : "#EF4444" }}>{signed(s.net_selected_usdt)}</td>
                      <td style={td}>{s.action_pct_applied}%</td>
                      <td style={{ padding: "10px 10px 10px 16px", textAlign: "left", fontSize: 12, fontWeight: 600, color: reg.color, whiteSpace: "nowrap" }}>{reg.text}</td>
                      <td style={{ ...td }}>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" }}>
                          <input value={payHash[s.id] ?? ""} onChange={e => setPayHash(h => ({ ...h, [s.id]: e.target.value }))} placeholder="tx_hash (optionnel)" spellCheck={false} style={{ width: 150, padding: "5px 8px", borderRadius: 6, fontSize: 11, fontFamily: "monospace", background: "var(--bg-elevated)", color: "var(--text)", border: "1px solid var(--border)", outline: "none" }} />
                          <button onClick={() => pay(s.id)} disabled={rowBusy === s.id} style={payBtn} title="Marquer payé"><BadgeCheck size={13} /> Payé</button>
                          <button onClick={() => unlock(s.id)} disabled={rowBusy === s.id} style={unlockBtn} title="Délock"><Unlock size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Historique (payés) ── */}
      {paid.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
            <BadgeCheck size={14} color="#10B981" /> Historique des règlements payés ({paid.length})
          </h3>
          <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 12, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ ...th, textAlign: "left" }}>Joueur</th>
                  <th style={{ ...th, textAlign: "left" }}>Payé le</th>
                  <th style={th}>Nb tx</th>
                  <th style={th}>Net</th>
                  <th style={th}>Action%</th>
                  <th style={{ ...th, textAlign: "left", paddingLeft: 16 }}>Règlement</th>
                  <th style={{ ...th, textAlign: "left" }}>Tx</th>
                </tr>
              </thead>
              <tbody>
                {paid.map(s => {
                  const reg = dueLabel(s.amount_due_usdt);
                  return (
                    <tr key={s.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ ...td, textAlign: "left", fontWeight: 600, color: "var(--text)" }}>{s.player_name}</td>
                      <td style={{ ...td, textAlign: "left", color: "var(--text-muted)", fontSize: 11 }}>{fmtDate(s.paid_at)}</td>
                      <td style={td}>{s.tx_count}</td>
                      <td style={{ ...td, color: s.net_selected_usdt >= 0 ? "#10B981" : "#EF4444" }}>{signed(s.net_selected_usdt)}</td>
                      <td style={td}>{s.action_pct_applied}%</td>
                      <td style={{ padding: "10px 10px 10px 16px", textAlign: "left", fontSize: 12, fontWeight: 600, color: reg.color, whiteSpace: "nowrap" }}>{reg.text}</td>
                      <td style={{ ...td, textAlign: "left" }}>
                        {s.tx_hash ? (
                          <a href={TRONSCAN_TX + s.tx_hash} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#38bdf8", textDecoration: "none", fontSize: 11, fontFamily: "monospace" }}>{s.tx_hash.slice(0, 8)}…<ExternalLink size={10} /></a>
                        ) : <span style={{ color: "var(--text-dim)" }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Recap modal ── */}
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
                  <b>{recap.player.player_name}</b> · {recap.preview.tx_count} transaction{recap.preview.tx_count > 1 ? "s" : ""}
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
                  <div style={{ fontSize: 18, fontWeight: 700, color: dueLabel(recap.preview.amount_due_usdt).color }}>
                    {dueLabel(recap.preview.amount_due_usdt).text}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{signed(recap.preview.amount_due_usdt)} USDT</div>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  Après lock, ces {recap.preview.tx_count} transactions sont figées (settled) et ne pourront plus entrer dans un autre règlement.
                </div>
              </>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <Btn onClick={() => setRecap(null)} style={{ background: "var(--bg-base)" }}>Annuler</Btn>
              {recap.preview?.ok && (
                <Btn variant="primary" onClick={confirmLock} disabled={busy}><Lock size={14} /> {busy ? "…" : "Lock"}</Btn>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

const ghostBtn: React.CSSProperties = { padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" };
const payBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "rgba(34,197,94,0.12)", color: "var(--green)", border: "1px solid rgba(34,197,94,0.3)", cursor: "pointer", whiteSpace: "nowrap" };
const unlockBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", padding: "6px 9px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" };

function RecapLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ color: "var(--text)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}
