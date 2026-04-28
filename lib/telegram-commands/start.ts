import { getDb } from "@/lib/db";
import { sendMsg } from "./helpers";

export async function handleStart(chatId: number, fromId: number, fromName: string) {
  const db = getDb();
  // Check if this user is already linked to a player
  const linked = db.prepare(
    `SELECT id, name FROM players WHERE telegram_id = ?`
  ).get(fromId) as { id: number; name: string } | undefined;

  if (linked) {
    // Auto-save telegram_chat_id for DMs
    db.prepare(`UPDATE players SET telegram_chat_id = ? WHERE id = ?`).run(String(chatId), linked.id);
    await sendMsg(chatId,
      `👋 <b>${linked.name}</b>, tu es déjà lié.\nTon chat_id : <code>${chatId}</code>\n\n` +
      `Commandes disponibles :\n<code>/solde</code> — ton solde par game\n<code>/historique</code> — tes dernières transactions`
    );
  } else {
    await sendMsg(chatId,
      `👋 Bienvenue <b>${fromName}</b> !\nTon chat_id : <code>${chatId}</code>\n\n` +
      `<i>L'opérateur peut utiliser cet ID pour te lier dans le dashboard.</i>`
    );
  }
}
