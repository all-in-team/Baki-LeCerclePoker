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

  if (!["initial", "escalation", "final"].includes(phase)) {
    return NextResponse.json({ error: "phase must be initial, escalation, or final" }, { status: 400 });
  }

  let result: any;
  if (phase === "initial") {
    result = await sendInitialReminders(playerIds);
  } else if (phase === "escalation") {
    result = await sendEscalationReminders(playerIds);
  } else {
    const escalation = await sendEscalationReminders(playerIds);
    const alert = await sendFinalAlert();
    result = { escalation, alert };
  }

  console.log(`[ADMIN] trigger-cashout-cycle phase=${phase}:`, result);
  return NextResponse.json({ ok: true, phase, ...result });
}
