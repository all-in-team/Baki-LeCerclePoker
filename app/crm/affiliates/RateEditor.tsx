"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Eye, Check, X } from "lucide-react";
import type { GameBreakdown } from "./AffiliatesClient";

// Éditeur du taux agent d'UN (filleul, game). Aucun calcul d'argent ici : l'exemple
// chiffré est une aide à la saisie (arithmétique d'affichage), le vrai calcul — et
// l'aperçu avant/après — viennent du moteur via POST /api/affiliate-agent-rates.
// Parcours imposé : saisir → Aperçu (dry_run, rien n'est écrit) → Confirmer.
//
// UNITÉ DE SAISIE (Baki 2026-09-26) : « % du résultat joueur » (5 pour Samyaza sur A5).
// Le SERVEUR convertit en % de la part agence avec le perçu de la semaine d'effet
// (5 × 100 / 20 = 25) et stocke ce dernier. Formule composite (Wepoker) : saisie
// directe en % de la part agence, un % du résultat joueur n'y a pas de sens.

interface PreviewWeek { week: string; part: number; old_pct: number | null; new_pct: number; commission_before: number | null; commission_after: number }
interface Preview {
  referred_name: string; game_name: string; start_week: string | null; end_week: string | null;
  old_pct_at_start: number | null; new_pct: number; base_at_start: number | null; weeks: PreviewWeek[];
  line_commission_before: number; line_commission_after: number;
  agent: { earned_before: number | null; earned_after: number | null; paid: number; due_before: number | null; due_after: number | null; blocked_before: number; blocked_after: number };
}
interface Result {
  ok: boolean; error?: string; written?: boolean; unchanged?: boolean; needs_confirmation?: boolean;
  preview?: Preview;
  frozen?: { frozen_through: string; earliest_week: string; payments: { paid_at: string; amount_usdt: number }[] };
}

const GREEN = "#22C55E", RED = "#EF4444", AMBER = "#EAB308";
const f2 = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n: number | null) => n === null ? "bloqué" : `${f2(n)} USDT`;
const pct = (n: number | null) => n === null ? "∅" : `${n.toLocaleString("fr-FR", { maximumFractionDigits: 4 })} %`;
function nextMondayAfter(iso: string | null): string {
  const d = iso ? new Date(iso + "T00:00:00Z") : new Date();
  if (iso) d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));   // lundi prochain
  return d.toISOString().slice(0, 10);
}
const isMonday = (iso: string) => /^\d{4}-\d{2}-\d{2}$/.test(iso) && new Date(iso + "T00:00:00Z").getUTCDay() === 1;

