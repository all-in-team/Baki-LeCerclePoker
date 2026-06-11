"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, AlertTriangle, Plus } from "lucide-react";
import Modal from "@/components/Modal";
import Btn from "@/components/Btn";
import type { GrinderRow, GrindhouseWeekCell } from "@/lib/queries";

export interface WeekCol {
  week_start: string;  // Monday YYYY-MM-DD
  week_end: string;    // Sunday YYYY-MM-DD
  iso: string;         // "W23"
  range: string;       // "2-8 juin"
}

interface WeeklyClientProps {
  weeks: WeekCol[];            // most recent first
  grinders: GrinderRow[];
  cells: GrindhouseWeekCell[];
  defaultGames: Record<number, number>;
  fallbackGame: number;
  nWeeks: number;
}

interface ModalState {
  grinder: GrinderRow;
  week: WeekCol;
  cell: GrindhouseWeekCell | null;
}

function fmtPnl(n: number): string {
  return (n >= 0 ? "+" : "−") + Math.abs(n).toLocaleString("fr-FR", { maximumFractionDigits: 0 });
}

export default function WeeklyClient({ weeks, grinders, cells, defaultGames, fallbackGame, nWeeks }: WeeklyClientProps) {
  const router = useRouter();
  const cellMap = new Map(cells.map(c => [`${c.player_id}|${c.week_start}`, c]));

  const [modal, setModal] = useState<ModalState | null>(null);
  const [pnlVal, setPnlVal] = useState("");
  const [hoursVal, setHoursVal] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const totalPnl = cells.reduce((s, c) => s + c.pnl, 0);
  const totalHours = cells.reduce((s, c) => s + c.hours, 0);
  const missingCount = grinders.length * weeks.length - cells.filter(c =>
    grinders.some(g => g.player_id === c.player_id)).length;

  function openCell(grinder: GrinderRow, week: WeekCol) {
    const cell = cellMap.get(`${grinder.player_id}|${week.week_start}`) ?? null;
    setPnlVal(cell && cell.session_count === 1 ? String(cell.pnl) : "");
    setHoursVal(cell && cell.session_count === 1 && cell.hours > 0 ? String(cell.hours) : "");
    setError("");
    setModal({ grinder, week, cell });
  }

  async function save() {
    if (!modal) return;
    const pnl = Number(pnlVal);
    if (pnlVal.trim() === "" || isNaN(pnl)) { setError("P&L USDT requis (nombre)"); return; }
    const hours = hoursVal.trim() === "" ? 0 : Number(hoursVal);
    if (isNaN(hours) || hours < 0) { setError("Heures invalides"); return; }
    setSaving(true);
    setError("");
    try {
      const { grinder, week, cell } = modal;
      let res: Response;
      if (cell?.single_session_id) {
        // exactly one session that week → edit it in place
        res = await fetch(`/api/grindhouse-sessions/${cell.single_session_id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ net_result_usdt: pnl, duration_hours: hours }),
        });
      } else {
        // empty week (insert) or multi-session week (add an extra entry)
        res = await fetch("/api/grindhouse-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            player_id: grinder.player_id,
            game_id: defaultGames[grinder.player_id] ?? fallbackGame,
            session_date: week.week_start,
            duration_hours: hours,
            net_result_usdt: pnl,
            notes: "weekly quick-add",
          }),
        });
      }
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(j?.error ?? `Erreur ${res.status}`);
        setSaving(false);
        return;
      }
      setModal(null);
      setSaving(false);
      router.refresh();
    } catch {
      setError("Erreur réseau");
      setSaving(false);
    }
  }

  return (
    <div>
      {/* Header: period selector */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: "#8888A0" }}>
          {nWeeks} dernières semaines · {grinders.length} grinders actifs
        </span>
        <Link
          href={nWeeks === 12 ? "/grindhouse/weekly?weeks=24" : "/grindhouse/weekly"}
          style={{
            fontSize: 12, fontWeight: 600, color: "#10B981", textDecoration: "none",
            padding: "7px 14px", borderRadius: 999,
            background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.2)",
          }}
        >
          {nWeeks === 12 ? "Show 24 weeks" : "Show 12 weeks"}
        </Link>
      </div>

      {/* Grid */}
      <div className="glass-card" style={{ overflow: "hidden" }}>
        <div style={{ overflowX: "auto", maxHeight: "62vh", overflowY: "auto" }}>
          <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", minWidth: weeks.length * 92 + 160 }}>
            <thead>
              <tr>
                <th style={{
                  position: "sticky", left: 0, top: 0, zIndex: 12,
                  background: "#13141C", padding: "10px 16px", textAlign: "left",
                  fontSize: 11, fontWeight: 600, color: "#8888A0",
                  textTransform: "uppercase", letterSpacing: "0.08em",
                  borderBottom: "1px solid rgba(255,255,255,0.07)", minWidth: 160,
                }}>Grinder</th>
                {weeks.map(w => (
                  <th key={w.week_start} style={{
                    position: "sticky", top: 0, zIndex: 10,
                    background: "#13141C", padding: "8px 10px", textAlign: "center",
                    borderBottom: "1px solid rgba(255,255,255,0.07)", minWidth: 88,
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#E8E8EE" }}>{w.iso}</div>
                    <div style={{ fontSize: 9, fontWeight: 500, color: "#555568", whiteSpace: "nowrap" }}>{w.range}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grinders.length === 0 && (
                <tr><td colSpan={weeks.length + 1} style={{ padding: 32, textAlign: "center", color: "#555568", fontSize: 13 }}>
                  Aucun grinder actif
                </td></tr>
              )}
              {grinders.map(g => (
                <tr key={g.player_id}>
                  <td style={{
                    position: "sticky", left: 0, zIndex: 5,
                    background: "#0F1017", padding: "10px 16px",
                    fontSize: 13, fontWeight: 600, color: "#E8E8EE", whiteSpace: "nowrap",
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                  }}>{g.name}</td>
                  {weeks.map(w => {
                    const cell = cellMap.get(`${g.player_id}|${w.week_start}`) ?? null;
                    const missing = !cell;
                    return (
                      <td key={w.week_start} style={{ padding: 3, borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                        <button
                          onClick={() => openCell(g, w)}
                          className={missing ? "weekly-cell weekly-missing" : "weekly-cell"}
                          title={missing ? `Ajouter — ${g.name} ${w.iso}` : `${cell!.session_count} session(s) — modifier`}
                        >
                          {missing ? (
                            <>
                              <AlertTriangle size={11} style={{ opacity: 0.65 }} />
                              <span className="weekly-add"><Plus size={10} /> Add</span>
                            </>
                          ) : (
                            <>
                              <span className="tabular-nums" style={{
                                fontWeight: 600, fontSize: 12,
                                color: cell!.pnl > 0 ? "#10B981" : cell!.pnl < 0 ? "#EF4444" : "#8888A0",
                              }}>{fmtPnl(cell!.pnl)}</span>
                              <Check size={10} style={{ color: "rgba(16,185,129,0.5)", flexShrink: 0 }} />
                            </>
                          )}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer totals */}
        <div style={{
          display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap",
          padding: "12px 18px", borderTop: "1px solid rgba(255,255,255,0.07)",
          background: "#0F1017", fontSize: 12,
        }}>
          <span style={{ color: "#8888A0" }}>
            Total P&L <b className="tabular-nums" style={{ color: totalPnl >= 0 ? "#10B981" : "#EF4444" }}>{fmtPnl(totalPnl)} USDT</b>
          </span>
          <span style={{ color: "#8888A0" }}>
            Total heures <b className="tabular-nums" style={{ color: "#E8E8EE" }}>{totalHours.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}h</b>
          </span>
          {missingCount > 0 && (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "4px 10px", borderRadius: 999,
              background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.25)",
              color: "#F59E0B", fontWeight: 600,
            }}>
              <AlertTriangle size={11} /> {missingCount} semaine{missingCount > 1 ? "s" : ""} manquante{missingCount > 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      {/* Quick-add / edit modal */}
      <Modal
        open={modal !== null}
        onClose={() => setModal(null)}
        title={modal ? `${modal.grinder.name} — Semaine ${modal.week.iso.slice(1)} (${modal.week.range})` : ""}
        width={420}
      >
        {modal && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {modal.cell && modal.cell.session_count > 1 && (
              <div style={{ fontSize: 11, color: "#F59E0B" }}>
                {modal.cell.session_count} sessions déjà loggées cette semaine — l&apos;entrée sera AJOUTÉE au total.
              </div>
            )}
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#8888A0", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                P&L USDT *
              </label>
              <input
                type="number" step="0.01" autoFocus value={pnlVal}
                onChange={e => setPnlVal(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") save(); }}
                placeholder="-250 ou 1200"
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#8888A0", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                Heures (optionnel)
              </label>
              <input
                type="number" step="0.5" min="0" value={hoursVal}
                onChange={e => setHoursVal(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") save(); }}
                placeholder="0"
              />
            </div>
            {error && <div style={{ fontSize: 12, color: "#EF4444" }}>{error}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn size="sm" onClick={() => setModal(null)}>Cancel</Btn>
              <Btn size="sm" variant="primary" onClick={save} disabled={saving}>
                {saving ? "..." : "Save"}
              </Btn>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
