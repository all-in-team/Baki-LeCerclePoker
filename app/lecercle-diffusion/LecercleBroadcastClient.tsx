"use client";

// Écran Diffusion @LeCercle_Lebot — composition, ciblage, récap bloquant, historique.
//
// Seuls des modules PURS sont importés en valeur (html.ts, segment.ts) ; les
// types serveur sont importés en `import type`, effacés à la compilation.
//
// Le nombre annoncé au moment de confirmer est TOUJOURS celui figé par le
// serveur à la création du brouillon, et le serveur refuse de démarrer si le
// chiffre confirmé diffère. Le compteur vivant ne sert qu'à composer.

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { FUNNEL_CARD } from "@/components/funnel/styles";
import { checkTelegramHtml, TELEGRAM_TEXT_LIMIT } from "@/lib/funnels/lecercle/html";
import {
  SOURCE_KEYS, SOURCE_LABELS, ONBOARDING_STAGES, NEXA_STAGES, QQPK_STAGES, MOTIVE_LABELS,
  DEFAULT_SEGMENT, type LecercleSegment, type SourceKey, type ExclusionMotive,
} from "@/lib/funnels/lecercle/segment";
import type { AudienceFacets, AudienceSummary } from "@/lib/funnels/lecercle/audience";
import type { BroadcastListRow, BroadcastGuard } from "@/lib/funnels/lecercle/broadcast";
import { INPUT, LABEL, STATUS_LABEL, Btn, Chip, HtmlPreview, fmtUtc8, pct } from "./ui";

interface Draft { id: number; total: number; excluded: Partial<Record<ExclusionMotive, number>> }

