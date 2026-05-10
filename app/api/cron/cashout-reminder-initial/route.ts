export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sendInitialReminders } from "@/lib/telegram-commands/cashout-reminder";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  const expected = process.env.AGENT_REPORT_SECRET;
  if (expected && secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await sendInitialReminders();
  console.log("[CRON] cashout-reminder-initial:", result);
  return NextResponse.json({ ok: true, ...result });
}
