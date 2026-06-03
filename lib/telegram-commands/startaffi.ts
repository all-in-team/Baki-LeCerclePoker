import { getDb } from "@/lib/db";
import { sendMsg } from "./helpers";

const DIRECT_LINK = "https://t.me/LeCercle_Lebot/portal";

export async function handleStartAffi(chatId: number, fromId: number, chatType: string, threadId?: number) {
  if (chatType !== "group" && chatType !== "supergroup") {
    await sendMsg(chatId, `❌ Cette commande doit être tapée dans le groupe d'un player.`, threadId);
    return;
  }

  const db = getDb();
  const player = db.prepare(
    `SELECT id, name, telegram_id FROM players WHERE telegram_group_id = ?`
  ).get(String(chatId)) as { id: number; name: string; telegram_id: number | null } | undefined;

  if (!player) {
    await sendMsg(chatId, `❌ Ce groupe n'est pas associé à un player.`, threadId);
    return;
  }

  if (player.telegram_id === null && fromId) {
    db.prepare(`UPDATE players SET telegram_id = ? WHERE id = ? AND telegram_id IS NULL`)
      .run(fromId, player.id);
    console.log(`[startaffi] Backfilled telegram_id=${fromId} for player ${player.id} (${player.name})`);
  }

  const existing = db.prepare(
    `SELECT 1 FROM affiliate_profiles WHERE affiliate_player_id = ?`
  ).get(player.id);

  if (existing) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) { console.error("[startaffi] No TELEGRAM_BOT_TOKEN"); return; }
    const body: Record<string, any> = {
      chat_id: chatId,
      text: `✅ <b>${player.name}</b> est déjà agent. Voici ton dashboard 👇`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "🎰 Ouvrir mon dashboard", url: DIRECT_LINK }]] },
    };
    if (threadId) body.message_thread_id = threadId;
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error("[startaffi] sendMessage failed (existing):", res.status, await res.text().catch(() => ""));
    return;
  }

  db.prepare(`INSERT INTO affiliate_profiles (affiliate_player_id) VALUES (?)`).run(player.id);
  console.log(`[startaffi] Created affiliate profile for player ${player.id} (${player.name})`);

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) { await sendMsg(chatId, `❌ Config erreur.`, threadId); return; }

  const body: Record<string, any> = {
    chat_id: chatId,
    text:
      `🎰 <b>${player.name}</b>, félicitations !\n\n` +
      `Tu es désormais agent LeCerclePoker.\n\n` +
      `Tu peux ramener des filleuls et gagner :\n` +
      `• <b>50% des profits agency lifetime</b> sur les games onboardés dans les 30 premiers jours\n` +
      `• Après 30 jours, les nouveaux games ne comptent plus\n\n` +
      `💡 Makeup : tu touches quand on est en profit cumulé sur ton filleul.\n` +
      `⚠️ Tu réponds de tes filleuls (scam = déduit de tes profits).\n\n` +
      `Ouvre ton dashboard pour récupérer ton lien perso 👇`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "🎰 Ouvrir mon dashboard", url: DIRECT_LINK }]] },
  };
  if (threadId) body.message_thread_id = threadId;
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error("[startaffi] sendMessage failed (new):", res.status, await res.text().catch(() => ""));
}
