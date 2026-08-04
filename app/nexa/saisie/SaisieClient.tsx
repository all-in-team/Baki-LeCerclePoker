"use client";

// Grille de saisie du report d'affiliation NEXA — recopie des screenshots.
//
// AUCUNE MATH D'ARGENT ICI (invariant #2). Le recalcul et le contrôle à 0,02
// tournent côté serveur, via /api/nexa/affiliate/validate, appelé en débounce.
// Ce composant n'additionne rien : il affiche des verdicts qu'on lui donne.
//
// Suppression : bouton dédié par ligne, jamais par omission. Retirer une ligne
// de la grille sans le dire ferait disparaître la semaine de ce joueur — le
// serveur refuse d'ailleurs ce cas et renvoie les orphelines nommément.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const CARD: React.CSSProperties = {
  background: "#12141C", border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 14, padding: 18,
};
const INPUT: React.CSSProperties = {
  background: "#0B0D12", border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8, color: "#E8E8EE", padding: "6px 8px", fontSize: 12, width: "100%",
};
const TH: React.CSSProperties = {
  textAlign: "left", fontSize: 11, color: "#8888A0", fontWeight: 600,
  padding: "6px 6px", whiteSpace: "nowrap",
};

type Verdict =
  | { ok: true; rates: Record<string, number>; recomputed: number; delta: number; zeroRated: string[] }
  | { ok: false; code: string; message: string; raw_deal: string; fragment: string | null; expected: number | null; delta: number | null };

type RowState = {
  uid: number;
  nickname: string; member_id: string; deal_text: string;
  nlh: string; mtt: string; plo: string; spins: string; affiliate_payment: string;
  /** Clé côté serveur si la ligne vient de la base — sert à la suppression explicite. */
  storedKey: string | null;
  override: string;
};

type RowFeedback = {
  row_key: string; player_id: number | null; resolved_by: string | null;
  hint: { player_id: number; via: string } | null; verdict: Verdict;
};

type Diff = {
  added: string[]; modified: { row_key: string; changes: string[] }[]; unchanged: string[];
  deleted: string[]; orphans: string[]; duplicates: string[];
  rejected: { row_key: string | null; nickname: string; code: string; message: string }[];
};

type Entrant = { nickname: string; nickname_key: string; member_id: string | null; last_deal_text: string | null };

let UID = 1;
const blank = (deal: string): RowState => ({
  uid: UID++, nickname: "", member_id: "", deal_text: deal,
  nlh: "", mtt: "", plo: "", spins: "", affiliate_payment: "", storedKey: null, override: "",
});
const num = (s: string) => { const n = parseFloat(String(s).replace(",", ".")); return Number.isFinite(n) ? n : NaN; };
const payload = (r: RowState) => ({
  nickname: r.nickname.trim(), member_id: r.member_id.trim() || null, deal_text: r.deal_text,
  nlh: num(r.nlh || "0"), mtt: num(r.mtt || "0"), plo: num(r.plo || "0"), spins: num(r.spins || "0"),
  affiliate_payment: num(r.affiliate_payment || "0"),
});

