import { getWeekBounds, toUTCISO, toParisDate, formatRangeLabel, isoWeekToOffset, parisLocalToUTC } from "@/lib/date-utils";

export interface PeriodFilter {
  key: string;
  startDate: string | undefined;
  endDate: string | undefined;
  rangeLabel: string;
}

/**
 * Server-side resolver for the shared PeriodFilterBar URL contract.
 * Mirrors the filter buttons: Cette semaine (current) / Semaine dernière (last) /
 * week-picker (ISO week) / 7 jours / 30 jours / Lifetime / Custom (Paris date+time range).
 *
 * Default (undefined / unknown) = current week, label spans full Mon→Sun,
 * endDate capped to now.
 */
export function computePeriodFilter(filter: string | undefined): PeriodFilter {
  const f = filter ?? "current";

  if (f === "lifetime") {
    return { key: "lifetime", startDate: undefined, endDate: undefined, rangeLabel: "Toutes les transactions" };
  }

  // 7d n'est PAS rendu par la barre complète (les pages P&L n'ont jamais eu ce
  // bouton) : il n'apparaît que sur les pages qui le demandent via `only`. Le
  // résolveur, lui, le connaît — sinon `?filter=7d` retomberait silencieusement
  // sur « cette semaine », qui n'est pas la même fenêtre.
  if (f === "7d") {
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 86400000);
    return { key: "7d", startDate: toUTCISO(start), endDate: toUTCISO(end), rangeLabel: formatRangeLabel(start, end) };
  }

  if (f === "30d") {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86400000);
    return { key: "30d", startDate: toUTCISO(start), endDate: toUTCISO(end), rangeLabel: formatRangeLabel(start, end) };
  }

  if (f === "last") {
    const { start, end } = getWeekBounds(-1);
    return { key: "last", startDate: toUTCISO(start), endDate: toUTCISO(end), rangeLabel: formatRangeLabel(start, end) };
  }

  // ISO week format: 2026-W18
  if (/^\d{4}-W\d{2}$/.test(f)) {
    const offset = isoWeekToOffset(f);
    if (offset !== null && offset < 0) {
      const { start, end } = getWeekBounds(offset);
      return { key: f, startDate: toUTCISO(start), endDate: toUTCISO(end), rangeLabel: formatRangeLabel(start, end) };
    }
  }

  if (f.startsWith("custom:")) {
    const parts = f.slice(7).split("~");
    if (parts.length === 2) {
      const [sd, ed] = parts;
      const sm = sd.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
      const em = ed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
      if (sm && em) {
        const start = parisLocalToUTC(+sm[1], +sm[2], +sm[3], +sm[4], +sm[5], 0, 0);
        const end = parisLocalToUTC(+em[1], +em[2], +em[3], +em[4], +em[5], 59, 0);
        if (end >= start) {
          return { key: f, startDate: toUTCISO(start), endDate: toUTCISO(end), rangeLabel: `${sd.replace("T", " ")} → ${ed.replace("T", " ")} (Paris)` };
        }
      }
    }
  }

  // Date format: 2026-04-27 (Monday of the week)
  if (/^\d{4}-\d{2}-\d{2}$/.test(f)) {
    const target = new Date(f + "T00:00:00Z");
    const { start: currentWeekStart } = getWeekBounds(0);
    const currentMonday = new Date(toParisDate(toUTCISO(currentWeekStart)) + "T00:00:00Z");
    let offset = Math.round((target.getTime() - currentMonday.getTime()) / (7 * 86400000));
    let bounds = getWeekBounds(offset);
    if (toParisDate(toUTCISO(bounds.start)) !== f) {
      offset += toParisDate(toUTCISO(bounds.start)) < f ? 1 : -1;
      bounds = getWeekBounds(offset);
    }
    return { key: f, startDate: toUTCISO(bounds.start), endDate: toUTCISO(bounds.end), rangeLabel: formatRangeLabel(bounds.start, bounds.end) };
  }

  // Default: current week — label shows full Mon→Sun, endDate capped to now.
  const { start, end } = getWeekBounds(0);
  const now = new Date();
  return { key: "current", startDate: toUTCISO(start), endDate: toUTCISO(now < end ? now : end), rangeLabel: formatRangeLabel(start, end) };
}
