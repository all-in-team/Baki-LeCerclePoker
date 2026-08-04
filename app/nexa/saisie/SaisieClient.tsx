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
  /**
   * Vrai tant que la ligne vient d'un screenshot et n'a pas été touchée. Retombe
   * à faux à la première frappe : ce qui est marqué « extraite » est ce que tu
   * n'as pas encore relu, pas ce qui vient d'une image.
   */
  fromScreenshot: boolean;
};

type Checksum = {
  total_read: number | null; sum_rows: number; delta: number | null;
  tolerance: number; ok: boolean; message: string | null;
};
type ExtractedRowOut = {
  nickname: string; member_id: string | null; deal_text: string;
  nlh: number; mtt: number; plo: number; spins: number; affiliate_payment: number;
};
type Extraction = {
  week_start: string; week_end: string; rows: ExtractedRowOut[];
  checksum: Checksum; rejected: { row: number | null; nickname: string | null; reason: string }[];
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
  fromScreenshot: false,
});
/** Miroir de la colonne générée `row_key` : sert à apparier extraction et grille. */
const keyOf = (memberId: string | null | undefined, nickname: string) => {
  const id = String(memberId ?? "").trim();
  return id !== "" ? id : `nick:${nickname.trim().toLowerCase()}`;
};
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
  const [extracting, setExtracting] = useState(false);
  const [checksum, setChecksum] = useState<Checksum | null>(null);
  const [extractRejects, setExtractRejects] = useState<Extraction["rejected"]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shotRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/nexa/affiliate/known-players")
      .then(r => r.json()).then(j => { if (j.ok) setEntrants(j.entrants); }).catch(() => {});
  }, []);

  // Charge la semaine : on ÉDITE ce qui existe, on ne retape pas.
  //
  // `merge` = lignes issues d'un screenshot. Elles ne REMPLACENT pas la semaine :
  // elles sont appariées par row_key aux lignes déjà en base et écrasent les seuls
  // montants, en conservant la storedKey. Ce qui n'existait pas est ajouté. Rien
  // n'est supprimé — la garde anti-omission du serveur reste seule maîtresse.
  const loadWeek = useCallback(async (w: string, merge?: ExtractedRowOut[]) => {
    setLoading(true); setBanner(null); setDeletions([]); setDiff(null); setFeedback([]);
    try {
      const res = await fetch(`/api/nexa/affiliate/week?week_start=${encodeURIComponent(w)}`);
      const j = await res.json();
      if (!j.ok) { setBanner({ kind: "err", text: j.error }); setRows([blank(defaultDeal)]); return; }

      const existing: RowState[] = j.rows.map((s: any) => ({
        uid: UID++, nickname: s.nickname, member_id: s.member_id ?? "", deal_text: s.deal_text,
        nlh: String(s.nlh), mtt: String(s.mtt), plo: String(s.plo), spins: String(s.spins),
        affiliate_payment: String(s.affiliate_payment),
        storedKey: s.row_key, override: s.override_reason ?? "", fromScreenshot: false,
      }));

      if (!merge) { setRows(existing.length ? existing : [blank(defaultDeal)]); return; }

      const byKey = new Map(existing.map(r => [keyOf(r.member_id, r.nickname), r]));
      const merged: RowState[] = [...existing];
      for (const x of merge) {
        const k = keyOf(x.member_id, x.nickname);
        const hit = byKey.get(k);
        const cells = {
          nickname: x.nickname, member_id: x.member_id ?? "", deal_text: x.deal_text,
          nlh: String(x.nlh), mtt: String(x.mtt), plo: String(x.plo), spins: String(x.spins),
          affiliate_payment: String(x.affiliate_payment), fromScreenshot: true,
        };
        if (hit) Object.assign(hit, cells);                       // correction d'une ligne existante
        else merged.push({ uid: UID++, storedKey: null, override: "", ...cells });
      }
      setRows(merged);
    } finally { setLoading(false); }
  }, [defaultDeal]);

  // Une extraction en attente est appliquée par le chargement de sa semaine.
  const pendingExtraction = useRef<ExtractedRowOut[] | null>(null);
  useEffect(() => {
    const merge = pendingExtraction.current;
    pendingExtraction.current = null;
    void loadWeek(week, merge ?? undefined);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [week]);

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

  // Toucher une cellule lève le marquage « extraite » : la ligne a été relue.
  const set = (uid: number, patch: Partial<RowState>) =>
    setRows(rs => rs.map(r => (r.uid === uid ? { ...r, ...patch, fromScreenshot: false } : r)));

  // ── Extraction depuis un screenshot ──────────────────────────────────────
  // NE FAIT QUE PRÉ-REMPLIR. Aucune écriture : le chemin reste extraction →
  // grille → validate → ta relecture → Enregistrer.
  async function extract(file: File) {
    setExtracting(true); setBanner(null); setChecksum(null); setExtractRejects([]);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/nexa/affiliate/extract", { method: "POST", body: fd });
      const j = await res.json();
      if (!j.ok) { setBanner({ kind: "err", text: j.error ?? `Extraction échouée (HTTP ${res.status}).` }); return; }

      const x = j as Extraction;
      setChecksum(x.checksum);
      setExtractRejects(x.rejected);
      if (x.week_start === week) {
        await loadWeek(week, x.rows);           // même semaine : on recharge et on fusionne
      } else {
        pendingExtraction.current = x.rows;      // autre semaine : le changement déclenche le chargement
        setWeek(x.week_start);
      }
      setBanner({
        kind: x.checksum.ok && x.rejected.length === 0 ? "ok" : "err",
        text: `Semaine du ${x.week_start} extraite — ${x.rows.length} ligne(s) pré-remplies. `
          + (x.checksum.ok ? "Checksum OK. " : `⚠️ ${x.checksum.message} `)
          + (x.rejected.length ? `⚠️ ${x.rejected.length} ligne(s) non extraites. ` : "")
          + "Relis avant d'enregistrer — rien n'est écrit à ce stade.",
      });
    } catch (e: any) {
      setBanner({ kind: "err", text: e.message ?? String(e) });
    } finally { setExtracting(false); if (shotRef.current) shotRef.current.value = ""; }
  }

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

          {/* Dépôt de screenshot : PRÉ-REMPLIT la grille, n'écrit jamais en base.
              La semaine détectée est appliquée au sélecteur ci-contre, qui reste
              modifiable — l'extraction propose, tu tranches. */}
          <input ref={shotRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif"
                 style={{ display: "none" }}
                 onChange={e => { const f = e.target.files?.[0]; if (f) void extract(f); }} />
          <button onClick={() => shotRef.current?.click()} disabled={extracting || loading}
                  title="Lit un screenshot du report NEXA et pré-remplit la grille. Rien n'est enregistré."
                  style={{ padding: "8px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600,
                           border: "1px solid rgba(96,165,250,0.4)", background: "rgba(96,165,250,0.10)",
                           color: "#60A5FA", cursor: extracting ? "wait" : "pointer" }}>
            {extracting ? "Lecture du screenshot…" : "📷 Extraire d'un screenshot"}
          </button>

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
                           onChange={e => onNickname(r.uid, e.target.value)}
                           style={{ ...INPUT, ...(r.fromScreenshot ? { borderColor: "rgba(96,165,250,0.55)" } : {}) }} />
                    {r.fromScreenshot && (
                      <div style={{ fontSize: 10, color: "#60A5FA", marginTop: 2 }}
                           title="Valeurs lues sur le screenshot, pas encore relues. Le marquage disparaît dès que tu touches la ligne.">
                        📷 extraite du screenshot
                      </div>
                    )}
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

      {(checksum || extractRejects.length > 0) && (
        <div style={CARD}>
          <div style={{ fontSize: 12, color: "#E8E8EE", fontWeight: 600, marginBottom: 8 }}>
            Contrôle du screenshot
          </div>
          {checksum && (
            <div style={{ fontSize: 12, color: checksum.ok ? "#34D399" : "#F87171" }}>
              {checksum.ok ? "✔" : "⚠️"} Σ des lignes {checksum.sum_rows.toFixed(2)} ·
              {" "}total lu {checksum.total_read === null ? "illisible" : checksum.total_read.toFixed(2)}
              {checksum.delta !== null && <> · écart {checksum.delta.toFixed(2)} (toléré {checksum.tolerance.toFixed(2)})</>}
              {!checksum.ok && checksum.message && <div style={{ marginTop: 4 }}>{checksum.message}</div>}
            </div>
          )}
          {extractRejects.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: "#F87171" }}>
              {extractRejects.length} ligne(s) non extraites — à saisir à la main :
              <ul style={{ margin: "6px 0 0 18px" }}>
                {extractRejects.map((r, i) => (
                  <li key={i}>{r.nickname ?? `ligne ${r.row}`} — {r.reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

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
