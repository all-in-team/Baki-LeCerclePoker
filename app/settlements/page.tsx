export const dynamic = "force-dynamic";
import { getQueue, getPeriod } from "@/lib/settlement-engine";
import { getWeekBounds, toParisDate, toUTCISO, formatRangeLabel, getLast12Weeks, isoWeekToOffset } from "@/lib/date-utils";
import PageHeader from "@/components/PageHeader";
import SettlementsClient from "./SettlementsClient";

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
    bounds = getWeekBounds(offset);
  }
  return offset;
}

export default async function SettlementsPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const params = await searchParams;
  const weekStart = resolveWeekStart(params.week);

  const { period, rows } = getQueue(weekStart);

  const offset = weekStartToOffset(weekStart);
  const { start, end } = getWeekBounds(offset);
  const rangeLabel = formatRangeLabel(start, end);

  const weeks = getLast12Weeks();

  return (
    <>
      <PageHeader title="Settlements" subtitle="Validation hebdomadaire des P&L wallet par joueur" />
      <SettlementsClient
        weekStart={weekStart}
        weekEnd={period?.week_end ?? ""}
        period={period}
        rows={rows}
        rangeLabel={rangeLabel}
        weeks={weeks.map(w => ({ isoWeek: w.isoWeek, label: w.label }))}
      />
    </>
  );
}
