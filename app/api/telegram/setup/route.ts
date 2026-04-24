import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token) return NextResponse.json({ error: "TELEGRAM_BOT_TOKEN not set in .env.local" }, { status: 500 });

  const { webhookUrl } = await req.json();
  if (!webhookUrl) return NextResponse.json({ error: "webhookUrl required" }, { status: 400 });

  const body: Record<string, any> = { url: webhookUrl, allowed_updates: ["message"] };
  if (secret) body.secret_token = secret;

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return NextResponse.json(data);
}

export async function GET() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return NextResponse.json({ error: "TELEGRAM_BOT_TOKEN not set" }, { status: 500 });
  const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const data = await res.json();
  return NextResponse.json(data);
}
