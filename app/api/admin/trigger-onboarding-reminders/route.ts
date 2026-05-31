import { NextRequest, NextResponse } from "next/server";
import { runOnboardingReminders } from "@/lib/onboarding-reminders";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  const provided = req.headers.get("x-admin-token");
  if (provided !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const phase = body.phase as "8h" | "24h" | "7d" | undefined;
  const leadId = body.lead_id as number | undefined;
  const dryRun = body.dry_run === true;

  if (phase && !["8h", "24h", "7d"].includes(phase)) {
    return NextResponse.json({ error: "phase must be '8h', '24h', or '7d'" }, { status: 400 });
  }

  const results = await runOnboardingReminders({ phase, leadId, dryRun });

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    count: results.length,
    results,
  });
}
