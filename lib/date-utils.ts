/**
 * France-time (Europe/Paris) week boundaries — DST-aware via Intl.
 *
 * Settlement weeks are Mon 00:00 → Sun 23:59:59 Europe/Paris.
 * tx_datetime is stored as UTC ISO 8601 with Z suffix.
 * These helpers return UTC Date objects representing Paris-time week
 * boundaries — ready for SQL string comparison against Z-formatted values.
 */

const TZ = "Europe/Paris";

const parisFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

const parisOffsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  timeZoneName: "longOffset",
});

function getParisComponents(d: Date) {
  const parts = Object.fromEntries(
    parisFormatter.formatToParts(d).map(p => [p.type, p.value])
  );
  return {
    year: +parts.year,
    month: +parts.month,
    day: +parts.day,
    hour: parts.hour === "24" ? 0 : +parts.hour,
    minute: +parts.minute,
    second: +parts.second,
  };
}

function getParisOffsetMinutes(d: Date): number {
  const tzPart = parisOffsetFormatter.formatToParts(d)
    .find(p => p.type === "timeZoneName")?.value ?? "";
  const match = tzPart.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 120; // fallback CEST
  const sign = match[1] === "+" ? 1 : -1;
  return sign * (parseInt(match[2]) * 60 + parseInt(match[3]));
}

function parisLocalToUTC(year: number, month: number, day: number, h: number, m: number, s: number, ms: number): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, h, m, s, ms));
  const offset = getParisOffsetMinutes(guess);
  const utc = new Date(guess.getTime() - offset * 60_000);
  const verify = getParisOffsetMinutes(utc);
  if (verify !== offset) {
    return new Date(guess.getTime() - verify * 60_000);
  }
  return utc;
}

// ── Week bounds (France-anchored, DST-aware) ─────────────

export function getWeekBounds(offsetWeeks: number): { start: Date; end: Date } {
  const nowParis = getParisComponents(new Date());

  const dayOfWeek = new Date(Date.UTC(nowParis.year, nowParis.month - 1, nowParis.day)).getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const mondayDay = nowParis.day - daysSinceMonday + offsetWeeks * 7;
  const startUTC = parisLocalToUTC(nowParis.year, nowParis.month, mondayDay, 0, 0, 0, 0);

  const sundayDay = mondayDay + 6;
  const endUTC = parisLocalToUTC(nowParis.year, nowParis.month, sundayDay, 23, 59, 59, 0);

  return { start: startUTC, end: endUTC };
}

// ── Formatting ───────────────────────────────────────────

const p2 = (n: number) => String(n).padStart(2, "0");

export function toUTCISO(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function toParisISO(d: Date): string {
  const c = getParisComponents(d);
  const off = getParisOffsetMinutes(d);
  const sign = off >= 0 ? "+" : "-";
  const absOff = Math.abs(off);
  const oh = p2(Math.floor(absOff / 60));
  const om = p2(absOff % 60);
  return `${c.year}-${p2(c.month)}-${p2(c.day)}T${p2(c.hour)}:${p2(c.minute)}:${p2(c.second)}${sign}${oh}:${om}`;
}

export function toParisDate(utcISO: string): string {
  const d = new Date(utcISO.endsWith("Z") ? utcISO : utcISO + "Z");
  const c = getParisComponents(d);
  return `${c.year}-${p2(c.month)}-${p2(c.day)}`;
}

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function toISODateTime(d: Date): string {
  return d.toISOString().replace("Z", "");
}

// ── ISO week string YYYY-Www from a Monday UTC Date ──────

export function toISOWeek(mondayUTC: Date): string {
  const parisMon = getParisComponents(mondayUTC);
  const jan1 = new Date(Date.UTC(parisMon.year, 0, 1));
  const jan1Day = jan1.getUTCDay() || 7;
  const firstThursday = new Date(jan1.getTime() + (4 - jan1Day) * 86400000);
  const firstWeekMonday = new Date(firstThursday.getTime() - 3 * 86400000);
  const monDate = new Date(Date.UTC(parisMon.year, parisMon.month - 1, parisMon.day));
  const weekNum = Math.round((monDate.getTime() - firstWeekMonday.getTime()) / (7 * 86400000)) + 1;
  return `${parisMon.year}-W${String(weekNum).padStart(2, "0")}`;
}

export function isoWeekToOffset(isoWeek: string): number | null {
  const match = isoWeek.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return null;
  const year = parseInt(match[1]);
  const week = parseInt(match[2]);

  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400000);
  const targetMondayDate = new Date(week1Monday.getTime() + (week - 1) * 7 * 86400000);

  const nowParis = getParisComponents(new Date());
  const dayOfWeek = new Date(Date.UTC(nowParis.year, nowParis.month - 1, nowParis.day)).getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const currentMondayDate = new Date(Date.UTC(nowParis.year, nowParis.month - 1, nowParis.day - daysSinceMonday));

  const diffMs = targetMondayDate.getTime() - currentMondayDate.getTime();
  return Math.round(diffMs / (7 * 86400000));
}

