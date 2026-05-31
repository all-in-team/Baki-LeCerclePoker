export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import {
  sendInitialReminders,
  sendEscalationReminders,
  sendFinalAlert,
} from "@/lib/telegram-commands/cashout-reminder";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  const provided = req.headers.get("x-admin-token");
  if (provided !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const phase: string = body.phase ?? "initial";
  const playerIds: number[] | undefined = body.player_ids;
  const dryRun: boolean = body.dry_run === true;

  if (!["initial", "escalation", "final"].includes(phase)) {
    return NextResponse.json({ error: "phase must be initial, escalation, or final" }, { status: 400 });
  }

  let result: any;
  if (phase === "initial") {
    result = await sendInitialReminders(playerIds, dryRun);
  } else if (phase === "escalation") {
    result = await sendEscalationReminders(playerIds, dryRun);
  } else {
    const escalation = await sendEscalationReminders(playerIds, dryRun);
    const alert = await sendFinalAlert(dryRun);
    result = { escalation, alert };
  }

  console.log(`[ADMIN] trigger-cashout-cycle phase=${phase} dry_run=${dryRun}:`, JSON.stringify(result));
  return NextResponse.json({ ok: true, phase, ...result });
}