export default function LecercleBroadcastClient({ facets, initialBroadcasts, initialGuard, testChatId }: {
  facets: AudienceFacets;
  initialBroadcasts: BroadcastListRow[];
  initialGuard: BroadcastGuard;
  testChatId: number | null;
}) {
  const [broadcasts, setBroadcasts] = useState(initialBroadcasts);
  const [guard, setGuard] = useState(initialGuard);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [buttonLabel, setButtonLabel] = useState("");
  const [buttonUrl, setButtonUrl] = useState("");
  const [segment, setSegment] = useState<LecercleSegment>(DEFAULT_SEGMENT);

  const [summary, setSummary] = useState<AudienceSummary & { error?: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mode, setMode] = useState<"now" | "schedule">("now");
  const [scheduleAt, setScheduleAt] = useState("");
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const html = useMemo(() => checkTelegramHtml(body), [body]);

  const post = useCallback(async (payload: Record<string, unknown>) => {
    const res = await fetch("/api/lecercle-broadcast", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  }, []);

  const refresh = useCallback((data: any) => {
    if (data.broadcasts) setBroadcasts(data.broadcasts);
    if (data.guard) setGuard(data.guard);
  }, []);

  // Compteur vivant : même requête SQL que la création, rappelée à chaque
  // changement de ciblage (anti-rebond 250 ms).
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      const r = await post({ action: "count", segment });
      if (mine === seq.current) setSummary(r.data);
    }, 250);
    return () => clearTimeout(t);
  }, [segment, post]);

  const set = <K extends keyof LecercleSegment>(k: K, v: LecercleSegment[K]) =>
    setSegment(s => ({ ...s, [k]: v }));

  /** Liste « null = tout » : cocher/décocher une valeur. */
  function toggleIn<T extends string | number>(cur: T[] | null, all: readonly T[], v: T): T[] | null {
    const base = cur ?? [...all];
    const next = base.includes(v) ? base.filter(x => x !== v) : [...base, v];
    return next.length === all.length ? null : next;
  }

  const buttonOk = (!buttonLabel.trim() && !buttonUrl.trim())
    || (buttonLabel.trim() !== "" && /^https?:\/\/\S+$/i.test(buttonUrl.trim()));
  const canPrepare = title.trim() !== "" && html.ok && buttonOk && (summary?.recipients ?? 0) > 0 && !draft;

  const doTest = useCallback(async () => {
    if (testChatId === null) return;
    setBusy(true); setMsg(null);
    const res = await post({ action: "test", chatId: testChatId, body, buttonLabel: buttonLabel || null, buttonUrl: buttonUrl || null });
    setBusy(false);
    setMsg(res.ok
      ? { tone: "ok", text: `Message de contrôle envoyé à ${testChatId} — non compté dans les stats. Le bouton du test pointe directement vers l'URL (pas de lien tracké).` }
      : { tone: "err", text: res.data.error ?? "Échec de l'envoi de contrôle" });
  }, [post, testChatId, body, buttonLabel, buttonUrl]);

  const doPrepare = useCallback(async () => {
    setBusy(true); setMsg(null);
    const r = await post({ action: "create", title, body, buttonLabel: buttonLabel || null, buttonUrl: buttonUrl || null, segment });
    setBusy(false);
    if (!r.ok) { setMsg({ tone: "err", text: r.data.error ?? "Création refusée" }); return; }
    refresh(r.data);
    setDraft({ id: r.data.id, total: r.data.total, excluded: r.data.excluded ?? {} });
    setConfirmChecked(false); setMode("now"); setScheduleAt("");
  }, [post, refresh, title, body, buttonLabel, buttonUrl, segment]);

  const abandonDraft = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    const r = await post({ action: "cancel", id: draft.id });
    setBusy(false);
    if (r.ok) refresh(r.data);
    setDraft(null); setConfirmChecked(false);
  }, [post, refresh, draft]);

  const doConfirm = useCallback(async () => {
    if (!draft) return;
    setBusy(true); setMsg(null);
    const r = mode === "now"
      ? await post({ action: "start", id: draft.id, expectedTotal: draft.total })
      : await post({ action: "schedule", id: draft.id, expectedTotal: draft.total, at: scheduleAt });
    setBusy(false);
    if (!r.ok) { setMsg({ tone: "err", text: r.data.error ?? "Refusé" }); return; }
    refresh(r.data);
    setMsg({
      tone: "ok",
      text: mode === "now"
        ? `Diffusion #${draft.id} lancée vers ${draft.total} destinataires.`
        : `Diffusion #${draft.id} programmée le ${fmtUtc8(r.data.scheduledAt, true)} (UTC+8) pour ${draft.total} destinataires.`,
    });
    setDraft(null); setConfirmChecked(false);
    setTitle(""); setBody(""); setButtonLabel(""); setButtonUrl("");
  }, [post, refresh, draft, mode, scheduleAt]);

  const act = useCallback(async (action: string, id: number) => {
    setBusy(true);
    const r = await post({ action, id });
    setBusy(false);
    if (r.ok) refresh(r.data); else setMsg({ tone: "err", text: r.data.error ?? "Action refusée" });
  }, [post, refresh]);

  const excludedTotal = Object.values(summary?.excluded ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  const nexaSourceKeys = Object.keys(facets.nexaSources);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <GuardBanner guard={guard} />

      <div style={{ ...FUNNEL_CARD, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ ...LABEL, marginBottom: 0 }}>Nouvelle diffusion · audience connue : {facets.botUsers} comptes</div>

        <div>
          <label style={LABEL}>Titre interne — jamais envoyé</label>
          <input style={INPUT} value={title} onChange={e => setTitle(e.target.value)} placeholder="rappel tournoi dimanche" disabled={!!draft} />
        </div>

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 360px", minWidth: 0 }}>
            <label style={LABEL}>Message · HTML Telegram</label>
            <textarea
              style={{ ...INPUT, minHeight: 150, resize: "vertical", lineHeight: 1.5 }}
              value={body} onChange={e => setBody(e.target.value)} lang="und" spellCheck={false} disabled={!!draft}
              placeholder={"🃏 Tournoi dimanche 20h\n\n<b>gras</b> · <i>italique</i> · <u>souligné</u> · <tg-spoiler>spoiler</tg-spoiler>\n< > & s'écrivent &lt; &gt; &amp;"}
            />
            <div style={{ fontSize: 11, marginTop: 4, color: html.visibleLength > TELEGRAM_TEXT_LIMIT ? "#F87171" : "#3A3A48" }}>
              {html.visibleLength} / {TELEGRAM_TEXT_LIMIT} caractères visibles · {[...body].length} caractères HTML
            </div>
            {body.trim() !== "" && !html.ok && (
              <div style={{ fontSize: 11.5, color: "#F87171", marginTop: 4 }}>
                {html.errors.slice(0, 4).map((e, i) => <div key={i}>⛔ {e}</div>)}
                {html.errors.length > 4 && <div>… {html.errors.length - 4} autre(s)</div>}
              </div>
            )}
          </div>
          <div style={{ flex: "1 1 280px", minWidth: 0 }}>
            <label style={LABEL}>Aperçu</label>
            {body.trim()
              ? <HtmlPreview nodes={html.nodes} buttonLabel={buttonLabel} />
              : <div style={{ fontSize: 12, color: "#3A3A48" }}>Le rendu apparaît ici.</div>}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 200px" }}>
            <label style={LABEL}>Bouton — libellé (optionnel)</label>
            <input style={INPUT} value={buttonLabel} onChange={e => setButtonLabel(e.target.value)} placeholder="Je m'inscris" disabled={!!draft} />
          </div>
          <div style={{ flex: "1 1 260px" }}>
            <label style={LABEL}>Bouton — URL (https, clics suivis)</label>
            <input style={INPUT} value={buttonUrl} onChange={e => setButtonUrl(e.target.value)} placeholder="https://…" disabled={!!draft} />
          </div>
        </div>
        {!buttonOk && (
          <div style={{ fontSize: 11.5, color: "#F87171", marginTop: -6 }}>
            Bouton : libellé et URL vont ensemble, et l&apos;URL doit commencer par http:// ou https://.
          </div>
        )}

        <Targeting segment={segment} set={set} toggleIn={toggleIn} facets={facets} nexaSourceKeys={nexaSourceKeys} disabled={!!draft} />

        <div style={{
          display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
          borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12,
        }}>
          <div style={{ fontSize: 13, color: "#E8E8EE" }}>
            <b style={{ fontSize: 20, color: (summary?.recipients ?? 0) > 0 ? "#34D399" : "#F87171" }}>{summary?.recipients ?? "…"}</b>
            {" "}destinataire{(summary?.recipients ?? 0) > 1 ? "s" : ""}
            {summary?.error && <span style={{ color: "#F87171", fontSize: 11.5, marginLeft: 8 }}>{summary.error}</span>}
            {excludedTotal > 0 && (
              <span style={{ color: "#8888A0", fontSize: 11.5, marginLeft: 8 }}>
                · {excludedTotal} exclu{excludedTotal > 1 ? "s" : ""} d&apos;office :{" "}
                {(Object.entries(summary?.excluded ?? {}) as [ExclusionMotive, number][])
                  .map(([m, n]) => `${n} ${MOTIVE_LABELS[m]}`).join(" · ")}
              </span>
            )}
          </div>
          <div style={{ flex: 1 }} />
          <Btn onClick={doTest} disabled={busy || testChatId === null || !html.ok || !buttonOk}>
            Test à moi{testChatId !== null ? ` (${testChatId})` : ""}
          </Btn>
          <Btn tone="primary" onClick={doPrepare} disabled={busy || !canPrepare}>Préparer l&apos;envoi…</Btn>
        </div>

        {msg && (
          <div style={{
            fontSize: 12, padding: "8px 12px", borderRadius: 8,
            background: msg.tone === "ok" ? "rgba(52,211,153,0.08)" : "rgba(248,113,113,0.08)",
            color: msg.tone === "ok" ? "#34D399" : "#F87171",
          }}>{msg.text}</div>
        )}
      </div>

      {draft && (
        <ConfirmRecap
          draft={draft} title={title} html={html} buttonLabel={buttonLabel} buttonUrl={buttonUrl}
          guard={guard} mode={mode} setMode={setMode} scheduleAt={scheduleAt} setScheduleAt={setScheduleAt}
          checked={confirmChecked} onCheck={setConfirmChecked} busy={busy}
          onCancel={abandonDraft} onConfirm={doConfirm} unproven={segment.includeUnproven}
        />
      )}

      <History rows={broadcasts} busy={busy} onAct={act} />
    </div>
  );
}

