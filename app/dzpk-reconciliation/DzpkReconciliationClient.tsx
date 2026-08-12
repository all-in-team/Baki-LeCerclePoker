"use client";

import { useState, useCallback } from "react";
import { FUNNEL_CARD } from "@/components/funnel/styles";

// Types recopiés côté client plutôt qu'importés du module serveur : ce fichier
// ne doit pas tirer `lib/funnels/dzpk/matcher` (donc better-sqlite3) dans le
// bundle navigateur.
interface Candidate {
  id: number;
  telegram_id: number;
  display_name: string | null;
  username: string | null;
  source: string;
  started_at: string;
  hours_before: number | null;
}
interface PendingItem {
  club_message_id: number;
  status: string;
  kind: string;
  player_name_raw: string | null;
  posted_at: string | null;
  raw_text: string;
  note: string;
  candidates: Candidate[];
}
interface Stats {
  total: number; pending: number; auto: number; manual: number; auto_rate_pct: number | null;
}
interface SearchResult {
  id: number; telegram_id: number; display_name: string | null;
  username: string | null; source: string; started_at: string; bound_at: string | null;
}

const KIND_LABEL: Record<string, string> = {
  bound: "🎯 Rattaché (revenu)",
  join: "👋 A rejoint",
  banned: "🚫 Banni",
};

interface ObservedMatch {
  club_message_id: number; kind: string; player_name_raw: string | null;
  posted_at: string | null; raw_text: string; method: string | null;
  lead_id: number; lead_display_name: string | null; lead_username: string | null;
  lead_source: string; lead_started_at: string; hours_before: number | null;
}

