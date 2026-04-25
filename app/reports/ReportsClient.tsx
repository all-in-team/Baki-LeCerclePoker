"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Upload, FileImage, CheckCircle, Trash2, ChevronDown, ChevronUp, Loader } from "lucide-react";
import Btn from "@/components/Btn";
import Badge from "@/components/Badge";

interface Game { id: number; name: string; default_action_pct: number | null; }
interface Player { id: number; name: string; }
interface ExtractedRow {
  external_id: string;
  rakeback_amount: number;
  insurance_amount: number;
  winnings_amount: number;
  currency: string;
  player_id: number | null;
  player_name: string | null;
}
interface Report {
  id: number; game_name: string; period_label: string; created_at: string;
  entry_count: number; total_amount: number; unmatched_count: number;
}

const GAME_COLOR: Record<string, string> = {
  TELE: "#a78bfa", Wepoker: "#38bdf8", Xpoker: "#fb923c", ClubGG: "#4ade80",
};

function PctInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <input type="number" min="0" max="100" step="1" value={value} onChange={e => onChange(e.target.value)}
        placeholder="—"
        style={{ width: 48, padding: "3px 6px", borderRadius: 5, fontSize: 12, background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.3)", color: "#eab308", textAlign: "center", outline: "none" }} />
      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>%</span>
    </div>
  );
}

