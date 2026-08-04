"use client";

// Table des leads Nexa + drawer conversation.
//
// Le panneau conversation était rendu comme une ligne dépliée DANS le conteneur de
// tableau à scroll horizontal : dès qu'on scrollait vers les colonnes Σ, la
// conversation sortait de l'écran avec le reste. Il vit maintenant dans un drawer
// ancré au viewport (position fixed), donc totalement indépendant du scroll de la
// table — et la table reste utilisable à côté pour passer d'un lead à l'autre.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { NexaLeadWithStats, NexaWeeklyStat, NexaLeadEvent } from "@/lib/nexa-funnel";
import { NEXA_STAGES, NEXA_CARDS } from "@/lib/funnels/nexa/config";
import {
  buildConversionCards, groupByMember, stageDef, verificationState,
  fmtAmount, fmtDateTime, hasPlayed,
} from "@/lib/funnels/shared";
import ConversionCards from "@/components/funnel/ConversionCards";
import WeeklyImportPanel from "@/components/funnel/WeeklyImportPanel";
import WeeklyEvolutionTable, { type WeeklyColumn } from "@/components/funnel/WeeklyEvolutionTable";
import { VerifiedBadge, PlayedBadge, BlockedBadge, LangBadge } from "@/components/funnel/Badges";
import { SignedAmount } from "@/components/funnel/Amounts";
import ConversationPanel from "@/components/funnel/ConversationPanel";
import { usePendingCount } from "@/components/funnel/usePendingCount";
import { FUNNEL_CARD } from "@/components/funnel/styles";
import {
  markDepositAction, relanceAction, createGroupAction, previewGroupAction, saveNotesAction,
  handoverToBotAction, stopRelancesAction,
} from "./actions";

// NEXAPOKER n'a ni insurance ni rewards (pas de rakeback) — 4 colonnes seulement.
const WEEKLY_COLUMNS: WeeklyColumn<NexaWeeklyStat>[] = [
  { label: "Rake", value: r => r.rake, tone: "bright" },
  { label: "Dépôts", value: r => r.deposits },
  { label: "Retraits", value: r => r.withdrawals },
  { label: "Win/Loss", value: r => r.winloss, tone: "signed" },
];

const OS_LABEL: Record<string, string> = { windows: "🪟", android: "🤖", mac: "🍎" };

const DRAWER_WIDTH = 520;
/** Largeurs FIXES des deux colonnes figées — un `left` sticky exige de les connaître. */
const W_LEAD = 240;
const W_UNREAD = 150;
/** En dessous, les colonnes Σ sont masquées par défaut (toggle « Colonnes chiffres »). */
const WIDE_VIEWPORT_PX = 1500;

const CARD_BG = "#11141A";
const ROW_BG_SELECTED = "#191D26";

type Col = {
  key: string;
  label: string;
  align?: "right";
  /** Décalage sticky en px ; absent = colonne normale. */
  stickyLeft?: number;
  width?: number;
  /** Colonne chiffrée, masquable par le toggle. */
  numeric?: boolean;
};

const COLUMNS: Col[] = [
  { key: "lead", label: "Lead", stickyLeft: 0, width: W_LEAD },
  { key: "unread", label: "💬", stickyLeft: W_LEAD, width: W_UNREAD },
  { key: "stage", label: "Étape" },
  { key: "member", label: "ID joueur" },
  { key: "os", label: "OS" },
  { key: "group", label: "Groupe" },
  { key: "started", label: "Started" },
  { key: "deposit", label: "Dépôt" },
  { key: "relances", label: "Relances" },
  { key: "questions", label: "❓" },
  { key: "weeks", label: "Semaines", align: "right" },
  { key: "rake", label: "Σ Rake", align: "right", numeric: true },
  { key: "dep", label: "Σ Dépôts", align: "right", numeric: true },
  { key: "wd", label: "Σ Retraits", align: "right", numeric: true },
  { key: "wl", label: "Σ Win/Loss", align: "right", numeric: true },
];

