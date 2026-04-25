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
  rb_pct: number | null;
  ins_pct: number | null;
  action_pct: number | null;
}
interface Report {
  id: number; game_name: string; period_label: string; created_at: string;
  club_id: string | null; club_name: string | null;
  entry_count: number; total_amount: number; unmatched_count: number;
}
interface DealDraft { rb_pct: string; ins_pct: string; action_pct: string; }

const GAME_COLOR: Record<string, string> = {
  TELE: "#a78bfa", Wepoker: "#38bdf8", Xpoker: "#fb923c", ClubGG: "#4ade80",
};

function PctCell({ value, onChange, color = "#eab308" }: { value: number | null; onChange: (v: number | null) => void; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
      <input type="number" min="0" max="100" step="1"
        value={value ?? ""}
        onChange={e => { const v = parseFloat(e.target.value); onChange(isNaN(v) ? null : v); }}
        placeholder="—"
        style={{ width: 44, padding: "3px 5px", borderRadius: 5, fontSize: 12, background: value !== null ? `${color}14` : "var(--bg-elevated)", border: `1px solid ${value !== null ? color + "55" : "var(--border)"}`, color, textAlign: "center", outline: "none" }} />
      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>%</span>
    </div>
  );
}

// Modal: configure deals for newly matched players with no stored deal
function DealSetupModal({
  rows, onConfirm, onSkip,
}: {
  rows: ExtractedRow[];
  onConfirm: (drafts: Record<number, DealDraft>) => void;
  onSkip: () => void;
}) {
  // Only matched players missing at least one %
  const needsDeal = rows.filter(r => r.player_id && (r.rb_pct === null || r.ins_pct === null || r.action_pct === null));
  const [drafts, setDrafts] = useState<Record<number, DealDraft>>(() =>
    Object.fromEntries(needsDeal.map((r, i) => [i, {
      rb_pct: r.rb_pct !== null ? String(r.rb_pct) : "",
      ins_pct: r.ins_pct !== null ? String(r.ins_pct) : "",
      action_pct: r.action_pct !== null ? String(r.action_pct) : "",
    }]))
  );

  if (!needsDeal.length) { onSkip(); return null; }

  function set(i: number, field: keyof DealDraft, val: string) {
    setDrafts(d => ({ ...d, [i]: { ...d[i], [field]: val } }));
  }

  const inputStyle = (color: string, val: string): React.CSSProperties => ({
    width: 56, padding: "6px 8px", borderRadius: 6, fontSize: 13, fontWeight: 600,
    background: val ? `${color}14` : "var(--bg-surface)",
    border: `1px solid ${val ? color + "66" : "var(--border)"}`,
    color: val ? color : "var(--text-dim)", textAlign: "center", outline: "none",
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 14, width: 520, maxHeight: "80vh", overflow: "auto", boxShadow: "0 24px 64px rgba(0,0,0,0.5)" }}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>Configurer les deals</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {needsDeal.length} joueur{needsDeal.length > 1 ? "s" : ""} — remplis les % une fois, mémorisés pour les prochains imports
          </div>
        </div>

        {/* Column headers */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px 80px", gap: 12, padding: "10px 24px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase" }}>Joueur</span>
          <span style={{ fontSize: 10, fontWeight: 600, color: "#38bdf8", textTransform: "uppercase", textAlign: "center" }}>% RB Rake</span>
          <span style={{ fontSize: 10, fontWeight: 600, color: "#a78bfa", textTransform: "uppercase", textAlign: "center" }}>% RB Ins.</span>
          <span style={{ fontSize: 10, fontWeight: 600, color: "#eab308", textTransform: "uppercase", textAlign: "center" }}>% Action</span>
        </div>

        {needsDeal.map((row, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px 80px", gap: 12, padding: "14px 24px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{row.player_name}</div>
              <div style={{ fontSize: 11, fontFamily: "monospace", color: "var(--text-dim)", marginTop: 2 }}>{row.external_id}</div>
            </div>
            <input type="number" min="0" max="100" step="1" placeholder="—"
              value={drafts[i]?.rb_pct ?? ""}
              onChange={e => set(i, "rb_pct", e.target.value)}
              style={inputStyle("#38bdf8", drafts[i]?.rb_pct ?? "")} />
            <input type="number" min="0" max="100" step="1" placeholder="—"
              value={drafts[i]?.ins_pct ?? ""}
              onChange={e => set(i, "ins_pct", e.target.value)}
              style={inputStyle("#a78bfa", drafts[i]?.ins_pct ?? "")} />
            <input type="number" min="0" max="100" step="1" placeholder="—"
              value={drafts[i]?.action_pct ?? ""}
              onChange={e => set(i, "action_pct", e.target.value)}
              style={inputStyle("#eab308", drafts[i]?.action_pct ?? "")} />
          </div>
        ))}

        <div style={{ padding: "16px 24px", display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onSkip} style={{ padding: "8px 16px", borderRadius: 7, fontSize: 13, background: "none", border: "1px solid var(--border)", color: "var(--text-muted)", cursor: "pointer" }}>
            Passer
          </button>
          <button onClick={() => onConfirm(drafts)}
            style={{ padding: "8px 20px", borderRadius: 7, fontSize: 13, fontWeight: 700, background: "var(--green)", border: "none", color: "#000", cursor: "pointer" }}>
            Confirmer
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ReportsClient({ games, players: initialPlayers }: { games: Game[]; players: Player[] }) {
  const [gameId, setGameId] = useState(games[0]?.id ?? 0);
  const [period, setPeriod] = useState("");
  const [clubId, setClubId] = useState("");
  const [clubName, setClubName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ExtractedRow[] | null>(null);
  const [showDealModal, setShowDealModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [expandedEntries, setExpandedEntries] = useState<any[]>([]);
  const [players, setPlayers] = useState<Player[]>(initialPlayers);
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

  async function fetchDeal(playerId: number, gId: number) {
    try {
      const deals = await fetch(`/api/games/deals?player_id=${playerId}`).then(r => r.json());
      const d = deals.find((x: any) => x.game_id === gId);
      return { rb_pct: d?.rakeback_pct ?? null, ins_pct: d?.insurance_pct ?? null, action_pct: d?.action_pct ?? null };
    } catch { return { rb_pct: null, ins_pct: null, action_pct: null }; }
  }

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
    const rowsWithDeals = await Promise.all((data.rows as any[]).map(async row => {
      const deal = row.player_id ? await fetchDeal(row.player_id, gameId) : { rb_pct: null, ins_pct: null, action_pct: null };
      return { ...row, ...deal };
    }));
    setRows(rowsWithDeals);
    // Open deal modal if any matched player is missing a %
    const needsSetup = rowsWithDeals.some(r => r.player_id && (r.rb_pct === null || r.ins_pct === null || r.action_pct === null));
    if (needsSetup) setShowDealModal(true);
  }

  function applyDealDrafts(drafts: Record<number, DealDraft>) {
    if (!rows) return;
    const needsDeal = rows.filter(r => r.player_id && (r.rb_pct === null || r.ins_pct === null || r.action_pct === null));
    let draftIdx = 0;
    setRows(rows.map(row => {
      if (!row.player_id || (row.rb_pct !== null && row.ins_pct !== null && row.action_pct !== null)) return row;
      const d = drafts[draftIdx++];
      if (!d) return row;
      return {
        ...row,
        rb_pct: d.rb_pct !== "" ? parseFloat(d.rb_pct) : row.rb_pct,
        ins_pct: d.ins_pct !== "" ? parseFloat(d.ins_pct) : row.ins_pct,
        action_pct: d.action_pct !== "" ? parseFloat(d.action_pct) : row.action_pct,
      };
    }));
    setShowDealModal(false);
  }

  async function setRowPlayer(idx: number, player_id: number | null) {
    const player_name = players.find(p => p.id === player_id)?.name ?? null;
    const deal = player_id ? await fetchDeal(player_id, gameId) : { rb_pct: null, ins_pct: null, action_pct: null };
    setRows(r => r!.map((row, i) => i !== idx ? row : { ...row, player_id, player_name, ...deal }));
  }

  function setRowField(idx: number, field: keyof ExtractedRow, value: any) {
    setRows(r => r!.map((row, i) => i !== idx ? row : { ...row, [field]: value }));
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
    setRows(r => r!.map((row, i) => i !== idx ? row : { ...row, player_id: newPlayer.id, player_name: newPlayer.name, rb_pct: null, ins_pct: null, action_pct: null }));
  }

  async function save() {
    if (!rows || !period.trim()) return;
    setSaving(true);
    const res = await fetch("/api/reports/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game_id: gameId, period_label: period.trim(), club_id: clubId.trim() || null, club_name: clubName.trim() || null, rows }),
    });
    setSaving(false);
    if (res.ok) { setSaved(true); setFile(null); setPreview(null); setRows(null); setPeriod(""); setClubId(""); setClubName(""); loadReports(); }
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

  const matchedCount = rows?.filter(r => r.player_id).length ?? 0;
  const unmatchedCount = rows ? rows.length - matchedCount : 0;

  const thStyle: React.CSSProperties = { padding: "9px 10px", textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" };
  const tdStyle: React.CSSProperties = { padding: "10px 10px", fontSize: 12 };

  function fmtAmount(v: number, positiveColor: string) {
    if (v === 0) return <span style={{ color: "var(--text-dim)" }}>—</span>;
    return <span style={{ fontWeight: 700, color: v > 0 ? positiveColor : "#f87171" }}>{v > 0 ? "+" : ""}{v.toFixed(2)}</span>;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 24, alignItems: "start" }}>

      {/* Deal setup modal */}
      {showDealModal && rows && (
        <DealSetupModal
          rows={rows}
          onConfirm={applyDealDrafts}
          onSkip={() => setShowDealModal(false)}
        />
      )}

      <div>
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 20 }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <select value={gameId} onChange={e => setGameId(Number(e.target.value))}
              style={{ fontSize: 13, fontWeight: 700, padding: "7px 12px", borderRadius: 7, background: "var(--bg-elevated)", border: "1px solid var(--border)", color: GAME_COLOR[games.find(g => g.id === gameId)?.name ?? ""] ?? "var(--text)", cursor: "pointer" }}>
              {games.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <input value={clubId} onChange={e => setClubId(e.target.value)}
              placeholder="Club ID"
              style={{ width: 90, fontSize: 12, padding: "7px 10px", borderRadius: 7, background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text)", outline: "none", fontFamily: "monospace" }} />
            <input value={clubName} onChange={e => setClubName(e.target.value)}
              placeholder="Club Name"
              style={{ width: 130, fontSize: 12, padding: "7px 10px", borderRadius: 7, background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text)", outline: "none" }} />
            <input value={period} onChange={e => setPeriod(e.target.value)}
              placeholder="Période — ex: Semaine 17, Avr 2026"
              style={{ flex: 1, minWidth: 160, fontSize: 12, padding: "7px 12px", borderRadius: 7, background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text)", outline: "none" }} />
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
                <Btn variant="primary" onClick={extract} disabled={loading}>
                  {loading ? <><Loader size={14} style={{ animation: "spin 1s linear infinite" }} /> Analyse en cours…</> : <><Upload size={14} /> Extraire avec Claude</>}
                </Btn>
                <Btn variant="secondary" onClick={() => { setFile(null); setPreview(null); setRows(null); setError(null); }}>Changer</Btn>
              </div>
            )}
            {error && <div style={{ marginTop: 12, padding: "10px 14px", background: "rgba(248,113,113,0.10)", border: "1px solid rgba(248,113,113,0.25)", borderRadius: 7, fontSize: 12, color: "#f87171" }}>{error}</div>}
          </div>
        </div>

        {rows && (
          <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10 }}>
            <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{rows.length} joueurs</span>
              <span style={{ fontSize: 12, color: "var(--green)" }}>{matchedCount} matchés</span>
              {unmatchedCount > 0 && <span style={{ fontSize: 12, color: "#fb923c" }}>{unmatchedCount} à identifier</span>}
              <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                {saved && <span style={{ fontSize: 12, color: "var(--green)", display: "flex", alignItems: "center", gap: 4 }}><CheckCircle size={13} /> Sauvegardé</span>}
                <Btn variant="primary" onClick={save} disabled={saving || unmatchedCount > 0 || !period.trim()}>
                  {saving ? "Sauvegarde…" : !period.trim() ? "Remplis la période ↑" : "Valider & sauvegarder"}
                </Btn>
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    <th style={thStyle}>ID App</th>
                    <th style={{ ...thStyle, color: "#38bdf8" }}>Rakeback</th>
                    <th style={{ ...thStyle, color: "#38bdf8", opacity: 0.7 }}>% RB Rake</th>
                    <th style={{ ...thStyle, color: "#a78bfa" }}>Insurance</th>
                    <th style={{ ...thStyle, color: "#a78bfa", opacity: 0.7 }}>% RB Ins.</th>
                    <th style={{ ...thStyle, color: "#4ade80" }}>Winnings / Pertes</th>
                    <th style={{ ...thStyle, color: "#eab308" }}>% Action</th>
                    <th style={thStyle}>Joueur CRM</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => {
                    const isCreating = creatingFor === idx;
                    return (
                      <tr key={idx} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ ...tdStyle, fontFamily: "monospace", color: "var(--text-muted)", fontSize: 11 }}>{row.external_id}</td>
                        <td style={tdStyle}>{fmtAmount(row.rakeback_amount, "#38bdf8")}</td>
                        <td style={tdStyle}>
                          <PctCell value={row.rb_pct} onChange={v => setRowField(idx, "rb_pct", v)} color="#38bdf8" />
                        </td>
                        <td style={tdStyle}>{fmtAmount(row.insurance_amount, "#a78bfa")}</td>
                        <td style={tdStyle}>
                          <PctCell value={row.ins_pct} onChange={v => setRowField(idx, "ins_pct", v)} color="#a78bfa" />
                        </td>
                        <td style={tdStyle}>{fmtAmount(row.winnings_amount, "#4ade80")}</td>
                        <td style={tdStyle}>
                          <PctCell value={row.action_pct} onChange={v => setRowField(idx, "action_pct", v)} color="#eab308" />
                        </td>
                        <td style={{ ...tdStyle, minWidth: 180 }}>
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
                              <option value="" disabled>— Identifier —</option>
                              <option value="__new__">+ Créer un joueur</option>
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
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.period_label}
                      {r.club_name && <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-muted)", marginLeft: 6 }}>· {r.club_name}{r.club_id ? ` #${r.club_id}` : ""}</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 1 }}>
                      {r.entry_count} joueurs · <span style={{ color: "var(--green)" }}>+{r.total_amount.toFixed(2)}</span>
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
                    <span style={{ fontSize: 11, color: "#38bdf8", flexShrink: 0 }}>rb:{(e.amount ?? 0).toFixed(2)}</span>
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
