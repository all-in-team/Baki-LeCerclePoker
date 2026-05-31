import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.key !== "drain-queue-20260517") {
    return NextResponse.json({ error: "bad key" }, { status: 403 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token) return NextResponse.json({ error: "no bot token" }, { status: 500 });

  const webhookUrl = "https://lecerclepoker-production.up.railway.app/api/telegram/webhook";

  // Delete webhook + drop pending updates
  const del = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`);
  const delData = await del.json();

  // Re-set webhook
  const setBody: Record<string, any> = {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query", "my_chat_member", "chat_member"],
  };
  if (secret) setBody.secret_token = secret;

  const set = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(setBody),
  });
  const setData = await set.json();

  // Verify
  const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const infoData = await info.json();

  return NextResponse.json({
    deleteWebhook: delData,
    setWebhook: setData,
    webhookInfo: infoData.result,
  });
}