export default function SaisieClient({ defaultDeal, initialWeek }: { defaultDeal: string; initialWeek: string }) {
  const [week, setWeek] = useState(initialWeek);
  const [rows, setRows] = useState<RowState[]>([blank(defaultDeal)]);
  const [deletions, setDeletions] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<RowFeedback[]>([]);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [entrants, setEntrants] = useState<Entrant[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch("/api/nexa/affiliate/known-players")
      .then(r => r.json()).then(j => { if (j.ok) setEntrants(j.entrants); }).catch(() => {});
  }, []);

  // Charge la semaine : on ÉDITE ce qui existe, on ne retape pas.
  const loadWeek = useCallback(async (w: string) => {
    setLoading(true); setBanner(null); setDeletions([]); setDiff(null); setFeedback([]);
    try {
      const res = await fetch(`/api/nexa/affiliate/week?week_start=${encodeURIComponent(w)}`);
      const j = await res.json();
      if (!j.ok) { setBanner({ kind: "err", text: j.error }); setRows([blank(defaultDeal)]); return; }
      setRows(j.rows.length
        ? j.rows.map((s: any) => ({
            uid: UID++, nickname: s.nickname, member_id: s.member_id ?? "", deal_text: s.deal_text,
            nlh: String(s.nlh), mtt: String(s.mtt), plo: String(s.plo), spins: String(s.spins),
            affiliate_payment: String(s.affiliate_payment),
            storedKey: s.row_key, override: s.override_reason ?? "",
          }))
        : [blank(defaultDeal)]);
    } finally { setLoading(false); }
  }, [defaultDeal]);

  useEffect(() => { void loadWeek(week); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [week]);

  // Contrôle serveur débouncé — c'est lui qui décide, pas le navigateur.
  const overrides = useMemo(() => {
    const o: Record<string, string> = {};
    for (const r of rows) if (r.override.trim()) {
      const key = r.member_id.trim() || `nick:${r.nickname.trim().toLowerCase()}`;
      o[key] = r.override.trim();
    }
    return o;
  }, [rows]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const filled = rows.filter(r => r.nickname.trim() !== "");
    if (!filled.length) { setFeedback([]); setDiff(null); return; }
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/nexa/affiliate/validate", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ week_start: week, rows: filled.map(payload), overrides, deletions }),
        });
        const j = await res.json();
        if (j.ok) { setFeedback(j.rows); setDiff(j.diff); }
      } catch { /* le contrôle repartira à la frappe suivante */ }
    }, 400);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [rows, week, overrides, deletions]);

  const set = (uid: number, patch: Partial<RowState>) =>
    setRows(rs => rs.map(r => (r.uid === uid ? { ...r, ...patch } : r)));

  // Choisir un pseudo connu pré-remplit ID et dernier deal — jamais un rattachement.
  const onNickname = (uid: number, value: string) => {
    const hit = entrants.find(e => e.nickname_key === value.trim().toLowerCase());
    set(uid, {
      nickname: value,
      ...(hit?.member_id ? { member_id: hit.member_id } : {}),
      ...(hit?.last_deal_text ? { deal_text: hit.last_deal_text } : {}),
    });
  };

  const removeRow = (r: RowState) => {
    if (r.storedKey && !confirm(`Supprimer « ${r.nickname} » de la semaine du ${week} ?\nCette ligne est déjà enregistrée.`)) return;
    if (r.storedKey) setDeletions(d => [...new Set([...d, r.storedKey!])]);
    setRows(rs => rs.filter(x => x.uid !== r.uid));
  };

  async function save() {
    setSaving(true); setBanner(null);
    try {
      const filled = rows.filter(r => r.nickname.trim() !== "");
      const res = await fetch("/api/nexa/affiliate/week", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week_start: week, rows: filled.map(payload), overrides, deletions }),
      });
      const j = await res.json();
      if (!j.ok) { setBanner({ kind: "err", text: j.error }); if (j.diff) setDiff(j.diff); return; }
      setBanner({ kind: "ok", text: `Semaine du ${week} enregistrée — ${j.written} ligne(s).` });
      await loadWeek(week);
    } catch (e: any) {
      setBanner({ kind: "err", text: e.message ?? String(e) });
    } finally { setSaving(false); }
  }

  // Le feedback arrive dans l'ordre des lignes remplies : on réaligne sur la grille.
  const fbByUid = useMemo(() => {
    const m = new Map<number, RowFeedback>();
    rows.filter(r => r.nickname.trim() !== "").forEach((r, i) => { if (feedback[i]) m.set(r.uid, feedback[i]); });
    return m;
  }, [rows, feedback]);

  const blocking = (diff?.orphans.length ?? 0) + (diff?.duplicates.length ?? 0) + (diff?.rejected.length ?? 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={CARD}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: "#8888A0", display: "flex", alignItems: "center", gap: 8 }}>
            Semaine du (lundi)
            <input type="date" value={week} onChange={e => setWeek(e.target.value)}
                   style={{ ...INPUT, width: "auto" }} />
          </label>
          {loading && <span style={{ fontSize: 12, color: "#8888A0" }}>chargement…</span>}
          <div style={{ flex: 1 }} />
          <button onClick={save} disabled={saving || blocking > 0}
                  title={blocking > 0 ? "Corrige les lignes en erreur avant d'enregistrer" : undefined}
                  style={{
                    padding: "8px 18px", borderRadius: 8, border: "none", fontSize: 12, fontWeight: 700,
                    background: blocking > 0 ? "#3A3A48" : "#10B981", color: blocking > 0 ? "#8888A0" : "#0B0D12",
                    cursor: saving ? "wait" : blocking > 0 ? "not-allowed" : "pointer",
                  }}>
            {saving ? "Enregistrement…" : "Enregistrer la semaine"}
          </button>
        </div>
      </div>

      <div style={{ ...CARD, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1000 }}>
          <thead>
            <tr>
              <th style={TH}>Nickname</th><th style={TH}>Member ID</th><th style={TH}>Deal</th>
              <th style={TH}>NLH</th><th style={TH}>MTT</th><th style={TH}>PLO</th><th style={TH}>Spins</th>
              <th style={TH}>Affiliate Pay</th><th style={TH}>Contrôle</th><th style={TH} />
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const fb = fbByUid.get(r.uid);
              const bad = fb && !fb.verdict.ok;
              const mismatch = bad && (fb!.verdict as any).code === "payment_mismatch";
              return (
                <tr key={r.uid} style={{ borderTop: "1px solid rgba(255,255,255,0.05)",
                                         background: bad ? "rgba(239,68,68,0.06)" : undefined }}>
                  <td style={{ padding: 4, minWidth: 130 }}>
                    <input list="nexa-entrants" value={r.nickname} placeholder="pseudo"
                           onChange={e => onNickname(r.uid, e.target.value)} style={INPUT} />
                  </td>
                  <td style={{ padding: 4, minWidth: 110 }}>
                    <input value={r.member_id} placeholder="(vide)" onChange={e => set(r.uid, { member_id: e.target.value })} style={INPUT} />
                  </td>
                  <td style={{ padding: 4, minWidth: 240 }}>
                    <input value={r.deal_text} onChange={e => set(r.uid, { deal_text: e.target.value })} style={INPUT} />
                  </td>
                  {(["nlh", "mtt", "plo", "spins", "affiliate_payment"] as const).map(f => (
                    <td key={f} style={{ padding: 4, minWidth: 80 }}>
                      <input value={r[f]} inputMode="decimal" placeholder="0"
                             onChange={e => set(r.uid, { [f]: e.target.value } as Partial<RowState>)}
                             style={{ ...INPUT, textAlign: "right" }} />
                    </td>
                  ))}
                  <td style={{ padding: 4, fontSize: 11, minWidth: 230 }}>
                    {!fb ? <span style={{ color: "#55556A" }}>—</span>
                     : fb.verdict.ok ? (
                       <span style={{ color: "#34D399" }}>
                         ✔ {fb.verdict.recomputed.toFixed(2)}
                         {fb.verdict.zeroRated.length > 0 &&
                           <span style={{ color: "#F0B90B" }}> · taux 0 : {fb.verdict.zeroRated.join(", ")}</span>}
                         {fb.player_id === null &&
                           <span style={{ color: "#F0B90B" }}> · à réconcilier
                             {fb.hint ? " (candidat proposé)" : ""}</span>}
                       </span>
                     ) : <span style={{ color: "#F87171" }}>✖ {fb.verdict.message}</span>}
                    {mismatch && (
                      <input value={r.override} placeholder="motif pour accepter l'écart"
                             onChange={e => set(r.uid, { override: e.target.value })}
                             style={{ ...INPUT, marginTop: 4, fontSize: 11 }} />
                    )}
                  </td>
                  <td style={{ padding: 4 }}>
                    <button onClick={() => removeRow(r)} title="Supprimer cette ligne"
                            style={{ background: "transparent", border: "1px solid rgba(239,68,68,0.35)",
                                     color: "#F87171", borderRadius: 8, padding: "4px 8px", cursor: "pointer", fontSize: 11 }}>
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <datalist id="nexa-entrants">
          {entrants.map(e => <option key={e.nickname_key} value={e.nickname} />)}
        </datalist>
        <button onClick={() => setRows(rs => [...rs, blank(defaultDeal)])}
                style={{ marginTop: 12, background: "transparent", border: "1px dashed rgba(255,255,255,0.18)",
                         color: "#8888A0", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 12 }}>
          + ligne
        </button>
      </div>

      {diff && (
        <div style={CARD}>
          <div style={{ fontSize: 12, color: "#E8E8EE", fontWeight: 600, marginBottom: 8 }}>Récapitulatif</div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12 }}>
            <span style={{ color: "#34D399" }}>{diff.added.length} ajoutée(s)</span>
            <span style={{ color: "#60A5FA" }}>{diff.modified.length} modifiée(s)</span>
            <span style={{ color: "#8888A0" }}>{diff.unchanged.length} inchangée(s)</span>
            <span style={{ color: diff.deleted.length ? "#F87171" : "#8888A0" }}>
              {diff.deleted.length} SUPPRIMÉE(S)
            </span>
          </div>
          {diff.orphans.length > 0 && (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 8, fontSize: 12,
                          background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", color: "#F87171" }}>
              {diff.orphans.length} ligne(s) enregistrée(s) ne sont pas dans la grille : {diff.orphans.join(", ")}.
              Utilise le bouton ✕ pour les supprimer explicitement — rien ne disparaît par omission.
            </div>
          )}
          {diff.duplicates.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: "#F87171" }}>
              Clé(s) en double : {diff.duplicates.join(", ")} — renseigne un Member ID pour distinguer les homonymes.
            </div>
          )}
        </div>
      )}

      {banner && (
        <div style={{ padding: "10px 14px", borderRadius: 10, fontSize: 12,
                      background: banner.kind === "ok" ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)",
                      border: `1px solid ${banner.kind === "ok" ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.3)"}`,
                      color: banner.kind === "ok" ? "#34D399" : "#F87171" }}>
          {banner.kind === "ok" ? "✅ " : "❌ "}{banner.text}
        </div>
      )}
    </div>
  );
}
