import { getDb } from "@/lib/db";
import { sendMsg, OWNER_IDS } from "./helpers";
import { handleOnboardingDirect } from "./onboarding";

export async function handleStart(chatId: number, fromId: number, fromName: string, from?: any, payload?: string) {
  const db = getDb();

  // Deep-link routing: ?start=kkpoker → KKPOKER onboarding (shared group flow)
  if (payload === "kkpoker") {
    await handleOnboardingDirect(chatId, {
      id: fromId,
      first_name: from?.first_name ?? fromName,
      last_name: from?.last_name,
      username: from?.username,
    }, "KKPOKER");
    return;
  }

  if (payload === "a5poker") {
    await handleOnboardingDirect(chatId, {
      id: fromId,
      first_name: from?.first_name ?? fromName,
      last_name: from?.last_name,
      username: from?.username,
    }, "A5POKER");
    return;
  }

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
  } else if (OWNER_IDS.has(fromId)) {
    await sendMsg(chatId,
      `👋 <b>${fromName}</b> — mode admin actif.`
    );
  } else {
    // Default = AKPOKER onboarding (unchanged)
    await handleOnboardingDirect(chatId, {
      id: fromId,
      first_name: from?.first_name ?? fromName,
      last_name: from?.last_name,
      username: from?.username,
    });
  }
}
