import { NextResponse } from "next/server";
import { getQueue } from "@/lib/settlement-engine";
import { getWeekBounds, toParisDate, toUTCISO } from "@/lib/date-utils";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const url = new URL(req.url);
  const weekParam = url.searchParams.get("week");

  let weekStart: string;
  if (weekParam) {
    // Accept YYYY-MM-DD (Monday) directly
    weekStart = weekParam;
  } else {
    // Default to last completed week
    const { start } = getWeekBounds(-1);
    weekStart = toParisDate(toUTCISO(start));
  }

  const { period, rows } = getQueue(weekStart);
  return NextResponse.json({ period, rows, week_start: weekStart });
}
