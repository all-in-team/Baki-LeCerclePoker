"use client";

// Règlement du RAKEBACK d'un joueur — panneau de la vue détail.
//
// AUCUNE MATH ICI (invariant #2). L'écran envoie une BORNE de semaine, jamais un
// montant : le total affiché n'est qu'un aperçu, et c'est le moteur qui recalcule
// au verrouillage. Si le report a changé depuis l'affichage, c'est le calcul qui
// gagne — même règle que le règlement de la part d'action.
//
// CE QUI SE VOIT AVANT LE CLIC, PAS APRÈS. Deux mécanismes distincts :
//   • le PLAFOND — une semaine en échec de contrôle arrête la plage, et l'écran dit
//     laquelle et pourquoi. Ce n'est pas négociable : régler au-delà ferait
//     disparaître son déficit pour toujours. Il se rend AVANT le retour anticipé
//     « aucune semaine ouverte » : quand la première semaine est bloquée, il n'y a
//     rien à proposer ET il y a tout à expliquer. Annoncer « tout est réglé » dans
//     ce cas est un mensonge chiffrable — 400 USDT invisibles sur le cas mesuré.
//     Le plafond porte aussi sa propre sortie : « acter à 0 », confirmé en retapant
//     la date de la semaine, parce qu'un OK se clique sans lire.
//   • les AVERTISSEMENTS du moteur (makeup reporté sur une autre assiette, makeup
//     abandonné) — ils n'empêchent pas de régler mais changent ce qui est payé,
//     donc ils exigent une confirmation. Le serveur refuse de son côté : décocher
//     la case ici ne suffit pas à passer outre.
//
// La colonne « Reliquat » montre le déficit qui SURVIT au règlement. Régler paie,
// ça ne solde pas — et il ne faut pas croire l'inverse au moment de cliquer.

import { useCallback, useEffect, useState } from "react";

type Week = {
  week_start: string; basis: string; rakeback_pct: number;
  base: number; makeup_in: number; base_net: number; due: number; makeup_out: number;
};
type Warning = { code: string; message: string };
type BlockingDetail = {
  week_start: string; check_delta: number; override_reason: string | null;
  base: number; rakeback_pct: number; makeup_in: number;
};

const CARD: React.CSSProperties = {
  background: "#12141C", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, padding: 14,
};
const INPUT: React.CSSProperties = {
  background: "#0B0D12", border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8, color: "#E8E8EE", padding: "6px 8px", fontSize: 12,
};
const fmt = (n: number) =>
  n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const BASIS_LABEL: Record<string, string> = {
  gross_rake: "rake brut", affiliate_commission: "commission",
};

