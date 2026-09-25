"use client";

import { useState } from "react";
import { AlertTriangle, Eye, Check } from "lucide-react";

// Changement du deal PERÇU d'un game — parcours imposé : saisir → Aperçu (dry_run,
// rien n'est écrit) → Confirmer. Le perçu est la base de la commission de TOUS les
// agents sur ce game : l'aperçu est par agent, et le serveur refuse tout changement
// qui modifierait une commission déjà payée. Aucun calcul d'argent ici.

export interface PerceivedPeriodView {
  id?: number; action_pct: number | null; rakeback_pct: number | null; insurance_pct: number | null;
  start_week: string | null; end_week: string | null; note: string | null;
}
interface WeekChange {
  relationship_id: number; referred_name: string; week: string; eff_before: number; eff_after: number;
  part_before: number; part_after: number; commission_before: number | null; commission_after: number | null;
}
interface AgentImpact {
  agent_name: string; frozen_through: string | null; paid: number; weeks: WeekChange[];
  due_before: number | null; due_after: number | null;
}
interface Result {
  ok: boolean; error?: string; written?: boolean; unchanged?: boolean; needs_confirmation?: boolean;
  preview?: { game_name: string; start_week: string | null; end_week: string | null; agents: AgentImpact[] };
  frozen?: { agent_name: string; frozen_through: string; earliest_week: string; last_payment: string | null; weeks: WeekChange[] }[];
}

const GREEN = "#22C55E", RED = "#EF4444";
const f2 = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n: number | null) => n === null ? "bloqué" : `${f2(n)} USDT`;
const pct = (n: number | null) => n === null ? "—" : `${n} %`;
const isMonday = (iso: string) => /^\d{4}-\d{2}-\d{2}$/.test(iso) && new Date(iso + "T00:00:00Z").getUTCDay() === 1;
function nextMonday(): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7)); return d.toISOString().slice(0, 10);
}

