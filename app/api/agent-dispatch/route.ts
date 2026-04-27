import { NextRequest, NextResponse } from "next/server";
import { dispatchFix, isWithinBudget, recentDoerSessions } from "@/lib/agent-doer";

export const dynamic = "force-dynamic";

function authorize(req: NextRequest): boolean {
  const expected = process.env.AGENT_REPORT_SECRET;
  if (!expected) return false;
  const got = req.headers.get("x-agent-report-secret");
  return got === expected;
}

export async function POST(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const description = typeof body?.description === "string" ? body.description.trim() : "";
  const chatId = typeof body?.chat_id === "string" ? body.chat_id : (process.env.AGENT_TELEGRAM_CHAT_ID ?? "-4846690641");
  const moneyOk = body?.money_ok === true;

  if (!description) {
    return NextResponse.json({ error: "description required" }, { status: 400 });
  }

  const result = await dispatchFix({ chatId, description, money_ok: moneyOk });

  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 400 });
  }

  return NextResponse.json({ ok: true, session_id: result.session_id });
}

export async function GET() {
  const budget = isWithinBudget();
  const recent = recentDoerSessions(5);
  return NextResponse.json({
    status: "agent-dispatch endpoint live",
    budget,
    recent: recent.map(r => ({
      session_id: r.session_id,
      description: r.description.slice(0, 80),
      status: r.status,
      pr_url: r.pr_url,
      cost_usd: r.cost_usd_estimate,
      created_at: r.created_at,
    })),
  });
}