function Targeting({ segment, set, toggleIn, facets, nexaSourceKeys, disabled }: {
  segment: LecercleSegment;
  set: <K extends keyof LecercleSegment>(k: K, v: LecercleSegment[K]) => void;
  toggleIn: <T extends string | number>(cur: T[] | null, all: readonly T[], v: T) => T[] | null;
  facets: AudienceFacets;
  nexaSourceKeys: string[];
  disabled: boolean;
}) {
  const has = (k: SourceKey) => segment.sources.includes(k);
  const toggleSource = (k: SourceKey) =>
    set("sources", has(k) ? segment.sources.filter(x => x !== k) : [...segment.sources, k]);
  const numOrNull = (v: string) => (v.trim() === "" ? null : Math.max(1, Math.floor(Number(v))) || null);

  return (
    <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <label style={LABEL}>Sources · un compte est retenu s&apos;il appartient à l&apos;une d&apos;elles</label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {SOURCE_KEYS.map(k => (
            <Chip key={k} active={has(k)} onClick={() => toggleSource(k)}>
              {SOURCE_LABELS[k]} <span style={{ opacity: 0.6 }}>{facets.bySource[k] ?? 0}</span>
            </Chip>
          ))}
        </div>
      </div>

      {has("onboarding") && (
        <StageRow label="Étapes onboarding" all={ONBOARDING_STAGES} cur={segment.onboardingStages} counts={facets.onboardingStages}
          onToggle={v => set("onboardingStages", toggleIn(segment.onboardingStages, ONBOARDING_STAGES, v))} />
      )}
      {has("nexa") && (
        <>
          <StageRow label="Étapes Nexa" all={NEXA_STAGES} cur={segment.nexaStages} counts={facets.nexaStages}
            onToggle={v => set("nexaStages", toggleIn(segment.nexaStages, NEXA_STAGES, v))} />
          {nexaSourceKeys.length > 0 && (
            <StageRow label="Canal d'acquisition Nexa" all={nexaSourceKeys} cur={segment.nexaSources} counts={facets.nexaSources}
              onToggle={v => set("nexaSources", toggleIn(segment.nexaSources, nexaSourceKeys, v))} />
          )}
        </>
      )}
      {has("qqpk") && (
        <StageRow label="Étapes QQPK" all={QQPK_STAGES} cur={segment.qqpkStages} counts={facets.qqpkStages}
          onToggle={v => set("qqpkStages", toggleIn(segment.qqpkStages, QQPK_STAGES, v))} />
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div>
          <label style={LABEL}>Joueur rattaché</label>
          <div style={{ display: "flex", gap: 6 }}>
            {(["any", "yes", "no"] as const).map(v => (
              <Chip key={v} active={segment.linked === v} onClick={() => set("linked", v)}>
                {v === "any" ? "Tous" : v === "yes" ? "Oui" : "Non"}
              </Chip>
            ))}
          </div>
        </div>
        <div style={{ width: 150 }}>
          <label style={LABEL}>1er contact du (UTC+8)</label>
          <input type="date" style={INPUT} value={segment.startedFrom ?? ""} onChange={e => set("startedFrom", e.target.value || null)} />
        </div>
        <div style={{ width: 150 }}>
          <label style={LABEL}>au (inclus)</label>
          <input type="date" style={INPUT} value={segment.startedTo ?? ""} onChange={e => set("startedTo", e.target.value || null)} />
        </div>
        <div style={{ width: 130 }}>
          <label style={LABEL}>Actif ≤ N jours</label>
          <input type="number" min={1} style={INPUT} value={segment.activeWithinDays ?? ""} onChange={e => set("activeWithinDays", numOrNull(e.target.value))} />
        </div>
        <div style={{ width: 130 }}>
          <label style={LABEL}>Inactif ≥ N jours</label>
          <input type="number" min={1} style={INPUT} value={segment.inactiveForDays ?? ""} onChange={e => set("inactiveForDays", numOrNull(e.target.value))} />
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#3A3A48", marginTop: -6 }}>
        Date de 1er contact inconnue pour les joueurs repris sans date : ils sortent dès qu&apos;un filtre de date est posé.
        Dernière activité partielle avant ce déploiement (reconstituée depuis les funnels), exacte ensuite.
      </div>

      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, color: "#E8E8EE", cursor: "pointer" }}>
        <input type="checkbox" checked={segment.includeUnproven} onChange={e => set("includeUnproven", e.target.checked)}
          style={{ width: "auto", flexShrink: 0, margin: "2px 0 0", padding: 0 }} />
        <span>
          Inclure les joueurs sans preuve de /start <span style={{ color: "#8888A0" }}>({facets.unprovenPlayers})</span>
          {segment.includeUnproven && (
            <div style={{ color: "#F0B90B", fontSize: 11.5, marginTop: 3 }}>
              ⚠️ La plupart vont échouer en 403 « bot can&apos;t initiate conversation » : Telegram interdit à un bot
              d&apos;écrire le premier. Ces échecs apparaîtront en « échec », pas en « bloqué ».
            </div>
          )}
        </span>
      </label>
    </fieldset>
  );
}