export default function PerceivedEditor({ gameId, gameName, current, periods, onSaved }: {
  gameId: number; gameName: string;
  current: { action_pct: number | null; rakeback_pct: number | null; insurance_pct: number | null };
  periods: PerceivedPeriodView[]; onSaved: () => void;
}) {
  const s = (v: number | null) => v === null ? "" : String(v);
  const [action, setAction] = useState(s(current.action_pct));
  const [rb, setRb] = useState(s(current.rakeback_pct));
  const [ins, setIns] = useState(s(current.insurance_pct));
  const [fromOrigin, setFromOrigin] = useState(false);
  const [week, setWeek] = useState(nextMonday());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);

  const num = (v: string) => v.trim() === "" ? null : Number(v.replace(",", "."));
  const a = num(action), r = num(rb), i = num(ins);
  const valid = a !== null && Number.isFinite(a) && [r, i].every(v => v === null || Number.isFinite(v));
  const weekOk = fromOrigin || isMonday(week);

  async function send(mode: "dry_run" | "confirm") {
    setBusy(true);
    try {
      const resp = await fetch(`/api/games/${gameId}/perceived`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action_pct: a, rakeback_pct: r, insurance_pct: i, start_week: fromOrigin ? null : week, note: note.trim() || null,
          dry_run: mode === "dry_run", confirm_retroactive: mode === "confirm" }),
      });
      const j = await resp.json() as Result;
      setRes(j);
      if (j.ok && (j.written || j.unchanged)) onSaved();
    } catch (e: any) { setRes({ ok: false, error: e.message }); } finally { setBusy(false); }
  }

  const input: React.CSSProperties = { background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", padding: "5px 8px", fontSize: 12, width: 64 };
  const p = res?.preview;
  const previewShown = !!p && !res?.frozen && !res?.written;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
      <div style={{ padding: "8px 10px", borderRadius: 7, background: "rgba(234,179,8,0.10)", border: "1px solid rgba(234,179,8,0.35)", color: "#EAB308", lineHeight: 1.5 }}>
        Le deal perçu est la <b>base de rémunération de tous les agents</b> sur {gameName}. Il est versionné par semaine :
        un changement prend effet un lundi, avec aperçu par agent, et il est <b>refusé</b> s&apos;il modifie une commission déjà payée.
      </div>

      {periods.length > 0 && (
        <div style={{ color: "var(--text-dim)" }}>
          <div style={{ fontWeight: 700, color: "var(--text-muted)", marginBottom: 3 }}>Historique du perçu</div>
          {periods.map((q, k) => (
            <div key={q.id ?? k}>
              {q.start_week ?? "origine"} → {q.end_week ? `sem. du ${q.end_week}` : "en cours"} · action <b style={{ color: "var(--text)" }}>{pct(q.action_pct)}</b> / RB {pct(q.rakeback_pct)} / ass. {pct(q.insurance_pct)}
              {q.note && <div style={{ paddingLeft: 10, fontStyle: "italic" }}>{q.note}</div>}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        Action <input value={action} onChange={e => { setAction(e.target.value); setRes(null); }} style={input} inputMode="decimal" /> %
        RB <input value={rb} onChange={e => { setRb(e.target.value); setRes(null); }} style={input} inputMode="decimal" placeholder="—" /> %
        Ass. <input value={ins} onChange={e => { setIns(e.target.value); setRes(null); }} style={input} inputMode="decimal" placeholder="—" /> %
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        à partir du <input type="date" value={week} disabled={fromOrigin} onChange={e => { setWeek(e.target.value); setRes(null); }} style={{ ...input, width: "auto", opacity: fromOrigin ? 0.4 : 1 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)" }}>
          <input type="checkbox" checked={fromOrigin} onChange={e => { setFromOrigin(e.target.checked); setRes(null); }} /> depuis l&apos;origine
        </label>
      </div>
      {!weekOk && <div style={{ color: RED }}>La date d&apos;effet doit être un lundi (pas de prorata).</div>}
      <input value={note} onChange={e => { setNote(e.target.value); setRes(null); }} placeholder="Motif (optionnel)" style={{ ...input, width: "100%" }} />

      {res && !res.ok && !previewShown && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, color: RED, fontWeight: 600 }}>
          <div style={{ display: "flex", gap: 6 }}><AlertTriangle size={14} style={{ flexShrink: 0 }} /> {res.error}</div>
          {(res.frozen ?? []).map(h => (
            <div key={h.agent_name} style={{ fontWeight: 400, paddingLeft: 20 }}>
              {h.agent_name} — {h.weeks.length} semaine(s) payée(s) touchée(s), ex. {h.weeks[0].referred_name} sem. du {h.weeks[0].week} :
              commission {h.weeks[0].commission_before === null ? "∅" : f2(h.weeks[0].commission_before)} → {h.weeks[0].commission_after === null ? "∅" : f2(h.weeks[0].commission_after)}
            </div>
          ))}
        </div>
      )}
      {res?.ok && res.unchanged && <div style={{ color: "var(--text-dim)" }}>Ce perçu est déjà en vigueur — rien à écrire.</div>}
      {res?.ok && res.written && <div style={{ color: GREEN, fontWeight: 600 }}>✓ Perçu enregistré.</div>}

      {previewShown && p && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontWeight: 700 }}>Aperçu — {p.game_name} · {p.start_week ?? "origine"} → {p.end_week ?? "…"}</div>
          {p.agents.length === 0 && <div style={{ color: "var(--text-dim)" }}>Aucun agent touché.</div>}
          {p.agents.map(ag => (
            <div key={ag.agent_name} style={{ borderTop: "1px dashed var(--border)", paddingTop: 4 }}>
              <div><b>{ag.agent_name}</b> — dû {money(ag.due_before)} → <b style={{ color: GREEN }}>{money(ag.due_after)}</b></div>
              {ag.weeks.map(w => (
                <div key={`${w.relationship_id}:${w.week}`} style={{ color: "var(--text-dim)", paddingLeft: 10, fontVariantNumeric: "tabular-nums" }}>
                  {w.referred_name} · sem. du {w.week} · perçu {w.eff_before} → {w.eff_after} % · part {f2(w.part_before)} → {f2(w.part_after)} · commission {w.commission_before === null ? "∅" : f2(w.commission_before)} → {w.commission_after === null ? "∅" : f2(w.commission_after)}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        {!previewShown ? (
          <button disabled={busy || !valid || !weekOk} onClick={() => send("dry_run")}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 6, cursor: "pointer", background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.35)", color: "#3B82F6", fontWeight: 600, opacity: busy || !valid || !weekOk ? 0.5 : 1 }}>
            <Eye size={13} /> Aperçu avant / après
          </button>
        ) : (
          <>
            <button onClick={() => setRes(null)} style={{ padding: "6px 12px", borderRadius: 6, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Modifier</button>
            <button disabled={busy} onClick={() => send("confirm")}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 6, cursor: "pointer", background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.35)", color: GREEN, fontWeight: 700 }}>
              <Check size={13} /> Confirmer ce perçu
            </button>
          </>
        )}
      </div>
    </div>
  );
}