/** Lien vers le sujet Telegram du lead — même construction que côté serveur. */
function topicUrl(lead: NexaLeadWithStats): string | null {
  if (!lead.admin_thread_id || !lead.admin_topic_chat_id) return null;
  const s = String(lead.admin_topic_chat_id);
  if (!s.startsWith("-100")) return null;
  return `https://t.me/c/${s.slice(4)}/${lead.admin_thread_id}`;
}

function leadName(lead: NexaLeadWithStats): string {
  return lead.tg_username ? `@${lead.tg_username}` : (lead.first_name ?? `tg:${lead.tg_user_id}`);
}

/**
 * Un lead « à répondre » : message non lu, OU question restée sans réponse.
 *
 * On teste `question_open` et NON `awaiting_human` : le silence du bot expire à
 * 90 min, pas la question. Qu'un scénario ait repris la main ne veut pas dire que
 * quelqu'un a répondu au lead — il doit rester dans la liste jusqu'à ce que ce soit
 * vrai.
 */
function needsReply(lead: NexaLeadWithStats): boolean {
  return lead.unread === 1 || lead.question_open === 1;
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

/** Pastille « message non lu » + horodatage du dernier message du lead. */
function UnreadCell({ lead }: { lead: NexaLeadWithStats }) {
  const unread = lead.unread === 1;
  const muted = lead.awaiting_human === 1;
  const open = lead.question_open === 1;
  const flag = unread || open;
  if (!lead.last_lead_msg_at && !open) return <span style={{ color: "#3A3A48" }}>—</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
      <span
        style={{
          width: 7, height: 7, borderRadius: "50%",
          background: flag ? "#F0B90B" : "rgba(255,255,255,0.12)",
          boxShadow: flag ? "0 0 0 3px rgba(240,185,11,0.15)" : "none", flexShrink: 0,
        }}
        title={open ? "Question sans réponse" : unread ? "Message non lu" : "Lu"}
      />
      <span style={{ color: flag ? "#F0B90B" : "#555568", fontWeight: flag ? 700 : 400 }}>
        {lead.last_lead_msg_at ? fmtDateTime(lead.last_lead_msg_at) : "en attente"}
      </span>
      {/* 🙋 = le bot est muselé · ❓ = question ouverte mais le bot a repris la main. */}
      {muted && <span title="Le bot est muselé : le lead attend un humain">🙋</span>}
      {!muted && open && <span title="Question sans réponse — le bot a repris la main après 90 min">❓</span>}
      {lead.takeover_active === 1 && (
        <span style={{ color: "#34D399" }} title="Takeover actif — aucun message automatique n'est envoyé">🎙</span>
      )}
    </span>
  );
}