function StageRow<T extends string | number>({ label, all, cur, counts, onToggle }: {
  label: string; all: readonly T[]; cur: T[] | null; counts: Record<string, number>; onToggle: (v: T) => void;
}) {
  return (
    <div>
      <label style={LABEL}>{label} {cur === null && <span style={{ color: "#34D399" }}>· toutes</span>}</label>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {all.map(v => (
          <Chip key={String(v)} active={cur === null || cur.includes(v)} onClick={() => onToggle(v)}>
            {String(v)} <span style={{ opacity: 0.6 }}>{counts[String(v)] ?? 0}</span>
          </Chip>
        ))}
      </div>
    </div>
  );
}

function GuardBanner({ guard }: { guard: BroadcastGuard }) {
  const recent = guard.hoursSince !== null && guard.hoursSince < 24;
  const heavy = guard.broadcastsLast7d >= 3;
  const alert = recent || heavy;
  return (
    <div style={{
      ...FUNNEL_CARD, padding: "10px 14px", fontSize: 12,
      border: `1px solid ${alert ? "rgba(240,185,11,0.28)" : "rgba(255,255,255,0.06)"}`,
      background: alert ? "rgba(240,185,11,0.05)" : "#11141A",
      color: alert ? "#F0B90B" : "#8888A0", display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center",
    }}>
      {guard.last ? (
        <>
          <span>Dernière diffusion : <b>{guard.last.title}</b> · {guard.last.sent} message{guard.last.sent > 1 ? "s" : ""} · {fmtUtc8(guard.last.at)} (UTC+8)
            {guard.hoursSince !== null && ` — il y a ${guard.hoursSince} h`}</span>
          <span style={{ color: "#555568" }}>24 h : {guard.sentLast24h} · 7 j : {guard.sentLast7d} sur {guard.broadcastsLast7d} diffusion{guard.broadcastsLast7d > 1 ? "s" : ""}</span>
        </>
      ) : <span>Aucune diffusion envoyée pour l&apos;instant.</span>}
      {alert && (
        <span style={{ fontWeight: 600 }}>
          ⚠️ {recent ? "Moins de 24 h depuis le dernier envoi." : "3 diffusions ou plus cette semaine."} Un compte qui reçoit trop signale le bot.
        </span>
      )}
    </div>
  );
}

