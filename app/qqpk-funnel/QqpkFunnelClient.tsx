"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { FunnelLeadWithStats, FunnelWeeklyReport } from "@/lib/qqpk-funnel";
import { QQPK_STAGES, QQPK_CARDS } from "@/lib/funnels/qqpk/config";
import {
  buildConversionCards, groupByMember, stageDef, verificationState,
  fmtAmount, fmtDateTime, hasPlayed,
} from "@/lib/funnels/shared";
import ConversionCards from "@/components/funnel/ConversionCards";
import WeeklyImportPanel from "@/components/funnel/WeeklyImportPanel";
import WeeklyEvolutionTable, { type WeeklyColumn } from "@/components/funnel/WeeklyEvolutionTable";
import { VerifiedBadge, PlayedBadge, BlockedBadge } from "@/components/funnel/Badges";
import { SignedAmount } from "@/components/funnel/Amounts";
import { FUNNEL_CARD } from "@/components/funnel/styles";

// Colonnes du détail hebdo QQPK (la room expose insurance + rewards).
const WEEKLY_COLUMNS: WeeklyColumn<FunnelWeeklyReport>[] = [
  { label: "Rake", value: r => r.rake, tone: "bright" },
  { label: "Dépôts", value: r => r.deposits },
  { label: "Retraits", value: r => r.withdrawals },
  { label: "Win/Loss", value: r => r.winloss, tone: "signed" },
  { label: "Insurance", value: r => r.insurance },
  { label: "Rewards", value: r => r.rewards },
];

export default function QqpkFunnelClient({ leads, reports }: {
  leads: FunnelLeadWithStats[];
  reports: FunnelWeeklyReport[];
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const reportsByMember = useMemo(() => groupByMember(reports), [reports]);
  const cards = buildConversionCards(leads, QQPK_CARDS);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <ConversionCards cards={cards} />

      <WeeklyImportPanel
        endpoint="/api/qqpk-funnel/import"
        onImported={() => router.refresh()}
        description={
          <>
            Chiffres de la <b>semaine passée</b> — seuls les Member ID enregistrés par un lead du funnel sont importés, le reste du back-office est ignoré. Ré-uploader la même semaine écrase (correction).
          </>
        }
      />

      {/* Table des leads */}
      <div style={{ ...FUNNEL_CARD, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
              {["Lead", "Étape", "ID joueur", "Started", "Débloqué", "Relances", "Semaines", "Σ Rake", "Σ Dépôts", "Σ Retraits", "Σ Win/Loss", ""].map(h => (
                <th key={h} style={{ textAlign: h.startsWith("Σ") || h === "Semaines" ? "right" : "left", padding: "12px 14px", fontSize: 10.5, fontWeight: 700, color: "#555568", textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && (
              <tr><td colSpan={12} style={{ padding: 24, textAlign: "center", color: "#555568" }}>
                Aucun lead pour l&apos;instant — partage le deep link <code style={{ color: "#8888A0" }}>t.me/LeCercle_Lebot?start=qqpk</code>
              </td></tr>
            )}
            {leads.map(lead => {
              const weekly = lead.qqpk_member_id ? (reportsByMember[lead.qqpk_member_id] ?? []) : [];
              const isOpen = expanded[lead.id] ?? false;
              return (
                <LeadRow
                  key={lead.id}
                  lead={lead} weekly={weekly} isOpen={isOpen}
                  onToggle={() => setExpanded(e => ({ ...e, [lead.id]: !isOpen }))}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LeadRow({ lead, weekly, isOpen, onToggle }: {
  lead: FunnelLeadWithStats;
  weekly: FunnelWeeklyReport[];
  isOpen: boolean;
  onToggle: () => void;
}) {
  const stage = stageDef(QQPK_STAGES, lead.stage);
  const name = lead.username ? `@${lead.username}` : (lead.first_name ?? `tg:${lead.telegram_id}`);
  return (
    <>
      <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", opacity: lead.blocked ? 0.5 : 1 }}>
        <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>
          <span style={{ color: "#E8E8EE", fontWeight: 600 }}>{name}</span>
          {lead.first_name && lead.username && <span style={{ color: "#555568", marginLeft: 6 }}>{lead.first_name}</span>}
          {lead.blocked === 1 && <BlockedBadge />}
          {hasPlayed(lead) && <PlayedBadge />}
        </td>
        <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>
          <span style={{ color: stage.color, fontWeight: 600 }}>{stage.label}</span>
        </td>
        <td style={{ padding: "10px 14px", color: "#E8E8EE", fontFamily: "monospace", whiteSpace: "nowrap" }}>
          {lead.qqpk_member_id ?? "—"}
          {lead.nickname && <span style={{ color: "#555568", marginLeft: 6, fontFamily: "inherit" }}>({lead.nickname})</span>}
          <VerifiedBadge state={verificationState(lead.qqpk_member_id, lead.weeks_count)} />
        </td>
        <td style={{ padding: "10px 14px", color: "#8888A0", whiteSpace: "nowrap" }}>{fmtDateTime(lead.created_at)}</td>
        <td style={{ padding: "10px 14px", color: "#8888A0", whiteSpace: "nowrap" }}>{fmtDateTime(lead.stage4_at)}</td>
        <td style={{ padding: "10px 14px", color: lead.reminders_sent > 0 ? "#F0B90B" : "#555568" }}>{lead.reminders_sent}</td>
        <td style={{ padding: "10px 14px", textAlign: "right", color: "#8888A0" }}>{lead.weeks_count || "—"}</td>
        <td style={{ padding: "10px 14px", textAlign: "right", color: "#E8E8EE", fontWeight: 600 }}>{lead.weeks_count ? fmtAmount(lead.total_rake) : "—"}</td>
        <td style={{ padding: "10px 14px", textAlign: "right", color: "#8888A0" }}>{lead.weeks_count ? fmtAmount(lead.total_deposits) : "—"}</td>
        <td style={{ padding: "10px 14px", textAlign: "right", color: "#8888A0" }}>{lead.weeks_count ? fmtAmount(lead.total_withdrawals) : "—"}</td>
        <td style={{ padding: "10px 14px", textAlign: "right" }}>{lead.weeks_count ? <SignedAmount value={lead.total_winloss} /> : <span style={{ color: "#555568" }}>—</span>}</td>
        <td style={{ padding: "10px 14px" }}>
          {weekly.length > 0 && (
            <button onClick={onToggle} style={{
              background: "none", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6,
              color: "#8888A0", fontSize: 10.5, padding: "3px 8px", cursor: "pointer", whiteSpace: "nowrap",
            }}>
              {isOpen ? "▲ Replier" : `▼ ${weekly.length} sem.`}
            </button>
          )}
        </td>
      </tr>
      {isOpen && weekly.length > 0 && (
        <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
          <td colSpan={12} style={{ padding: "0 14px 12px", background: "rgba(255,255,255,0.015)" }}>
            <WeeklyEvolutionTable rows={weekly} columns={WEEKLY_COLUMNS} />
          </td>
        </tr>
      )}
    </>
  );
}
