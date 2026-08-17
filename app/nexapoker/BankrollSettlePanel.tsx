"use client";

// Règlement hebdomadaire sur BANKROLL — panneau de la vue détail d'un joueur staké.
//
// AUCUNE MATH ICI (invariant #2). Le résultat, ma part, le versement et la BR de
// départ suivante sont TOUS calculés par le serveur, par la fonction même qui
// verrouille (previewBankrollWeekOn). Recalculer côté client pour « éviter un
// aller-retour » fabriquerait un second chiffre pour la même semaine — c'est
// exactement ce que ce chantier existe pour empêcher. Ce composant lit un
// montant, l'envoie, et affiche ce qu'on lui répond.
//
// LA PHOTO NE FAIT QUE PRÉ-REMPLIR. L'extraction écrit dans le champ « BR de
// fin », qui reste modifiable, et c'est le champ — relu par Hugo — qui part au
// verrouillage. Une photo illisible n'est pas une panne : le champ s'ouvre, on
// tape. Plusieurs photos à la suite ne posent donc aucun problème.
//
// RIEN N'EST ENREGISTRÉ AVANT « RÉGLER ». Pas de brouillon en base : une ligne
// brouillon serait une seconde copie mutable des chiffres de la semaine.

import { useCallback, useEffect, useRef, useState } from "react";

const CARD: React.CSSProperties = {
  background: "#12141C", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, padding: 18,
};
const INPUT: React.CSSProperties = {
  background: "#0B0D12", border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8, color: "#E8E8EE", padding: "6px 8px", fontSize: 12,
};

const fmt = (n: number) =>
  n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Positif = le joueur me doit · négatif = je lui dois. Convention du repo. */
const netColor = (n: number) => (Math.abs(n) < 0.005 ? "#8888A0" : n > 0 ? "#34D399" : "#F87171");

function isMonday(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.getUTCDay() === 1;
}

/**
 * Lundi de la semaine PASSÉE — celle qu'on clôture le lundi matin.
 * Tout en calendrier UTC : mélanger getUTCDay() avec une date locale décale
 * d'une semaine entière entre minuit et 2 h à Paris. Même calcul que WinlossGrid.
 */
function lastMonday(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7);
  return d.toISOString().slice(0, 10);
}

/**
 * Parse STRICT d'un montant saisi — repris tel quel de WinlossGrid.
 *
 * parseFloat seul est un piège de saisie d'argent : il s'arrête au premier
 * caractère invalide et rend un nombre d'apparence valide. « 1 234,56 » collé
 * depuis un tableur devient 1. Ici on nettoie les séparateurs de milliers, on
 * ramène la virgule sur le point, puis on EXIGE que toute la chaîne soit un nombre.
 */
