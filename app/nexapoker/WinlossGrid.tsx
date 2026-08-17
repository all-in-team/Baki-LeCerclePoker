"use client";

// Saisie hebdomadaire des win/loss — le geste du lundi, tous les joueurs stakés
// d'un coup.
//
// AUCUNE MATH ICI (invariant #2). Ce composant lit des montants et les renvoie
// tels quels à /api/nexapoker/winloss, la route existante et déjà auditée, un
// joueur à la fois. Aucune écriture groupée n'est inventée : un échec sur un
// joueur ne peut donc pas corrompre les autres, chaque saisie valant pour
// elle-même. Le récapitulatif dit exactement ce qui est passé et ce qui a échoué.
//
// VIDE ≠ ZÉRO, ET C'EST TOUT L'ENJEU DE CET ÉCRAN. Un champ laissé vide n'écrit
// rien ; un champ effacé sur une semaine déjà saisie DÉ-SAISIT (amount: null),
// il n'écrit pas 0. Le moteur distingue « le joueur a fini à l'équilibre » de
// « je ne sais pas encore », et refuse de calculer une part d'action sur le
// second. Confondre les deux fabriquerait des parts d'action sur du vide.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Row = {
  player_id: number; name: string; action_pct: number; amount: number | null;
  /** Semaine calculée depuis la bankroll : la cellule est en LECTURE SEULE.
   *  Le refus réel vit dans setWeeklyWinlossOn ; ce drapeau évite de taper pour rien. */
  bankroll_locked?: boolean;
};

const CARD: React.CSSProperties = {
  background: "#12141C", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, padding: 18,
};
const INPUT: React.CSSProperties = {
  background: "#0B0D12", border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8, color: "#E8E8EE", padding: "6px 8px", fontSize: 12,
};

/**
 * Lundi de la semaine passée — celle qu'on saisit le lundi matin.
 *
 * Tout en calendrier UTC : mélanger getUTCDay() avec une date construite sur
 * l'heure locale décale d'une semaine entière entre minuit et 2 h à Paris (le
 * dimanche 22 h UTC est déjà lundi à Paris). La grille se serait ouverte sur la
 * mauvaise semaine, à l'heure exacte où on la remplit le moins.
 */
function lastMonday(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7);
  return d.toISOString().slice(0, 10);
}

/** La saisie est hebdomadaire : une date qui n'est pas un lundi n'a pas de sens ici. */
function isMonday(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.getUTCDay() === 1;
}

const fmt = (n: number) =>
  n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Parse STRICT d'un montant saisi. `undefined` = illisible, et le champ passe en
 * rouge : rien ne part en base.
 *
 * parseFloat seul est un piège de saisie d'argent : il s'arrête au premier
 * caractère invalide et rend un nombre d'apparence valide. « 1 234,56 » collé
 * depuis un tableur devient 1 — pas une erreur, pas une alerte, juste un montant
 * faux de 1233,56. « 12o » devient 12, « 5- » devient 5. Ici on nettoie d'abord
 * les séparateurs de milliers (espace, espace insécable, apostrophe), on ramène
 * la virgule sur le point, puis on EXIGE que toute la chaîne soit un nombre.
 */
