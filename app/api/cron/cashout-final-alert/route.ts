export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sendEscalationReminders, sendFinalAlert } from "@/lib/telegram-commands/cashout-reminder";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  const expected = process.env.AGENT_REPORT_SECRET;
  if (expected && secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Send one last escalation reminder to pending players, then alert ops
  const escalation = await sendEscalationReminders();
  const alert = await sendFinalAlert();

  console.log("[CRON] cashout-final-alert:", { escalation, alert });
  return NextResponse.json({ ok: true, escalation, alert });
}
