"use client";

// Écran de diffusion dzpk — composition, récap obligatoire, suivi d'envoi.
//
// Types recopiés côté client plutôt qu'importés du module serveur : ce fichier
// ne doit pas tirer `lib/funnels/dzpk/broadcast` (donc better-sqlite3) dans le
// bundle navigateur. Même parti pris que DzpkReconciliationClient.
//
// ┌─ CE QUE CET ÉCRAN DOIT EMPÊCHER ───────────────────────────────────────────┐
// │ Le risque n'est pas de mal composer un message : c'est de l'envoyer à un   │
// │ public qu'on n'avait pas en tête, ou trop souvent. Les deux se règlent par │
// │ la MÊME chose — rendre le nombre et la fréquence impossibles à ne pas voir │
// │ avant de cliquer. D'où un récap qui bloque, et un compteur d'historique    │
// │ affiché en permanence, même quand tout va bien.                            │
// └────────────────────────────────────────────────────────────────────────────┘

import { useState, useMemo, useCallback } from "react";
import { FUNNEL_CARD } from "@/components/funnel/styles";

type Stage = "started" | "replied" | "joined" | "bound" | "converted";

const STAGE_LABELS: Record<Stage, string> = {
  started: "🚀 Started",
  replied: "💬 A écrit",
  joined: "👥 A rejoint",
  bound: "🍓 Rattaché",
  converted: "✅ Converti",
};
const ALL_STAGES: Stage[] = ["started", "replied", "joined", "bound", "converted"];

interface Counts { pending: number; sent: number; blocked: number; failed: number }
interface BroadcastRow {
  id: number; title: string; body: string; status: string; total: number;
  last_error: string | null; created_at: string; started_at: string | null;
  finished_at: string | null; counts: Counts;
}
interface Guard {
  last: { id: number; title: string; sent: number; at: string } | null;
  hoursSince: number | null;
  sentLast24h: number; sentLast7d: number; broadcastsLast7d: number;
}
interface LeadLite { source: string; state: Stage; blocked: number; banned_at: string | null }

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  draft: { label: "brouillon", color: "#8888A0" },
  running: { label: "⏳ en cours", color: "#F0B90B" },
  paused: { label: "⏸ en pause", color: "#F87171" },
  done: { label: "✅ terminée", color: "#34D399" },
  cancelled: { label: "annulée", color: "#555568" },
};

const INPUT: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 8, fontSize: 13,
  background: "#0B0E13", border: "1px solid rgba(255,255,255,0.1)", color: "#E8E8EE",
  fontFamily: "inherit",
};
const LABEL: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, color: "#555568",
  textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5, display: "block",
};

function Btn({ onClick, disabled, tone, children }: {
  onClick: () => void; disabled?: boolean; tone?: "primary" | "danger"; children: React.ReactNode;
}) {
  const bg = tone === "primary" ? "rgba(52,211,153,0.12)"
    : tone === "danger" ? "rgba(248,113,113,0.10)" : "rgba(255,255,255,0.05)";
  const color = tone === "primary" ? "#34D399" : tone === "danger" ? "#F87171" : "#8888A0";
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: "7px 13px", borderRadius: 8, fontSize: 12, fontWeight: 600,
      cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1,
      border: `1px solid ${tone ? color + "40" : "rgba(255,255,255,0.1)"}`,
      background: bg, color, fontFamily: "inherit",
    }}>{children}</button>
  );
}

