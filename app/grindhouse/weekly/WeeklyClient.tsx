"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, AlertTriangle, Plus, Trash2 } from "lucide-react";
import Modal from "@/components/Modal";
import Btn from "@/components/Btn";
import type { GrinderRow, GrindhouseWeekCell, GrindhouseWeekSession } from "@/lib/queries";

export interface WeekCol {
  week_start: string;  // Monday YYYY-MM-DD
  week_end: string;    // Sunday YYYY-MM-DD
  iso: string;         // "W23"
  range: string;       // "2-8 juin"
}

interface Game { id: number; name: string; }

interface WeeklyClientProps {
  weeks: WeekCol[];            // most recent first
  grinders: GrinderRow[];
  cells: GrindhouseWeekCell[];
  sessions: GrindhouseWeekSession[];
  games: Game[];
  nWeeks: number;
}

// One editable log line in the modal
interface LogRow {
  key: number;
  sessionId: number | null;    // existing session → PATCH/DELETE, null → POST
  game_id: number | "";
  pnl: string;
  hours: string;
}

interface ModalState {
  grinder: GrinderRow;
  week: WeekCol;
}

function fmtPnl(n: number): string {
  return (n >= 0 ? "+" : "−") + Math.abs(n).toLocaleString("fr-FR", { maximumFractionDigits: 0 });
}

let keySeq = 1;

