export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getOpsFeed, getDashboardStatus } from "@/lib/queries";

// READ-ONLY aggregation for the War Room dashboard. No writes, no side effects.
export async function GET() {
  const events = getOpsFeed(20);
  const status = getDashboardStatus();
  return NextResponse.json({ ok: true, events, status });
}