export function parseMontant(raw: string): number | undefined {
  const t = raw.trim().replace(/[\s  ']/g, "").replace(",", ".");
  if (t === "") return undefined;
  if (!/^[+-]?\d*\.?\d+$/.test(t)) return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}

type Movement = { id: number; type: "deposit" | "withdrawal"; amount: number; tx_date: string; note: string | null };

type Computed = {
  result: number; action_amount: number; transfer_amount: number;
  /** BR de départ de la semaine suivante — la BR de fin, sans report. */
  next_br_open: number;
  /** Sa bankroll une fois le versement reçu. Affichage seulement. */
  br_after_transfer: number;
};

type Preview = {
  player_id: number; player_name: string; week_start: string; week_end: string;
  action_pct: number;
  br_open: number | null; br_open_source: "carry" | "manual"; carried_from: string | null;
  deposits: number; cashouts: number; movements: Movement[];
  blockers: string[]; computed: Computed | null;
};

type HistoryRow = {
  id: number; week_start: string; br_open: number; br_open_source: "carry" | "manual";
  br_close: number; deposits: number; cashouts: number; result: number;
  action_pct: number; action_amount: number;
  transfer_movement_id: number | null; settlement_id: number | null; locked_at: string;
};

export default function BankrollSettlePanel({ playerId, playerName, onSettled }: {
  playerId: number; playerName: string; onSettled?: () => void;
}) {
  const [week, setWeek] = useState(lastMonday);
  const [brClose, setBrClose] = useState("");
  const [brOpenManual, setBrOpenManual] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  const [extracting, setExtracting] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const closeParsed = parseMontant(brClose);
  const closeIllisible = brClose.trim() !== "" && closeParsed === undefined;
  const openParsed = parseMontant(brOpenManual);
  const openIllisible = brOpenManual.trim() !== "" && openParsed === undefined;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ player_id: String(playerId), week_start: week });
      if (closeParsed !== undefined) q.set("br_close", String(closeParsed));
      if (openParsed !== undefined) q.set("br_open", String(openParsed));
      const j = await (await fetch(`/api/nexapoker/bankroll?${q}`)).json();
      if (!j.ok) { setMsg({ kind: "err", text: j.error ?? "Chargement impossible." }); setPreview(null); return; }
      setHistory(j.history ?? []);
      setPreview(j.preview ?? null);
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? "Réseau injoignable." });
    } finally { setLoading(false); }
  }, [playerId, week, closeParsed, openParsed]);

  // Débounce : la BR se tape chiffre par chiffre, un aller-retour par frappe
  // n'apporterait rien et ferait clignoter le calcul.
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 250);
    return () => clearTimeout(t);
  }, [load]);

  /** La semaine proposée par défaut suit la chaîne : celle qui suit la dernière figée. */
  useEffect(() => {
    if (history.length === 0) return;
    const last = history[history.length - 1];
    const d = new Date(`${last.week_start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    const next = d.toISOString().slice(0, 10);
    setWeek(w => (history.some(h => h.week_start === w) ? next : w));
  }, [history]);

  async function onPhoto(file: File) {
    setExtracting(true); setMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/nexa/bankroll/extract", { method: "POST", body: fd });
      const j = await res.json().catch(() => null);
      if (!res.ok) { setMsg({ kind: "err", text: j?.error ?? `Extraction indisponible (HTTP ${res.status}).` }); return; }
      if (!j?.ok) {
        // Cas NOMINAL, pas une panne : le modèle n'a pas su lire. On le dit et on
        // laisse le champ ouvert plutôt que d'écrire un chiffre deviné.
        setMsg({ kind: "info", text: `${j?.error ?? "Montant non lu"} — saisis la BR à la main.` });
        return;
      }
      setBrClose(String(j.bankroll));
      setMsg({
        kind: "ok",
        text: `Lu sur la photo : ${fmt(j.bankroll)}${j.label_seen ? ` (champ « ${j.label_seen} »)` : ""}. `
            + `Relis-le avant de régler.`,
      });
    } finally {
      setExtracting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function settle() {
    if (closeParsed === undefined) { setMsg({ kind: "err", text: "BR de fin manquante ou illisible." }); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/nexapoker/bankroll", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          player_id: playerId, week_start: week, br_close: closeParsed,
          // La BR de début n'est envoyée que si elle est saisie : sur une semaine
          // reprise, le serveur la recalcule et ignore ce champ.
          br_open: openParsed,
        }),
      });
      const j = await res.json().catch(() => null);
      if (!j?.ok) { setMsg({ kind: "err", text: j?.error ?? `Échec (HTTP ${res.status}).` }); return; }
      const c = j.computed as Computed;
      setMsg({
        kind: "ok",
        text: `Semaine ${week} figée — résultat ${fmt(c.result)}, ma part ${fmt(c.action_amount)}`
            + `${c.transfer_amount > 0 ? `, ${fmt(c.transfer_amount)} à lui verser (marque le règlement payé dans /payments une fois envoyé)` : ""}`
            + `. Il repart de ${fmt(c.next_br_open)}`
            + `${c.transfer_amount > 0 ? ` (${fmt(c.br_after_transfer)} une fois ton versement reçu)` : ""}.`,
      });
      setBrClose(""); setBrOpenManual("");
      await load();
      onSettled?.();
    } finally { setBusy(false); }
  }

  async function unlock(weekStart: string) {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api/nexapoker/bankroll?player_id=${playerId}&week_start=${weekStart}`,
                              { method: "DELETE" });
      const j = await res.json().catch(() => null);
      if (!j?.ok) { setMsg({ kind: "err", text: j?.error ?? `Échec (HTTP ${res.status}).` }); return; }
      setMsg({ kind: "ok", text: `Semaine ${weekStart} déverrouillée — règlement, versement et win/loss retirés.` });
      setWeek(weekStart);
      await load();
      onSettled?.();
    } finally { setBusy(false); }
  }

  const p = preview;
  const c = p?.computed ?? null;
  const bloque = (p?.blockers.length ?? 0) > 0;
  const besoinBrOpen = p !== null && p.br_open === null;
  const last = history.length > 0 ? history[history.length - 1] : null;

  return (
    <div style={{ ...CARD, borderColor: "rgba(34,211,238,0.35)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#E8E8EE" }}>
          💰 Règlement BR — {playerName}
        </div>
        <label style={{ fontSize: 12, color: "#8888A0", display: "flex", gap: 6, alignItems: "center" }}>
          Semaine du (lundi)
          <input type="date" value={week} disabled={busy}
                 style={{ ...INPUT, borderColor: isMonday(week) ? "rgba(255,255,255,0.1)" : "rgba(239,68,68,0.5)" }}
                 onChange={e => setWeek(e.target.value)} />
        </label>
        {p && <span style={{ fontSize: 11, color: "#555568" }}>au {p.week_end} · action {p.action_pct} %</span>}
        <div style={{ flex: 1 }} />
        {loading && <span style={{ fontSize: 11, color: "#555568" }}>…</span>}
      </div>

      <div style={{ fontSize: 12, color: "#8888A0", marginBottom: 12 }}>
        Résultat = (BR de fin + cash-outs) − (BR de début + dépôts). Les dépôts et cash-outs
        sont <b>repris des mouvements</b> déjà saisis, jamais re-tapés ici. Le montant réglé est
        <b> recalculé au verrouillage</b> : si un buy-in arrive après l&apos;affichage, c&apos;est le calcul qui gagne.
      </div>

      {bloque && (
        <div style={{ border: "1px solid rgba(240,185,11,0.4)", background: "rgba(240,185,11,0.06)",
                      borderRadius: 10, padding: 10, marginBottom: 12 }}>
          {p!.blockers.map((b, i) => (
            <div key={i} style={{ fontSize: 11.5, color: "#F0B90B", marginBottom: i < p!.blockers.length - 1 ? 6 : 0 }}>
              ⚠️ {b}
            </div>
          ))}
        </div>
      )}

      {p && !bloque && (
        <>
          {/* ── Les entrées du calcul ── */}
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", marginBottom: 12 }}>
            {/* BR de début : reprise, ou saisie pour la toute première semaine. */}
            <div style={{ padding: "8px 10px", borderRadius: 8, background: "#0B0D12",
                          border: `1px solid ${besoinBrOpen ? "rgba(240,185,11,0.5)" : "rgba(255,255,255,0.06)"}` }}>
              <div style={{ fontSize: 10.5, color: "#8888A0", marginBottom: 4 }}>
                BR de début
                {p.br_open_source === "carry" && p.carried_from && (
                  <span style={{ color: "#22D3EE", marginLeft: 6 }}>reprise de {p.carried_from}</span>
                )}
              </div>
              {p.br_open_source === "carry" && p.br_open !== null ? (
                <div style={{ fontSize: 15, fontWeight: 700, color: "#E8E8EE" }}>{fmt(p.br_open)}</div>
              ) : (
                <>
                  <input value={brOpenManual} inputMode="decimal" placeholder="à saisir"
                         onChange={e => setBrOpenManual(e.target.value)} disabled={busy}
                         style={{ ...INPUT, width: "100%", fontSize: 14, fontWeight: 700,
                                  borderColor: openIllisible ? "rgba(239,68,68,0.5)" : "rgba(255,255,255,0.1)",
                                  color: openIllisible ? "#F87171" : "#E8E8EE" }} />
                  <div style={{ fontSize: 10, color: "#F0B90B", marginTop: 4 }}>
                    Première semaine : elle n&apos;est pas supposée à 0.
                  </div>
                </>
              )}
            </div>

            <div style={{ padding: "8px 10px", borderRadius: 8, background: "#0B0D12", border: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ fontSize: 10.5, color: "#8888A0", marginBottom: 4 }}>Dépôts de la semaine</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#F0B90B" }}>{fmt(p.deposits)}</div>
            </div>

            <div style={{ padding: "8px 10px", borderRadius: 8, background: "#0B0D12", border: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ fontSize: 10.5, color: "#8888A0", marginBottom: 4 }}>Cash-outs de la semaine</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#34D399" }}>{fmt(p.cashouts)}</div>
            </div>

            {/* BR de fin : le seul champ vraiment saisi. */}
            <div style={{ padding: "8px 10px", borderRadius: 8, background: "#0B0D12",
                          border: `1px solid ${closeIllisible ? "rgba(239,68,68,0.5)" : "rgba(34,211,238,0.35)"}` }}>
              <div style={{ fontSize: 10.5, color: "#8888A0", marginBottom: 4 }}>BR de fin (photo)</div>
              <input value={brClose} inputMode="decimal" placeholder="non saisie"
                     onChange={e => setBrClose(e.target.value)} disabled={busy}
                     style={{ ...INPUT, width: "100%", fontSize: 14, fontWeight: 700,
                              borderColor: "transparent",
                              color: closeIllisible ? "#F87171" : "#E8E8EE" }} />
            </div>
          </div>

          {/* ── La photo ── */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif"
                   disabled={busy || extracting} style={{ display: "none" }}
                   onChange={e => { const f = e.target.files?.[0]; if (f) void onPhoto(f); }} />
            <button type="button" disabled={busy || extracting} onClick={() => fileRef.current?.click()}
                    style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid rgba(34,211,238,0.35)",
                             background: "transparent", color: "#22D3EE", fontSize: 11.5, cursor: "pointer" }}>
              {extracting ? "Lecture de la photo…" : "📷 Déposer la photo de BR"}
            </button>
            <span style={{ fontSize: 11, color: "#555568" }}>
              L&apos;extraction ne fait que pré-remplir le champ — rien n&apos;est enregistré, et le chiffre reste modifiable.
            </span>
          </div>

          {/* ── Les mouvements retenus ── */}
          {p.movements.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#8888A0", marginBottom: 6 }}>
                Mouvements de la semaine repris dans le calcul :
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {p.movements.map(m => (
                  <span key={m.id} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6,
                                            background: "#0B0D12", border: "1px solid rgba(255,255,255,0.06)",
                                            color: m.type === "deposit" ? "#F0B90B" : "#34D399" }}>
                    {m.tx_date} · {m.type === "deposit" ? "buy-in" : "cash-out"} {fmt(m.amount)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* ── Le calcul, rendu par le serveur ── */}
          {c && (
            <div style={{ border: "1px solid rgba(34,211,238,0.35)", background: "rgba(34,211,238,0.04)",
                          borderRadius: 10, padding: 12, marginBottom: 12 }}>
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap", fontSize: 12, color: "#8888A0" }}>
                <span>Résultat de la semaine{" "}
                  <b style={{ color: netColor(c.result), fontSize: 15 }}>{fmt(c.result)}</b>
                </span>
                <span>Ma part ({p.action_pct} %){" "}
                  <b style={{ color: netColor(c.action_amount), fontSize: 15 }}>{fmt(c.action_amount)}</b>
                </span>
                <span style={{ color: "#E8E8EE" }}>
                  {c.transfer_amount > 0
                    ? <>À lui envoyer <b style={{ color: "#F87171", fontSize: 15 }}>{fmt(c.transfer_amount)}</b></>
                    : Math.abs(c.action_amount) < 0.005
                      ? <>Rien à échanger</>
                      : <>À recevoir <b style={{ color: "#34D399", fontSize: 15 }}>{fmt(c.action_amount)}</b></>}
                </span>
                {/* La BR de départ de la semaine suivante est la BR de FIN, sans
                    report du versement : celui-ci comptera comme un dépôt à sa
                    date de paiement réelle. L'ajouter ici supposerait qu'il a eu
                    lieu, et fabriquerait une seconde dette s'il traîne. Sa BR
                    « une fois payé » est montrée à côté, comme une description. */}
                <span>Nouvelle BR de départ{" "}
                  <b style={{ color: "#22D3EE", fontSize: 15 }}>{fmt(c.next_br_open)}</b>
                  {c.transfer_amount > 0 && (
                    <span style={{ color: "#555568" }}>
                      {" "}→ {fmt(c.br_after_transfer)} une fois ton versement reçu
                    </span>
                  )}
                </span>
              </div>

              {/* AUCUN mouvement n'est écrit ici, dans un sens ni dans l'autre. Le
                  règlement part en « à payer » dans /payments, et c'est le « marquer
                  payé » — quand l'argent a réellement bougé — qui crée le mouvement,
                  à la vraie date. L'écrire au verrouillage affirmerait un transfert
                  qui n'a pas eu lieu et fausserait la position nette jusqu'au
                  paiement. Les deux sens sont traités pareil, pour qu'aucun
                  encaissement n'ait à être saisi à la main — saisi en buy-in, il
                  serait compté comme un dépôt de bankroll et fausserait la semaine. */}
              {Math.abs(c.action_amount) >= 0.005 && (
                <div style={{ marginTop: 10, fontSize: 11.5, color: "#8888A0" }}>
                  Le verrouillage <b>n&apos;enregistre aucun mouvement</b> : il crée la ligne
                  « à {c.transfer_amount > 0 ? "payer" : "encaisser"} » dans /payments.
                  {c.transfer_amount > 0
                    ? <> Le versement de {fmt(c.transfer_amount)} apparaîtra dans l&apos;Historique
                        quand tu marqueras ce règlement <b>payé</b>, à la date réelle de l&apos;envoi.</>
                    : <> L&apos;encaissement de {fmt(c.action_amount)} apparaîtra dans l&apos;Historique
                        quand tu marqueras ce règlement <b>payé</b>. Ne le saisis pas à la main
                        en buy-in : il serait compté comme un dépôt de bankroll et fausserait la semaine.</>}
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button disabled={busy || !c || besoinBrOpen} onClick={() => void settle()}
                    style={{ padding: "8px 16px", borderRadius: 8, border: "none",
                             background: c && !besoinBrOpen ? "#22D3EE" : "#2A2D3A",
                             color: c && !besoinBrOpen ? "#0B0D12" : "#555568",
                             fontSize: 12, fontWeight: 700,
                             cursor: c && !besoinBrOpen ? "pointer" : "not-allowed" }}>
              {busy ? "Verrouillage…" : "Régler la semaine"}
            </button>
            {/* « BR inchangée » : le geste EXPLICITE pour une semaine sans photo où
                le joueur n'a pas joué. Il pré-remplit, il ne valide pas — c'est
                Hugo qui clique « régler » derrière. Un 0 automatique dirait
                « il a fini à l'équilibre » sans que personne ne l'ait constaté. */}
            {p.br_open !== null && (
              <button type="button" disabled={busy} onClick={() => setBrClose(String(p.br_open))}
                      style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)",
                               background: "transparent", color: "#8888A0", fontSize: 11.5, cursor: "pointer" }}>
                BR inchangée ({fmt(p.br_open)})
              </button>
            )}
            <span style={{ fontSize: 11, color: "#555568" }}>
              Une semaine réglée est figée : elle n&apos;est plus saisissable dans la grille win/loss.
              Elle reste déverrouillable <b>tant que son règlement n&apos;est pas marqué payé</b> —
              après, elle est définitivement incorrigible. Vérifie la BR avant de payer, pas après.
            </span>
          </div>
        </>
      )}

      {msg && (
        <div style={{ fontSize: 11.5, marginTop: 10,
                      color: msg.kind === "ok" ? "#34D399" : msg.kind === "info" ? "#F0B90B" : "#F87171" }}>
          {msg.kind === "ok" ? "✅ " : msg.kind === "info" ? "ℹ️ " : "❌ "}{msg.text}
        </div>
      )}

      {/* ── Historique — non modifiable, sauf la dernière semaine ── */}
      {history.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#E8E8EE", marginBottom: 8 }}>
            Semaines réglées
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
              <thead>
                <tr style={{ fontSize: 10.5, color: "#555568", textAlign: "right" }}>
                  <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Semaine</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>BR début</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Dépôts</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Cash-outs</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>BR fin</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Résultat</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>%</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Ma part</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}></th>
                </tr>
              </thead>
              <tbody>
                {[...history].reverse().map(h => {
                  const estDerniere = last !== null && h.week_start === last.week_start;
                  return (
                    <tr key={h.id} style={{ borderTop: "1px solid rgba(255,255,255,0.05)", fontSize: 11.5, textAlign: "right" }}>
                      <td style={{ textAlign: "left", padding: "5px 8px", color: "#E8E8EE" }}>
                        {h.week_start}
                        {h.br_open_source === "manual" && (
                          <span style={{ color: "#555568", marginLeft: 6, fontSize: 10 }}>1re</span>
                        )}
                      </td>
                      <td style={{ padding: "5px 8px", color: "#8888A0" }}>{fmt(h.br_open)}</td>
                      <td style={{ padding: "5px 8px", color: "#F0B90B" }}>{fmt(h.deposits)}</td>
                      <td style={{ padding: "5px 8px", color: "#34D399" }}>{fmt(h.cashouts)}</td>
                      <td style={{ padding: "5px 8px", color: "#E8E8EE" }}>{fmt(h.br_close)}</td>
                      <td style={{ padding: "5px 8px", color: netColor(h.result) }}>{fmt(h.result)}</td>
                      <td style={{ padding: "5px 8px", color: "#555568" }}>{h.action_pct}</td>
                      <td style={{ padding: "5px 8px", color: netColor(h.action_amount), fontWeight: 600 }}>
                        {fmt(h.action_amount)}
                      </td>
                      <td style={{ padding: "5px 8px" }}>
                        {/* Seule la DERNIÈRE se déverrouille : la BR de début des
                            semaines suivantes est reprise de celle-ci. */}
                        {estDerniere ? (
                          <button type="button" disabled={busy} onClick={() => void unlock(h.week_start)}
                                  style={{ padding: "3px 8px", borderRadius: 6, border: "1px solid rgba(239,68,68,0.35)",
                                           background: "transparent", color: "#F87171", fontSize: 10.5, cursor: "pointer" }}>
                            déverrouiller
                          </button>
                        ) : (
                          <span style={{ fontSize: 10.5, color: "#555568" }} title="La chaîne des BR se remonte dans l'ordre">
                            figée
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 10.5, color: "#555568", marginTop: 6 }}>
            Une semaine figée n&apos;est plus modifiable. Seule la dernière se déverrouille — la BR de
            début de la suivante est reprise d&apos;elle, la déverrouiller invaliderait tout l&apos;aval.
            Un règlement déjà marqué payé dans /payments ne se déverrouille pas du tout.
          </div>
        </div>
      )}
    </div>
  );
}