export default function RakebackSettlePanel({ playerId, playerName, onSettled }: {
  playerId: number;
  playerName: string;
  onSettled: () => void;
}) {
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [through, setThrough] = useState<string>("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  /** Semaine en échec qui PLAFONNE la plage — l'écran doit dire pourquoi il s'arrête. */
  const [blocking, setBlocking] = useState<string | null>(null);
  const [blockingDetail, setBlockingDetail] = useState<BlockingDetail | null>(null);
  /** Saisie de la confirmation « acter à 0 » : la date de la semaine, retapée. */
  const [ackWeekInput, setAckWeekInput] = useState("");
  const [ackOpen, setAckOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setMsg(null); setAck(false);
    setAckOpen(false); setAckWeekInput("");
    try {
      const j = await (await fetch(`/api/nexapoker/settle-rakeback?player_id=${playerId}`)).json();
      if (!j.ok) { setMsg({ kind: "err", text: j.error ?? "Chargement impossible." }); return; }
      setWeeks(j.weeks); setWarnings(j.warnings ?? []); setBlocking(j.blocking_week ?? null);
      setBlockingDetail(j.blocking_detail ?? null);
      // Par défaut on propose de solder TOUT l'ouvert : c'est le geste courant.
      setThrough(j.weeks.length > 0 ? j.weeks[j.weeks.length - 1].week_start : "");
    } finally { setLoading(false); }
  }, [playerId]);

  useEffect(() => { void load(); }, [load]);

  // La plage est CONTIGUË depuis la première semaine ouverte : le makeup se chaîne,
  // on ne règle pas en sautant des semaines. L'écran ne propose donc qu'une borne
  // de fin, jamais une sélection éparse.
  const couvertes = weeks.filter(w => w.week_start <= through);
  const apercu = couvertes.reduce((s, w) => s + w.due, 0);
  const makeupConsomme = couvertes.reduce((s, w) => s + w.makeup_in, 0);

  async function lock() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/nexapoker/settle-rakeback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_id: playerId, through_week: through, acknowledge_warnings: ack }),
      });
      const j = await res.json().catch(() => null);
      if (!j?.ok) {
        if (j?.warnings?.length) setWarnings(j.warnings);
        setMsg({ kind: "err", text: j?.error ?? `Échec (HTTP ${res.status}).` });
        return;
      }
      setMsg({ kind: "ok", text: `Règlement #${j.settlement_id} verrouillé — ${fmt(j.amount_due_usdt)} USDT `
                                + `sur ${j.weeks.length} semaine(s). La ligne est dans /payments.` });
      await load();
      onSettled();
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? String(e) });
    } finally { setBusy(false); }
  }

  /** Acter à 0 la semaine qui plafonne — irréversible, d'où la date retapée. */
  async function ackBlockedWeek() {
    if (!blocking) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/nexapoker/settle-rakeback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ack_blocked_week", player_id: playerId,
          week_start: blocking, confirm_week: ackWeekInput.trim(),
        }),
      });
      const j = await res.json().catch(() => null);
      if (!j?.ok) {
        setMsg({ kind: "err", text: j?.error ?? `Échec (HTTP ${res.status}).` });
        return;
      }
      setMsg({ kind: "ok", text: `Écart de la semaine ${j.week_start} acté à 0 (règlement #${j.settlement_id}, `
                                + `visible dans l'historique). La plage reprend après cette semaine.` });
      await load();
      onSettled();
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message ?? String(e) });
    } finally { setBusy(false); }
  }

  if (loading) return <div style={{ ...CARD, fontSize: 12, color: "#8888A0" }}>Rakeback — chargement…</div>;

  // LE PLAFOND SE VOIT MÊME QUAND IL NE RESTE RIEN À PROPOSER.
  //
  // Ce bloc était rendu APRÈS le retour anticipé « aucune semaine ouverte » : quand
  // la toute première semaine était bloquée, l'écran annonçait « tout ce qui était
  // calculable est réglé » alors que les semaines suivantes portaient un dû bien
  // réel — 400 USDT sur le cas mesuré par l'audit, rendus invisibles par un message
  // qui affirmait le contraire. Le plafond se rend donc en premier, toujours.
  const bandeauPlafond = blocking && (
    <div style={{ border: "1px solid rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.06)",
                  borderRadius: 10, padding: 10, marginBottom: 10, fontSize: 11.5, color: "#F87171" }}>
      ⛔ La plage s&apos;arrête avant le <b>{blocking}</b> : le recalcul de cette semaine ne retombe
      pas sur le report{blockingDetail ? ` (écart ${fmt(blockingDetail.check_delta)}, tolérance ±0,02)` : ""}.
      On ne règle pas au-delà — son déficit serait absorbé par des semaines déjà payées.
      {blockingDetail?.override_reason && (
        <div style={{ marginTop: 6, color: "#FCA5A5" }}>
          Motif saisi sur le report : « {blockingDetail.override_reason} »
        </div>
      )}
      <div style={{ marginTop: 6, color: "#FCA5A5" }}>
        <b>Un motif d&apos;écart ne rouvre PAS la plage</b> — le contrôle est calculé sur le seul
        écart chiffré. Deux sorties, et seulement deux : corriger le report pour que le recalcul
        revienne dans ±0,02, ou acter cet écart à 0 ci-dessous.
      </div>

      {!ackOpen ? (
        <button onClick={() => setAckOpen(true)} disabled={busy}
                style={{ ...INPUT, marginTop: 8, cursor: "pointer", borderColor: "rgba(239,68,68,0.5)", color: "#F87171" }}>
          Acter cet écart à 0 et débloquer la suite…
        </button>
      ) : (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(239,68,68,0.25)" }}>
          <div style={{ color: "#FCA5A5", marginBottom: 6 }}>
            ⚠️ <b>Irréversible.</b> Le rakeback de la semaine {blocking}
            {blockingDetail ? ` (rake brut ${fmt(blockingDetail.base)} · taux ${blockingDetail.rakeback_pct} %)` : ""}
            {" "}ne sera plus jamais réglable, même si le report est corrigé plus tard.
            L&apos;acte est enregistré dans l&apos;historique des règlements du joueur, avec l&apos;écart et le motif.
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "#FCA5A5" }}>Retape la date de la semaine pour confirmer :</span>
            <input value={ackWeekInput} onChange={e => setAckWeekInput(e.target.value)}
                   placeholder={blocking} style={{ ...INPUT, width: 120 }} />
            <button onClick={() => void ackBlockedWeek()}
                    disabled={busy || ackWeekInput.trim() !== blocking}
                    style={{ ...INPUT, cursor: ackWeekInput.trim() === blocking ? "pointer" : "not-allowed",
                             opacity: ackWeekInput.trim() === blocking ? 1 : 0.45,
                             borderColor: "rgba(239,68,68,0.5)", color: "#F87171" }}>
              {busy ? "…" : "Acter à 0"}
            </button>
            <button onClick={() => { setAckOpen(false); setAckWeekInput(""); }} disabled={busy}
                    style={{ ...INPUT, cursor: "pointer" }}>Annuler</button>
          </div>
        </div>
      )}
    </div>
  );

  const bandeauMessage = msg && (
    <div style={{ fontSize: 11.5, marginTop: 8, color: msg.kind === "ok" ? "#34D399" : "#F87171" }}>
      {msg.kind === "ok" ? "✅ " : "❌ "}{msg.text}
    </div>
  );

  if (weeks.length === 0) {
    return (
      <div style={{ ...CARD, ...(blocking ? { borderColor: "rgba(239,68,68,0.35)" } : {}) }}>
        {bandeauPlafond}
        <div style={{ fontSize: 12, color: "#8888A0" }}>
          {blocking
            ? <>Rakeback — <b>aucune semaine réglable pour {playerName} tant que le {blocking} plafonne</b>.
                Ce n&apos;est pas « tout est réglé » : les semaines suivantes ne sont simplement pas
                proposées.</>
            : <>Rakeback — aucune semaine ouverte pour {playerName}. Tout ce qui était calculable est réglé.</>}
        </div>
        {bandeauMessage}
      </div>
    );
  }

  return (
    <div style={{ ...CARD, borderColor: "rgba(167,139,250,0.35)" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#E8E8EE", marginBottom: 4 }}>
        Régler le rakeback — {playerName}
      </div>
      <div style={{ fontSize: 11.5, color: "#8888A0", marginBottom: 10 }}>
        Le rakeback est de l&apos;argent qui <b>sort</b> : positif = à verser au joueur.
        La plage part forcément de la plus ancienne semaine non réglée ({weeks[0].week_start}) —
        le makeup se chaîne d&apos;une semaine à l&apos;autre, on ne règle pas en sautant.
        Régler <b>paie</b> ce qui est dû, sans effacer le déficit restant : le makeup non
        récupéré continue de courir sur les semaines suivantes, et aucun montant à venir
        n&apos;est modifié par ce règlement.
      </div>

      {bandeauPlafond}

      {warnings.length > 0 && (
        <div style={{ border: "1px solid rgba(240,185,11,0.4)", background: "rgba(240,185,11,0.06)",
                      borderRadius: 10, padding: 10, marginBottom: 10 }}>
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 11.5, color: "#F0B90B", marginBottom: 6 }}>⚠️ {w.message}</div>
          ))}
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11.5, color: "#E8E8EE", cursor: "pointer" }}>
            <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
            J&apos;ai vu ces avertissements et je règle quand même.
          </label>
        </div>
      )}

      <div style={{ overflowX: "auto", marginBottom: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
          <thead><tr>
            {["Semaine", "Assiette", "Taux", "Base", "Makeup entrant", "Base nette", "Dû", "Reliquat"].map((h, i) => (
              <th key={h} style={{ textAlign: i === 0 || i === 1 ? "left" : "right", fontSize: 10.5,
                                   color: "#555568", fontWeight: 700, padding: "6px 7px", whiteSpace: "nowrap" }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {weeks.map(w => {
              const dedans = w.week_start <= through;
              return (
                <tr key={w.week_start} style={{ borderTop: "1px solid rgba(255,255,255,0.05)",
                                                opacity: dedans ? 1 : 0.35 }}>
                  <td style={{ fontSize: 12, color: "#E8E8EE", padding: "6px 7px", fontWeight: 600 }}>{w.week_start}</td>
                  <td style={{ fontSize: 11, color: "#8888A0", padding: "6px 7px" }}>{BASIS_LABEL[w.basis] ?? w.basis}</td>
                  <td style={{ fontSize: 12, color: "#8888A0", padding: "6px 7px", textAlign: "right" }}>{w.rakeback_pct} %</td>
                  <td style={{ fontSize: 12, color: "#E8E8EE", padding: "6px 7px", textAlign: "right" }}>{fmt(w.base)}</td>
                  <td style={{ fontSize: 12, padding: "6px 7px", textAlign: "right",
                               color: w.makeup_in < -0.005 ? "#F0B90B" : "#555568" }}>
                    {w.makeup_in < -0.005 ? fmt(w.makeup_in) : "—"}
                  </td>
                  <td style={{ fontSize: 12, color: "#8888A0", padding: "6px 7px", textAlign: "right" }}>{fmt(w.base_net)}</td>
                  <td style={{ fontSize: 12, padding: "6px 7px", textAlign: "right", fontWeight: 600,
                               color: w.due > 0.005 ? "#A78BFA" : "#555568" }}>
                    {w.due > 0.005 ? fmt(w.due) : "—"}
                  </td>
                  {/* Reliquat : ce que la semaine laisse à récupérer. Il SURVIT au
                      règlement — l'afficher évite de croire qu'on solde tout. */}
                  <td style={{ fontSize: 12, padding: "6px 7px", textAlign: "right",
                               color: w.makeup_out < -0.005 ? "#F0B90B" : "#555568" }}
                      title="Déficit restant, reporté sur les semaines suivantes — le règlement ne l'efface pas">
                    {w.makeup_out < -0.005 ? fmt(w.makeup_out) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: "#8888A0", display: "flex", gap: 6, alignItems: "center" }}>
          Régler jusqu&apos;à
          <select value={through} onChange={e => setThrough(e.target.value)} style={{ ...INPUT, cursor: "pointer" }}>
            {weeks.map(w => <option key={w.week_start} value={w.week_start}>{w.week_start}</option>)}
          </select>
        </label>
        <span style={{ fontSize: 12, color: "#8888A0" }}>
          {couvertes.length} semaine(s) ·{" "}
          <b style={{ color: apercu > 0.005 ? "#A78BFA" : "#555568", fontSize: 14 }}>{fmt(apercu)} USDT</b>
          {makeupConsomme < -0.005 && (
            <span style={{ color: "#F0B90B" }}> · makeup consommé {fmt(makeupConsomme)}</span>
          )}
        </span>
        <button disabled={busy || through === "" || (warnings.length > 0 && !ack)}
                onClick={() => void lock()}
                title={warnings.length > 0 && !ack ? "Confirme d'abord les avertissements" : undefined}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#A78BFA",
                         color: "#0B0D12", fontSize: 12, fontWeight: 700, cursor: "pointer",
                         opacity: busy || (warnings.length > 0 && !ack) ? 0.5 : 1 }}>
          {busy ? "Verrouillage…" : "Verrouiller le règlement"}
        </button>
      </div>

      <div style={{ fontSize: 11, color: "#555568", marginTop: 8 }}>
        Ce montant est un <b>aperçu</b>. Le montant réglé est recalculé par le moteur au
        verrouillage, et les paramètres appliqués (taux, assiette, makeup consommé) sont figés
        sur la ligne de règlement — c&apos;est ce qui permettra de dire plus tard pourquoi ce
        montant-là a été payé ce jour-là.
      </div>

      {bandeauMessage}
    </div>
  );
}