export function parseMontant(raw: string): number | undefined {
  const t = raw.trim().replace(/[\s\u00A0\u202F']/g, "").replace(",", ".");
  if (t === "") return undefined;
  if (!/^[+-]?\d*\.?\d+$/.test(t)) return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}

export default function WinlossGrid() {
  const router = useRouter();
  const [week, setWeek] = useState(lastMonday);
  const [rows, setRows] = useState<Row[]>([]);
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Seuls les joueurs stakés par défaut : saisir un win/loss pour un joueur à 0 %
  // d'action ne produit aucune part. Le voile se lève à la demande.
  const [onlyStaked, setOnlyStaked] = useState(true);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  const load = useCallback(async (w: string) => {
    setLoading(true); setMsg(null);
    try {
      const j = await (await fetch(`/api/nexapoker/winloss-week?week_start=${w}`)).json();
      if (!j.ok) { setMsg({ kind: "err", text: j.error ?? "Chargement impossible." }); return; }
      setRows(j.players);
      // Le brouillon part de ce qui est EN BASE : la grille montre l'état réel,
      // et ne « propose » aucune valeur que Baki n'aurait pas saisie lui-même.
      setDraft(Object.fromEntries(
        (j.players as Row[]).map(p => [p.player_id, p.amount === null ? "" : String(p.amount)]),
      ));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(week); }, [week, load]);

  const shown = rows.filter(r => !onlyStaked || r.action_pct > 0);
  const saisis = shown.filter(r => (draft[r.player_id] ?? "").trim() !== "").length;

  /** Entrée / flèches : on descend d'un champ, sans quitter le clavier. */
  function onKey(e: React.KeyboardEvent, i: number) {
    if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); inputs.current[i + 1]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); inputs.current[i - 1]?.focus(); }
  }

  async function saveAll() {
    if (!isMonday(week)) {
      setMsg({ kind: "err", text: `${week} n'est pas un lundi — la saisie est hebdomadaire.` });
      return;
    }
    setBusy(true); setMsg(null);
    // La semaine est FIGÉE le temps de la boucle : si elle changeait en cours de
    // route, le test « inchangé » se jugerait sur les montants d'une autre semaine
    // et sauterait silencieusement une saisie légitime.
    const week0 = week;
    let ecrits = 0, desaisis = 0, inchanges = 0;
    const erreurs: string[] = [];
    for (const r of shown) {
      // Semaine calculée depuis la bankroll : elle n'appartient pas à cette grille.
      // On l'écarte AVANT tout envoi — la route la refuserait de toute façon, mais
      // un échec par joueur dans le récapitulatif ferait passer un fonctionnement
      // normal pour une panne.
      if (r.bankroll_locked) { inchanges++; continue; }
      const brut = (draft[r.player_id] ?? "").trim();
      // Rien à faire : champ vide sur une semaine jamais saisie.
      if (brut === "" && r.amount === null) { inchanges++; continue; }

      let amount: number | null;
      if (brut === "") {
        amount = null; // dé-saisie explicite d'une valeur qui existait
      } else {
        const v = parseMontant(brut);
        if (v === undefined) { erreurs.push(`${r.name} : « ${brut} » illisible`); continue; }
        // Comparaison de flottants par différence (invariant #9), jamais par ===.
        if (r.amount !== null && Math.abs(v - r.amount) < 0.005) { inchanges++; continue; }
        amount = v;
      }

      // Un fetch qui LÈVE (réseau coupé) ne doit pas interrompre la boucle sans
      // récapitulatif : les écritures déjà passées sont en base, il faut les dire.
      try {
        const res = await fetch("/api/nexapoker/winloss", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ player_id: r.player_id, week_start: week0, amount }),
        });
        const j = await res.json().catch(() => null);
        if (!j?.ok) { erreurs.push(`${r.name} : ${j?.error ?? `HTTP ${res.status}`}`); continue; }
        if (amount === null) desaisis++; else ecrits++;
      } catch (e: any) {
        erreurs.push(`${r.name} : ${e?.message ?? "réseau injoignable"}`);
      }
    }

    const parts = [
      ecrits > 0 ? `${ecrits} saisi(s)` : null,
      desaisis > 0 ? `${desaisis} dé-saisi(s)` : null,
      inchanges > 0 ? `${inchanges} inchangé(s)` : null,
    ].filter(Boolean).join(" · ");
    setMsg(erreurs.length > 0
      ? { kind: "err", text: `${parts || "rien d'écrit"} — ${erreurs.length} échec(s) : ${erreurs.join(" ; ")}` }
      : { kind: "ok", text: `Semaine du ${week0} — ${parts || "rien à écrire"}.` });

    await load(week0);
    // Les cartes, le graph et la table vivent côté serveur : sans ce refresh, la
    // grille afficherait des win/loss que le reste de la page ignore encore.
    router.refresh();
    setBusy(false);
  }

  return (
    <div style={{ ...CARD, borderColor: "rgba(167,139,250,0.35)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#E8E8EE" }}>
          ♠️ Win/loss de la semaine
        </div>
        <label style={{ fontSize: 12, color: "#8888A0", display: "flex", gap: 6, alignItems: "center" }}>
          Semaine du (lundi)
          <input type="date" value={week} disabled={busy}
                 style={{ ...INPUT, borderColor: isMonday(week) ? "rgba(255,255,255,0.1)" : "rgba(239,68,68,0.5)" }}
                 onChange={e => setWeek(e.target.value)} />
        </label>
        <label style={{ fontSize: 11, color: "#8888A0", display: "flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={onlyStaked} onChange={e => setOnlyStaked(e.target.checked)} />
          joueurs stakés seulement
        </label>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: isMonday(week) ? "#555568" : "#F87171" }}>
          {!isMonday(week) ? "⚠️ pas un lundi" : loading ? "…" : `${saisis}/${shown.length} renseigné(s)`}
        </span>
      </div>
      <div style={{ fontSize: 12, color: "#8888A0", marginBottom: 12 }}>
        Le montant est <b>signé</b> : positif si le joueur a gagné, négatif s&apos;il a perdu.
        Un champ laissé vide n&apos;écrit rien ; vider un champ déjà rempli remet la semaine
        en « non saisie » — ce n&apos;est pas la même chose qu&apos;un zéro, et le moteur
        refuse de calculer une part d&apos;action sur une semaine non saisie.
        Entrée ou ↓ passe au joueur suivant.
      </div>

      {!loading && shown.length === 0 && (
        <div style={{ fontSize: 12, color: "#555568", padding: "10px 0" }}>
          Aucun joueur staké. Décoche « joueurs stakés seulement » pour voir tout le monde,
          ou règle une part d&apos;action dans la table ci-dessus.
        </div>
      )}

      {shown.length > 0 && (
        <div style={{ display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
          {shown.map((r, i) => {
            const brut = draft[r.player_id] ?? "";
            const parsed = parseMontant(brut);
            const illisible = brut.trim() !== "" && parsed === undefined;
            const v = parsed ?? null;
            // « Déjà saisi » se juge sur la BASE, pas sur le brouillon.
            const enBase = r.amount !== null;
            return (
              <label key={r.player_id}
                     style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px",
                              borderRadius: 8, background: "#0B0D12",
                              border: `1px solid ${illisible ? "rgba(239,68,68,0.5)" : "rgba(255,255,255,0.06)"}` }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "#E8E8EE",
                               overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.name}
                  <span style={{ color: "#555568", marginLeft: 6, fontSize: 10 }}>{r.action_pct} %</span>
                </span>
                {enBase && !r.bankroll_locked && (
                  <span style={{ fontSize: 10, color: "#555568" }} title="Montant actuellement en base">
                    {fmt(r.amount!)}
                  </span>
                )}
                {r.bankroll_locked && (
                  <span style={{ fontSize: 10, color: "#22D3EE" }} title="Calculé depuis la bankroll — se corrige en déverrouillant le règlement BR">
                    BR
                  </span>
                )}
                <input
                  ref={el => { inputs.current[i] = el; }}
                  value={brut} inputMode="decimal"
                  placeholder={r.bankroll_locked ? "—" : "non saisi"}
                  readOnly={r.bankroll_locked}
                  title={r.bankroll_locked
                    ? "Semaine calculée depuis la bankroll. Pour la corriger, déverrouille le règlement BR dans la vue détail du joueur."
                    : undefined}
                  onKeyDown={e => onKey(e, i)}
                  onChange={e => setDraft({ ...draft, [r.player_id]: e.target.value })}
                  style={{ ...INPUT, width: 92, textAlign: "right",
                           opacity: r.bankroll_locked ? 0.55 : 1,
                           cursor: r.bankroll_locked ? "not-allowed" : "text",
                           color: r.bankroll_locked ? "#22D3EE"
                                : illisible ? "#F87171" : v !== null && v < 0 ? "#F87171" : "#E8E8EE" }}
                />
              </label>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        <button disabled={busy || loading || shown.length === 0 || !isMonday(week)} onClick={() => void saveAll()}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#A78BFA",
                         color: "#0B0D12", fontSize: 12, fontWeight: 700, cursor: "pointer",
                         opacity: busy || loading ? 0.6 : 1 }}>
          {busy ? "Enregistrement…" : "Enregistrer la semaine"}
        </button>
        {msg && (
          <span style={{ fontSize: 11.5, color: msg.kind === "ok" ? "#34D399" : "#F87171" }}>
            {msg.kind === "ok" ? "✅ " : "❌ "}{msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
