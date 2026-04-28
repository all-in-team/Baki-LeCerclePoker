import { getDb } from "@/lib/db";
import { sendMsg } from "./helpers";

export async function handleStart(chatId: number, fromId: number, fromName: string) {
  const db = getDb();
  // Check if this user is already linked to a player
  const linked = db.prepare(
    `SELECT id, name FROM players WHERE telegram_id = ?`
  ).get(fromId) as { id: number; name: string } | undefined;

  if (linked) {
    db.prepare(`UPDATE players SET telegram_chat_id = ? WHERE id = ?`).run(String(chatId), linked.id);
    await sendMsg(chatId,
      `👋 <b>${linked.name}</b>, tu es connecté !\n\n` +
      `Commandes disponibles :\n` +
      `<code>/solde</code> — ton solde\n` +
      `<code>/historique</code> — tes transactions\n` +
      `<code>/deal</code> — tes deals\n` +
      `<code>/cashout 500</code> — demander un retrait`
    );
  } else {
    await sendMsg(chatId,
      `👋 Bienvenue <b>${fromName}</b> !\n` +
      `<i>Tu n'es pas encore lié à un joueur. L'opérateur s'en occupe.</i>`
    );
  }
}
