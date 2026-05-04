/**
 * China-time (UTC+8) week boundaries.
 *
 * Players grind Mon–Sun and settle every Sunday night China time.
 * All poker apps (TELE, Wepoker) operate on China time, so settlement
 * weeks are Mon 00:00 → Sun 23:59:59 UTC+8.
 * The DB stores dates as ISO UTC strings. These helpers return UTC Date
 * objects representing China-time week boundaries — ready for SQL.
 */

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

function toChinaDate(d: Date): Date {
  return new Date(d.getTime() + CHINA_OFFSET_MS);
}

export function getChinaWeekBounds(offsetWeeks: number): { start: Date; end: Date } {
  const nowChina = toChinaDate(new Date());

  // Monday of the current week in China time
  const dayOfWeek = nowChina.getUTCDay(); // 0=Sun, 1=Mon, ...
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const mondayChina = new Date(Date.UTC(
    nowChina.getUTCFullYear(),
    nowChina.getUTCMonth(),
    nowChina.getUTCDate() - daysSinceMonday,
  ));

  // Shift by offsetWeeks
  const targetMonday = new Date(mondayChina.getTime() + offsetWeeks * 7 * 24 * 60 * 60 * 1000);
  const targetSunday = new Date(targetMonday.getTime() + 6 * 24 * 60 * 60 * 1000);

  // Mon 00:00:00 China time → convert back to UTC
  const startUTC = new Date(targetMonday.getTime() - CHINA_OFFSET_MS);
  // Sun 23:59:59.999 China time → convert back to UTC
  const endUTC = new Date(
    Date.UTC(targetSunday.getUTCFullYear(), targetSunday.getUTCMonth(), targetSunday.getUTCDate(), 23, 59, 59, 999)
    - CHINA_OFFSET_MS
  );

  return { start: startUTC, end: endUTC };
}

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function toISODateTime(d: Date): string {
  return d.toISOString().replace("Z", "");
}

// ISO week string YYYY-Www from a Monday date (in UTC, representing China Monday)
export function toISOWeek(mondayUTC: Date): string {
  // The monday in China time
  const chinaMonday = toChinaDate(mondayUTC);
  const jan1 = new Date(Date.UTC(chinaMonday.getUTCFullYear(), 0, 1));
  const jan1Day = jan1.getUTCDay() || 7; // Mon=1..Sun=7
  // ISO week 1 contains the first Thursday of the year
  const firstThursday = new Date(jan1.getTime() + (4 - jan1Day) * 86400000);
  const firstWeekMonday = new Date(firstThursday.getTime() - 3 * 86400000);
  const weekNum = Math.round((chinaMonday.getTime() - firstWeekMonday.getTime()) / (7 * 86400000)) + 1;
  return `${chinaMonday.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

// Parse YYYY-Www back to offset relative to current week
export function isoWeekToOffset(isoWeek: string): number | null {
  const match = isoWeek.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return null;
  const year = parseInt(match[1]);
  const week = parseInt(match[2]);

  // Find Monday of that ISO week
  const jan4 = new Date(Date.UTC(year, 0, 4)); // Jan 4 is always in week 1
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400000);
  const targetMondayChina = new Date(week1Monday.getTime() + (week - 1) * 7 * 86400000);

  // Current week Monday in China time
  const nowChina = toChinaDate(new Date());
  const dayOfWeek = nowChina.getUTCDay() === 0 ? 6 : nowChina.getUTCDay() - 1;
  const currentMondayChina = new Date(Date.UTC(
    nowChina.getUTCFullYear(), nowChina.getUTCMonth(), nowChina.getUTCDate() - dayOfWeek,
  ));

  const diffMs = targetMondayChina.getTime() - currentMondayChina.getTime();
  return Math.round(diffMs / (7 * 86400000));
}

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
    const { start, end } = getChinaWeekBounds(i);
    weeks.push({
      offset: i,
      isoWeek: toISOWeek(start),
      label: formatWeekLabel(start, end),
      start,
      end,
    });
  }
  return weeks;
}

function formatWeekLabel(startUTC: Date, endUTC: Date): string {
  const s = toChinaDate(startUTC);
  const e = toChinaDate(endUTC);
  const months = ["jan.", "fév.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const sd = `${s.getUTCDate()} ${months[s.getUTCMonth()]}`;
  const ed = `${e.getUTCDate()} ${months[e.getUTCMonth()]}`;
  if (s.getUTCFullYear() !== e.getUTCFullYear()) {
    return `${sd} ${s.getUTCFullYear()} → ${ed} ${e.getUTCFullYear()}`;
  }
  return `${sd} → ${ed}`;
}

export function formatRangeLabel(startUTC: Date, endUTC: Date): string {
  const s = toChinaDate(startUTC);
  const e = toChinaDate(endUTC);
  const days = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
  const months = ["jan.", "fév.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const sDay = days[s.getUTCDay()];
  const eDay = days[e.getUTCDay()];
  const sd = `${sDay} ${s.getUTCDate()} ${months[s.getUTCMonth()]}`;
  const ed = `${eDay} ${e.getUTCDate()} ${months[e.getUTCMonth()]} ${e.getUTCFullYear()}`;
  return `${sd} → ${ed} (UTC+8)`;
}
