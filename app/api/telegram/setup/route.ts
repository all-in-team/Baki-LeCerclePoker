import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token) return NextResponse.json({ error: "TELEGRAM_BOT_TOKEN not set in .env.local" }, { status: 500 });

  const { webhookUrl } = await req.json();
  if (!webhookUrl) return NextResponse.json({ error: "webhookUrl required" }, { status: 400 });

  const body: Record<string, any> = { url: webhookUrl, allowed_updates: ["message", "callback_query", "my_chat_member", "chat_member"] };
  if (secret) body.secret_token = secret;

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  const descRes = await fetch(`https://api.telegram.org/bot${token}/setMyDescription`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description: "Bienvenue sur Le Cercle !\n\nPour jouer, il te suffit de cliquer sur Start — on va créer un groupe privé avec ton support dédié.\n\n🃏 Tables privées 24/7\n💰 Dépôts & retraits rapides en USDT\n🤝 Support personnel dédié",
    }),
  });
  const descData = await descRes.json();

  return NextResponse.json({ webhook: data, description: descData });
}

export async function GET() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return NextResponse.json({ error: "TELEGRAM_BOT_TOKEN not set" }, { status: 500 });
  const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const data = await res.json();
  return NextResponse.json(data);
}
