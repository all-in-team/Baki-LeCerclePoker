"use client";

// Détail d'une diffusion : chiffres + liste nominative filtrable.
//
// Dénominateurs : envoyés / échecs / bloqués / écartés / en attente sur le
// total FIGÉ ; clics et réponses sur les ENVOYÉS — on ne peut ni cliquer ni
// répondre à un message qu'on n'a pas reçu.

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { FUNNEL_CARD } from "@/components/funnel/styles";
import { checkTelegramHtml } from "@/lib/funnels/lecercle/html";
import { MOTIVE_LABELS, type ExclusionMotive } from "@/lib/funnels/lecercle/segment";
import type { LecercleBroadcast, BroadcastStats, TargetRow, TargetFilter } from "@/lib/funnels/lecercle/broadcast";
import { INPUT, LABEL, STATUS_LABEL, Btn, Chip, HtmlPreview, fmtUtc8, displayName, pct } from "../ui";

const FILTERS: Array<{ key: TargetFilter; label: string }> = [
  { key: "all", label: "Tous" },
  { key: "sent", label: "Envoyés" },
  { key: "failed", label: "Échecs" },
  { key: "blocked", label: "Bloqués" },
  { key: "skipped", label: "Écartés" },
  { key: "pending", label: "En attente" },
  { key: "unknown", label: "Issue inconnue" },
  { key: "clicked", label: "Ont cliqué" },
  { key: "not_clicked", label: "Reçu sans clic" },
  { key: "replied", label: "Ont répondu" },
  { key: "not_replied", label: "Reçu sans réponse" },
];

const TARGET_STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: "en attente", color: "#8888A0" },
  sending: { label: "envoi en cours", color: "#F0B90B" },
  unknown: { label: "issue inconnue", color: "#F97316" },
  sent: { label: "envoyé", color: "#34D399" },
  failed: { label: "échec", color: "#F87171" },
  blocked: { label: "bloqué", color: "#F0B90B" },
  skipped: { label: "écarté", color: "#555568" },
};

function matches(r: TargetRow, f: TargetFilter): boolean {
  switch (f) {
    case "all": return true;
    case "clicked": return r.first_click_at !== null;
    case "not_clicked": return r.status === "sent" && r.first_click_at === null;
    case "replied": return r.replied_at !== null;
    case "not_replied": return r.status === "sent" && r.replied_at === null;
    case "pending": return r.status === "pending" || r.status === "sending";
    default: return r.status === f;
  }
}