export default function DzpkBroadcastPanel({ leads, initialBroadcasts, initialGuard }: {
  leads: LeadLite[];
  initialBroadcasts: BroadcastRow[];
  initialGuard: Guard;
}) {
  const [broadcasts, setBroadcasts] = useState(initialBroadcasts);
  const [guard, setGuard] = useState(initialGuard);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [buttonLabel, setButtonLabel] = useState("");
  const [buttonUrl, setButtonUrl] = useState("");
  const [stages, setStages] = useState<Stage[]>([...ALL_STAGES]);
  const [sources, setSources] = useState<string[] | null>(null);
  const [testChatId, setTestChatId] = useState("");

  const [confirming, setConfirming] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  // Sources disponibles, avec leur volume — l'ordre met en tête celles qui
  // pèsent, pas l'alphabet.
  const allSources = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of leads) m.set(l.source, (m.get(l.source) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [leads]);

  // Compte calculé ici pour l'aperçu vivant, mais le chiffre qui FIGE la liste
  // est celui rendu par le serveur à la création. Les deux appliquent les mêmes
  // exclusions dures — c'est le test dzpk-broadcast.test.ts qui les tient
  // ensemble, pas cette ligne.
  const recipients = useMemo(() => leads.filter(l =>
    l.blocked === 0 && l.banned_at === null
    && stages.includes(l.state)
    && (sources === null || sources.includes(l.source))
  ).length, [leads, stages, sources]);

  const excluded = useMemo(
    () => leads.filter(l => l.blocked === 1 || l.banned_at !== null).length,
    [leads],
  );

  const canCompose = title.trim() !== "" && body.trim() !== "" && recipients > 0;

  const post = useCallback(async (payload: Record<string, unknown>) => {
    const res = await fetch("/api/dzpk-broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  }, []);

  const refresh = useCallback((data: any) => {
    if (data.broadcasts) setBroadcasts(data.broadcasts);
    if (data.guard) setGuard(data.guard);
  }, []);

  const doSend = useCallback(async () => {
    setBusy(true); setMsg(null);
    const created = await post({
      action: "create", title, body,
      buttonLabel: buttonLabel || null, buttonUrl: buttonUrl || null,
      segment: { sources, stages },
    });
    if (!created.ok) {
      setBusy(false);
      setMsg({ tone: "err", text: created.data.error ?? "Création refusée" });
      return;
    }
    const started = await post({ action: "start", id: created.data.id });
    setBusy(false);
    setConfirming(false); setConfirmChecked(false);
    if (!started.ok) {
      setMsg({ tone: "err", text: `Brouillon #${created.data.id} créé mais non démarré : ${started.data.error}` });
      refresh(created.data);
      return;
    }
    refresh(started.data);
    setMsg({ tone: "ok", text: `Diffusion #${created.data.id} lancée vers ${created.data.total} destinataires.` });
    setTitle(""); setBody(""); setButtonLabel(""); setButtonUrl("");
  }, [post, refresh, title, body, buttonLabel, buttonUrl, sources, stages]);

  const doTest = useCallback(async () => {
    setBusy(true); setMsg(null);
    const res = await post({
      action: "test", chatId: Number(testChatId),
      body, buttonLabel: buttonLabel || null, buttonUrl: buttonUrl || null,
    });
    setBusy(false);
    setMsg(res.ok
      ? { tone: "ok", text: "Message de contrôle envoyé — vérifie le rendu dans Telegram." }
      : { tone: "err", text: res.data.error ?? "Échec de l'envoi de contrôle" });
  }, [post, testChatId, body, buttonLabel, buttonUrl]);

  const act = useCallback(async (action: string, id: number) => {
    setBusy(true);
    const res = await post({ action, id });
    setBusy(false);
    if (res.ok) refresh(res.data);
    else setMsg({ tone: "err", text: res.data.error ?? "Action refusée" });
  }, [post, refresh]);

  const toggleStage = (s: Stage) =>
    setStages(cur => cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s]);

  const toggleSource = (s: string) =>
    setSources(cur => {
      if (cur === null) return allSources.map(([n]) => n).filter(n => n !== s);
      const next = cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s];
      return next.length === allSources.length ? null : next;
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <GuardBanner guard={guard} />

      <div style={{ ...FUNNEL_CARD, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#555568", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Nouvelle diffusion
        </div>

        <div>
          <label style={LABEL}>Titre interne — jamais envoyé</label>
          <input style={INPUT} value={title} onChange={e => setTitle(e.target.value)}
            placeholder="promo weekend août" />
        </div>

        <div>
          <label style={LABEL}>Message · HTML Telegram · anglais et chinois acceptés</label>
          <textarea
            style={{ ...INPUT, minHeight: 120, resize: "vertical", lineHeight: 1.5 }}
            value={body}
            onChange={e => setBody(e.target.value)}
            // lang="und" : on n'annonce AUCUNE langue. Déclarer "fr" ferait
            // corriger l'anglais et le chinois par le correcteur du navigateur.
            lang="und"
            spellCheck={false}
            placeholder={"🎉 Weekend bonus is live!\n周末奖金上线了！\n\n<b>gras</b> · <i>italique</i> · <a href=\"https://…\">lien</a>"}
          />
          <div style={{ fontSize: 11, color: charCount(body) > 4096 ? "#F87171" : "#3A3A48", marginTop: 4 }}>
            {charCount(body)} / 4096 caractères
            {charCount(body) > 4096 && " — Telegram refusera ce message"}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 200px" }}>
            <label style={LABEL}>Bouton — libellé (optionnel)</label>
            <input style={INPUT} value={buttonLabel} onChange={e => setButtonLabel(e.target.value)}
              lang="und" spellCheck={false} placeholder="立即加入 · Join now" />
          </div>
          <div style={{ flex: "1 1 260px" }}>
            <label style={LABEL}>Bouton — URL</label>
            <input style={INPUT} value={buttonUrl} onChange={e => setButtonUrl(e.target.value)}
              placeholder="https://t.me/…" />
          </div>
        </div>

        <div>
          <label style={LABEL}>Étapes</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {ALL_STAGES.map(s => (
              <Chip key={s} active={stages.includes(s)} onClick={() => toggleStage(s)}>
                {STAGE_LABELS[s]}
              </Chip>
            ))}
          </div>
        </div>

        <div>
          <label style={LABEL}>
            Sources {sources === null && <span style={{ color: "#34D399" }}>· toutes</span>}
          </label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {allSources.map(([name, n]) => (
              <Chip key={name} active={sources === null || sources.includes(name)}
                onClick={() => toggleSource(name)}>
                {name} <span style={{ opacity: 0.6 }}>{n}</span>
              </Chip>
            ))}
            {allSources.length === 0 && (
              <span style={{ fontSize: 12, color: "#555568" }}>Aucun lead — rien à diffuser.</span>
            )}
          </div>
        </div>

        <div style={{
          display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
          borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12,
        }}>
          <div style={{ fontSize: 13, color: "#E8E8EE" }}>
            <b style={{ fontSize: 20, color: recipients > 0 ? "#34D399" : "#F87171" }}>{recipients}</b>
            {" "}destinataire{recipients > 1 ? "s" : ""}
            {excluded > 0 && (
              <span style={{ color: "#555568", fontSize: 11.5, marginLeft: 8 }}
                title="Bloqués par le lead ou bannis par le club — jamais diffusables">
                · {excluded} exclu{excluded > 1 ? "s" : ""} d&apos;office
              </span>
            )}
          </div>
          <div style={{ flex: 1 }} />
          <input style={{ ...INPUT, width: 150 }} value={testChatId}
            onChange={e => setTestChatId(e.target.value)} placeholder="ton telegram_id" />
          <Btn onClick={doTest} disabled={busy || !body.trim() || !testChatId.trim()}>
            Test à moi
          </Btn>
          <Btn tone="primary" onClick={() => { setConfirming(true); setConfirmChecked(false); }}
            disabled={busy || !canCompose}>
            Envoyer…
          </Btn>
        </div>

        {msg && (
          <div style={{
            fontSize: 12, padding: "8px 12px", borderRadius: 8,
            background: msg.tone === "ok" ? "rgba(52,211,153,0.08)" : "rgba(248,113,113,0.08)",
            color: msg.tone === "ok" ? "#34D399" : "#F87171",
          }}>{msg.text}</div>
        )}
      </div>

      {confirming && (
        <ConfirmRecap
          recipients={recipients} title={title} body={body}
          stages={stages} sources={sources} guard={guard}
          checked={confirmChecked} onCheck={setConfirmChecked}
          busy={busy}
          onCancel={() => { setConfirming(false); setConfirmChecked(false); }}
          onConfirm={doSend}
        />
      )}

      <History rows={broadcasts} busy={busy} onAct={act} />
    </div>
  );
}

/** Compte en points de code : une emoji ou un idéogramme = 1, comme chez Telegram. */
function charCount(s: string): number {
  return [...s].length;
}

function Chip({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} style={{
      padding: "5px 11px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
      border: `1px solid ${active ? "rgba(52,211,153,0.35)" : "rgba(255,255,255,0.1)"}`,
      background: active ? "rgba(52,211,153,0.10)" : "#11141A",
      color: active ? "#34D399" : "#555568", fontFamily: "inherit",
    }}>{children}</button>
  );
}

/**
 * Compteur d'historique, affiché EN PERMANENCE.
 *
 * Y compris quand tout va bien : un garde-fou qui n'apparaît qu'en cas
 * d'anomalie n'apprend rien sur son propre rythme. Le voir à chaque visite est
 * ce qui permet de sentir qu'on accélère avant que Telegram ne le signale.
 */
function GuardBanner({ guard }: { guard: Guard }) {
  const recent = guard.hoursSince !== null && guard.hoursSince < 24;
  const heavy = guard.broadcastsLast7d >= 3;
  const alert = recent || heavy;

  return (
    <div style={{
      ...FUNNEL_CARD, padding: "10px 14px", fontSize: 12,
      border: `1px solid ${alert ? "rgba(240,185,11,0.28)" : "rgba(255,255,255,0.06)"}`,
      background: alert ? "rgba(240,185,11,0.05)" : "#11141A",
      color: alert ? "#F0B90B" : "#8888A0",
      display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center",
    }}>
      {guard.last ? (
        <>
          <span>
            Dernière diffusion : <b>{guard.last.title}</b> · {guard.last.sent} message
            {guard.last.sent > 1 ? "s" : ""} · {guard.last.at}
            {guard.hoursSince !== null && ` (il y a ${guard.hoursSince} h)`}
          </span>
          <span style={{ color: "#555568" }}>
            24 h : {guard.sentLast24h} · 7 j : {guard.sentLast7d} sur {guard.broadcastsLast7d} diffusion
            {guard.broadcastsLast7d > 1 ? "s" : ""}
          </span>
        </>
      ) : (
        <span>Aucune diffusion envoyée pour l&apos;instant.</span>
      )}
      {alert && (
        <span style={{ fontWeight: 600 }}>
          ⚠️ {recent ? "Moins de 24 h depuis le dernier envoi." : "3 diffusions ou plus cette semaine."}{" "}
          Un lead qui reçoit trop signale le bot, et Telegram restreint sans préavis.
        </span>
      )}
    </div>
  );
}

/**
 * Récap bloquant.
 *
 * Le nombre est répété en grand et la case doit être cochée à la main : ce
 * n'est pas de la décoration. Le geste coûteux à annuler, ici, n'est pas la
 * création du brouillon — c'est le premier message arrivé chez un lead. Après,
 * il n'y a plus de retour en arrière possible.
 */
function ConfirmRecap({
  recipients, title, body, stages, sources, guard, checked, onCheck, busy, onCancel, onConfirm,
}: {
  recipients: number; title: string; body: string;
  stages: Stage[]; sources: string[] | null; guard: Guard;
  checked: boolean; onCheck: (v: boolean) => void; busy: boolean;
  onCancel: () => void; onConfirm: () => void;
}) {
  const recent = guard.hoursSince !== null && guard.hoursSince < 24;
  return (
    <div style={{
      ...FUNNEL_CARD, border: "1px solid rgba(240,185,11,0.35)", background: "rgba(240,185,11,0.04)",
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{ fontSize: 15, color: "#E8E8EE", fontWeight: 600 }}>
        Tu vas envoyer à <span style={{ color: "#F0B90B", fontSize: 24 }}>{recipients}</span> destinataire{recipients > 1 ? "s" : ""}.
      </div>

      <div style={{ fontSize: 12, color: "#8888A0", display: "flex", flexDirection: "column", gap: 4 }}>
        <div>Titre interne : <b style={{ color: "#E8E8EE" }}>{title}</b></div>
        <div>Étapes : {stages.map(s => STAGE_LABELS[s]).join(" · ") || "—"}</div>
        <div>Sources : {sources === null ? "toutes" : sources.join(" · ")}</div>
        <div style={{ color: "#555568" }}>
          Les leads ayant bloqué le bot et les comptes bannis sont exclus, sans exception.
        </div>
      </div>

      <div style={{
        background: "#0B0E13", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10,
        padding: 12, fontSize: 13, color: "#E8E8EE", whiteSpace: "pre-wrap",
        maxHeight: 200, overflowY: "auto", lineHeight: 1.5,
      }}>{body}</div>

      {recent && (
        <div style={{ fontSize: 12, color: "#F0B90B" }}>
          ⚠️ La dernière diffusion date d&apos;il y a {guard.hoursSince} h ({guard.sentLast24h} message
          {guard.sentLast24h > 1 ? "s" : ""} sur 24 h). Deux envois rapprochés sont le motif de
          signalement le plus courant.
        </div>
      )}

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#E8E8EE", cursor: "pointer" }}>
        {/* `width: auto` contre la règle globale `input { width: 100% }`
            (app/globals.css:265), écrite pour les champs texte. Sans elle la
            case s'étire sur toute la ligne et rejette son libellé à droite —
            la case à cocher ne se lit plus comme appartenant à la phrase. */}
        <input type="checkbox" checked={checked} onChange={e => onCheck(e.target.checked)}
          style={{ width: "auto", flexShrink: 0, margin: 0, padding: 0 }} />
        <span>J&apos;ai relu le message et j&apos;assume l&apos;envoi à ces {recipients} personnes.</span>
      </label>

      <div style={{ display: "flex", gap: 8 }}>
        <Btn onClick={onCancel} disabled={busy}>Annuler</Btn>
        <Btn tone="primary" onClick={onConfirm} disabled={busy || !checked}>
          {busy ? "Envoi en cours…" : `Envoyer à ${recipients} destinataires`}
        </Btn>
      </div>
    </div>
  );
}

function History({ rows, busy, onAct }: {
  rows: BroadcastRow[]; busy: boolean; onAct: (action: string, id: number) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div style={{ ...FUNNEL_CARD, padding: 0, overflowX: "auto" }}>
      <div style={{
        fontSize: 10.5, fontWeight: 700, color: "#555568", textTransform: "uppercase",
        letterSpacing: "0.06em", padding: "14px 18px 8px",
      }}>
        Diffusions
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <tbody>
          {rows.map(b => {
            const st = STATUS_LABEL[b.status] ?? { label: b.status, color: "#8888A0" };
            const done = b.counts.sent + b.counts.blocked + b.counts.failed;
            const pct = b.total > 0 ? Math.round((done / b.total) * 100) : 0;
            return (
              <tr key={b.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                <td style={{ padding: "10px 18px", whiteSpace: "nowrap" }}>
                  <span style={{ fontFamily: "monospace", color: "#555568" }}>#{b.id}</span>{" "}
                  <span style={{ color: "#E8E8EE", fontWeight: 600 }}>{b.title}</span>
                  <div style={{ color: "#3A3A48", fontSize: 11 }}>{b.created_at}</div>
                </td>
                <td style={{ padding: "10px 8px", color: st.color, fontWeight: 600, whiteSpace: "nowrap" }}>
                  {st.label}
                  {b.last_error && (
                    <div style={{ color: "#F87171", fontSize: 11, fontWeight: 400, maxWidth: 280, whiteSpace: "normal" }}>
                      {b.last_error}
                    </div>
                  )}
                </td>
                <td style={{ padding: "10px 8px", whiteSpace: "nowrap", color: "#8888A0" }}>
                  <span style={{ color: "#34D399" }}>{b.counts.sent} envoyés</span>
                  {b.counts.blocked > 0 && <span style={{ color: "#F0B90B" }}> · {b.counts.blocked} bloqués</span>}
                  {b.counts.failed > 0 && <span style={{ color: "#F87171" }}> · {b.counts.failed} échecs</span>}
                  {b.counts.pending > 0 && <span> · {b.counts.pending} en attente</span>}
                  <div style={{ fontSize: 11, color: "#3A3A48" }}>{pct}% de {b.total}</div>
                </td>
                <td style={{ padding: "10px 18px", whiteSpace: "nowrap", textAlign: "right" }}>
                  {(b.status === "paused" || b.status === "draft") && (
                    <span style={{ marginRight: 6 }}>
                      <Btn tone="primary" onClick={() => onAct("start", b.id)} disabled={busy}>Reprendre</Btn>
                    </span>
                  )}
                  {b.status === "running" && (
                    <span style={{ marginRight: 6 }}>
                      <Btn onClick={() => onAct("pause", b.id)} disabled={busy}>Pause</Btn>
                    </span>
                  )}
                  {b.status !== "done" && b.status !== "cancelled" && (
                    <Btn tone="danger" onClick={() => onAct("cancel", b.id)} disabled={busy}>Annuler</Btn>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