function ConfirmRecap({
  draft, title, html, buttonLabel, buttonUrl, guard, mode, setMode, scheduleAt, setScheduleAt,
  checked, onCheck, busy, onCancel, onConfirm, unproven,
}: {
  draft: Draft; title: string; html: ReturnType<typeof checkTelegramHtml>; buttonLabel: string; buttonUrl: string;
  guard: BroadcastGuard; mode: "now" | "schedule"; setMode: (m: "now" | "schedule") => void;
  scheduleAt: string; setScheduleAt: (v: string) => void;
  checked: boolean; onCheck: (v: boolean) => void; busy: boolean;
  onCancel: () => void; onConfirm: () => void; unproven: boolean;
}) {
  const recent = guard.hoursSince !== null && guard.hoursSince < 24;
  const excluded = Object.entries(draft.excluded) as [ExclusionMotive, number][];
  return (
    <div style={{
      ...FUNNEL_CARD, border: "1px solid rgba(240,185,11,0.35)", background: "rgba(240,185,11,0.04)",
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{ fontSize: 15, color: "#E8E8EE", fontWeight: 600 }}>
        Brouillon #{draft.id} : <span style={{ color: "#F0B90B", fontSize: 24 }}>{draft.total}</span> destinataire{draft.total > 1 ? "s" : ""} figé{draft.total > 1 ? "s" : ""}.
      </div>
      <div style={{ fontSize: 12, color: "#8888A0", display: "flex", flexDirection: "column", gap: 4 }}>
        <div>Titre interne : <b style={{ color: "#E8E8EE" }}>{title}</b></div>
        {buttonLabel && <div>Bouton : « {buttonLabel} » → {buttonUrl} (via lien tracké)</div>}
        <div>Exclus d&apos;office : {excluded.length ? excluded.map(([m, n]) => `${n} ${MOTIVE_LABELS[m]}`).join(" · ") : "aucun"}</div>
        <div style={{ color: "#555568" }}>Les exclusions sont relues juste avant chaque envoi : un compte bloqué ou pris en main entre-temps est écarté.</div>
        {unproven && <div style={{ color: "#F0B90B" }}>⚠️ Joueurs sans preuve de /start inclus : attends-toi à beaucoup d&apos;échecs 403.</div>}
      </div>
      <HtmlPreview nodes={html.nodes} buttonLabel={buttonLabel} />

      {recent && (
        <div style={{ fontSize: 12, color: "#F0B90B" }}>
          ⚠️ Dernière diffusion il y a {guard.hoursSince} h ({guard.sentLast24h} message{guard.sentLast24h > 1 ? "s" : ""} sur 24 h).
        </div>
      )}

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Chip active={mode === "now"} onClick={() => setMode("now")}>Envoyer maintenant</Chip>
        <Chip active={mode === "schedule"} onClick={() => setMode("schedule")}>Programmer</Chip>
        {mode === "schedule" && (
          <>
            <input type="datetime-local" style={{ ...INPUT, width: 210 }} value={scheduleAt} onChange={e => setScheduleAt(e.target.value)} />
            <span style={{ fontSize: 11.5, color: "#8888A0" }}>heure UTC+8 · les destinataires restent ceux figés maintenant</span>
          </>
        )}
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#E8E8EE", cursor: "pointer" }}>
        <input type="checkbox" checked={checked} onChange={e => onCheck(e.target.checked)} style={{ width: "auto", flexShrink: 0, margin: 0, padding: 0 }} />
        <span>J&apos;ai relu le message et j&apos;assume l&apos;envoi à ces {draft.total} personnes.</span>
      </label>

      <div style={{ display: "flex", gap: 8 }}>
        <Btn onClick={onCancel} disabled={busy}>Abandonner le brouillon</Btn>
        <Btn tone="primary" onClick={onConfirm} disabled={busy || !checked || (mode === "schedule" && !scheduleAt)}>
          {busy ? "…" : mode === "now" ? `Envoyer à ${draft.total} destinataires` : `Programmer pour ${draft.total} destinataires`}
        </Btn>
      </div>
    </div>
  );
}

function History({ rows, busy, onAct }: { rows: BroadcastListRow[]; busy: boolean; onAct: (a: string, id: number) => void }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ ...FUNNEL_CARD, padding: 0, overflowX: "auto" }}>
      <div style={{ ...LABEL, padding: "14px 18px 8px", marginBottom: 0 }}>Historique des diffusions</div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <tbody>
          {rows.map(b => {
            const st = STATUS_LABEL[b.status] ?? { label: b.status, color: "#8888A0" };
            const s = b.stats;
            return (
              <tr key={b.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                <td style={{ padding: "10px 18px", whiteSpace: "nowrap" }}>
                  <span style={{ fontFamily: "monospace", color: "#555568" }}>#{b.id}</span>{" "}
                  <Link href={`/lecercle-diffusion/${b.id}`} style={{ color: "#E8E8EE", fontWeight: 600 }}>{b.title}</Link>
                  <div style={{ color: "#3A3A48", fontSize: 11 }}>créée {fmtUtc8(b.created_at)} (UTC+8)</div>
                </td>
                <td style={{ padding: "10px 8px", color: st.color, fontWeight: 600, whiteSpace: "nowrap" }}>
                  {st.label}
                  {b.status === "scheduled" && <div style={{ fontSize: 11, fontWeight: 400 }}>{fmtUtc8(b.scheduled_at, true)} UTC+8</div>}
                  {b.last_error && <div style={{ color: "#F87171", fontSize: 11, fontWeight: 400, maxWidth: 280, whiteSpace: "normal" }}>{b.last_error}</div>}
                </td>
                <td style={{ padding: "10px 8px", whiteSpace: "nowrap", color: "#8888A0" }}>
                  <span style={{ color: "#34D399" }}>{s.sent} envoyés</span>
                  {s.failed > 0 && <span style={{ color: "#F87171" }}> · {s.failed} échecs</span>}
                  {s.blocked > 0 && <span style={{ color: "#F0B90B" }}> · {s.blocked} bloqués</span>}
                  {s.pending + s.sending > 0 && <span> · {s.pending + s.sending} en attente</span>}
                  {s.unknown > 0 && <span style={{ color: "#F97316" }}> · {s.unknown} issue inconnue</span>}
                  <div style={{ fontSize: 11, color: "#3A3A48" }}>
                    {s.clicked} clic{s.clicked > 1 ? "s" : ""} ({pct(s.clicked, s.sent)}) · {s.replied} réponse{s.replied > 1 ? "s" : ""} ({pct(s.replied, s.sent)}) · {b.total} figés
                  </div>
                </td>
                <td style={{ padding: "10px 18px", whiteSpace: "nowrap", textAlign: "right" }}>
                  {b.status === "paused" && <span style={{ marginRight: 6 }}><Btn tone="primary" onClick={() => onAct("start", b.id)} disabled={busy}>Reprendre</Btn></span>}
                  {b.status === "running" && <span style={{ marginRight: 6 }}><Btn onClick={() => onAct("pause", b.id)} disabled={busy}>Pause</Btn></span>}
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
