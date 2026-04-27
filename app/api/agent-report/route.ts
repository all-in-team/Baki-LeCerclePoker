import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const TG_API = "https://api.telegram.org";

async function postToTelegram(chatId: string, text: string): Promise<{ ok: boolean; status: number; body: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, status: 500, body: "TELEGRAM_BOT_TOKEN not set" };
  const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

function authorize(req: NextRequest): boolean {
  const expected = process.env.AGENT_REPORT_SECRET;
  if (!expected) return false;
  const got = req.headers.get("x-agent-report-secret");
  return got === expected;
}

function fmt(title: string, summary: string): string {
  const safeTitle = title.slice(0, 200);
  const safeSummary = summary.slice(0, 3500);
  return `<b>🤖 ${escapeHtml(safeTitle)}</b>\n\n${escapeHtml(safeSummary)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

  const title = typeof body?.title === "string" ? body.title : null;
  const summary = typeof body?.summary === "string" ? body.summary : null;
  const chatId = typeof body?.chat_id === "string"
    ? body.chat_id
    : (process.env.AGENT_TELEGRAM_CHAT_ID ?? "-4846690641");
  const raw = body?.raw === true;

  if (!title || !summary) {
    return NextResponse.json({ error: "title and summary are required" }, { status: 400 });
  }

  const text = raw ? summary.slice(0, 4000) : fmt(title, summary);
  const result = await postToTelegram(chatId, text);

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, telegram_status: result.status, telegram_body: result.body },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ status: "agent-report endpoint live", method: "POST with x-agent-report-secret header" });
}
