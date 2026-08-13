"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Calendar, Clock, ChevronDown, Loader2 } from "lucide-react";

export interface WeekOpt { isoWeek: string; label: string }

/** Contrôles affichables de la barre — clés du prop `only`. */
export type PeriodControl = "current" | "last" | "weeks" | "7d" | "30d" | "lifetime" | "custom";

/**
 * Shared period filter bar: Cette semaine / Semaine dernière / week-picker /
 * 7 jours / 30 jours / Lifetime / Custom (date+time range, Europe/Paris).
 *
 * « 7 jours » est OPT-IN : il ne s'affiche que si `only` le demande. Les pages
 * P&L n'ont jamais eu ce bouton — le rendre par défaut changerait leur barre
 * sans que personne l'ait demandé.
 *
 * URL contract (paired with `computePeriodFilter` in lib/period-filter.ts):
 *   - "current"        → basePath (no query)
 *   - "last" | "7d" | "30d" | "lifetime" | ISO week (2026-W18) | "custom:<start>~<end>"
 *
 * Reused by every P&L page so the filters stay identical across games.
 *
 * `only` restreint la barre à un sous-ensemble de contrôles SANS toucher au
 * contrat d'URL : /players expose 7j / 30j / Lifetime / Custom (les bornes
 * hebdomadaires n'ont pas de lecture utile sur un roster), mais reste lisible
 * par computePeriodFilter comme n'importe quelle page P&L. Omis = barre
 * historique, rendu inchangé pour les pages existantes.
 */
