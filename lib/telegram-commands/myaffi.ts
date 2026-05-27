import { getDb } from "@/lib/db";

const PORTAL_URL = "https://lecerclepoker-production.up.railway.app/portal";
const BOT_USERNAME = "LeCercle_Lebot";

export async function handleMyAffi(chatId: number, fromId: number, chatType: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;

  const db = getDb();
  const player = db.prepare(
    `SELECT p.id, p.name FROM players p WHERE p.telegram_id = ?`
  ).get(fromId) as { id: number; name: string } | undefined;

  const name = player?.name ?? "toi";

  if (chatType !== "private") {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🎰 <b>${name}</b>, ton dashboard affiliate est prêt !`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🎰 Voir mon dashboard", url: `https://t.me/${BOT_USERNAME}?start=myaffi` }]],
        },
      }),
    });
    return;
  }

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `🎰 <b>${name}</b>, ton dashboard affiliate 👇`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🎰 Ouvrir mon dashboard", web_app: { url: PORTAL_URL } }]],
      },
    }),
  });
}
