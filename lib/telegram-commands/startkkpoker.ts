import { getDb } from "@/lib/db";
import { sendMsg, AGENT_CHAT_ID } from "./helpers";
import { getPlayerGameWallets, getPlayerCashouts } from "@/lib/queries";
import { sendKkpokerPitch } from "./new-members";
import { KKPOKER_GAME_LINK } from "@/lib/games/kkpoker/config";

export async function handleStartKkpoker(chatId: number) {
  const db = getDb();

  const player = db.prepare(
    `SELECT id, name, telegram_id, telegram_handle FROM players WHERE telegram_group_id = ?`
  ).get(String(chatId)) as { id: number; name: string; telegram_id: number | null; telegram_handle: string | null } | undefined;

  if (!player) {
    await sendMsg(chatId, `Ce groupe n'est lié à aucun joueur.`);
    return;
  }

  const kkGameId = (db.prepare(`SELECT id FROM games WHERE name = 'KKPOKER'`).get() as { id: number } | undefined)?.id;
  if (kkGameId) {
    const existingWallets = getPlayerGameWallets(player.id, kkGameId);
    const existingCashouts = getPlayerCashouts(player.id, kkGameId);
    if (existingWallets.length > 0 || existingCashouts.length > 0) {
      await sendMsg(chatId,
        `✅ <b>${player.name}</b> a déjà KKPOKER actif.\n` +
        `Lien : ${KKPOKER_GAME_LINK}`
      );
      return;
    }
  }

  await sendMsg(AGENT_CHAT_ID,
    `🎮 <b>/startkkpoker</b> triggered for <b>${player.name}</b> (id=${player.id}) in group <code>${chatId}</code>`
  );

  await sendKkpokerPitch(chatId, player.id, player);
}
