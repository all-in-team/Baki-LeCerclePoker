import { getDb } from "@/lib/db";
import { sendMsg } from "./helpers";

const PORTAL_URL = "https://lecerclepoker-production.up.railway.app/portal";

export async function handleMyAffi(chatId: number, chatType: string, fromId: number) {
  if (chatType !== "private") return;

  const db = getDb();
  const player = db.prepare(
    `SELECT p.id, p.name FROM players p WHERE p.telegram_id = ?`
  ).get(fromId) as { id: number; name: string } | undefined;

  if (!player) {
    await sendMsg(chatId, `Tu n'es pas encore enregistré chez LeCerclePoker. Tape /start pour commencer.`);
    return;
  }

  const rel = db.prepare(
    `SELECT 1 FROM affiliate_relationships WHERE affiliate_player_id = ? AND status = 'active'`
  ).get(player.id);

  if (!rel) {
    await sendMsg(chatId, `Tu n'es pas encore affilié à LeCerclePoker. Contacte @baki77777 pour rejoindre le programme.`);
    return;
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) { await sendMsg(chatId, `❌ Config erreur.`); return; }

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `🎰 <b>${player.name}</b>, voici ton dashboard affiliate.\n\nTu y trouveras tes stats, filleuls et paiements.`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🎰 Ouvrir mon dashboard", web_app: { url: PORTAL_URL } }]],
      },
    }),
  });
}
