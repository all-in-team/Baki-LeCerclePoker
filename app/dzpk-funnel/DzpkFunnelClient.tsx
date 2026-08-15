"use client";

// Table des leads dzpk — même gabarit que le funnel Nexa (cards de conversion,
// chips de filtre, table dans une FUNNEL_CARD), avec les composants partagés de
// components/funnel/.
//
// Ce qui diffère de Nexa, et pourquoi :
//   • une colonne « Matching » à la place des colonnes Σ — sur ce funnel, le
//     risque n'est pas seulement de rater une réponse mais d'attribuer un
//     rattachement (donc du revenu) au mauvais lead ;
//   • deux signaux de conversation au lieu d'un : « ⏳ à répondre » (le dernier
//     message vient du lead) et « 💬 N » (non lus). Le premier ne s'éteint qu'à
//     l'envoi — ouvrir un fil sans répondre ne doit pas effacer une question ;
//   • le fil s'ouvre sur N'IMPORTE quelle ligne, pas seulement sur les leads qui
//     ont écrit : écrire le premier à un lead est un usage à part entière.

import { useMemo, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import ConversationPanel from "@/components/funnel/ConversationPanel";
import type { DzpkDashboardLead, DzpkPendingMatch } from "@/lib/funnels/dzpk/dashboard";
import type { DzpkWeeklyRow, DzpkAbStatsRow } from "@/lib/funnels/dzpk/report";
import type { CommissionTotalRow } from "@/lib/funnels/dzpk/ingest";
import { DZPK_STAGES, DZPK_CARDS, MATCH_LABELS } from "@/lib/funnels/dzpk/stages";
import { buildConversionCards, stageDef, fmtAmount, fmtDateTime, type ConversionCard } from "@/lib/funnels/shared";
import ConversionCards from "@/components/funnel/ConversionCards";
import { BlockedBadge } from "@/components/funnel/Badges";
import { FUNNEL_CARD } from "@/components/funnel/styles";
import DzpkBroadcastPanel from "./DzpkBroadcastPanel";

// Formes recopiées plutôt qu'importées de lib/funnels/dzpk/broadcast : ce
// fichier est un composant client, il ne doit pas tirer better-sqlite3 dans le
// bundle navigateur. Même parti pris que DzpkReconciliationClient.
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

const CARD_BG = "#11141A";

/** Date compacte « MM-JJ hh:mm » — découpe de chaîne, aucun parsing : le fuseau ne bouge pas. */
function fmtDateShort(s: string | null): string {
  if (!s) return "—";
  return s.slice(5, 16).replace("T", " ");
}

function leadName(lead: DzpkDashboardLead): string {
  if (lead.username) return `@${lead.username}`;
  if (lead.display_name) return lead.display_name;
  return `tg:${lead.telegram_id}`;
}

/**
 * Card « Commissions encaissées ».
 *
 * Un montant PAR DEVISE, juxtaposés, jamais additionnés (invariant #3). Le
 * montant affiché est le PAYÉ (`total_paid`), pas le demandé : c'est ce qui est
 * réellement arrivé.
 */
function commissionCard(rows: CommissionTotalRow[]): ConversionCard {
  const n = rows.reduce((a, r) => a + r.n, 0);
  if (rows.length === 0) {
    return { label: "Commissions encaissées", count: 0, value: "—", sub: "aucun paiement reçu" };
  }
  return {
    label: "Commissions encaissées",
    count: n,
    value: rows.map(r => `${fmtAmount(r.total_paid)} ${r.currency}`).join(" · "),
    sub: rows.length === 1
      ? `${n} paiement${n > 1 ? "s" : ""} · demandé ${fmtAmount(rows[0].total_requested)}`
      : `${n} paiement${n > 1 ? "s" : ""} · ${rows.length} devises`,
  };
}

function FilterChip({ active, tone, onClick, title, children }: {
  active: boolean;
  tone?: "warn";
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  const accent = tone === "warn" ? "#F0B90B" : "#E8E8EE";
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: "5px 11px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
        border: `1px solid ${active ? (tone === "warn" ? "rgba(240,185,11,0.4)" : "rgba(255,255,255,0.22)") : "rgba(255,255,255,0.1)"}`,
        background: active ? (tone === "warn" ? "rgba(240,185,11,0.10)" : "rgba(255,255,255,0.06)") : CARD_BG,
        color: active ? accent : "#8888A0",
      }}
    >
      {children}
    </button>
  );
}