export default function RateEditor({ relationshipId, referredName, game, frozenThrough, onClose, onSaved }: {
  relationshipId: number; referredName: string; game: GameBreakdown; frozenThrough: string | null;
  onClose: () => void; onSaved: () => void;
}) {
  // Date d'effet proposée : lundi qui suit la dernière semaine payée, sinon lundi prochain.
  const proposed = useMemo(() => {
    const next = nextMondayAfter(null);
    const afterFreeze = frozenThrough ? nextMondayAfter(frozenThrough) : null;
    return afterFreeze && afterFreeze > next ? afterFreeze : next;
  }, [frozenThrough]);
  const P = game.effective_action_pct;         // base perçue (%) de la semaine en cours
  const composite = game.is_composite;
  const byPlayer = !composite && P > 0;        // saisie en % du résultat joueur
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  const initial = game.agent_pct_current === null ? "" : String(byPlayer ? r4(game.agent_pct_current * P / 100) : game.agent_pct_current);
  const [pctStr, setPctStr] = useState(initial);
  const [fromOrigin, setFromOrigin] = useState(false);
  const [week, setWeek] = useState(proposed);
  const [note, setNote] = useState("");
  const [wantAmount, setWantAmount] = useState("500");
  const [wantBase, setWantBase] = useState("10000");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);

  const n = Number(pctStr.replace(",", "."));
  // Équivalent en % de la part agence — AFFICHAGE (le serveur refait la conversion avec le perçu de la date d'effet).
  const partPct = byPlayer ? n * 100 / P : n;
  const valid = pctStr.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 100
    && (partPct === 0 || (partPct >= 1 && partPct <= 100));
  const fractionTrap = !byPlayer && Number.isFinite(n) && n > 0 && n < 1;
  const weekOk = fromOrigin || isMonday(week);
  const noteOk = n !== 0 || note.trim().length > 0;

  // Exemple en direct : sur 10 000 de résultat joueur → part agence (base perçue) → part agent.
  const EX = 10000;
  const exBase = composite ? EX : EX * P / 100;
  const exAgent = valid ? (byPlayer ? EX * n / 100 : exBase * n / 100) : null;
  // Saisie inverse : « je veux A sur B » → taux à saisir, dans l'unité de saisie.
  const A = Number(wantAmount.replace(",", ".")), B = Number(wantBase.replace(",", "."));
  const invBase = byPlayer ? B : (composite ? B : B * P / 100);
  const invPct = Number.isFinite(A) && Number.isFinite(B) && invBase !== 0 ? A / invBase * 100 : null;
  const invPart = invPct === null ? null : byPlayer ? invPct * 100 / P : invPct;
  const invOk = invPart !== null && (invPart === 0 || (invPart >= 1 && invPart <= 100));

  async function send(mode: "dry_run" | "confirm") {
    setBusy(true);
    try {
      const r = await fetch("/api/affiliate-agent-rates", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          relationship_id: relationshipId, game_id: game.game_id, ...(byPlayer ? { player_pct: n } : { agent_pct: n }),
          start_week: fromOrigin ? null : week, note: note.trim() || null,
          dry_run: mode === "dry_run", confirm_retroactive: mode === "confirm",
        }),
      });
      const j = await r.json() as Result;
      setRes(j);
      if (j.ok && (j.written || j.unchanged)) onSaved();
    } catch (e: any) { setRes({ ok: false, error: e.message }); } finally { setBusy(false); }
  }

  const input: React.CSSProperties = { background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", padding: "5px 8px", fontSize: 12 };
  const p = res?.preview;
  const previewShown = !!p && !res?.frozen && !res?.written;

  return (
    <div style={{ marginTop: 8, border: "1px solid rgba(59,130,246,0.35)", borderRadius: 8, padding: 12, background: "rgba(59,130,246,0.05)", display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <b style={{ color: "var(--text)" }}>Taux agent — {referredName} / {game.game_name}</b>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)" }}><X size={14} /></button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label>{byPlayer ? "Taux (% du résultat joueur)" : "Taux (% de la part agence)"}</label>
        <input value={pctStr} onChange={e => { setPctStr(e.target.value); setRes(null); }} style={{ ...input, width: 70 }} inputMode="decimal" />
        <span style={{ color: "var(--text-dim)" }}>à partir du</span>
        <input type="date" value={week} disabled={fromOrigin} onChange={e => { setWeek(e.target.value); setRes(null); }} style={{ ...input, opacity: fromOrigin ? 0.4 : 1 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)" }}>
          <input type="checkbox" checked={fromOrigin} onChange={e => { setFromOrigin(e.target.checked); setRes(null); }} /> depuis l&apos;origine
        </label>
      </div>
      {byPlayer && pctStr.trim() !== "" && Number.isFinite(n) && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: -4 }}>
          = {pct(r4(partPct))} de la part agence (perçu {P} % aujourd&apos;hui — converti par le serveur avec le perçu de la date d&apos;effet)
        </div>
      )}
      {byPlayer && valid === false && pctStr.trim() !== "" && Number.isFinite(n) && (
        <div style={{ color: RED }}>{pct(r4(partPct))} de la part agence : hors bornes (0, ou 1 à 100 %).</div>
      )}
      {!weekOk && <div style={{ color: RED }}>La date d&apos;effet doit être un lundi (pas de prorata).</div>}
      {frozenThrough && <div style={{ color: "var(--text-dim)" }}>Semaines payées (gelées) jusqu&apos;à celle du {frozenThrough} — date d&apos;effet au plus tôt : {nextMondayAfter(frozenThrough)}.</div>}
      {fractionTrap && <div style={{ color: RED }}>{pctStr} ressemble à une fraction : le taux est en POURCENT ({n * 100} % ? alors saisir {n * 100}).</div>}

      {/* Exemple chiffré en direct — c'est lui qui empêche de saisir 5 en croyant obtenir 500. */}
      <div style={{ padding: "8px 10px", borderRadius: 6, background: "var(--bg-surface)", border: "1px solid var(--border)", lineHeight: 1.6 }}>
        {composite ? (
          <>Sur <b>10 000</b> de part agence (formule composite {game.currency}) → agent <b>{exAgent === null ? "—" : f2(exAgent)}</b></>
        ) : (
          <>Sur <b>10 000</b> de résultat joueur → agent {valid ? pct(n) : "—"} = <b style={{ color: GREEN }}>{exAgent === null ? "—" : f2(exAgent)}</b>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>part agence ({P} % perçu) {f2(exBase)} × {valid ? pct(r4(partPct)) : "—"} de la part agence</div></>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", color: "var(--text-muted)" }}>
        Je veux <input value={wantAmount} onChange={e => setWantAmount(e.target.value)} style={{ ...input, width: 70 }} inputMode="decimal" />
        sur <input value={wantBase} onChange={e => setWantBase(e.target.value)} style={{ ...input, width: 80 }} inputMode="decimal" />
        de {composite ? "part agence" : "résultat joueur"} → taux à saisir <b style={{ color: invOk ? "var(--text)" : RED }}>{invPct === null ? "—" : pct(invPct)}</b>
        {invOk && invPct !== null && (
          <button onClick={() => { setPctStr(String(r4(invPct))); setRes(null); }}
            style={{ ...input, cursor: "pointer", padding: "3px 8px" }}>utiliser</button>
        )}
        {invPct !== null && !invOk && <span style={{ color: RED }}>hors bornes (0, ou 1 à 100 % de la part agence)</span>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={{ color: n === 0 ? AMBER : "var(--text-muted)" }}>Note {n === 0 ? "(obligatoire pour un 0 % : pourquoi ce filleul ne rapporte rien à l'agent)" : "(optionnelle)"}</label>
        <input value={note} onChange={e => { setNote(e.target.value); setRes(null); }} style={input} placeholder={n === 0 ? "ex. on prend 70 % d'action, l'agent ne touche rien sur lui" : "ex. nouveau deal 50/45/5"} />
      </div>

      {res && !res.ok && !previewShown && (
        <div style={{ display: "flex", gap: 6, color: RED, fontWeight: 600 }}><AlertTriangle size={14} style={{ flexShrink: 0 }} /> {res.error}</div>
      )}
      {res?.ok && res.unchanged && <div style={{ color: "var(--text-dim)" }}>Ce taux est déjà en vigueur — rien à écrire.</div>}
      {res?.ok && res.written && <div style={{ color: GREEN, fontWeight: 600 }}>✓ Taux enregistré.</div>}

      {previewShown && p && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontWeight: 700 }}>
            Aperçu — {p.referred_name} / {p.game_name} · {p.start_week ?? "origine"} → {p.end_week ?? "…"} ·{" "}
            {p.base_at_start !== null
              ? <>{pct(p.old_pct_at_start === null ? null : r4(p.old_pct_at_start * p.base_at_start / 100))} → {pct(r4(p.new_pct * p.base_at_start / 100))} du résultat joueur</>
              : <>{pct(p.old_pct_at_start)} → {pct(p.new_pct)}</>}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: -4 }}>
            stocké : {pct(p.old_pct_at_start)} → <b>{pct(r4(p.new_pct))}</b> de la part agence{p.base_at_start !== null && <> (perçu {p.base_at_start} % à la date d&apos;effet)</>}
          </div>
          {p.weeks.length === 0
            ? <div style={{ color: "var(--text-dim)" }}>Aucune semaine à activité recalculée.</div>
            : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
                <thead><tr style={{ color: "var(--text-dim)", textAlign: "right" }}>
                  <th style={{ textAlign: "left" }}>Semaine</th><th>Part agence</th><th>Taux (part agence)</th><th>Commission</th>
                </tr></thead>
                <tbody>{p.weeks.map(w => (
                  <tr key={w.week} style={{ textAlign: "right" }}>
                    <td style={{ textAlign: "left" }}>{w.week}</td><td>{f2(w.part)}</td>
                    <td>{pct(w.old_pct)} → <b>{pct(w.new_pct)}</b></td>
                    <td>{w.commission_before === null ? "∅" : f2(w.commission_before)} → <b>{f2(w.commission_after)}</b></td>
                  </tr>))}
                </tbody>
              </table>
            )}
          <div>Commission {p.game_name} (cumul) : {f2(p.line_commission_before)} → <b>{f2(p.line_commission_after)}</b></div>
          <div style={{ fontSize: 13 }}>Dû agent : {money(p.agent.due_before)} → <b style={{ color: GREEN }}>{money(p.agent.due_after)}</b> <span style={{ color: "var(--text-dim)" }}>(déjà payé {f2(p.agent.paid)})</span></div>
          {p.agent.blocked_after > 0 && <div style={{ color: RED }}>⚠️ L&apos;agent resterait bloqué ({p.agent.blocked_after} taux manquant).</div>}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        {!previewShown ? (
          <button disabled={busy || !valid || !weekOk || !noteOk} onClick={() => send("dry_run")}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 6, cursor: "pointer", background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.35)", color: "#3B82F6", fontWeight: 600, opacity: busy || !valid || !weekOk || !noteOk ? 0.5 : 1 }}>
            <Eye size={13} /> Aperçu avant / après
          </button>
        ) : (
          <>
            <button onClick={() => setRes(null)} style={{ padding: "6px 12px", borderRadius: 6, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Modifier</button>
            <button disabled={busy} onClick={() => send("confirm")}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 6, cursor: "pointer", background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.35)", color: GREEN, fontWeight: 700 }}>
              <Check size={13} /> Confirmer ce taux
            </button>
          </>
        )}
      </div>
    </div>
  );
}