export default function NexaFunnelClient({ leads, stats, events }: {
  leads: NexaLeadWithStats[];
  stats: NexaWeeklyStat[];
  events: NexaLeadEvent[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<number | null>(null);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [showNumbers, setShowNumbers] = useState(true);
  const tableRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // `?lead=<id>` — cible du lien « Fiche dans le back-office » de la carte contexte
  // épinglée dans le sujet Telegram. Lu depuis window plutôt que via useSearchParams
  // pour ne pas imposer de frontière Suspense au rendu de la table.
  //
  // Les colonnes Σ sont masquées d'office sur écran étroit : dans l'usage courant
  // (répondre aux leads) elles ne servent pas, et leur seule présence imposait un
  // scroll horizontal à toute la table.
  useEffect(() => {
    setShowNumbers(window.innerWidth >= WIDE_VIEWPORT_PX);
    const wanted = Number(new URLSearchParams(window.location.search).get("lead"));
    if (!Number.isInteger(wanted) || wanted <= 0) return;
    setSelected(wanted);
    requestAnimationFrame(() => {
      document.getElementById(`lead-${wanted}`)?.scrollIntoView({ block: "center" });
    });
  }, []);

  const close = useCallback(() => setSelected(null), []);

  // Échap ferme le drawer.
  useEffect(() => {
    if (selected === null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, close]);

  // Clic extérieur — mais la TABLE ne compte pas comme extérieur : cliquer une autre
  // ligne doit changer de lead, pas fermer le drawer. Un overlay cliquable aurait
  // rendu ces deux exigences incompatibles ; il est donc purement visuel
  // (pointer-events: none) et la détection se fait ici.
  useEffect(() => {
    if (selected === null) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (drawerRef.current?.contains(t)) return;
      if (tableRef.current?.contains(t)) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [selected, close]);

  const localReplyCount = useMemo(() => leads.filter(needsReply).length, [leads]);
  // Le compteur du serveur (poll 30 s) prime sur celui calculé depuis les lignes
  // rendues : la page peut rester ouverte des heures pendant que des leads arrivent.
  const pending = usePendingCount(localReplyCount, "Nexa Funnel");
  const replyCount = pending.count;
  const visibleLeads = useMemo(
    () => (onlyUnread ? leads.filter(needsReply) : leads),
    [leads, onlyUnread],
  );

  const statsByMember = useMemo(() => groupByMember(stats), [stats]);
  const eventsByLead = useMemo(() => {
    const m: Record<number, NexaLeadEvent[]> = {};
    for (const e of events) (m[e.lead_id] ??= []).push(e);
    return m;
  }, [events]);
  const cards = buildConversionCards(leads, NEXA_CARDS);

  const cols = useMemo(() => COLUMNS.filter(c => showNumbers || !c.numeric), [showNumbers]);
  const selectedLead = selected === null ? null : (leads.find(l => l.id === selected) ?? null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <ConversionCards cards={cards} />

      <WeeklyImportPanel
        endpoint="/api/nexa-funnel/import"
        onImported={() => router.refresh()}
        description={
          <>
            Chiffres de la <b>semaine passée</b> — seuls les Member ID enregistrés par un lead du funnel sont importés, le reste du back-office est ignoré. Ré-uploader la même semaine écrase (correction).
          </>
        }
      />

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <FilterChip active={!onlyUnread} onClick={() => setOnlyUnread(false)}>
          Tous ({leads.length})
        </FilterChip>
        <FilterChip active={onlyUnread} tone="warn" onClick={() => setOnlyUnread(true)}
          title="Messages non lus et questions restées sans réponse">
          🔴 À répondre ({replyCount})
        </FilterChip>
        <FilterChip active={showNumbers} onClick={() => setShowNumbers(v => !v)}
          title="Affiche ou masque Σ Rake / Dépôts / Retraits / Win-Loss">
          Σ Colonnes chiffres
        </FilterChip>
        {pending.permission === "default" && (
          <FilterChip active={false} onClick={pending.requestPermission}
            title="Recevoir une notification navigateur quand un lead se met à attendre">
            🔔 Activer les notifications
          </FilterChip>
        )}
        <span style={{ fontSize: 11, color: "#3A3A48" }}>
          Clique une ligne pour ouvrir la conversation.
        </span>
      </div>

      <div ref={tableRef} style={{ ...FUNNEL_CARD, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5 }}>
          <thead>
            <tr>
              {cols.map(c => (
                <th key={c.key} style={{
                  textAlign: c.align === "right" ? "right" : "left",
                  padding: "12px 14px", fontSize: 10.5, fontWeight: 700, color: "#555568",
                  textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap",
                  borderBottom: "1px solid rgba(255,255,255,0.07)",
                  ...(c.width ? { width: c.width, minWidth: c.width } : {}),
                  // Les cellules figées doivent être OPAQUES, sinon le contenu qui
                  // défile dessous transparaît. z-index 3 pour passer au-dessus des
                  // cellules figées du corps (2), elles-mêmes au-dessus du reste.
                  ...(c.stickyLeft !== undefined
                    ? { position: "sticky" as const, left: c.stickyLeft, zIndex: 3, background: CARD_BG }
                    : {}),
                }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && (
              <tr><td colSpan={cols.length} style={{ padding: 24, textAlign: "center", color: "#555568" }}>
                Aucun lead pour l&apos;instant — partage le deep link <code style={{ color: "#8888A0" }}>t.me/LeCercle_Lebot?start=nexa</code>
              </td></tr>
            )}
            {leads.length > 0 && visibleLeads.length === 0 && (
              <tr><td colSpan={cols.length} style={{ padding: 24, textAlign: "center", color: "#555568" }}>
                Aucun message en attente de réponse. 👌
              </td></tr>
            )}
            {visibleLeads.map(lead => (
              <LeadRow
                key={lead.id}
                lead={lead}
                cols={cols}
                selected={selected === lead.id}
                onSelect={() => setSelected(lead.id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {selectedLead && (
        <>
          {/* Voile purement décoratif : il ne capte AUCUN clic, pour que la table
              reste utilisable pendant que le drawer est ouvert. */}
          <div style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
            pointerEvents: "none", zIndex: 40,
          }} />
          <LeadDrawer
            ref={drawerRef}
            lead={selectedLead}
            weekly={selectedLead.member_id ? (statsByMember[selectedLead.member_id] ?? []) : []}
            events={eventsByLead[selectedLead.id] ?? []}
            onClose={close}
            onChanged={() => router.refresh()}
          />
        </>
      )}
    </div>
  );
}

function LeadRow({ lead, cols, selected, onSelect }: {
  lead: NexaLeadWithStats;
  cols: Col[];
  selected: boolean;
  onSelect: () => void;
}) {
  const stage = stageDef(NEXA_STAGES, lead.stage);
  const rowBg = selected ? ROW_BG_SELECTED : CARD_BG;

  const cell = (c: Col): React.ReactNode => {
    switch (c.key) {
      case "lead":
        return (
          <div style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            <span style={{ color: "#E8E8EE", fontWeight: 600 }}>{leadName(lead)}</span>
            {lead.source !== "direct" && (
              <span style={{ marginLeft: 6, fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(96,165,250,0.12)", color: "#60A5FA", fontWeight: 600 }}>{lead.source}</span>
            )}
            <LangBadge lang={lead.lang} chosenAt={lead.lang_chosen_at} />
            {lead.blocked === 1 && <BlockedBadge />}
            {lead.cold === 1 && <span style={{ marginLeft: 6, fontSize: 10, color: "#8888A0" }}>🧊</span>}
            {hasPlayed(lead) && <PlayedBadge />}
          </div>
        );
      case "unread": return <UnreadCell lead={lead} />;
      case "stage": return <span style={{ color: stage.color, fontWeight: 600 }}>{stage.label}</span>;
      case "member":
        return (
          <span style={{ color: "#E8E8EE", fontFamily: "monospace" }}>
            {lead.member_id ?? "—"}
            {lead.nickname && <span style={{ color: "#555568", marginLeft: 6, fontFamily: "inherit" }}>({lead.nickname})</span>}
            <VerifiedBadge state={verificationState(lead.member_id, lead.weeks_count)} />
            {lead.duplicate_id === 1 && (
              <span style={{ marginLeft: 6, fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(239,68,68,0.12)", color: "#F87171", fontWeight: 700, fontFamily: "inherit" }} title="Ce lead a envoyé un ID déjà rattaché à un autre lead — rien n'a été écrasé">⚠️ DOUBLON</span>
            )}
          </span>
        );
      case "os": return <span style={{ color: "#8888A0" }}>{lead.os ? (OS_LABEL[lead.os] ?? lead.os) : "—"}</span>;
      case "group":
        return lead.group_invite_link ? (
          <>
            <a href={lead.group_invite_link} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color: "#34D399", fontSize: 11 }}>🔐 groupe</a>
            {!lead.group_joined_at && (
              <span style={{ marginLeft: 6, fontSize: 10, color: "#F0B90B" }} title="Groupe créé, le lead ne l'a pas encore rejoint">⏳</span>
            )}
          </>
        ) : lead.group_not_joined === 1 ? (
          <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(240,185,11,0.12)", color: "#F0B90B", fontWeight: 700 }} title="Groupe créé mais jamais rejoint dans les 24 h — il a été nettoyé, le lead est à relancer">⚠️ non rejoint</span>
        ) : <span style={{ color: "#555568" }}>—</span>;
      case "started": return <span style={{ color: "#8888A0" }}>{fmtDateTime(lead.created_at)}</span>;
      case "deposit": return <span style={{ color: lead.deposit_at ? "#34D399" : "#555568" }}>{fmtDateTime(lead.deposit_at)}</span>;
      case "relances": return <span style={{ color: lead.relances_count > 0 ? "#F0B90B" : "#555568" }}>{lead.relances_count}</span>;
      case "questions": return <span style={{ color: lead.questions_count > 0 ? "#F0B90B" : "#555568" }}>{lead.questions_count || "—"}</span>;
      case "weeks": return <span style={{ color: "#8888A0" }}>{lead.weeks_count || "—"}</span>;
      case "rake": return <span style={{ color: "#E8E8EE", fontWeight: 600 }}>{lead.weeks_count ? fmtAmount(lead.total_rake) : "—"}</span>;
      case "dep": return <span style={{ color: "#8888A0" }}>{lead.weeks_count ? fmtAmount(lead.total_deposits) : "—"}</span>;
      case "wd": return <span style={{ color: "#8888A0" }}>{lead.weeks_count ? fmtAmount(lead.total_withdrawals) : "—"}</span>;
      case "wl": return lead.weeks_count ? <SignedAmount value={lead.total_winloss} /> : <span style={{ color: "#555568" }}>—</span>;
      default: return null;
    }
  };

  return (
    <tr
      id={`lead-${lead.id}`}
      onClick={onSelect}
      style={{ opacity: lead.blocked ? 0.5 : 1, cursor: "pointer", background: rowBg }}
    >
      {cols.map(c => (
        <td key={c.key} style={{
          padding: "10px 14px", whiteSpace: "nowrap",
          textAlign: c.align === "right" ? "right" : "left",
          borderBottom: "1px solid rgba(255,255,255,0.04)",
          ...(c.width ? { width: c.width, minWidth: c.width, maxWidth: c.width } : {}),
          ...(c.stickyLeft !== undefined
            ? { position: "sticky" as const, left: c.stickyLeft, zIndex: 2, background: rowBg }
            : {}),
          // Le liseré de sélection vit sur la 1ʳᵉ colonne, qui est toujours visible
          // grâce au sticky : la ligne active reste repérable même scrollée à droite.
          ...(c.stickyLeft === 0 && selected ? { boxShadow: "inset 3px 0 0 #34D399" } : {}),
        }}>{cell(c)}</td>
      ))}
    </tr>
  );
}

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, color: "#555568",
  textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8,
};

const LeadDrawer = function LeadDrawer({ ref, lead, weekly, events, onClose, onChanged }: {
  ref: React.Ref<HTMLDivElement>;
  lead: NexaLeadWithStats;
  weekly: NexaWeeklyStat[];
  events: NexaLeadEvent[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const stage = stageDef(NEXA_STAGES, lead.stage);
  const url = topicUrl(lead);

  return (
    <aside
      ref={ref}
      style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: DRAWER_WIDTH, maxWidth: "100vw",
        background: CARD_BG, borderLeft: "1px solid rgba(255,255,255,0.10)",
        boxShadow: "-18px 0 40px rgba(0,0,0,0.45)", zIndex: 50,
        display: "flex", flexDirection: "column", padding: 16, gap: 12,
      }}
    >
      {/* En-tête lead — identité, étape, liens. Hors flux scrollable. */}
      <div style={{ flex: "none" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: "#E8E8EE", fontWeight: 700, fontSize: 14 }}>
              {leadName(lead)}
              {lead.first_name && lead.tg_username && (
                <span style={{ color: "#555568", marginLeft: 8, fontWeight: 400, fontSize: 12 }}>{lead.first_name}</span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap", fontSize: 11.5 }}>
              <span style={{ color: stage.color, fontWeight: 600 }}>{stage.label}</span>
              <span style={{ color: "#3A3A48" }}>·</span>
              <span style={{ color: "#8888A0" }}>src <code>{lead.source}</code></span>
              <span style={{ color: "#3A3A48" }}>·</span>
              <span style={{ color: "#8888A0", fontFamily: "monospace" }}>{lead.member_id ?? "sans ID"}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
              {url && (
                <a href={url} target="_blank" rel="noreferrer"
                  style={{ fontSize: 11, color: "#60A5FA", fontWeight: 600 }}
                  title="Ouvrir le sujet de ce lead dans le chat admin Telegram">
                  🧵 Sujet Telegram
                </a>
              )}
              {lead.takeover_active === 1 && (
                <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(52,211,153,0.12)", color: "#34D399", fontWeight: 700 }}
                  title={`Aucun message automatique jusqu'à ${lead.takeover_until} (UTC)`}>
                  🎙 takeover{lead.takeover_by ? ` · ${lead.takeover_by}` : ""}
                </span>
              )}
              {lead.awaiting_human === 1 && (
                <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(240,185,11,0.12)", color: "#F0B90B", fontWeight: 700 }}
                  title="Le bot est muselé : ce lead attend une réponse humaine">
                  🙋 attend une réponse
                </span>
              )}
              {lead.awaiting_human !== 1 && lead.question_open === 1 && (
                <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(240,185,11,0.10)", color: "#F0B90B", fontWeight: 600 }}
                  title="Sa question est restée sans réponse — le bot a repris la main après 90 min">
                  ❓ question sans réponse
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} aria-label="Fermer" style={{
            background: "none", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8,
            color: "#8888A0", fontSize: 13, lineHeight: 1, padding: "5px 9px", cursor: "pointer", flex: "none",
          }}>✕</button>
        </div>
      </div>

      {/* Conversation : occupe tout l'espace restant, seule elle scrolle. Le champ de
          réponse est à l'intérieur, épinglé en bas — donc toujours visible. */}
      <ConversationPanel key={lead.id} leadId={lead.id} onChanged={onChanged} />

      {/* Parcours / Historique / Actions / Notes — sous le champ de réponse, dans
          leur propre zone scrollable bornée, pour ne jamais le repousser hors écran. */}
      <div style={{ flex: "0 1 auto", minHeight: 0, maxHeight: "38vh", overflowY: "auto", paddingRight: 4 }}>
        <LeadDetail lead={lead} weekly={weekly} events={events} onChanged={onChanged} />
      </div>
    </aside>
  );
};

function LeadDetail({ lead, weekly, events, onChanged }: {
  lead: NexaLeadWithStats;
  weekly: NexaWeeklyStat[];
  events: NexaLeadEvent[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState(lead.notes ?? "");
  const [msg, setMsg] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string; warning?: string }>) {
    setBusy(key); setMsg(null);
    try {
      const res = await fn();
      // `warning` = l'action a réussi mais un effet de bord a été supprimé (typiquement
      // un message au lead bloqué par le takeover). Le taire ferait croire à un envoi.
      setMsg(res.ok ? (res.warning ? `⚠️ ${res.warning}` : "✅ Fait") : `❌ ${res.error ?? "Erreur"}`);
      if (res.ok) onChanged();
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? String(e)}`);
    } finally { setBusy(null); }
  }

  /**
   * Le bouton DIT ce qu'il va faire avant de le faire (règle Hugo 2026-08-04 : mon choix
   * explicite en cas de doute). L'aperçu ne crée rien et n'écrit rien — c'est le même
   * moteur de décision que la création, en dry-run, donc les deux ne peuvent pas diverger.
   */
  async function handleGroupClick() {
    setBusy("group"); setMsg(null);
    try {
      const p = await previewGroupAction(lead.id);

      if (p.action === "review") {
        // Rapprochement non prouvé : la porte refusera de créer. On ne propose même pas
        // le choix ici — l'arbitrage se fait sur la page « Groupes à trancher », avec les
        // candidats sous les yeux.
        setMsg(`🕵️ ${p.reason ?? "Cas ambigu"} — rien créé. Va sur « Groupes à trancher » pour décider.`);
        setBusy(null);
        return;
      }

      if (p.action === "reuse") {
        const quand = p.createdAt ? ` (créé le ${fmtDateTime(p.createdAt)})` : "";
        const qui = p.ownerLabel ? ` — ${p.ownerLabel}` : "";
        const ok = window.confirm(
          `Ce contact a déjà un groupe${quand}${qui}.\n` +
          `Groupe ${p.chatId} · source : ${p.source}\n\n` +
          `OK = le rattacher à NEXA (aucun nouveau groupe, message « NEXA ajouté à ton suivi » posté dedans).\n` +
          `Annuler = ne rien faire.`
        );
        if (!ok) { setMsg("Annulé — rien n'a été touché."); setBusy(null); return; }
      } else if (p.action === "create") {
        const ok = window.confirm(
          `Aucun groupe existant trouvé pour ce contact.\n\nOK = créer un NOUVEAU groupe.`
        );
        if (!ok) { setMsg("Annulé — rien n'a été touché."); setBusy(null); return; }
      }

      const res = await createGroupAction(lead.id);
      setMsg(res.ok
        ? (res.reused ? "♻️ Groupe existant rattaché — aucun doublon créé" : "✅ Groupe créé")
        : res.needsReview
          ? `🕵️ Cas ambigu — rien créé, à trancher dans « Groupes à trancher »`
          : `❌ ${res.error ?? "Erreur"}`);
      if (res.ok) onChanged();
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? String(e)}`);
    } finally { setBusy(null); }
  }

  const timeline: { label: string; at: string | null }[] = [
    { label: "🚀 Started", at: lead.started_at ?? lead.created_at },
    { label: "📲 App installée", at: lead.installed_at },
    { label: "📝 Compte créé", at: lead.account_at },
    { label: "💰 Dépôt fait", at: lead.deposit_at },
    { label: "✅ Vérifié room", at: lead.verified_at },
    { label: "♠️ A joué", at: lead.played_at },
  ];

  const btn: React.CSSProperties = {
    padding: "7px 12px", borderRadius: 8, fontSize: 11.5, fontWeight: 600,
    cursor: "pointer", border: "1px solid rgba(255,255,255,0.12)", background: "#0B0D12", color: "#E8E8EE",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={SECTION_LABEL}>Parcours</div>
        {timeline.map(t => (
          <div key={t.label} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "3px 0", fontSize: 12 }}>
            <span style={{ color: t.at ? "#E8E8EE" : "#555568" }}>{t.label}</span>
            <span style={{ color: t.at ? "#8888A0" : "#3A3A48" }}>{t.at ? fmtDateTime(t.at) : "—"}</span>
          </div>
        ))}
      </div>

      <div>
        <div style={SECTION_LABEL}>Historique ({events.length})</div>
        <div style={{ maxHeight: 170, overflowY: "auto", fontSize: 11.5 }}>
          {events.length === 0 && <div style={{ color: "#555568" }}>Aucun événement.</div>}
          {[...events].reverse().map(e => (
            <div key={e.id} style={{ display: "flex", gap: 8, padding: "3px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
              <span style={{ color: "#555568", whiteSpace: "nowrap" }}>{fmtDateTime(e.created_at)}</span>
              <span style={{ color: e.kind === "question" ? "#F0B90B" : e.kind === "reminder" ? "#60A5FA" : "#8888A0" }}>
                {e.kind === "question" ? "❓ question" : e.kind === "reminder" ? "🔔 relance" : e.kind === "group_created" ? "🔐 groupe" : e.kind === "stage_change" ? "➡️ étape" : "🛠 admin"}
                {e.stage ? ` · ${e.stage}` : ""}{e.payload ? ` · ${e.payload}` : ""}
              </span>
              <span style={{ color: "#3A3A48", marginLeft: "auto" }}>{e.actor}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div style={SECTION_LABEL}>Actions</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          <button
            style={{ ...btn, opacity: lead.deposit_at ? 0.5 : 1, color: "#34D399", borderColor: "rgba(52,211,153,0.35)" }}
            disabled={!!lead.deposit_at || busy === "deposit"}
            onClick={() => run("deposit", () => markDepositAction(lead.id))}
          >
            {lead.deposit_at ? "💰 Dépôt déjà marqué" : busy === "deposit" ? "..." : "💰 Marquer dépôt fait"}
          </button>
          <button style={btn} disabled={busy === "relance" || lead.blocked === 1}
            onClick={() => run("relance", () => relanceAction(lead.id))}>
            {busy === "relance" ? "..." : "🔔 Relancer maintenant"}
          </button>
          {!lead.group_invite_link && (
            <button style={btn} disabled={busy === "group"}
              onClick={() => void handleGroupClick()}>
              {busy === "group" ? "..." : "🔐 Créer le groupe"}
            </button>
          )}
          {/* Équivalents back-office de /bot et /stop du chat admin. `/bot` lève
              aussi l'attente de réponse humaine — d'où le bouton dans les deux cas. */}
          {(lead.takeover_active === 1 || lead.awaiting_human === 1 || lead.question_open === 1) && (
            <button style={{ ...btn, color: "#60A5FA", borderColor: "rgba(96,165,250,0.35)" }}
              disabled={busy === "handover"}
              onClick={() => run("handover", () => handoverToBotAction(lead.id))}
              title="Rend la main au scénario automatique immédiatement (= /bot)">
              {busy === "handover" ? "..." : "🤖 Rendre la main au bot"}
            </button>
          )}
          {lead.relances_off !== 1 && (
            <button style={{ ...btn, color: "#F0B90B", borderColor: "rgba(240,185,11,0.3)" }}
              disabled={busy === "stop"}
              onClick={() => run("stop", () => stopRelancesAction(lead.id))}
              title="Désactive DÉFINITIVEMENT les relances de ce lead (= /stop)">
              {busy === "stop" ? "..." : "🔕 Stop relances"}
            </button>
          )}
        </div>
        {lead.relances_off === 1 && (
          <div style={{ fontSize: 11, color: "#F0B90B", marginBottom: 8 }}>🔕 Relances désactivées sur ce lead.</div>
        )}
        {msg && <div style={{ fontSize: 11.5, color: msg.startsWith("✅") ? "#34D399" : msg.startsWith("⚠️") ? "#F0B90B" : "#F87171", marginBottom: 8 }}>{msg}</div>}
      </div>

      <div>
        <div style={SECTION_LABEL}>Notes</div>
        <textarea
          value={notes} onChange={e => setNotes(e.target.value)} rows={3}
          placeholder="Notes internes sur ce lead…"
          style={{ width: "100%", background: "#0B0D12", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, color: "#E8E8EE", padding: "8px 10px", fontSize: 12, resize: "vertical", fontFamily: "inherit" }}
        />
        <button style={{ ...btn, marginTop: 6 }} disabled={busy === "notes"}
          onClick={() => run("notes", async () => saveNotesAction(lead.id, notes))}>
          {busy === "notes" ? "..." : "💾 Enregistrer"}
        </button>
      </div>

      {weekly.length > 0 && (
        <div>
          <div style={SECTION_LABEL}>Évolution semaine par semaine</div>
          <WeeklyEvolutionTable rows={weekly} columns={WEEKLY_COLUMNS} />
        </div>
      )}
    </div>
  );
}