// ── Week lists ───────────────────────────────────────────

export interface WeekOption {
  offset: number;
  isoWeek: string;
  label: string;
  start: Date;
  end: Date;
}

export function getLast12Weeks(): WeekOption[] {
  const weeks: WeekOption[] = [];
  for (let i = -1; i >= -12; i--) {
    const { start, end } = getWeekBounds(i);
    weeks.push({
      offset: i,
      isoWeek: toParisDate(toUTCISO(start)),
      label: formatWeekLabel(start, end),
      start,
      end,
    });
  }
  return weeks;
}

// ── Labels ───────────────────────────────────────────────

function formatWeekLabel(startUTC: Date, endUTC: Date): string {
  const s = getParisComponents(startUTC);
  const e = getParisComponents(endUTC);
  const months = ["jan.", "fév.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const sd = `${s.day} ${months[s.month - 1]}`;
  const ed = `${e.day} ${months[e.month - 1]}`;
  if (s.year !== e.year) {
    return `${sd} ${s.year} → ${ed} ${e.year}`;
  }
  return `${sd} → ${ed}`;
}

export function formatRangeLabel(startUTC: Date, endUTC: Date): string {
  const s = getParisComponents(startUTC);
  const e = getParisComponents(endUTC);
  const days = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
  const months = ["jan.", "fév.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const sDate = new Date(Date.UTC(s.year, s.month - 1, s.day));
  const eDate = new Date(Date.UTC(e.year, e.month - 1, e.day));
  const sDay = days[sDate.getUTCDay()];
  const eDay = days[eDate.getUTCDay()];
  const sd = `${sDay} ${s.day} ${months[s.month - 1]}`;
  const ed = `${eDay} ${e.day} ${months[e.month - 1]} ${e.year}`;
  return `${sd} → ${ed} (heure FR)`;
}

// ── Deprecation aliases — surface missed callers ─────────

/** @deprecated Use getWeekBounds */
export function getChinaWeekBounds(offsetWeeks: number) {
  console.warn("getChinaWeekBounds is deprecated — use getWeekBounds");
  return getWeekBounds(offsetWeeks);
}

/** @deprecated Use toParisISO */
export function toChinaISO(d: Date) {
  console.warn("toChinaISO is deprecated — use toParisISO");
  return toParisISO(d);
}

// ── DST sanity examples (Europe/Paris) ───────────────────
//
// Summer (CEST, UTC+2) — May 4 2026:
//   getWeekBounds(0) → start: 2026-05-03T22:00:00Z (= Mon May 4 00:00+02)
//                       end:   2026-05-10T21:59:59Z (= Sun May 10 23:59:59+02)
//
// Winter (CET, UTC+1) — Jan 5 2026:
//   getWeekBounds(0) → start: 2026-01-04T23:00:00Z (= Mon Jan 5 00:00+01)
//                       end:   2026-01-11T22:59:59Z (= Sun Jan 11 23:59:59+01)
//
// Spring forward (Mar 29 2026 — clocks skip 02:00→03:00):
//   Week containing Mar 29: start uses +01:00, end uses +02:00
//   Bounds correctly span the DST transition because they're UTC Dates
//
// Fall back (Oct 25 2026 — clocks repeat 02:00→03:00):
//   Week containing Oct 25: start uses +02:00, end uses +01:00
//   Same logic — UTC Dates are unambiguous
//
// tx_datetime comparison (all values stored as UTC Z):
//   Block timestamp 2026-05-03T20:00:00Z → stored "2026-05-03T20:00:00Z"
//   getWeekBounds(0).start = "2026-05-03T22:00:00Z"
//   "2026-05-03T20:00:00Z" >= "2026-05-03T22:00:00Z" → FALSE (last week) ✓
//   getWeekBounds(-1).end = "2026-05-03T21:59:59Z"
//   "2026-05-03T20:00:00Z" <= "2026-05-03T21:59:59Z" → TRUE (last week) ✓
