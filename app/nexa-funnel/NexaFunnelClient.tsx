"use client";

import { useMemo, useState } from "react";
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
import { FUNNEL_CARD } from "@/components/funnel/styles";
import {
  markDepositAction, relanceAction, createGroupAction, saveNotesAction,
  handoverToBotAction, stopRelancesAction,
} from "./actions";

// NEXAPOKER n'a ni insurance ni rewards (pas de rakeback) — 4 colonnes seulement.
const WEEKLY_COLUMNS: WeeklyColumn<NexaWeeklyStat>[] = [
  { label: "Rake", value: r => r.rake, tone: "bright" },
  { label: "Dépôts", value: r => r.deposits },
  { label: "Retraits", value: r => r.withdrawals },
  { label: "Win/Loss", value: r => r.winloss, tone: "signed" },
];

const HEADERS = [
  "Lead", "💬", "Étape", "ID joueur", "OS", "Groupe", "Started", "Dépôt",
  "Relances", "❓", "Semaines", "Σ Rake", "Σ Dépôts", "Σ Retraits", "Σ Win/Loss", "",
];
const COLSPAN = HEADERS.length;

const OS_LABEL: Record<string, string> = { windows: "🪟", android: "🤖", mac: "🍎" };

function FilterChip({ active, tone, onClick, children }: {
  active: boolean;
  tone?: "warn";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const accent = tone === "warn" ? "#F0B90B" : "#E8E8EE";
  return (
    <button
      onClick={onClick}
      style={{
        padding: "5px 11px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
        border: `1px solid ${active ? (tone === "warn" ? "rgba(240,185,11,0.4)" : "rgba(255,255,255,0.22)") : "rgba(255,255,255,0.1)"}`,
        background: active ? (tone === "warn" ? "rgba(240,185,11,0.10)" : "rgba(255,255,255,0.06)") : "#11141A",
        color: active ? accent : "#8888A0",
      }}
    >
      {children}
    </button>
  );
}

/** Pastille « message non lu » + horodatage du dernier message du lead. */
function UnreadCell({ lead }: { lead: NexaLeadWithStats }) {
  if (!lead.last_lead_msg_at) return <span style={{ color: "#3A3A48" }}>—</span>;
  const unread = lead.unread === 1;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
      <span
        style={{
          width: 7, height: 7, borderRadius: "50%",
          background: unread ? "#F0B90B" : "rgba(255,255,255,0.12)",
          boxShadow: unread ? "0 0 0 3px rgba(240,185,11,0.15)" : "none", flexShrink: 0,
        }}
        title={unread ? "Message non lu" : "Lu"}
      />
      <span style={{ color: unread ? "#F0B90B" : "#555568", fontWeight: unread ? 700 : 400 }}>
        {fmtDateTime(lead.last_lead_msg_at)}
      </span>
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
  const [openLead, setOpenLead] = useState<number | null>(null);
  const [onlyUnread, setOnlyUnread] = useState(false);

  const unreadCount = useMemo(() => leads.filter(l => l.unread === 1).length, [leads]);
  const visibleLeads = useMemo(
    () => (onlyUnread ? leads.filter(l => l.unread === 1) : leads),
    [leads, onlyUnread],
  );

  const statsByMember = useMemo(() => groupByMember(stats), [stats]);
  const eventsByLead = useMemo(() => {
    const m: Record<number, NexaLeadEvent[]> = {};
    for (const e of events) (m[e.lead_id] ??= []).push(e);
    return m;
  }, [events]);
  const cards = buildConversionCards(leads, NEXA_CARDS);

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

      {/* Filtre « à répondre » — en tête de table, au-dessus des en-têtes de colonnes. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <FilterChip active={!onlyUnread} onClick={() => setOnlyUnread(false)}>
          Tous ({leads.length})
        </FilterChip>
        <FilterChip active={onlyUnread} tone="warn" onClick={() => setOnlyUnread(true)}>
          🔴 À répondre ({unreadCount})
        </FilterChip>
        <span style={{ fontSize: 11, color: "#3A3A48" }}>
          Clique une ligne pour ouvrir la conversation.
        </span>
      </div>

      <div style={{ ...FUNNEL_CARD, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
              {HEADERS.map(h => (
                <th key={h} style={{
                  textAlign: h.startsWith("Σ") || h === "Semaines" ? "right" : "left",
                  padding: "12px 14px", fontSize: 10.5, fontWeight: 700, color: "#555568",
                  textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap",
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && (
              <tr><td colSpan={COLSPAN} style={{ padding: 24, textAlign: "center", color: "#555568" }}>
                Aucun lead pour l&apos;instant — partage le deep link <code style={{ color: "#8888A0" }}>t.me/LeCercle_Lebot?start=nexa</code>
              </td></tr>
            )}
            {leads.length > 0 && visibleLeads.length === 0 && (
              <tr><td colSpan={COLSPAN} style={{ padding: 24, textAlign: "center", color: "#555568" }}>
                Aucun message en attente de réponse. 👌
              </td></tr>
            )}
            {visibleLeads.map(lead => (
              <LeadRow
                key={lead.id}
                lead={lead}
                weekly={lead.member_id ? (statsByMember[lead.member_id] ?? []) : []}
                events={eventsByLead[lead.id] ?? []}
                isOpen={openLead === lead.id}
                onToggle={() => setOpenLead(o => (o === lead.id ? null : lead.id))}
                onChanged={() => router.refresh()}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LeadRow({ lead, weekly, events, isOpen, onToggle, onChanged }: {
  lead: NexaLeadWithStats;
  weekly: NexaWeeklyStat[];
  events: NexaLeadEvent[];
  isOpen: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const stage = stageDef(NEXA_STAGES, lead.stage);
  const name = lead.tg_username ? `@${lead.tg_username}` : (lead.first_name ?? `tg:${lead.tg_user_id}`);
  const td: React.CSSProperties = { padding: "10px 14px", whiteSpace: "nowrap" };

  return (
    <>
      {/* La ligne entière est cliquable (§5 du brief) : un clic ouvre le panneau
          conversation. Les liens internes (groupe) stoppent la propagation. */}
      <tr
        onClick={onToggle}
        style={{
          borderBottom: "1px solid rgba(255,255,255,0.04)",
          opacity: lead.blocked ? 0.5 : 1,
          cursor: "pointer",
          background: isOpen ? "rgba(255,255,255,0.02)" : undefined,
        }}
      >
        <td style={td}>
          <span style={{ color: "#E8E8EE", fontWeight: 600 }}>{name}</span>
          {lead.first_name && lead.tg_username && <span style={{ color: "#555568", marginLeft: 6 }}>{lead.first_name}</span>}
          {lead.source !== "direct" && (
            <span style={{ marginLeft: 6, fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(96,165,250,0.12)", color: "#60A5FA", fontWeight: 600 }}>{lead.source}</span>
          )}
          <LangBadge lang={lead.lang} chosenAt={lead.lang_chosen_at} />
          {lead.blocked === 1 && <BlockedBadge />}
          {lead.cold === 1 && <span style={{ marginLeft: 6, fontSize: 10, color: "#8888A0" }}>🧊 cold</span>}
          {hasPlayed(lead) && <PlayedBadge />}
        </td>
        <td style={td}><UnreadCell lead={lead} /></td>
        <td style={td}><span style={{ color: stage.color, fontWeight: 600 }}>{stage.label}</span></td>
        <td style={{ ...td, color: "#E8E8EE", fontFamily: "monospace" }}>
          {lead.member_id ?? "—"}
          {lead.nickname && <span style={{ color: "#555568", marginLeft: 6, fontFamily: "inherit" }}>({lead.nickname})</span>}
          <VerifiedBadge state={verificationState(lead.member_id, lead.weeks_count)} />
          {lead.duplicate_id === 1 && (
            <span style={{ marginLeft: 6, fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(239,68,68,0.12)", color: "#F87171", fontWeight: 700, fontFamily: "inherit" }} title="Ce lead a envoyé un ID déjà rattaché à un autre lead — rien n'a été écrasé">⚠️ DOUBLON</span>
          )}
        </td>
        <td style={{ ...td, color: "#8888A0" }}>{lead.os ? (OS_LABEL[lead.os] ?? lead.os) : "—"}</td>
        <td style={td}>
          {lead.group_invite_link
            ? (
              <>
                <a href={lead.group_invite_link} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color: "#34D399", fontSize: 11 }}>🔐 groupe</a>
                {!lead.group_joined_at && (
                  <span style={{ marginLeft: 6, fontSize: 10, color: "#F0B90B" }} title="Groupe créé, le lead ne l'a pas encore rejoint">⏳</span>
                )}
              </>
            )
            : lead.group_not_joined === 1
              ? <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(240,185,11,0.12)", color: "#F0B90B", fontWeight: 700 }} title="Groupe créé mais jamais rejoint dans les 24 h — il a été nettoyé, le lead est à relancer">⚠️ non rejoint</span>
              : <span style={{ color: "#555568" }}>—</span>}
        </td>
        <td style={{ ...td, color: "#8888A0" }}>{fmtDateTime(lead.created_at)}</td>
        <td style={{ ...td, color: lead.deposit_at ? "#34D399" : "#555568" }}>{fmtDateTime(lead.deposit_at)}</td>
        <td style={{ ...td, color: lead.relances_count > 0 ? "#F0B90B" : "#555568" }}>{lead.relances_count}</td>
        <td style={{ ...td, color: lead.questions_count > 0 ? "#F0B90B" : "#555568" }}>{lead.questions_count || "—"}</td>
        <td style={{ ...td, textAlign: "right", color: "#8888A0" }}>{lead.weeks_count || "—"}</td>
        <td style={{ ...td, textAlign: "right", color: "#E8E8EE", fontWeight: 600 }}>{lead.weeks_count ? fmtAmount(lead.total_rake) : "—"}</td>
        <td style={{ ...td, textAlign: "right", color: "#8888A0" }}>{lead.weeks_count ? fmtAmount(lead.total_deposits) : "—"}</td>
        <td style={{ ...td, textAlign: "right", color: "#8888A0" }}>{lead.weeks_count ? fmtAmount(lead.total_withdrawals) : "—"}</td>
        <td style={{ ...td, textAlign: "right" }}>{lead.weeks_count ? <SignedAmount value={lead.total_winloss} /> : <span style={{ color: "#555568" }}>—</span>}</td>
        <td style={{ padding: "10px 14px" }}>
          <button onClick={e => { e.stopPropagation(); onToggle(); }} style={{
            background: "none", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6,
            color: "#8888A0", fontSize: 10.5, padding: "3px 8px", cursor: "pointer", whiteSpace: "nowrap",
          }}>
            {isOpen ? "▲ Fermer" : "▼ Fiche"}
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
          <td colSpan={COLSPAN} style={{ padding: "14px 18px", background: "rgba(255,255,255,0.015)" }}>
            <LeadDetail lead={lead} weekly={weekly} events={events} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

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
    <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 1fr) minmax(260px, 1.2fr) minmax(240px, 1fr)", gap: 20 }}>
      {/* Conversation — en tête de fiche : c'est ce qu'on vient chercher en cliquant. */}
      <div style={{ gridColumn: "1 / -1" }}>
        <ConversationPanel leadId={lead.id} onChanged={onChanged} />
      </div>

      {/* Timeline */}
      <div>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#555568", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Parcours</div>
        {timeline.map(t => (
          <div key={t.label} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "4px 0", fontSize: 12 }}>
            <span style={{ color: t.at ? "#E8E8EE" : "#555568" }}>{t.label}</span>
            <span style={{ color: t.at ? "#8888A0" : "#3A3A48" }}>{t.at ? fmtDateTime(t.at) : "—"}</span>
          </div>
        ))}
      </div>

      {/* Historique événements */}
      <div>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#555568", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
          Historique ({events.length})
        </div>
        <div style={{ maxHeight: 190, overflowY: "auto", fontSize: 11.5 }}>
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

      {/* Actions + notes */}
      <div>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#555568", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Actions</div>
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
              onClick={() => run("group", () => createGroupAction(lead.id))}>
              {busy === "group" ? "..." : "🔐 Créer le groupe"}
            </button>
          )}
          {/* Équivalents back-office de /bot et /stop du chat admin. */}
          {lead.takeover_active === 1 && (
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
        {msg && <div style={{ fontSize: 11.5, color: msg.startsWith("✅") ? "#34D399" : "#F87171", marginBottom: 8 }}>{msg}</div>}

        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#555568", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Notes</div>
        <textarea
          value={notes} onChange={e => setNotes(e.target.value)} rows={3}
          placeholder="Notes internes sur ce lead…"
          style={{ width: "100%", background: "#0B0D12", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, color: "#E8E8EE", padding: "8px 10px", fontSize: 12, resize: "vertical" }}
        />
        <button style={{ ...btn, marginTop: 6 }} disabled={busy === "notes"}
          onClick={() => run("notes", async () => saveNotesAction(lead.id, notes))}>
          {busy === "notes" ? "..." : "💾 Enregistrer"}
        </button>
      </div>

      {/* Évolution hebdo */}
      {weekly.length > 0 && (
        <div style={{ gridColumn: "1 / -1" }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "#555568", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Évolution semaine par semaine
          </div>
          <WeeklyEvolutionTable rows={weekly} columns={WEEKLY_COLUMNS} />
        </div>
      )}
    </div>
  );
}
