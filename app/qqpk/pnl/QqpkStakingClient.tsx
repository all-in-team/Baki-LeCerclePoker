"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Scale, AlertTriangle } from "lucide-react";
import Modal from "@/components/Modal";
import Btn from "@/components/Btn";
import { saveMainsAction, previewSettlementAction, settleMonthAction } from "./actions";

interface Row {
  player_id: number;
  player_name: string;
  block_month: string;
  resultat_periode: number;
  mains: number;
  c_prec: number;
  t_prec: number;
  c: number;
  t: number;
  reglement: number;
  condition_30k_applied: boolean;
  operator_pnl: number;
  settled: boolean;
}
type HistoryRow = Row & { settled_at: string | null };

interface Preview {
  ok: boolean;
  error?: string;
  player_id: number;
  block_month: string;
  resultat_periode: number;
  mains: number;
  c_prec: number;
  t_prec: number;
  c: number;
  t: number;
  reglement: number;
  condition_30k_applied: boolean;
  operator_pnl: number;
  already_settled: boolean;
}

function fmt(n: number): string {
  return Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function signed(n: number): string {
  return (n >= 0 ? "+" : "−") + fmt(n);
}

// Règlement, from the player↔Cercle perspective. reglement>0 = Cercle pays player.
function reglementLabel(reglement: number): { text: string; color: string } {
  if (Math.abs(reglement) < 0.005) return { text: "Aucun mouvement", color: "var(--text-dim)" };
  if (reglement > 0) return { text: `Cercle verse ${fmt(reglement)} USDT`, color: "#EF4444" };
  return { text: `Joueur verse ${fmt(reglement)} USDT`, color: "#10B981" };
}

function ConditionBadge({ row }: { row: { mains: number; condition_30k_applied: boolean } }) {
  if (row.condition_30k_applied) {
    return (
      <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "rgba(239,68,68,0.15)", color: "#EF4444", whiteSpace: "nowrap" }}>
        ⚠️ &lt;30k — non couvert
      </span>
    );
  }
  if (row.mains >= 30000) {
    return (
      <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "rgba(16,185,129,0.15)", color: "#10B981", whiteSpace: "nowrap" }}>
        ✓ 30k OK
      </span>
    );
  }
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "rgba(245,197,24,0.15)", color: "#F5C518", whiteSpace: "nowrap" }}>
      &lt;30k
    </span>
  );
}

