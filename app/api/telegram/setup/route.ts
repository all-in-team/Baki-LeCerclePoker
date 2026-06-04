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
      description: "Bienvenue sur Le Cercle !\n\nPour jouer, il te suffit de cliquer sur Start — on va créer un groupe privé avec ton support dédié.\n\n🃏 Tables privées 24/7\n💰 Dépôts & retraits : USDT / Bancaire\n🤝 Support personnel dédié",
    }),
  });
  const descData = await descRes.json();

  return NextResponse.json({ webhook: data, description: descData });
}

export async function GET(req: NextRequest) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return NextResponse.json({ error: "TELEGRAM_BOT_TOKEN not set" }, { status: 500 });

  const chatId = req.nextUrl.searchParams.get("test_chat");
  if (chatId) {
    const action = req.nextUrl.searchParams.get("action") ?? "send";
    if (action === "members") {
      const res = await fetch(`https://api.telegram.org/bot${token}/getChatAdministrators`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId }),
      });
      return NextResponse.json(await res.json());
    }
    const [sendRes, chatRes] = await Promise.all([
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: "🔧 Test message from diagnostic endpoint", parse_mode: "HTML" }),
      }),
      fetch(`https://api.telegram.org/bot${token}/getChat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId }),
      }),
    ]);
    const [sendData, chatData] = await Promise.all([sendRes.json(), chatRes.json()]);
    return NextResponse.json({ test_send: sendData, chat_info: chatData });
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const data = await res.json();
  return NextResponse.json(data);
}
