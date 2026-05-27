import { getDb } from "@/lib/db";
import { sendMsg } from "./helpers";

const DIRECT_LINK = "https://t.me/LeCercle_Lebot/portal";

export async function handleStartAffi(chatId: number, fromId: number, chatType: string) {
  if (chatType !== "group" && chatType !== "supergroup") {
    await sendMsg(chatId, `❌ Cette commande doit être tapée dans le groupe d'un player.`);
    return;
  }

  const db = getDb();
  const player = db.prepare(
    `SELECT id, name FROM players WHERE telegram_group_id = ?`
  ).get(String(chatId)) as { id: number; name: string } | undefined;

  if (!player) {
    await sendMsg(chatId, `❌ Ce groupe n'est pas associé à un player.`);
    return;
  }

  const existing = db.prepare(
    `SELECT 1 FROM affiliate_profiles WHERE affiliate_player_id = ?`
  ).get(player.id);

  if (existing) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return;
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `✅ <b>${player.name}</b> est déjà agent. Voici ton dashboard 👇`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🎰 Ouvrir mon dashboard", url: DIRECT_LINK }]],
        },
      }),
    });
    return;
  }

  db.prepare(`INSERT INTO affiliate_profiles (affiliate_player_id) VALUES (?)`).run(player.id);

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) { await sendMsg(chatId, `❌ Config erreur.`); return; }

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text:
        `🎰 <b>${player.name}</b>, félicitations !\n\n` +
        `Tu es désormais agent LeCerclePoker.\n\n` +
        `Tu peux ramener des filleuls et gagner :\n` +
        `• <b>50%</b> des profits agency lifetime sur leur game origin\n` +
        `• <b>50%</b> pendant 30j sur les nouveaux games\n` +
        `• <b>10%</b> en passif après\n\n` +
        `Ouvre ton dashboard pour récupérer ton lien perso 👇`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🎰 Ouvrir mon dashboard", url: DIRECT_LINK }]],
      },
    }),
  });
}