export default function WeeklyClient({ weeks, grinders, cells, sessions, games, nWeeks }: WeeklyClientProps) {
  const router = useRouter();
  const cellMap = new Map(cells.map(c => [`${c.player_id}|${c.week_start}`, c]));

  const [modal, setModal] = useState<ModalState | null>(null);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [deletedIds, setDeletedIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const totalPnl = cells.reduce((s, c) => s + c.pnl, 0);
  const totalHours = cells.reduce((s, c) => s + c.hours, 0);
  const grinderIds = new Set(grinders.map(g => g.player_id));
  const missingCount = grinders.length * weeks.length - cells.filter(c => grinderIds.has(c.player_id)).length;

  function openCell(grinder: GrinderRow, week: WeekCol) {
    const existing = sessions.filter(s => s.player_id === grinder.player_id && s.week_start === week.week_start);
    setRows(existing.length > 0
      ? existing.map(s => ({
          key: keySeq++,
          sessionId: s.id,
          game_id: s.game_id,
          pnl: String(s.net_result_usdt),
          hours: s.duration_hours > 0 ? String(s.duration_hours) : "",
        }))
      : [{ key: keySeq++, sessionId: null, game_id: "", pnl: "", hours: "" }]);
    setDeletedIds([]);
    setError("");
    setModal({ grinder, week });
  }

  function addRow() {
    setRows(r => [...r, { key: keySeq++, sessionId: null, game_id: "", pnl: "", hours: "" }]);
  }

  function removeRow(key: number) {
    setRows(r => {
      const row = r.find(x => x.key === key);
      if (row?.sessionId) setDeletedIds(d => [...d, row.sessionId!]);
      return r.filter(x => x.key !== key);
    });
  }

  function patchRow(key: number, patch: Partial<LogRow>) {
    setRows(r => r.map(x => (x.key === key ? { ...x, ...patch } : x)));
  }

  async function save() {
    if (!modal) return;
    // a row counts when P&L is filled; game is then mandatory
    const filled = rows.filter(r => r.pnl.trim() !== "");
    for (const r of filled) {
      if (isNaN(Number(r.pnl))) { setError("P&L invalide sur une ligne"); return; }
      if (r.game_id === "") { setError("Game requis sur chaque ligne avec un P&L"); return; }
      if (r.hours.trim() !== "" && (isNaN(Number(r.hours)) || Number(r.hours) < 0)) { setError("Heures invalides sur une ligne"); return; }
    }
    if (filled.length === 0 && deletedIds.length === 0) { setError("Au moins une ligne valide (game + P&L) requise"); return; }

    setSaving(true);
    setError("");
    try {
      const { grinder, week } = modal;
      // deletions of removed existing sessions
      for (const id of deletedIds) {
        const res = await fetch(`/api/grindhouse-sessions/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`DELETE ${id} → ${res.status}`);
      }
      for (const r of filled) {
        if (r.sessionId) {
          const res = await fetch(`/api/grindhouse-sessions/${r.sessionId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              game_id: Number(r.game_id),
              net_result_usdt: Number(r.pnl),
              duration_hours: r.hours.trim() === "" ? 0 : Number(r.hours),
            }),
          });
          if (!res.ok) throw new Error(`PATCH → ${res.status}`);
        } else {
          const res = await fetch("/api/grindhouse-sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              player_id: grinder.player_id,
              game_id: Number(r.game_id),
              session_date: week.week_start,
              duration_hours: r.hours.trim() === "" ? 0 : Number(r.hours),
              net_result_usdt: Number(r.pnl),
              notes: "weekly quick-add",
            }),
          });
          if (!res.ok) throw new Error(`POST → ${res.status}`);
        }
      }
      setModal(null);
      setSaving(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur réseau");
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
          <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", minWidth: weeks.length * 96 + 160 }}>
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
                    borderBottom: "1px solid rgba(255,255,255,0.07)", minWidth: 92,
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
                          title={missing ? `Ajouter — ${g.name} ${w.iso}` : `${cell!.session_count} log(s), ${cell!.games_count} game(s) — modifier`}
                        >
                          {missing ? (
                            <>
                              <AlertTriangle size={11} style={{ opacity: 0.65 }} />
                              <span className="weekly-add"><Plus size={10} /> Add</span>
                            </>
                          ) : (
                            <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                                <span className="tabular-nums" style={{
                                  fontWeight: 600, fontSize: 12,
                                  color: cell!.pnl > 0 ? "#10B981" : cell!.pnl < 0 ? "#EF4444" : "#8888A0",
                                }}>{fmtPnl(cell!.pnl)}</span>
                                <Check size={10} style={{ color: "rgba(16,185,129,0.5)", flexShrink: 0 }} />
                              </span>
                              {cell!.games_count > 1 && (
                                <span style={{ fontSize: 8.5, fontWeight: 600, color: "#555568", letterSpacing: "0.03em" }}>
                                  {cell!.games_count} games
                                </span>
                              )}
                            </span>
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

      {/* Multi-game weekly log editor */}
      <Modal
        open={modal !== null}
        onClose={() => setModal(null)}
        title={modal ? `${modal.grinder.name} — Semaine ${modal.week.iso.slice(1)} (${modal.week.range})` : ""}
        width={520}
      >
        {modal && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* column labels */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 90px 30px", gap: 8, fontSize: 10, fontWeight: 700, color: "#555568", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              <span>Game</span><span>P&L USDT</span><span>Heures</span><span />
            </div>
            {rows.map(r => (
              <div key={r.key} style={{ display: "grid", gridTemplateColumns: "1fr 110px 90px 30px", gap: 8, alignItems: "center" }}>
                <select
                  value={r.game_id}
                  onChange={e => patchRow(r.key, { game_id: e.target.value === "" ? "" : Number(e.target.value) })}
                >
                  <option value="">— Game —</option>
                  {games.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <input
                  type="number" step="0.01" placeholder="-250 / 1200"
                  value={r.pnl}
                  onChange={e => patchRow(r.key, { pnl: e.target.value })}
                />
                <input
                  type="number" step="0.5" min="0" placeholder="0"
                  value={r.hours}
                  onChange={e => patchRow(r.key, { hours: e.target.value })}
                />
                <button
                  className="btn-del-ghost"
                  title="Retirer ce log"
                  onClick={() => removeRow(r.key)}
                  style={{ padding: 5, justifySelf: "center" }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}

            <button
              onClick={addRow}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, alignSelf: "flex-start",
                padding: "6px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600,
                background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.2)",
                color: "#10B981", cursor: "pointer",
              }}
            >
              <Plus size={12} /> Ajouter un log
            </button>

            {deletedIds.length > 0 && (
              <div style={{ fontSize: 11, color: "#F59E0B" }}>
                {deletedIds.length} log{deletedIds.length > 1 ? "s" : ""} existant{deletedIds.length > 1 ? "s" : ""} sera{deletedIds.length > 1 ? "ont" : ""} supprimé{deletedIds.length > 1 ? "s" : ""} au save.
              </div>
            )}
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
