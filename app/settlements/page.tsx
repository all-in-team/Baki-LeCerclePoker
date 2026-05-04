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

export default async function SettlementsPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const params = await searchParams;
  const weekStart = resolveWeekStart(params.week);

  const { period, rows } = getQueue(weekStart);

  // Compute range label
  const offset = isoWeekToOffset(weekStart.replace(/(\d{4})-(\d{2})-(\d{2})/, (_, y, m, d) => {
    const jan4 = new Date(Date.UTC(+y, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400000);
    const target = new Date(`${y}-${m}-${d}T12:00:00Z`);
    const weekNum = Math.round((target.getTime() - week1Monday.getTime()) / (7 * 86400000)) + 1;
    return `${y}-W${String(weekNum).padStart(2, "0")}`;
  })) ?? -1;

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
