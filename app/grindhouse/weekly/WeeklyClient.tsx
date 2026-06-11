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
  variants: string[];          // distinct variants already logged (autocomplete)
  nWeeks: number;
}

// One editable log line in the modal
interface LogRow {
  key: number;
  sessionId: number | null;    // existing session → PATCH/DELETE, null → POST
  game_id: number | "";
  variant: string;
  pnl: string;
  hours: string;
}

const CREATE_GAME = "__create__";
const COMMON_CURRENCIES = ["USDT", "INR", "EUR", "USD", "CNY", "MYR"];
const OTHER_CURRENCY = "__other__";

// USDT first, then alphabetical — stable order everywhere currencies are listed
function currencyOrder(a: string, b: string): number {
  if (a === "USDT") return -1;
  if (b === "USDT") return 1;
  return a.localeCompare(b);
}

interface ModalState {
  grinder: GrinderRow;
  week: WeekCol;
}

function fmtPnl(n: number): string {
  return (n >= 0 ? "+" : "−") + Math.abs(n).toLocaleString("fr-FR", { maximumFractionDigits: 0 });
}

let keySeq = 1;

export default function WeeklyClient({ weeks, grinders, cells, sessions, games, variants, nWeeks }: WeeklyClientProps) {
  const router = useRouter();
  // One entry per player×week, holding one row per currency (never summed together)
  const cellMap = new Map<string, GrindhouseWeekCell[]>();
  for (const c of cells) {
    const k = `${c.player_id}|${c.week_start}`;
    const arr = cellMap.get(k) ?? [];
    arr.push(c);
    cellMap.set(k, arr);
  }
  for (const arr of cellMap.values()) arr.sort((a, b) => currencyOrder(a.currency, b.currency));

  const [modal, setModal] = useState<ModalState | null>(null);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [deletedIds, setDeletedIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Inline game creation (per-row mini form inside the modal)
  const [extraGames, setExtraGames] = useState<Game[]>([]);   // created this session, until router.refresh lands
  const [createForKey, setCreateForKey] = useState<number | null>(null);
  const [newGameName, setNewGameName] = useState("");
  const [newGameCurrency, setNewGameCurrency] = useState("USDT");
  const [customCurrency, setCustomCurrency] = useState("");
  const [creatingGame, setCreatingGame] = useState(false);
  const knownIds = new Set(games.map(g => g.id));
  const allGames = [...games, ...extraGames.filter(g => !knownIds.has(g.id))];

  async function createGame() {
    const name = newGameName.trim();
    if (!name) { setError("Nom de la game requis"); return; }
    const currency = (newGameCurrency === OTHER_CURRENCY ? customCurrency : newGameCurrency).trim().toUpperCase();
    if (!/^[A-Z]{3,5}$/.test(currency)) { setError("Currency invalide (3-5 lettres, ex: INR)"); return; }
    setCreatingGame(true);
    setError("");
    try {
      const res = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, currency }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `POST /api/games → ${res.status}`);
      setExtraGames(g => [...g, { id: data.id, name: data.name }]);
      if (createForKey !== null) patchRow(createForKey, { game_id: data.id });
      setCreateForKey(null);
      setNewGameName("");
      setNewGameCurrency("USDT");
      setCustomCurrency("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur réseau");
    } finally {
      setCreatingGame(false);
    }
  }

  // Footer totals — one total PER currency, raw amounts are never mixed (invariant #3)
  const totalsByCurrency = new Map<string, number>();
  for (const c of cells) totalsByCurrency.set(c.currency, (totalsByCurrency.get(c.currency) ?? 0) + c.pnl);
  const totalEntries = [...totalsByCurrency.entries()].sort(([a], [b]) => currencyOrder(a, b));
  const totalHours = cells.reduce((s, c) => s + c.hours, 0);
  const grinderIds = new Set(grinders.map(g => g.player_id));
  const filledKeys = new Set(cells.filter(c => grinderIds.has(c.player_id)).map(c => `${c.player_id}|${c.week_start}`));
  const missingCount = grinders.length * weeks.length - filledKeys.size;

  function openCell(grinder: GrinderRow, week: WeekCol) {
    const existing = sessions.filter(s => s.player_id === grinder.player_id && s.week_start === week.week_start);
    setRows(existing.length > 0
      ? existing.map(s => ({
          key: keySeq++,
          sessionId: s.id,
          game_id: s.game_id,
          variant: s.variant ?? "",
          pnl: String(s.net_result_usdt),
          hours: s.duration_hours > 0 ? String(s.duration_hours) : "",
        }))
      : [{ key: keySeq++, sessionId: null, game_id: "", variant: "", pnl: "", hours: "" }]);
    setDeletedIds([]);
    setCreateForKey(null);
    setNewGameName("");
    setNewGameCurrency("USDT");
    setCustomCurrency("");
    setError("");
    setModal({ grinder, week });
  }

  function addRow() {
    setRows(r => [...r, { key: keySeq++, sessionId: null, game_id: "", variant: "", pnl: "", hours: "" }]);
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
              variant: r.variant.trim() === "" ? null : r.variant.trim(),
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
              variant: r.variant.trim() === "" ? null : r.variant.trim(),
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
                    const cellRows = cellMap.get(`${g.player_id}|${w.week_start}`) ?? [];
                    const missing = cellRows.length === 0;
                    const sessionCount = cellRows.reduce((s, c) => s + c.session_count, 0);
                    const gamesCount = cellRows.reduce((s, c) => s + c.games_count, 0);
                    return (
                      <td key={w.week_start} style={{ padding: 3, borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                        <button
                          onClick={() => openCell(g, w)}
                          className={missing ? "weekly-cell weekly-missing" : "weekly-cell"}
                          title={missing ? `Ajouter — ${g.name} ${w.iso}` : `${sessionCount} log(s), ${gamesCount} game(s) — modifier`}
                        >
                          {missing ? (
                            <>
                              <AlertTriangle size={11} style={{ opacity: 0.65 }} />
                              <span className="weekly-add"><Plus size={10} /> Add</span>
                            </>
                          ) : (
                            <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                              {cellRows.map((c, idx) => (
                                <span key={c.currency} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                                  <span className="tabular-nums" style={{
                                    fontWeight: 600, fontSize: cellRows.length > 1 ? 11 : 12,
                                    color: c.pnl > 0 ? "#10B981" : c.pnl < 0 ? "#EF4444" : "#8888A0",
                                  }}>
                                    {fmtPnl(c.pnl)}
                                    {c.currency !== "USDT" && (
                                      <span style={{ fontSize: 8.5, fontWeight: 600, color: "#8888A0" }}> {c.currency}</span>
                                    )}
                                  </span>
                                  {idx === 0 && <Check size={10} style={{ color: "rgba(16,185,129,0.5)", flexShrink: 0 }} />}
                                </span>
                              ))}
                              {gamesCount > 1 && (
                                <span style={{ fontSize: 8.5, fontWeight: 600, color: "#555568", letterSpacing: "0.03em" }}>
                                  {gamesCount} games
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
            Total P&L{" "}
            {totalEntries.length === 0 ? (
              <b className="tabular-nums" style={{ color: "#8888A0" }}>+0 USDT</b>
            ) : (
              totalEntries.map(([cur, v], i) => (
                <span key={cur}>
                  {i > 0 && <span style={{ color: "#555568" }}> · </span>}
                  <b className="tabular-nums" style={{ color: v >= 0 ? "#10B981" : "#EF4444" }}>{fmtPnl(v)} {cur}</b>
                </span>
              ))
            )}
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
        width={620}
      >
        {modal && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <datalist id="gh-variants">
              {variants.map(v => <option key={v} value={v} />)}
            </datalist>
            {/* column labels */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 92px 64px 28px", gap: 8, fontSize: 10, fontWeight: 700, color: "#555568", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              <span>Game</span><span>Variante</span><span>P&L USDT</span><span>Heures</span><span />
            </div>
            {rows.map(r => (
              <div key={r.key} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 92px 64px 28px", gap: 8, alignItems: "center" }}>
                  <select
                    value={createForKey === r.key ? CREATE_GAME : r.game_id}
                    onChange={e => {
                      if (e.target.value === CREATE_GAME) {
                        setCreateForKey(r.key);
                        setNewGameName("");
                      } else {
                        if (createForKey === r.key) setCreateForKey(null);
                        patchRow(r.key, { game_id: e.target.value === "" ? "" : Number(e.target.value) });
                      }
                    }}
                  >
                    <option value="">— Game —</option>
                    {allGames.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                    <option value={CREATE_GAME}>+ Créer une game…</option>
                  </select>
                  <input
                    type="text" list="gh-variants" placeholder="Squid, Holdem, PLO…"
                    value={r.variant}
                    onChange={e => patchRow(r.key, { variant: e.target.value })}
                  />
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
                {createForKey === r.key && (
                  <div style={{
                    display: "flex", gap: 8, alignItems: "center",
                    padding: "8px 10px", borderRadius: 10,
                    background: "rgba(16,185,129,0.05)", border: "1px solid rgba(16,185,129,0.18)",
                  }}>
                    <input
                      type="text" placeholder="Nom de la game" autoFocus
                      value={newGameName}
                      onChange={e => setNewGameName(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); createGame(); } }}
                      style={{ flex: 1 }}
                    />
                    <select
                      value={newGameCurrency}
                      onChange={e => setNewGameCurrency(e.target.value)}
                      title="Currency de la game"
                      style={{ width: 86 }}
                    >
                      {COMMON_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                      <option value={OTHER_CURRENCY}>Autre…</option>
                    </select>
                    {newGameCurrency === OTHER_CURRENCY && (
                      <input
                        type="text" placeholder="THB" maxLength={5}
                        value={customCurrency}
                        onChange={e => setCustomCurrency(e.target.value.toUpperCase())}
                        style={{ width: 60 }}
                      />
                    )}
                    <Btn size="sm" variant="primary" onClick={createGame} disabled={creatingGame}>
                      {creatingGame ? "..." : "Créer"}
                    </Btn>
                    <Btn size="sm" onClick={() => { setCreateForKey(null); setNewGameName(""); setNewGameCurrency("USDT"); setCustomCurrency(""); }}>Annuler</Btn>
                  </div>
                )}
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