export default function DzpkReconciliationClient({
  initialStats, initialQueue, initialObserved, autoMatchEnabled,
}: {
  initialStats: Stats; initialQueue: PendingItem[];
  initialObserved: ObservedMatch[]; autoMatchEnabled: boolean;
}) {
  const [stats, setStats] = useState(initialStats);
  const [queue, setQueue] = useState(initialQueue);
  const [observed, setObserved] = useState(initialObserved);
  const [openId, setOpenId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) { setResults([]); return; }
    try {
      const r = await fetch(`/api/dzpk-reconciliation?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const d = await r.json();
      setResults(d.results ?? []);
    } catch { setResults([]); }
  }, []);

  const attach = useCallback(async (clubMessageId: number, leadId: number) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/dzpk-reconciliation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ club_message_id: clubMessageId, lead_id: leadId }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error ?? "échec du rattachement"); return; }
      // La file est renvoyée recalculée par le serveur : le lien qu'on vient
      // d'apprendre peut avoir résolu d'autres lignes d'un coup.
      setStats(d.stats); setQueue(d.queue);
      if (d.observed) setObserved(d.observed);
      setOpenId(null); setQuery(""); setResults([]);
    } catch (e: any) {
      setError(e?.message ?? "erreur réseau");
    } finally { setBusy(false); }
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ── Compteurs ─────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <Tile label="En attente" value={stats.pending} accent={stats.pending > 0 ? "#F5C518" : "#8888A0"} />
        <Tile label="Auto" value={stats.auto} />
        <Tile label="Manuels" value={stats.manual} />
        <Tile
          label="Taux d'auto"
          // `null` ≠ 0 % : sans notification examinée, il n'y a pas de taux, et
          // afficher « 0 % » ferait croire à un échec d'appariement.
          value={stats.auto_rate_pct === null ? "—" : `${stats.auto_rate_pct} %`}
          hint={stats.auto_rate_pct === null ? "aucune notification examinée" : undefined}
        />
      </div>

      {error && (
        <div style={{ ...FUNNEL_CARD, borderColor: "rgba(239,68,68,0.4)", color: "#FCA5A5", fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* ── Troisième état : certains, calculés, PAS appliqués ─────────────
          Listés un par un, avec le lead visé et l'écart temporel, pour être
          vérifiés AVANT de lever le drapeau. Un compteur ne suffit pas :
          c'est chaque rattachement qu'il faut pouvoir contrôler. */}
      {/* Affiché dès qu'il reste des observés, drapeau levé ou non : si le
          matching s'arrête (session userbot retirée, agent non configuré), le
          backlog certain n'est jamais appliqué — et le cacher ici le rendait
          invisible partout à la fois. (audit du 2026-08-12, F4) */}
      {observed.length > 0 && (
        <div style={{ ...FUNNEL_CARD, borderColor: "rgba(245,197,24,0.35)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#F5C518" }}>
            🔍 {observed.length} rattachement(s) jugé(s) certain(s), non appliqué(s)
            {autoMatchEnabled && " — le drapeau est LEVÉ : ils devraient s'appliquer à la prochaine passe. S'ils restent, le matching ne tourne plus."}
          </div>
          <div style={{ fontSize: 12, color: "#8888A0", marginTop: 6, marginBottom: 12, lineHeight: 1.5 }}>
            Rien n&apos;est crédité. Vérifie que chaque ligne tombe sur le bon lead, puis pose{" "}
            <code style={{ color: "#E8E8EE" }}>DZPK_AUTO_MATCH=on</code> — la passe suivante les appliquera.
            Une ligne fausse se corrige dès maintenant avec « Rattacher ailleurs ».
          </div>

          {observed.map(o => (
            <div key={o.club_message_id} style={{
              padding: "10px 12px", borderRadius: 8, background: "#0B0D12", marginBottom: 8,
              display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap",
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "#E8E8EE" }}>
                  <b>{o.player_name_raw ?? "—"}</b>
                  <span style={{ color: "#555568" }}> → </span>
                  <b style={{ color: "#10B981" }}>{o.lead_display_name ?? `lead ${o.lead_id}`}</b>
                  <span style={{ color: "#8888A0", fontSize: 12 }}> · {o.lead_source}</span>
                </div>
                <div style={{ fontSize: 11, color: "#8888A0", marginTop: 3 }}>
                  {KIND_LABEL[o.kind] ?? o.kind} · notif {o.posted_at ?? "sans date"} ·
                  {" "}@{o.lead_username ?? "—"} · /start {o.lead_started_at}
                  {o.hours_before !== null && (
                    <span style={{ color: o.hours_before < 0 ? "#FCA5A5" : "#555568" }}>
                      {" "}· {o.hours_before < 0
                        ? `⚠️ ${Math.abs(Math.round(o.hours_before))} h APRÈS la notif`
                        : `${Math.round(o.hours_before)} h avant la notif`}
                    </span>
                  )}
                  {o.method === "link" && <span style={{ color: "#555568" }}> · via lien appris</span>}
                </div>
              </div>
              <button
                onClick={() => { setOpenId(openId === o.club_message_id ? null : o.club_message_id); setQuery(""); setResults([]); }}
                style={btnStyle(openId === o.club_message_id)}
              >
                {openId === o.club_message_id ? "Fermer" : "Rattacher ailleurs"}
              </button>
              {openId === o.club_message_id && (
                <div style={{ width: "100%", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12 }}>
                  <input
                    value={query}
                    onChange={e => search(e.target.value)}
                    placeholder="nom, @handle ou telegram_id"
                    autoFocus
                    style={{
                      width: "100%", padding: "8px 12px", borderRadius: 8, fontSize: 13,
                      background: "#11141A", border: "1px solid rgba(255,255,255,0.1)", color: "#E8E8EE",
                    }}
                  />
                  <div style={{ marginTop: 8 }}>
                    {results.map(r => (
                      <LeadRow
                        key={r.id}
                        title={r.display_name ?? `tg:${r.telegram_id}`}
                        subtitle={`@${r.username ?? "—"} · ${r.source} · /start ${r.started_at}`}
                        disabled={busy}
                        onPick={() => attach(o.club_message_id, r.id)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {queue.length === 0 && (
        <div style={{ ...FUNNEL_CARD, color: "#8888A0", fontSize: 13 }}>
          Rien à rattacher. Les notifications non résolues apparaîtront ici au fil de l'ingestion.
        </div>
      )}

      {/* ── File ──────────────────────────────────────────────────── */}
      {queue.map(item => (
        <div key={item.club_message_id} style={FUNNEL_CARD}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#E8E8EE" }}>
                {item.player_name_raw ?? <em style={{ color: "#8888A0" }}>nom absent</em>}
              </div>
              <div style={{ fontSize: 12, color: "#8888A0", marginTop: 4 }}>
                {KIND_LABEL[item.kind] ?? item.kind} · {item.posted_at ?? "sans date"}
              </div>
              <div style={{ fontSize: 12, color: "#F5C518", marginTop: 6 }}>{item.note}</div>
            </div>
            <button
              onClick={() => { setOpenId(openId === item.club_message_id ? null : item.club_message_id); setQuery(""); setResults([]); }}
              style={btnStyle(openId === item.club_message_id)}
            >
              {openId === item.club_message_id ? "Fermer" : "Rattacher"}
            </button>
          </div>

          <details style={{ marginTop: 10 }}>
            <summary style={{ fontSize: 11, color: "#555568", cursor: "pointer" }}>message brut</summary>
            <div style={{ fontSize: 12, color: "#8888A0", marginTop: 6, wordBreak: "break-word" }}>
              {item.raw_text || <em>vide</em>}
            </div>
          </details>

          {openId === item.club_message_id && (
            <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 14 }}>
              {/* Candidats homonymes : le cas le plus fréquent, proposé d'emblée
                  pour éviter une recherche inutile. */}
              {item.candidates.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: "#555568", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Leads portant ce nom
                  </div>
                  {item.candidates.map(c => (
                    <LeadRow
                      key={c.id}
                      title={c.display_name ?? `tg:${c.telegram_id}`}
                      subtitle={`@${c.username ?? "—"} · ${c.source} · /start ${c.started_at}` +
                        (c.hours_before === null ? "" :
                          c.hours_before >= 0
                            ? ` · ${Math.round(c.hours_before)} h avant la notif`
                            : ` · ⚠️ ${Math.abs(Math.round(c.hours_before))} h APRÈS la notif`)}
                      disabled={busy}
                      onPick={() => attach(item.club_message_id, c.id)}
                    />
                  ))}
                </div>
              )}

              <div style={{ fontSize: 11, color: "#555568", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Chercher un autre lead
              </div>
              <input
                value={query}
                onChange={e => search(e.target.value)}
                placeholder="nom, @handle ou telegram_id"
                autoFocus
                style={{
                  width: "100%", padding: "8px 12px", borderRadius: 8, fontSize: 13,
                  background: "#0B0D12", border: "1px solid rgba(255,255,255,0.1)", color: "#E8E8EE",
                }}
              />
              <div style={{ marginTop: 8 }}>
                {results.map(r => (
                  <LeadRow
                    key={r.id}
                    title={r.display_name ?? `tg:${r.telegram_id}`}
                    subtitle={`@${r.username ?? "—"} · ${r.source} · /start ${r.started_at}` +
                      (r.bound_at ? ` · déjà rattaché le ${r.bound_at}` : "")}
                    disabled={busy}
                    onPick={() => attach(item.club_message_id, r.id)}
                  />
                ))}
                {query.trim().length >= 2 && results.length === 0 && (
                  <div style={{ fontSize: 12, color: "#8888A0", padding: "8px 0" }}>Aucun lead trouvé.</div>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Tile({ label, value, accent, hint }: { label: string; value: React.ReactNode; accent?: string; hint?: string }) {
  return (
    <div style={FUNNEL_CARD}>
      <div style={{ fontSize: 11, color: "#555568", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: accent ?? "#E8E8EE", marginTop: 6 }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: "#555568", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function LeadRow({ title, subtitle, onPick, disabled }: {
  title: string; subtitle: string; onPick: () => void; disabled: boolean;
}) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
      padding: "8px 10px", borderRadius: 8, background: "#0B0D12", marginBottom: 6,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, color: "#E8E8EE" }}>{title}</div>
        <div style={{ fontSize: 11, color: "#8888A0", marginTop: 2 }}>{subtitle}</div>
      </div>
      <button onClick={onPick} disabled={disabled} style={btnStyle(false, disabled)}>
        Relier
      </button>
    </div>
  );
}

function btnStyle(active: boolean, disabled = false): React.CSSProperties {
  return {
    padding: "7px 14px", borderRadius: 999, fontSize: 12, fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    background: active ? "rgba(255,255,255,0.08)" : "rgba(16,185,129,0.15)",
    border: `1px solid ${active ? "rgba(255,255,255,0.12)" : "rgba(16,185,129,0.3)"}`,
    color: active ? "#8888A0" : "#10B981",
    opacity: disabled ? 0.5 : 1,
    whiteSpace: "nowrap",
  };
}