const COLUMNS = [
  { key: "lead", label: "Lead" },
  { key: "source", label: "Source" },
  { key: "stage", label: "Étape" },
  { key: "dates", label: "Arrivé / rattaché", title: "Date du /start, puis date du rattachement au club (已绑定为代理)" },
  { key: "match", label: "Matching", title: "Fiabilité du rattachement aux notifications du club" },
];

export default function DzpkFunnelClient({ leads, commissions, pending, orphans, broadcasts, guard, weekly, abStats }: {
  leads: DzpkDashboardLead[];
  commissions: CommissionTotalRow[];
  pending: DzpkPendingMatch[];
  orphans: number;
  broadcasts: BroadcastRow[];
  guard: Guard;
  weekly: DzpkWeeklyRow[];
  abStats: DzpkAbStatsRow[];
}) {
  const [filter, setFilter] = useState<"all" | "pending" | "awaiting">("all");
  const [showQueue, setShowQueue] = useState(false);
  const [showWeekly, setShowWeekly] = useState(false);
  const [tab, setTab] = useState<"leads" | "broadcast">("leads");
  const [openLead, setOpenLead] = useState<DzpkDashboardLead | null>(null);
  const router = useRouter();

  // Rafraîchit les pastilles après un envoi : le serveur recalcule `unread`.
  const refresh = useCallback(() => router.refresh(), [router]);

  // Échap ferme le fil — même convention que le drawer Nexa.
  useEffect(() => {
    if (!openLead) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenLead(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openLead]);

  const pendingCount = useMemo(() => leads.filter(l => l.match === "pending").length, [leads]);
  const awaitingCount = useMemo(() => leads.filter(l => l.awaiting_reply).length, [leads]);
  const visibleLeads = useMemo(() => {
    if (filter === "pending") return leads.filter(l => l.match === "pending");
    if (filter === "awaiting") return leads.filter(l => l.awaiting_reply);
    return leads;
  }, [leads, filter]);

  const cards = [...buildConversionCards(leads, DZPK_CARDS), commissionCard(commissions)];

  if (tab === "broadcast") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <Tabs tab={tab} setTab={setTab} leadCount={leads.length} />
        <DzpkBroadcastPanel
          // Le panneau ne reçoit QUE ce qu'il segmente. Lui passer la ligne
          // complète l'exposerait au reste du modèle de lead pour rien.
          leads={leads.map(l => ({
            source: l.source, state: l.state, blocked: l.blocked, banned_at: l.banned_at,
          }))}
          initialBroadcasts={broadcasts}
          initialGuard={guard}
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Tabs tab={tab} setTab={setTab} leadCount={leads.length} />
      <ConversionCards cards={cards} />

      {/* Dit une fois, en clair, ce que les commissions NE sont pas. Le schéma le
          dit déjà (dzpk_commissions), mais personne ne lit un CREATE TABLE avant
          de lire un chiffre à l'écran. */}
      <div style={{ fontSize: 11, color: "#555568", marginTop: -8 }}>
        Commissions = notifications de paiement du club, au niveau agent. Elles n&apos;alimentent
        ni les wallets, ni le P&amp;L, ni les règlements — aucun rapprochement avec les USDT
        réellement reçus n&apos;est fait ici.
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
          Tous ({leads.length})
        </FilterChip>
        {/* En tête des filtres parce que c'est le seul qui porte une demande
            adressée à un humain : quelqu'un a écrit et attend. */}
        <FilterChip active={filter === "awaiting"} tone="warn" onClick={() => setFilter("awaiting")}
          title="Leads dont le dernier message est le leur — ils attendent une réponse">
          ⏳ À répondre ({awaitingCount})
        </FilterChip>
        <FilterChip active={filter === "pending"} tone="warn" onClick={() => setFilter("pending")}
          title="Leads cités par une notification du club qui n'a pas encore été tranchée">
          🟡 À réconcilier ({pendingCount})
        </FilterChip>
        {pending.length > 0 && (
          <FilterChip active={showQueue} onClick={() => setShowQueue(v => !v)}
            title="Notifications du club en attente d'une décision humaine">
            📥 File de réconciliation ({pending.length})
          </FilterChip>
        )}
        <FilterChip active={showWeekly} onClick={() => setShowWeekly(v => !v)}
          title="Clic → start → join → rattaché, par semaine de /start et par source">
          📊 Rapport hebdo
        </FilterChip>
        <span style={{ fontSize: 11, color: "#3A3A48" }}>
          Lecture seule — le rattachement manuel passe par l&apos;API admin.
        </span>
      </div>

      {/* Les notifications qui ne citent AUCUN lead ne peuvent pas apparaître dans
          le tableau : sans cette ligne, elles seraient invisibles alors qu'elles
          portent potentiellement du revenu. */}
      {orphans > 0 && (
        <div style={{
          ...FUNNEL_CARD, padding: "10px 14px", fontSize: 12,
          border: "1px solid rgba(240,185,11,0.28)", background: "rgba(240,185,11,0.05)", color: "#F0B90B",
        }}>
          ⚠️ {orphans} notification{orphans > 1 ? "s" : ""} du club ne correspond{orphans > 1 ? "ent" : ""} à
          aucun lead connu — invisible{orphans > 1 ? "s" : ""} dans le tableau ci-dessous.
          {pending.length > 0 && " Voir « File de réconciliation »."}
        </div>
      )}

      {showQueue && <ReconciliationQueue rows={pending} />}

      {showWeekly && <WeeklyReport rows={weekly} abStats={abStats} />}

      <div style={{ ...FUNNEL_CARD, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
              {COLUMNS.map(c => (
                <th key={c.key} title={c.title} style={{
                  textAlign: "left", padding: "12px 14px", fontSize: 10.5, fontWeight: 700,
                  color: "#555568", textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap",
                }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && (
              <tr><td colSpan={COLUMNS.length} style={{ padding: 24, textAlign: "center", color: "#555568" }}>
                Aucun lead pour l&apos;instant — chaque <code style={{ color: "#8888A0" }}>/start</code> sur
                le bot dzpk atterrit ici, avec la source de son deep link.
              </td></tr>
            )}
            {leads.length > 0 && visibleLeads.length === 0 && (
              <tr><td colSpan={COLUMNS.length} style={{ padding: 24, textAlign: "center", color: "#555568" }}>
                {filter === "awaiting"
                  ? "Personne n'attend de réponse. 👌"
                  : "Aucun lead en attente de réconciliation. 👌"}
              </td></tr>
            )}
            {visibleLeads.map(lead => (
              <LeadRow key={lead.id} lead={lead} onOpen={() => setOpenLead(lead)} />
            ))}
          </tbody>
        </table>
      </div>

      {openLead && (
        <ConversationDrawer
          key={openLead.id}
          lead={openLead}
          onClose={() => setOpenLead(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

/**
 * Fil de conversation d'un lead, en tiroir.
 *
 * En tiroir plutôt qu'en ligne dépliée dans le tableau, pour la raison déjà
 * constatée côté Nexa : dans le conteneur du tableau, le panneau sortait de
 * l'écran avec le reste du défilement et le champ de réponse devenait
 * inatteignable dès que l'historique s'allongeait.
 */
function ConversationDrawer({ lead, onClose, onChanged }: {
  lead: DzpkDashboardLead;
  onClose: () => void;
  onChanged: () => void;
}) {
  return (
    <div style={{
      position: "fixed", top: 0, right: 0, bottom: 0, width: "min(560px, 92vw)",
      background: "#0D1015", borderLeft: "1px solid rgba(255,255,255,0.08)",
      boxShadow: "-24px 0 48px rgba(0,0,0,0.45)", zIndex: 50,
      display: "flex", flexDirection: "column", padding: 18, gap: 12,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flex: "none" }}>
        <span style={{ color: "#E8E8EE", fontWeight: 700, fontSize: 15 }}>{leadName(lead)}</span>
        <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: "rgba(96,165,250,0.12)", color: "#60A5FA", fontWeight: 600 }}>
          {lead.source_label}
        </span>
        <span style={{ color: stageDef(DZPK_STAGES, lead.state).color, fontSize: 12, fontWeight: 600 }}>
          {stageDef(DZPK_STAGES, lead.state).label}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={{
          background: "transparent", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8,
          color: "#8888A0", padding: "4px 10px", fontSize: 11.5, cursor: "pointer", fontFamily: "inherit",
        }}>Fermer ✕</button>
      </div>

      <div style={{ fontSize: 11, color: "#3A3A48", flex: "none" }}>
        /start le {fmtDateTime(lead.started_at)} · tg:{lead.telegram_id}
      </div>

      <ConversationPanel
        leadId={lead.id}
        endpoint="/api/dzpk-funnel/conversation"
        emptyHint="Aucun message. Le lead n'a encore rien écrit au bot — l'accueil l'invite à répondre ici."
        // Pas de takeover côté dzpk : le bot n'a aucun scénario à reprendre,
        // donc rien n'est « repoussé » par un envoi.
        sendHint="⌘/Ctrl + Entrée pour envoyer · le lead reçoit le message du bot"
        onChanged={onChanged}
      />
    </div>
  );
}

function Tabs({ tab, setTab, leadCount }: {
  tab: "leads" | "broadcast";
  setTab: (t: "leads" | "broadcast") => void;
  leadCount: number;
}) {
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <FilterChip active={tab === "leads"} onClick={() => setTab("leads")}>
        Leads ({leadCount})
      </FilterChip>
      <FilterChip active={tab === "broadcast"} onClick={() => setTab("broadcast")}
        title="Pousser un message à tous les leads ayant fait /start — segmentable par étape et par source">
        📣 Diffusion
      </FilterChip>
    </div>
  );
}

function LeadRow({ lead, onOpen }: { lead: DzpkDashboardLead; onOpen: () => void }) {
  const stage = stageDef(DZPK_STAGES, lead.state);
  const match = MATCH_LABELS[lead.match];
  const td: React.CSSProperties = { padding: "10px 14px", whiteSpace: "nowrap" };

  return (
    <tr onClick={onOpen} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", opacity: lead.blocked ? 0.5 : 1, cursor: "pointer" }}>
      <td style={td}>
        <span style={{ color: "#E8E8EE", fontWeight: 600 }}>{leadName(lead)}</span>
        {/* Le display_name est répété à côté du @handle : c'est LUI que le club
            reprend, donc lui qu'on compare quand un rattachement est douteux. */}
        {lead.display_name && lead.username && (
          <span style={{ color: "#555568", marginLeft: 6 }} title="Nom du compte Telegram — clé d'appariement avec le club">
            {lead.display_name}
          </span>
        )}
        {lead.blocked === 1 && <BlockedBadge />}
        {lead.banned_at && (
          <span style={{ marginLeft: 6, fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(239,68,68,0.12)", color: "#F87171", fontWeight: 700 }}
            title={`Banni par le club le ${fmtDateTime(lead.banned_at)} — il avait bel et bien été rattaché, son étape ne recule pas`}>
            🚫 BANNI
          </span>
        )}
        {lead.start_count > 1 && (
          <span style={{ marginLeft: 6, fontSize: 10, color: "#555568" }} title={`${lead.start_count} /start — la source retenue reste celle du premier`}>
            ×{lead.start_count}
          </span>
        )}
        {/* Deux signaux distincts, et l'écart entre eux est délibéré.
            « À répondre » ne s'éteint qu'à l'ENVOI : ouvrir un fil sans répondre
            ne doit pas faire disparaître une question. Le compteur de non-lus,
            lui, s'éteint à la lecture — il dit « du nouveau », pas « ça
            attend ». Confondre les deux, c'est perdre les questions lues. */}
        {lead.awaiting_reply && (
          <span style={{
            marginLeft: 6, fontSize: 10, padding: "2px 6px", borderRadius: 999,
            background: "rgba(240,185,11,0.16)", color: "#F0B90B", fontWeight: 700,
          }} title="Le dernier message vient du lead — il attend une réponse">
            ⏳ à répondre
          </span>
        )}
        {lead.unread > 0 && (
          <span style={{
            marginLeft: 6, fontSize: 10, padding: "2px 6px", borderRadius: 999,
            background: "rgba(96,165,250,0.16)", color: "#60A5FA", fontWeight: 700,
          }} title={`${lead.unread} message(s) non lu(s)`}>
            💬 {lead.unread}
          </span>
        )}
      </td>
      <td style={{ ...td, color: "#60A5FA" }}>
        <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: "rgba(96,165,250,0.12)", fontWeight: 600 }}
          title={lead.source_label === lead.source ? undefined : `source brute : ${lead.source}`}>
          {lead.source_label}
        </span>
      </td>
      <td style={{ ...td, color: stage.color, fontWeight: 600 }}>{stage.label}</td>
      <td style={{ padding: "10px 14px" }}>
        <div style={{ color: "#8888A0", whiteSpace: "nowrap" }} title={`/start le ${fmtDateTime(lead.started_at)}`}>
          🚀 {fmtDateShort(lead.started_at)}
        </div>
        <div style={{ color: lead.bound_at ? "#34D399" : "#3A3A48", whiteSpace: "nowrap" }}
          title={lead.bound_at ? `Rattaché le ${fmtDateTime(lead.bound_at)}` : "Pas encore rattaché au club"}>
          🍓 {fmtDateShort(lead.bound_at)}
        </div>
      </td>
      <td style={{ ...td, color: match.color, fontWeight: 600 }}
        title={`${match.title}${lead.match_auto + lead.match_manual > 0 ? ` · ${lead.match_auto + lead.match_manual} notification(s) rattachée(s)` : ""}`}>
        {match.label}
        {lead.match === "pending" && lead.match_pending > 1 && (
          <span style={{ marginLeft: 4, fontWeight: 400 }}>×{lead.match_pending}</span>
        )}
      </td>
    </tr>
  );
}

/** `n/d` en pourcentage lisible — « — » plutôt qu'un NaN quand le dénominateur est nul. */
function pct(n: number, d: number): string {
  if (!d) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

/**
 * Rapport hebdo : cohortes par semaine de /start × source. La dépense vit chez
 * les réseaux — le coût par étape se lit en rapprochant ce tableau des stats de
 * campagne (cf. lib/funnels/dzpk/report.ts).
 */
function WeeklyReport({ rows, abStats }: { rows: DzpkWeeklyRow[]; abStats: DzpkAbStatsRow[] }) {
  const th: React.CSSProperties = {
    textAlign: "left", padding: "8px 12px", fontSize: 10.5, fontWeight: 700,
    color: "#555568", textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap",
  };
  const td: React.CSSProperties = { padding: "7px 12px", whiteSpace: "nowrap", color: "#8888A0" };

  // Une ligne de séparation visuelle à chaque changement de semaine.
  let lastWeek: string | null = null;

  return (
    <div style={{ ...FUNNEL_CARD, padding: 14 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: "#555568", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
        Rapport hebdo — cohortes par semaine de /start
      </div>

      {abStats.length > 0 && (
        <div style={{ marginBottom: 12, fontSize: 12, display: "flex", gap: 18, flexWrap: "wrap" }}>
          {abStats.map(v => (
            <div key={v.variant} style={{ color: "#8888A0" }}>
              <span style={{ fontWeight: 700, color: v.variant === "B" ? "#F0B90B" : "#60A5FA" }}>
                Accueil {v.variant}
              </span>{" "}
              · {v.leads} leads · bloqués {v.blocked} ({pct(v.blocked, v.leads)}) ·
              join {v.joined} ({pct(v.joined, v.leads)}) · rattachés {v.bound}
            </div>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: "#555568" }}>Aucune donnée sur la période.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                <th style={th}>Semaine du</th>
                <th style={th}>Source</th>
                <th style={th} title="Clics uniques captés par /go cette semaine-là">Clics</th>
                <th style={th}>Starts</th>
                <th style={th} title="starts / clics">Clic→start</th>
                <th style={th}>Joins</th>
                <th style={th} title="joins / starts (cohorte)">Start→join</th>
                <th style={th}>Rattachés</th>
                <th style={th}>Bloqués</th>
                <th style={th} title="Leads de la cohorte ayant reçu la relance J+1">Relancés</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const newWeek = r.week !== lastWeek;
                lastWeek = r.week;
                return (
                  <tr key={`${r.week}|${r.source}`} style={{
                    borderTop: newWeek ? "1px solid rgba(255,255,255,0.10)" : "1px solid rgba(255,255,255,0.03)",
                  }}>
                    <td style={{ ...td, color: newWeek ? "#E8E8EE" : "#3A3A48", fontWeight: newWeek ? 600 : 400 }}>
                      {r.week}
                    </td>
                    <td style={{ ...td, color: "#60A5FA" }}>{r.source_label}</td>
                    <td style={td}>{r.clicks || "—"}</td>
                    <td style={{ ...td, color: "#E8E8EE", fontWeight: 600 }}>{r.starts || "—"}</td>
                    <td style={td}>{pct(r.starts, r.clicks)}</td>
                    <td style={{ ...td, color: r.joined ? "#F0B90B" : undefined }}>{r.joined || "—"}</td>
                    <td style={td}>{pct(r.joined, r.starts)}</td>
                    <td style={{ ...td, color: r.bound ? "#34D399" : undefined }}>{r.bound || "—"}</td>
                    <td style={{ ...td, color: r.blocked ? "#F87171" : undefined }}>{r.blocked || "—"}</td>
                    <td style={td}>{r.followups || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontSize: 11, color: "#3A3A48", marginTop: 10 }}>
        Joins et rattachements comptés dans la semaine du /start de leur lead (cohorte) — les
        chiffres d&apos;une semaine récente bougent tant que sa cohorte vit. La dépense reste chez
        les réseaux : rapprocher ce tableau des stats de campagne pour le coût par étape.
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  join: "👥 已进群",
  bound: "🍓 已绑定为代理",
  banned: "🚫 封号",
};

/**
 * File de réconciliation — ce qui attend une décision, notification par
 * notification. Read-only : les candidats sont affichés avec leur id, qui est
 * l'argument à passer à l'API admin (`action: "resolve"`).
 */
function ReconciliationQueue({ rows }: { rows: DzpkPendingMatch[] }) {
  return (
    <div style={{ ...FUNNEL_CARD, padding: 14 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: "#555568", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
        File de réconciliation ({rows.length})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 320, overflowY: "auto" }}>
        {rows.map(r => (
          <div key={r.club_message_id} style={{ fontSize: 12, borderBottom: "1px solid rgba(255,255,255,0.04)", paddingBottom: 8 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
              <span style={{ color: "#8888A0", fontFamily: "monospace" }}>#{r.club_message_id}</span>
              <span style={{ color: "#E8E8EE" }}>{KIND_LABEL[r.parsed_kind] ?? r.parsed_kind}</span>
              <span style={{ color: "#E8E8EE", fontWeight: 600 }}>{r.player_name_raw ?? "—"}</span>
              <span style={{ color: "#555568" }}>{fmtDateTime(r.posted_at)}</span>
              <span style={{ color: r.status === "unmatched" ? "#F87171" : "#F0B90B" }}>
                {r.status === "unmatched" ? "aucun candidat" : r.note || "à trancher"}
              </span>
            </div>
            {r.candidates.length > 0 && (
              <div style={{ marginTop: 3, color: "#8888A0", fontSize: 11.5 }}>
                Candidats :{" "}
                {r.candidates.map(c => (
                  <span key={c.id} style={{ marginRight: 10 }}>
                    <span style={{ fontFamily: "monospace", color: "#60A5FA" }}>#{c.id}</span> {c.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "#3A3A48", marginTop: 10 }}>
        Trancher : <code>POST /api/admin/dzpk-ingest</code> ·{" "}
        <code>{`{"action":"resolve","club_message_id":N,"lead_id":M,"operator":"baki"}`}</code>
      </div>
    </div>
  );
}
