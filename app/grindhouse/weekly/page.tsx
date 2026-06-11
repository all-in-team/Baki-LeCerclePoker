export const dynamic = "force-dynamic";
import { getDb } from "@/lib/db";
import { getActiveGrinders, getGrindhouseWeeklyCells, getGrindhouseWeeklySessions, getGrindhouseVariants } from "@/lib/queries";
import { getWeekBounds, toUTCISO, toParisDate } from "@/lib/date-utils";
import WeeklyClient, { type WeekCol } from "./WeeklyClient";

// ISO 8601 week number from a YYYY-MM-DD Monday
function isoWeekNum(dateStr: string): number {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round((d.getTime() - jan4.getTime()) / 86400000 / 7);
}

const MONTHS = ["jan.", "fév.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
function shortRange(monday: string, sunday: string): string {
  const [, m1, d1] = monday.split("-").map(Number);
  const [, m2, d2] = sunday.split("-").map(Number);
  return m1 === m2 ? `${d1}-${d2} ${MONTHS[m1 - 1]}` : `${d1} ${MONTHS[m1 - 1]} - ${d2} ${MONTHS[m2 - 1]}`;
}

export default async function GrindhouseWeeklyPage({ searchParams }: { searchParams: Promise<{ weeks?: string }> }) {
  const sp = await searchParams;
  const nWeeks = sp.weeks === "24" ? 24 : 12;

  // current week first (offset 0), then back in time
  const weeks: WeekCol[] = [];
  for (let off = 0; off > -nWeeks; off--) {
    const { start, end } = getWeekBounds(off);
    const monday = toParisDate(toUTCISO(start));
    const sunday = toParisDate(toUTCISO(end));
    weeks.push({
      week_start: monday,
      week_end: sunday,
      iso: `W${isoWeekNum(monday)}`,
      range: shortRange(monday, sunday),
    });
  }

  const from = weeks[weeks.length - 1].week_start;
  const to = weeks[0].week_end;

  const grinders = getActiveGrinders();
  const cells = getGrindhouseWeeklyCells(from, to);
  const sessions = getGrindhouseWeeklySessions(from, to);
  const games = getDb().prepare(`SELECT id, name, COALESCE(currency, 'USDT') AS currency FROM games WHERE status = 'active' ORDER BY name`).all() as { id: number; name: string; currency: string }[];
  const variants = getGrindhouseVariants();

  return (
    <WeeklyClient
      weeks={weeks}
      grinders={grinders}
      cells={cells}
      sessions={sessions}
      games={games}
      variants={variants}
      nWeeks={nWeeks}
    />
  );
}
