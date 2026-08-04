"use client";

// File d'arbitrage des groupes (incident Alexis 2026-08-04).
//
// Chaque ligne = un moment où le système a REFUSÉ de décider seul : le contact ressemble
// à quelqu'un qui a déjà un groupe, mais la ressemblance ne tient qu'à un @handle ou à un
// nom. Fusionner à tort mélangerait les conversations de deux joueurs — donc rien n'a été
// créé, rien n'a été lié, et la décision revient à Hugo.
//
// Cette page ne fait AUCUNE action Telegram : elle montre le contexte et archive la
// décision. Le rattachement réel passe par `/linkgroup` dans le groupe concerné, la
// création par le bouton du funnel une fois l'identité corrigée.

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { GroupReviewCase } from "@/lib/queries/group-cases";
import { FUNNEL_CARD } from "@/components/funnel/styles";
import { fmtDateTime } from "@/lib/funnels/shared";
import { resolveCaseAction } from "./actions";

const KIND_LABEL: Record<GroupReviewCase["kind"], string> = {
  ambiguous_match: "Rapprochement non prouvé",
  no_tg_user_id: "Pas de compte Telegram identifié",
};

const SOURCE_LABEL: Record<string, string> = {
  affiliate_lead: "parrainage affilié (clé = handle)",
  player_no_tg: "joueur sans telegram_id (groupe lié à la main)",
  registry_no_owner: "groupe au registre sans propriétaire Telegram",
};

export default function GroupCasesClient({ cases }: { cases: GroupReviewCase[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const open = cases.filter((c) => c.status === "open");
  const closed = cases.filter((c) => c.status !== "open");

  async function resolve(c: GroupReviewCase, dismissed: boolean) {
    const label = dismissed ? "Ignoré" : "Traité";
    const note = window.prompt(`${label} — note (ce que tu as fait, pour la trace) :`, dismissed ? "faux positif" : "rattaché à la main");
    if (note === null) return;
    setBusy(c.id); setMsg(null);
    try {
      const res = await resolveCaseAction(c.id, note, dismissed);
      setMsg(res.ok ? "✅ Cas clos" : `❌ ${res.error}`);
      if (res.ok) router.refresh();
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? String(e)}`);
    } finally { setBusy(null); }
  }

  const btn: React.CSSProperties = {
    padding: "7px 12px", borderRadius: 8, fontSize: 11.5, fontWeight: 600,
    cursor: "pointer", border: "1px solid rgba(255,255,255,0.12)", background: "#0B0D12", color: "#E8E8EE",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {msg && <div style={{ fontSize: 12, color: "#8888A0" }}>{msg}</div>}

      {open.length === 0 && (
        <div style={{ ...FUNNEL_CARD, color: "#8888A0", fontSize: 13 }}>
          Aucun cas en attente. Tout ce qui arrive ici est un groupe que le système a refusé
          de créer ou de fusionner sans ton feu vert.
        </div>
      )}

      {open.map((c) => (
        <div key={c.id} style={FUNNEL_CARD}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#E8E8EE" }}>
              #{c.id} · {c.handle ? `@${c.handle}` : (c.display_name ?? "contact inconnu")}
              <span style={{ marginLeft: 10, fontSize: 11, fontWeight: 600, color: "#F5A524" }}>
                {KIND_LABEL[c.kind]}
              </span>
            </div>
            <div style={{ fontSize: 11, color: "#8888A0" }}>{fmtDateTime(c.created_at)}</div>
          </div>

          <div style={{ fontSize: 12, color: "#B8B8C8", marginBottom: 10 }}>{c.detail}</div>

          <div style={{ fontSize: 11.5, color: "#8888A0", marginBottom: 10 }}>
            Contexte : <code>{c.context}</code>
            {c.tg_user_id ? <> · tg <code>{c.tg_user_id}</code></> : <> · <b>aucun tg_user_id</b></>}
          </div>

          {c.candidates.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "#555568", marginBottom: 6 }}>
                Groupes candidats — ressemblance par {c.candidates[0].matchedOn === "handle" ? "handle" : "nom"}, non prouvée
              </div>
              {c.candidates.map((cand) => (
                <div key={cand.chatId} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "3px 0", fontSize: 12 }}>
                  <code style={{ color: "#E8E8EE" }}>{cand.chatId}</code>
                  <span style={{ color: "#B8B8C8" }}>{cand.label}</span>
                  <span style={{ color: "#555568", fontSize: 11 }}>
                    {SOURCE_LABEL[cand.source] ?? cand.source}
                    {cand.createdAt ? ` · ${fmtDateTime(cand.createdAt)}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div style={{ fontSize: 11, color: "#555568", marginBottom: 10 }}>
            Pour rattacher : <code>/linkgroup</code> dans le groupe choisi. Pour créer malgré tout :
            corrige d'abord l'identité Telegram du contact, puis relance depuis sa fiche.
            Rien ici ne touche Telegram.
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button style={btn} disabled={busy === c.id} onClick={() => void resolve(c, false)}>
              {busy === c.id ? "..." : "✅ Traité"}
            </button>
            <button style={{ ...btn, color: "#8888A0" }} disabled={busy === c.id} onClick={() => void resolve(c, true)}>
              Ignorer
            </button>
          </div>
        </div>
      ))}

      {closed.length > 0 && (
        <div style={FUNNEL_CARD}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "#555568", marginBottom: 8 }}>
            Historique
          </div>
          {closed.map((c) => (
            <div key={c.id} style={{ display: "flex", gap: 10, padding: "3px 0", fontSize: 12, color: "#8888A0" }}>
              <span style={{ color: "#3A3A48" }}>#{c.id}</span>
              <span>{c.handle ? `@${c.handle}` : c.display_name}</span>
              <span style={{ color: "#3A3A48" }}>{c.status === "dismissed" ? "ignoré" : "traité"}</span>
              <span style={{ marginLeft: "auto", color: "#3A3A48" }}>{c.resolution}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