export default function ReportsClient({ games: initialGames, players: initialPlayers }: { games: Game[]; players: Player[] }) {
  const [games] = useState<Game[]>(initialGames);
  const [gameId, setGameId] = useState(initialGames[0]?.id ?? 0);
  const [period, setPeriod] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ExtractedRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [expandedEntries, setExpandedEntries] = useState<any[]>([]);
  const [players, setPlayers] = useState<Player[]>(initialPlayers);
  // Per-type action percentages (report-level)
  const [rakebackPct, setRakebackPct] = useState("");
  const [insurancePct, setInsurancePct] = useState("");
  const [winningsPct, setWinningsPct] = useState("");
  // New player creation
  const [creatingFor, setCreatingFor] = useState<number | null>(null);
  const [newPlayerName, setNewPlayerName] = useState("");
  const [creatingBusy, setCreatingBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadReports(); }, []);

  async function loadReports() {
    const res = await fetch("/api/reports").then(r => r.json());
    setReports(res);
  }

  function onFile(f: File) {
    setFile(f); setRows(null); setSaved(false); setError(null);
    setPreview(URL.createObjectURL(f));
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith("image/")) onFile(f);
  }, []);

  async function extract() {
    if (!file || !gameId) return;
    setLoading(true); setError(null); setRows(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("game_id", String(gameId));
    const res = await fetch("/api/reports/upload", { method: "POST", body: fd });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) { setError(data.error); return; }
    setRows(data.rows as ExtractedRow[]);
  }

  async function setRowPlayer(idx: number, player_id: number | null) {
    const player_name = players.find(p => p.id === player_id)?.name ?? null;
    setRows(r => r!.map((row, i) => i !== idx ? row : { ...row, player_id, player_name }));
  }

  async function createPlayer(idx: number) {
    if (!newPlayerName.trim()) return;
    setCreatingBusy(true);
    const res = await fetch("/api/players", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newPlayerName.trim(), status: "active", tier: "B" }),
    });
    const data = await res.json();
    setCreatingBusy(false);
    if (!res.ok) return;
    const newPlayer = { id: data.id, name: newPlayerName.trim() };
    setPlayers(p => [...p, newPlayer].sort((a, b) => a.name.localeCompare(b.name)));
    setCreatingFor(null);
    setNewPlayerName("");
    setRows(r => r!.map((row, i) => i !== idx ? row : { ...row, player_id: newPlayer.id, player_name: newPlayer.name }));
  }

  async function save() {
    if (!rows || !period.trim()) return;
    setSaving(true);
    const res = await fetch("/api/reports/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        game_id: gameId,
        period_label: period.trim(),
        rakeback_pct: parseFloat(rakebackPct) || null,
        insurance_pct: parseFloat(insurancePct) || null,
        winnings_pct: parseFloat(winningsPct) || null,
        rows,
      }),
    });
    setSaving(false);
    if (res.ok) { setSaved(true); setFile(null); setPreview(null); setRows(null); setPeriod(""); loadReports(); }
  }

  async function deleteReport(id: number) {
    if (!confirm("Supprimer ce rapport ?")) return;
    await fetch(`/api/reports/${id}`, { method: "DELETE" });
    setReports(r => r.filter(x => x.id !== id));
    if (expanded === id) setExpanded(null);
  }

  async function toggleExpand(id: number) {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    setExpandedEntries(await fetch(`/api/reports/${id}`).then(r => r.json()));
  }

  async function matchEntry(reportId: number, entryId: number, playerId: number) {
    await fetch(`/api/reports/${reportId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry_id: entryId, player_id: playerId }),
    });
    setExpandedEntries(await fetch(`/api/reports/${reportId}`).then(r => r.json()));
    loadReports();
  }

  const rkPct = parseFloat(rakebackPct) || 0;
  const insPct = parseFloat(insurancePct) || 0;
  const winPct = parseFloat(winningsPct) || 0;

  const matchedCount = rows?.filter(r => r.player_id).length ?? 0;
  const unmatchedCount = rows ? rows.length - matchedCount : 0;

  function rowCost(row: ExtractedRow) {
    if (!row.player_id) return null;
    const v = row.rakeback_amount * rkPct / 100
            + row.insurance_amount * insPct / 100
            + row.winnings_amount * winPct / 100;
    return v > 0 ? v : null;
  }

  const myTotalCost = rows?.reduce((s, r) => s + (rowCost(r) ?? 0), 0) ?? 0;

  const thStyle: React.CSSProperties = { padding: "9px 12px", textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" };
  const tdStyle: React.CSSProperties = { padding: "10px 12px", fontSize: 12 };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 24, alignItems: "start" }}>

      {/* Upload + extraction */}
      <div>
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 20 }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <select value={gameId} onChange={e => setGameId(Number(e.target.value))}
              style={{ fontSize: 13, fontWeight: 700, padding: "7px 12px", borderRadius: 7, background: "var(--bg-elevated)", border: "1px solid var(--border)", color: GAME_COLOR[games.find(g => g.id === gameId)?.name ?? ""] ?? "var(--text)", cursor: "pointer" }}>
              {games.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <input value={period} onChange={e => setPeriod(e.target.value)}
              placeholder="Période — ex: Semaine 17, Avr 2026"
              style={{ flex: 1, fontSize: 12, padding: "7px 12px", borderRadius: 7, background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text)", outline: "none" }} />
          </div>

          {/* Action % per type */}
          <div style={{ padding: "10px 20px", borderBottom: "1px solid var(--border)", display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap", background: "rgba(234,179,8,0.03)" }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", marginRight: 4 }}>Mon action %</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "#38bdf8" }}>Rakeback</span>
              <PctInput value={rakebackPct} onChange={setRakebackPct} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "#a78bfa" }}>Insurance</span>
              <PctInput value={insurancePct} onChange={setInsurancePct} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "#4ade80" }}>Winnings</span>
              <PctInput value={winningsPct} onChange={setWinningsPct} />
            </div>
          </div>

          <div style={{ padding: 20 }}>
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => !preview && fileRef.current?.click()}
              style={{
                border: `2px dashed ${dragging ? "var(--green)" : "var(--border)"}`,
                borderRadius: 10, cursor: preview ? "default" : "pointer",
                background: dragging ? "rgba(34,197,94,0.05)" : "var(--bg-surface)",
                overflow: "hidden", transition: "all 0.15s",
                padding: preview ? 0 : "44px 20px", textAlign: "center",
              }}>
              {preview
                ? <img src={preview} alt="" style={{ width: "100%", display: "block", borderRadius: 8 }} />
                : <>
                  <FileImage size={36} color="var(--text-dim)" style={{ marginBottom: 12 }} />
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }}>Glisse le screenshot ici</div>
                  <div style={{ fontSize: 12, color: "var(--text-dim)" }}>ou clique pour choisir — JPG, PNG</div>
                </>
              }
            </div>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
            {file && (
              <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <Btn variant="primary" onClick={extract} disabled={loading || !period.trim()}>
                  {loading ? <><Loader size={14} style={{ animation: "spin 1s linear infinite" }} /> Analyse…</> : <><Upload size={14} /> Extraire avec Claude</>}
                </Btn>
                <Btn variant="secondary" onClick={() => { setFile(null); setPreview(null); setRows(null); setError(null); }}>Changer</Btn>
                {!period.trim() && <span style={{ fontSize: 11, color: "#f87171" }}>Remplis la période d'abord</span>}
              </div>
            )}
            {error && <div style={{ marginTop: 12, padding: "10px 14px", background: "rgba(248,113,113,0.10)", border: "1px solid rgba(248,113,113,0.25)", borderRadius: 7, fontSize: 12, color: "#f87171" }}>{error}</div>}
          </div>
        </div>

        {/* Extracted rows */}
        {rows && (
          <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
            <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{rows.length} joueurs</span>
              <span style={{ fontSize: 12, color: "var(--green)" }}>{matchedCount} matchés</span>
              {unmatchedCount > 0 && <span style={{ fontSize: 12, color: "#fb923c" }}>{unmatchedCount} à identifier</span>}
              {myTotalCost > 0 && (
                <span style={{ fontSize: 12, fontWeight: 700, color: "#f87171", marginLeft: 4 }}>
                  Mon coût total : −{myTotalCost.toFixed(2)} USDT
                </span>
              )}
              <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                {saved && <span style={{ fontSize: 12, color: "var(--green)", display: "flex", alignItems: "center", gap: 4 }}><CheckCircle size={13} /> Sauvegardé</span>}
                <Btn variant="primary" onClick={save} disabled={saving || unmatchedCount > 0}>
                  {saving ? "Sauvegarde…" : "Valider & sauvegarder"}
                </Btn>
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    <th style={thStyle}>ID App</th>
                    <th style={{ ...thStyle, color: "#38bdf8" }}>Rakeback</th>
                    <th style={{ ...thStyle, color: "#a78bfa" }}>Insurance</th>
                    <th style={{ ...thStyle, color: "#4ade80" }}>Winnings</th>
                    <th style={{ ...thStyle, color: "#f87171" }}>Mon coût</th>
                    <th style={thStyle}>Joueur CRM</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => {
                    const cost = rowCost(row);
                    const isCreating = creatingFor === idx;
                    return (
                      <tr key={idx} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ ...tdStyle, fontFamily: "monospace", color: "var(--text-muted)" }}>{row.external_id}</td>
                        <td style={{ ...tdStyle, fontWeight: 700, color: "#38bdf8" }}>
                          {row.rakeback_amount > 0 ? `+${row.rakeback_amount.toFixed(2)}` : <span style={{ color: "var(--text-dim)" }}>—</span>}
                        </td>
                        <td style={{ ...tdStyle, fontWeight: 700, color: "#a78bfa" }}>
                          {row.insurance_amount > 0 ? `+${row.insurance_amount.toFixed(2)}` : <span style={{ color: "var(--text-dim)" }}>—</span>}
                        </td>
                        <td style={{ ...tdStyle, fontWeight: 700, color: "#4ade80" }}>
                          {row.winnings_amount > 0 ? `+${row.winnings_amount.toFixed(2)}` : <span style={{ color: "var(--text-dim)" }}>—</span>}
                        </td>
                        <td style={{ ...tdStyle, fontWeight: 700, color: cost !== null ? "#f87171" : "var(--text-dim)" }}>
                          {cost !== null ? `−${cost.toFixed(2)} ${row.currency}` : "—"}
                        </td>
                        <td style={{ ...tdStyle, minWidth: 190 }}>
                          {row.player_id && !isCreating ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <Badge label={row.player_name!} color="green" />
                              <button onClick={() => setRowPlayer(idx, null)} style={{ fontSize: 11, color: "var(--text-dim)", background: "none", border: "none", cursor: "pointer" }}>✕</button>
                            </div>
                          ) : isCreating ? (
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <input autoFocus value={newPlayerName} onChange={e => setNewPlayerName(e.target.value)}
                                onKeyDown={e => e.key === "Enter" && createPlayer(idx)}
                                placeholder="Nom du joueur"
                                style={{ flex: 1, padding: "5px 8px", borderRadius: 6, fontSize: 12, background: "var(--bg-elevated)", border: "1px solid var(--green)", color: "var(--text)", outline: "none" }} />
                              <button onClick={() => createPlayer(idx)} disabled={creatingBusy}
                                style={{ padding: "5px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "var(--green)", cursor: "pointer" }}>
                                {creatingBusy ? "…" : "Créer"}
                              </button>
                              <button onClick={() => { setCreatingFor(null); setNewPlayerName(""); }}
                                style={{ fontSize: 12, color: "var(--text-dim)", background: "none", border: "none", cursor: "pointer" }}>✕</button>
                            </div>
                          ) : (
                            <select onChange={e => {
                              if (e.target.value === "__new__") { setCreatingFor(idx); setNewPlayerName(""); }
                              else setRowPlayer(idx, Number(e.target.value));
                            }} defaultValue=""
                              style={{ fontSize: 12, padding: "5px 10px", borderRadius: 6, background: "rgba(251,146,60,0.10)", border: "1px solid rgba(251,146,60,0.3)", color: "#fb923c", cursor: "pointer", width: "100%" }}>
                              <option value="" disabled>— Identifier le joueur —</option>
                              <option value="__new__">+ Créer un nouveau joueur</option>
                              {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {unmatchedCount > 0 && (
              <div style={{ padding: "10px 16px", fontSize: 11, color: "#fb923c", borderTop: "1px solid var(--border)" }}>
                ⚠️ {unmatchedCount} joueur(s) non identifié(s) — leur ID sera mémorisé pour les prochains rapports
              </div>
            )}
          </div>
        )}
      </div>

      {/* History */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, position: "sticky", top: 24 }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Historique</span>
        </div>
        {reports.length === 0
          ? <div style={{ padding: 28, textAlign: "center", fontSize: 12, color: "var(--text-dim)" }}>Aucun rapport encore</div>
          : reports.map(r => {
            const gc = GAME_COLOR[r.game_name] ?? "var(--text-muted)";
            const isOpen = expanded === r.id;
            return (
              <div key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: gc, background: gc + "18", padding: "2px 6px", borderRadius: 4, flexShrink: 0 }}>{r.game_name}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.period_label}</div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 1 }}>
                      {r.entry_count} joueurs · <span style={{ color: "var(--green)" }}>+{r.total_amount.toFixed(2)} USDT</span>
                      {r.unmatched_count > 0 && <span style={{ color: "#fb923c" }}> · {r.unmatched_count} non matchés</span>}
                    </div>
                  </div>
                  <button onClick={() => toggleExpand(r.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 4 }}>
                    {isOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>
                  <button onClick={() => deleteReport(r.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#f87171", padding: 4 }}>
                    <Trash2 size={12} />
                  </button>
                </div>
                {isOpen && expandedEntries.map((e: any) => (
                  <div key={e.id} style={{ padding: "7px 16px", display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid var(--border)", background: "var(--bg-surface)" }}>
                    <span style={{ fontSize: 11, fontFamily: "monospace", color: "var(--text-dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{e.external_id}</span>
                    <span style={{ fontSize: 11, color: "#38bdf8", flexShrink: 0 }}>rb:{e.amount?.toFixed(2)}</span>
                    {e.player_id
                      ? <span style={{ fontSize: 11, fontWeight: 600, color: "var(--green)", flexShrink: 0 }}>{e.player_name}</span>
                      : <select onChange={ev => matchEntry(r.id, e.id, Number(ev.target.value))} defaultValue=""
                          style={{ fontSize: 11, padding: "2px 6px", borderRadius: 5, background: "rgba(251,146,60,0.10)", border: "1px solid rgba(251,146,60,0.3)", color: "#fb923c" }}>
                          <option value="" disabled>Matcher</option>
                          {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                    }
                  </div>
                ))}
              </div>
            );
          })}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