export default function QqpkStakingClient({
  month, monthLabel, months, rows, history,
}: {
  month: string; monthLabel: string; months: { key: string; label: string }[];
  rows: Row[]; history: HistoryRow[];
}) {
  const router = useRouter();
  const [mainsEdits, setMainsEdits] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [recap, setRecap] = useState<{ player: Row; preview: Preview } | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Summary cards
  const reglementsCercle = rows.filter((r) => r.settled).reduce((s, r) => s + r.operator_pnl, 0);
  const makeupEnCours = rows.filter((r) => !r.settled && r.t > 0).reduce((s, r) => s + r.t, 0);
  const nbJoueurs = rows.length;

  async function saveMains(pid: number) {
    const raw = mainsEdits[pid];
    if (raw === undefined) return;
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0) { alert("Mains: entier ≥ 0 requis."); return; }
    setBusy(pid);
    try {
      const res = await saveMainsAction(pid, month, n);
      if (!res.ok) { alert(res.error ?? "Erreur"); return; }
      setMainsEdits((m) => { const c = { ...m }; delete c[pid]; return c; });
      router.refresh();
    } finally { setBusy(null); }
  }

  async function openRecap(player: Row) {
    setBusy(player.player_id);
    try {
      const preview = (await previewSettlementAction(player.player_id, month)) as Preview;
      setRecap({ player, preview });
    } finally { setBusy(null); }
  }

  async function confirmSettle() {
    if (!recap) return;
    setConfirming(true);
    try {
      const res = await settleMonthAction(recap.player.player_id, month);
      if (!res.ok) { alert(res.error ?? "Erreur règlement"); return; }
      setRecap(null);
      router.refresh();
    } finally { setConfirming(false); }
  }

  const th: React.CSSProperties = { textAlign: "right", padding: "8px 10px", color: "var(--text-muted)", fontWeight: 600, fontSize: 11, whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "10px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 12 };

  return (
    <div style={{ padding: "8px 28px 40px" }}>
      {/* Month selector */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Bloc mensuel :</span>
        <select
          value={month}
          onChange={(e) => router.push(`/qqpk/pnl?month=${e.target.value}`)}
          style={{ padding: "8px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-raised)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", textTransform: "capitalize" }}
        >
          {months.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      </div>

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 22 }}>
        <Card label="Règlements réglés (Cercle)" value={`${signed(reglementsCercle)} USDT`} color={reglementsCercle >= 0 ? "#10B981" : "#EF4444"} hint="Σ P&L opérateur des blocs réglés ce mois" />
        <Card label="Makeup en cours" value={`${fmt(makeupEnCours)} USDT`} color="#F5C518" hint="Σ T (>0) des blocs non réglés — avance Cercle" />
        <Card label="Joueurs QQPK" value={String(nbJoueurs)} color="var(--text)" hint="Joueurs avec un deal QQPK" />
      </div>

      {/* Main table */}
      <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", fontSize: 13, fontWeight: 700, color: "var(--text)", textTransform: "capitalize" }}>
          Bloc {monthLabel}
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Aucun joueur QQPK (pas de deal QQPK enregistré).</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 880 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ ...th, textAlign: "left" }}>Joueur</th>
                  <th style={th}>Résultat (net)</th>
                  <th style={th}>Mains</th>
                  <th style={th}>C (cumulé)</th>
                  <th style={th}>T (position)</th>
                  <th style={{ ...th, textAlign: "left", paddingLeft: 16 }}>Règlement</th>
                  <th style={{ ...th, textAlign: "center" }}>30k</th>
                  <th style={{ ...th, textAlign: "center" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const reg = reglementLabel(r.reglement);
                  const edited = mainsEdits[r.player_id] !== undefined && parseInt(mainsEdits[r.player_id] || "0", 10) !== r.mains;
                  return (
                    <tr key={r.player_id} style={{ borderBottom: "1px solid var(--border)", background: r.settled ? "rgba(16,185,129,0.04)" : undefined }}>
                      <td style={{ ...td, textAlign: "left", fontWeight: 600, color: "var(--text)" }}>
                        {r.player_name}
                        {r.settled && <span style={{ marginLeft: 8, fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: "rgba(16,185,129,0.15)", color: "#10B981" }}>RÉGLÉ</span>}
                      </td>
                      <td style={{ ...td, color: r.resultat_periode >= 0 ? "#10B981" : "#EF4444", fontWeight: 600 }}>{signed(r.resultat_periode)}</td>
                      <td style={td}>
                        {r.settled ? (
                          r.mains.toLocaleString("fr-FR")
                        ) : (
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
                        )}
                      </td>
                      <td style={{ ...td, color: r.c >= 0 ? "var(--text)" : "#EF4444" }}>{signed(r.c)}</td>
                      <td style={{ ...td, color: r.t > 0 ? "#F5C518" : "var(--text-muted)" }}>{signed(r.t)}</td>
                      <td style={{ padding: "10px 10px 10px 16px", textAlign: "left", fontSize: 12, fontWeight: 600, color: reg.color, whiteSpace: "nowrap" }}>{reg.text}</td>
                      <td style={{ ...td, textAlign: "center" }}><ConditionBadge row={r} /></td>
                      <td style={{ ...td, textAlign: "center" }}>
                        {r.settled ? (
                          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>—</span>
                        ) : (
                          <Btn onClick={() => openRecap(r)} disabled={busy === r.player_id} style={{ fontSize: 11, gap: 5, padding: "6px 10px" }}>
                            <Scale size={13} /> Régler
                          </Btn>
                        )}
                      </td>
                    </tr>
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
          <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 12 }}>Historique des blocs réglés</h3>
          <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 12, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ ...th, textAlign: "left" }}>Mois</th>
                  <th style={{ ...th, textAlign: "left" }}>Joueur</th>
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
                    <tr key={`${h.player_id}-${h.block_month}`} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ ...td, textAlign: "left", color: "var(--text-muted)" }}>{h.block_month}</td>
                      <td style={{ ...td, textAlign: "left", fontWeight: 600, color: "var(--text)" }}>{h.player_name}</td>
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

      {/* Recap confirmation modal */}
      <Modal open={!!recap} onClose={() => setRecap(null)} title="Régler le mois — récapitulatif">
        {recap && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {recap.preview.already_settled ? (
              <div style={{ padding: 14, borderRadius: 8, background: "rgba(239,68,68,0.1)", color: "#EF4444", fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
                <AlertTriangle size={16} /> Ce bloc est déjà réglé (immutable).
              </div>
            ) : (
              <>
                <div style={{ fontSize: 13, color: "var(--text)" }}>
                  <b>{recap.player.player_name}</b> · bloc <b>{recap.player.block_month}</b>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 12 }}>
                  <RecapLine label="Résultat (net mois)" value={`${signed(recap.preview.resultat_periode)} USDT`} />
                  <RecapLine label="Mains" value={recap.preview.mains.toLocaleString("fr-FR")} />
                  <RecapLine label="C précédent" value={signed(recap.preview.c_prec)} />
                  <RecapLine label="T précédent" value={signed(recap.preview.t_prec)} />
                  <RecapLine label="C (nouveau cumulé)" value={signed(recap.preview.c)} />
                  <RecapLine label="T (nouvelle position)" value={signed(recap.preview.t)} />
                </div>
                <div style={{ padding: 14, borderRadius: 8, background: "var(--bg-base)", border: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Règlement</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: reglementLabel(recap.preview.reglement).color }}>
                    {reglementLabel(recap.preview.reglement).text}
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", marginRight: 6 }}>Condition 30k :</span>
                    <ConditionBadge row={recap.preview} />
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  Une fois réglé, le bloc devient immuable. Le bloc suivant repart en makeup/reset automatiquement.
                </div>
              </>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <Btn onClick={() => setRecap(null)} style={{ background: "var(--bg-base)" }}>Annuler</Btn>
              {!recap.preview.already_settled && (
                <Btn onClick={confirmSettle} disabled={confirming}>{confirming ? "..." : "Confirmer le règlement"}</Btn>
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
