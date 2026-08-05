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
//     disparaître son déficit pour toujours.
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

  const load = useCallback(async () => {
    setLoading(true); setMsg(null); setAck(false);
    try {
      const j = await (await fetch(`/api/nexapoker/settle-rakeback?player_id=${playerId}`)).json();
      if (!j.ok) { setMsg({ kind: "err", text: j.error ?? "Chargement impossible." }); return; }
      setWeeks(j.weeks); setWarnings(j.warnings ?? []); setBlocking(j.blocking_week ?? null);
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

  if (loading) return <div style={{ ...CARD, fontSize: 12, color: "#8888A0" }}>Rakeback — chargement…</div>;

  if (weeks.length === 0) {
    return (
      <div style={{ ...CARD, fontSize: 12, color: "#8888A0" }}>
        Rakeback — aucune semaine ouverte pour {playerName}. Tout ce qui était calculable est réglé.
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

      {blocking && (
        <div style={{ border: "1px solid rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.06)",
                      borderRadius: 10, padding: 10, marginBottom: 10, fontSize: 11.5, color: "#F87171" }}>
          ⛔ La plage s&apos;arrête avant le <b>{blocking}</b> : le contrôle de cette semaine a échoué.
          On ne règle pas au-delà — son déficit serait absorbé par des semaines déjà payées et
          ne pourrait plus jamais être récupéré, même en corrigeant la semaine ensuite.
          Corrige le <b>{blocking}</b> pour débloquer la suite.
        </div>
      )}

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

      {msg && (
        <div style={{ fontSize: 11.5, marginTop: 8, color: msg.kind === "ok" ? "#34D399" : "#F87171" }}>
          {msg.kind === "ok" ? "✅ " : "❌ "}{msg.text}
        </div>
      )}
    </div>
  );
}