export default function BroadcastDetailClient({ broadcast, initialStats, initialRows }: {
  broadcast: LecercleBroadcast; initialStats: BroadcastStats; initialRows: TargetRow[];
}) {
  const [stats, setStats] = useState(initialStats);
  const [rows, setRows] = useState(initialRows);
  const [filter, setFilter] = useState<TargetFilter>("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setBusy(true);
    const res = await fetch("/api/lecercle-broadcast", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "recipients", id: broadcast.id, filter: "all" }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (data.rows) setRows(data.rows);
    if (data.stats) setStats(data.stats);
  }, [broadcast.id]);

  const shown = useMemo(() => {
    const needle = q.trim().replace(/^@/, "").toLowerCase();
    return rows.filter(r => matches(r, filter) && (!needle
      || (r.username ?? "").toLowerCase().includes(needle)
      || (r.first_name ?? "").toLowerCase().includes(needle)
      || String(r.telegram_id).includes(needle)));
  }, [rows, filter, q]);

  const counts = useMemo(() => {
    const m = {} as Record<TargetFilter, number>;
    for (const f of FILTERS) m[f.key] = rows.filter(r => matches(r, f.key)).length;
    return m;
  }, [rows]);

  const st = STATUS_LABEL[broadcast.status] ?? { label: broadcast.status, color: "#8888A0" };
  const html = useMemo(() => checkTelegramHtml(broadcast.body), [broadcast.body]);
  let excluded: [ExclusionMotive, number][] = [];
  try { excluded = Object.entries(JSON.parse(broadcast.excluded || "{}")) as [ExclusionMotive, number][]; } catch {}

  const tiles: Array<{ label: string; n: number; d: number; color: string; hint: string }> = [
    { label: "Envoyés", n: stats.sent, d: stats.total, color: "#34D399", hint: "du total figé" },
    { label: "Échecs", n: stats.failed, d: stats.total, color: "#F87171", hint: "du total figé" },
    { label: "Bloqués", n: stats.blocked, d: stats.total, color: "#F0B90B", hint: "du total figé" },
    { label: "Ont cliqué", n: stats.clicked, d: stats.sent, color: "#60A5FA", hint: "des envoyés" },
    { label: "Ont répondu", n: stats.replied, d: stats.sent, color: "#A78BFA", hint: "des envoyés, sous 72 h" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 12 }}><Link href="/lecercle-diffusion" style={{ color: "#8888A0" }}>← Toutes les diffusions</Link></div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        {tiles.map(t => (
          <div key={t.label} style={{ ...FUNNEL_CARD, padding: 14 }}>
            <div style={{ ...LABEL, marginBottom: 6 }}>{t.label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: t.color, fontVariantNumeric: "tabular-nums" }}>{t.n}</div>
            <div style={{ fontSize: 11.5, color: "#8888A0" }}>{pct(t.n, t.d)} {t.hint}</div>
          </div>
        ))}
      </div>

      <div style={{ ...FUNNEL_CARD, display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, color: "#8888A0" }}>
        <div style={{ flex: "1 1 300px", display: "flex", flexDirection: "column", gap: 4 }}>
          <div>Statut : <b style={{ color: st.color }}>{st.label}</b>{broadcast.last_error && <span style={{ color: "#F87171" }}> — {broadcast.last_error}</span>}</div>
          <div>Total figé : {stats.total} · en attente {stats.pending + stats.sending} · écartés à l&apos;envoi {stats.skipped}
            {stats.unknown > 0 && <span style={{ color: "#F97316" }}> · {stats.unknown} issue inconnue (possiblement reçu, jamais renvoyé)</span>}</div>
          <div>Exclus d&apos;office à la création : {excluded.length ? excluded.map(([m, n]) => `${n} ${MOTIVE_LABELS[m] ?? m}`).join(" · ") : "aucun"}</div>
          <div>Créée {fmtUtc8(broadcast.created_at, true)} · démarrée {fmtUtc8(broadcast.started_at, true)} · finie {fmtUtc8(broadcast.finished_at, true)} (UTC+8)</div>
          {broadcast.scheduled_at && <div>Programmée : {fmtUtc8(broadcast.scheduled_at, true)} (UTC+8)</div>}
          {broadcast.button_url && <div>Bouton : « {broadcast.button_label} » → {broadcast.button_url}</div>}
          <div style={{ color: "#555568" }}>Pas de colonne « lu » : l&apos;API Bot Telegram ne donne aucun accusé de lecture.</div>
        </div>
        <HtmlPreview nodes={html.nodes} buttonLabel={broadcast.button_label ?? undefined} />
      </div>

      <div style={{ ...FUNNEL_CARD, padding: 0, overflowX: "auto" }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "14px 18px 10px" }}>
          {FILTERS.map(f => (
            <Chip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label} <span style={{ opacity: 0.6 }}>{counts[f.key]}</span>
            </Chip>
          ))}
          <div style={{ flex: 1 }} />
          <input style={{ ...INPUT, width: 200 }} value={q} onChange={e => setQ(e.target.value)} placeholder="@handle, prénom, id" />
          <Btn onClick={reload} disabled={busy}>{busy ? "…" : "Rafraîchir"}</Btn>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: "#555568", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "left" }}>
              <th style={{ padding: "6px 18px" }}>Compte</th>
              <th style={{ padding: "6px 8px" }}>telegram_id</th>
              <th style={{ padding: "6px 8px" }}>Statut</th>
              <th style={{ padding: "6px 8px" }}>Envoyé (UTC+8)</th>
              <th style={{ padding: "6px 8px" }}>Clic</th>
              <th style={{ padding: "6px 18px" }}>Réponse</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(r => {
              const ts = TARGET_STATUS[r.status] ?? { label: r.status, color: "#8888A0" };
              return (
                <tr key={r.id} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ padding: "8px 18px", color: "#E8E8EE" }}>{displayName(r)}</td>
                  <td style={{ padding: "8px", fontFamily: "monospace", color: "#8888A0" }}>{r.telegram_id}</td>
                  <td style={{ padding: "8px", color: ts.color, fontWeight: 600 }}>
                    {ts.label}
                    {r.error && (
                      <div style={{ color: "#8888A0", fontWeight: 400, fontSize: 11, maxWidth: 320 }}>
                        {r.error_code ? `${r.error_code} · ` : ""}{r.error}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "8px", color: "#8888A0", whiteSpace: "nowrap" }}>{fmtUtc8(r.sent_at)}</td>
                  <td style={{ padding: "8px", color: r.first_click_at ? "#60A5FA" : "#3A3A48", whiteSpace: "nowrap" }}>
                    {r.first_click_at ? `${fmtUtc8(r.first_click_at)}${r.click_count > 1 ? ` · ×${r.click_count}` : ""}` : "—"}
                  </td>
                  <td style={{ padding: "8px 18px", color: r.replied_at ? "#A78BFA" : "#3A3A48", whiteSpace: "nowrap" }}>
                    {fmtUtc8(r.replied_at)}
                    {r.topic_link && (
                      <a href={r.topic_link} target="_blank" rel="noopener noreferrer"
                        style={{ marginLeft: 8, color: "#60A5FA", fontSize: 11.5 }}>ouvrir le sujet ↗</a>
                    )}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr><td colSpan={6} style={{ padding: "14px 18px", color: "#555568" }}>Personne dans ce filtre.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
