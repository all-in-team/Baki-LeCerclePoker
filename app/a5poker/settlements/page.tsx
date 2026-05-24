export const dynamic = "force-dynamic";
import { getQueue } from "@/lib/settlement-engine";
import { getWeekBounds, toParisDate, toUTCISO, formatRangeLabel, getLast12Weeks, isoWeekToOffset } from "@/lib/date-utils";
import PageHeader from "@/components/PageHeader";
import SettlementsClient from "@/app/akpoker/settlements/SettlementsClient";

function resolveWeekStart(filter: string | undefined): string {
  if (filter && /^\d{4}-\d{2}-\d{2}$/.test(filter)) return filter;
  if (filter && /^\d{4}-W\d{2}$/.test(filter)) {
    const offset = isoWeekToOffset(filter);
    if (offset !== null) {
      const { start } = getWeekBounds(offset);
      return toParisDate(toUTCISO(start));
    }
  }
  const { start } = getWeekBounds(-1);
  return toParisDate(toUTCISO(start));
}

function weekStartToOffset(weekStartDate: string): number {
  const target = new Date(weekStartDate + "T00:00:00Z");
  const { start: currentWeekStart } = getWeekBounds(0);
  const currentMonday = new Date(toParisDate(toUTCISO(currentWeekStart)) + "T00:00:00Z");
  let offset = Math.round((target.getTime() - currentMonday.getTime()) / (7 * 86400000));
  let bounds = getWeekBounds(offset);
  if (toParisDate(toUTCISO(bounds.start)) !== weekStartDate) {
    offset += toParisDate(toUTCISO(bounds.start)) < weekStartDate ? 1 : -1;
  }
  return offset;
}

export default async function A5POKERSettlementsPage({ searchParams }: { searchParams: Promise<{ week?: string; player?: string }> }) {
  const params = await searchParams;
  const playerFilter = params.player ? parseInt(params.player) : undefined;
  const weekStart = resolveWeekStart(params.week);

  let { period, rows } = getQueue(weekStart);
  if (playerFilter) rows = rows.filter(r => r.player_id === playerFilter);

  const offset = weekStartToOffset(weekStart);
  const { start, end } = getWeekBounds(offset);
  const rangeLabel = formatRangeLabel(start, end);
  const weeks = getLast12Weeks();

  const filterPlayerName = playerFilter ? (rows.find(r => r.player_id === playerFilter)?.player_name ?? `#${playerFilter}`) : null;

  return (
    <>
      <PageHeader title="A5POKER — Settlements" subtitle="Validation hebdomadaire des P&L wallet par joueur" />
      {filterPlayerName && (
        <div style={{ padding: "0 28px 12px", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ background: "rgba(212,175,55,0.15)", color: "#D4AF37", padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
            Filtré : {filterPlayerName}
          </span>
          <a href="/a5poker/settlements" style={{ fontSize: 11, color: "var(--text-muted)", textDecoration: "none" }}>✕ Retirer le filtre</a>
        </div>
      )}
      <SettlementsClient
        weekStart={weekStart}
        weekEnd={period?.week_end ?? ""}
        period={period}
        rows={rows}
        rangeLabel={rangeLabel}
        weeks={weeks.map(w => ({ isoWeek: w.isoWeek, label: w.label }))}
        basePath="/a5poker/settlements"
      />
    </>
  );
}