export default function PeriodFilterBar({
  activeFilter, rangeLabel, weeks, basePath, only,
}: {
  activeFilter: string;
  rangeLabel: string;
  weeks: WeekOpt[];
  basePath: string;
  only?: PeriodControl[];
}) {
  const router = useRouter();
  const [weekOpen, setWeekOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customStartTime, setCustomStartTime] = useState("00:00");
  const [customEnd, setCustomEnd] = useState("");
  const [customEndTime, setCustomEndTime] = useState("23:59");
  // Pending feedback: the clicked filter highlights instantly and the bar dims
  // while the server re-renders — without this the click feels dead for 1-2s.
  const [isPending, startTransition] = useTransition();
  const [pendingFilter, setPendingFilter] = useState<string | null>(null);
  const effectiveFilter = isPending && pendingFilter !== null ? pendingFilter : activeFilter;

  function navigate(filter: string) {
    setWeekOpen(false);
    setPendingFilter(filter);
    startTransition(() => {
      // `?filter=current` est émis EXPLICITEMENT, y compris pour la semaine en
      // cours. Auparavant « Cette semaine » renvoyait sur basePath nu : sur une
      // page dont le défaut sans query n'est pas « current » (NEXAPOKER ouvre en
      // lifetime, son report étant hebdomadaire et différé), le bouton était mort.
      // Aucun changement pour les pages P&L : leur défaut sans query EST déjà
      // « current », et computePeriodFilter("current") rend exactement ce défaut.
      router.push(`${basePath}?filter=${filter}`);
    });
  }

  const isWeekPick = /^\d{4}-W\d{2}$/.test(effectiveFilter);
  const activeWeekLabel = isWeekPick ? weeks.find(w => w.isoWeek === effectiveFilter)?.label : null;
  const isCustom = effectiveFilter.startsWith("custom:");

  // Sans `only`, on rend la barre HISTORIQUE — donc tout sauf 7d, ajouté après coup.
  const show = (k: PeriodControl) => only ? only.includes(k) : k !== "7d";
  const showWeekNav = show("current") || show("last") || show("weeks");
  const showRange = show("7d") || show("30d") || show("lifetime");
  // Séparateurs : uniquement ENTRE deux groupes réellement rendus, sinon la barre
  // restreinte ouvrirait sur un trait vertical orphelin.
  const sepBeforeRange = showWeekNav && (showRange || show("custom"));
  const sepBeforeCustom = (showWeekNav || showRange) && show("custom");

  function applyCustomRange() {
    if (!customStart || !customEnd) return;
    navigate(`custom:${customStart}T${customStartTime}~${customEnd}T${customEndTime}`);
    setCustomOpen(false);
  }

  return (
    <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 20px", marginBottom: 20, opacity: isPending ? 0.65 : 1, transition: "opacity 150ms ease" }}>
      <style>{`@keyframes pfb-spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {([
          { key: "current", label: "Cette semaine" },
          { key: "last", label: "Semaine dernière" },
        ] as const).filter(f => show(f.key)).map(f => (
          <button key={f.key} onClick={() => navigate(f.key)} style={{
            padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
            border: effectiveFilter === f.key ? "1px solid var(--green)" : "1px solid var(--border)",
            background: effectiveFilter === f.key ? "rgba(34,197,94,0.12)" : "var(--bg-surface)",
            color: effectiveFilter === f.key ? "var(--green)" : "var(--text-muted)",
          }}>
            {f.label}
          </button>
        ))}
        {show("weeks") && <div style={{ position: "relative" }}>
          <button onClick={() => setWeekOpen(!weekOpen)} style={{
            padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
            border: isWeekPick ? "1px solid var(--green)" : "1px solid var(--border)",
            background: isWeekPick ? "rgba(34,197,94,0.12)" : "var(--bg-surface)",
            color: isWeekPick ? "var(--green)" : "var(--text-muted)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <Calendar size={12} />
            {isWeekPick ? `Sem. du ${activeWeekLabel}` : "Semaine…"}
            <ChevronDown size={12} />
          </button>
          {weekOpen && (
            <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 100, background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.25)", minWidth: 260, maxHeight: 320, overflowY: "auto" }}>
              {weeks.map(w => (
                <button key={w.isoWeek} onClick={() => navigate(w.isoWeek)} style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 14px", fontSize: 12, cursor: "pointer", border: "none", background: effectiveFilter === w.isoWeek ? "rgba(34,197,94,0.10)" : "transparent", color: effectiveFilter === w.isoWeek ? "var(--green)" : "var(--text-muted)", fontWeight: effectiveFilter === w.isoWeek ? 700 : 400, borderBottom: "1px solid var(--border)" }}>
                  Sem. du {w.label}
                </button>
              ))}
            </div>
          )}
        </div>}
        {sepBeforeRange && <div style={{ width: 1, height: 20, background: "var(--border)", margin: "0 4px" }} />}
        {([
          { key: "7d", label: "7 jours" },
          { key: "30d", label: "30 jours" },
          { key: "lifetime", label: "Lifetime" },
        ] as const).filter(f => show(f.key)).map(f => (
          <button key={f.key} onClick={() => navigate(f.key)} style={{
            padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
            border: effectiveFilter === f.key ? "1px solid var(--green)" : "1px solid var(--border)",
            background: effectiveFilter === f.key ? "rgba(34,197,94,0.12)" : "var(--bg-surface)",
            color: effectiveFilter === f.key ? "var(--green)" : "var(--text-muted)",
          }}>
            {f.label}
          </button>
        ))}
        {sepBeforeCustom && <div style={{ width: 1, height: 20, background: "var(--border)", margin: "0 4px" }} />}
        {show("custom") && <button onClick={() => setCustomOpen(!customOpen)} style={{
          padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
          border: isCustom ? "1px solid var(--green)" : "1px solid var(--border)",
          background: isCustom ? "rgba(34,197,94,0.12)" : "var(--bg-surface)",
          color: isCustom ? "var(--green)" : "var(--text-muted)",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <Clock size={12} />
          {isCustom ? "Custom" : "Custom…"}
        </button>}
      </div>
      {customOpen && show("custom") && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          <label style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>Du</label>
          <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none" }} />
          <input type="time" value={customStartTime} onChange={e => setCustomStartTime(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", width: 90 }} />
          <label style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>Au</label>
          <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none" }} />
          <input type="time" value={customEndTime} onChange={e => setCustomEndTime(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", width: 90 }} />
          <button onClick={applyCustomRange} disabled={!customStart || !customEnd} style={{ padding: "5px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: customStart && customEnd ? "pointer" : "not-allowed", border: "1px solid var(--green)", background: "rgba(34,197,94,0.12)", color: "var(--green)", opacity: customStart && customEnd ? 1 : 0.4 }}>
            Appliquer
          </button>
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>Heure France (Europe/Paris)</span>
        </div>
      )}
      <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 6 }}>
        <Calendar size={12} />
        {isPending ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--green)" }}>
            <Loader2 size={12} style={{ animation: "pfb-spin 0.8s linear infinite" }} /> Chargement de la période…
          </span>
        ) : rangeLabel}
      </div>
    </div>
  );
}
