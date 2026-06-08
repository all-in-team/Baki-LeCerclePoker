import { getDb } from "@/lib/db";
import { sendMsg, setSession, AGENT_CHAT_ID } from "./helpers";
import { AAPKMY_GAME_NAME, AAPKMY_DOWNLOAD_LINK, AAPKMY_CLUB_ID } from "@/lib/games/aapkmy/config";
import type { Step } from "./helpers";

export async function handleStartAapkmy(chatId: number, threadId?: number) {
  const db = getDb();

  const player = db.prepare(
    `SELECT id, name, telegram_id, telegram_handle FROM players WHERE telegram_group_id = ?`
  ).get(String(chatId)) as { id: number; name: string; telegram_id: number | null; telegram_handle: string | null } | undefined;

  if (!player) {
    await sendMsg(chatId, `Ce groupe n'est lié à aucun joueur.`, threadId);
    return;
  }

  const gameId = (db.prepare(`SELECT id FROM games WHERE name = ?`).get(AAPKMY_GAME_NAME) as { id: number } | undefined)?.id;
  if (gameId) {
    const existing = db.prepare(
      `SELECT external_id FROM player_game_ids WHERE player_id = ? AND game_id = ?`
    ).get(player.id, gameId) as { external_id: string } | undefined;
    if (existing) {
      await sendMsg(chatId,
        `✅ <b>${player.name}</b> a déjà AAPK actif (ID: <code>${existing.external_id}</code>).\n` +
        `Club ID: ${AAPKMY_CLUB_ID}`,
        threadId
      );
      return;
    }
  }

  await sendMsg(AGENT_CHAT_ID,
    `🎮 <b>/startaapkmy</b> triggered for <b>${player.name}</b> (id=${player.id}) in group <code>${chatId}</code>`
  );

  setSession(chatId, "aapkmy_waiting_id" as Step, player.id, player.telegram_id);

  await sendMsg(chatId,
    `🎰 <b>Welcome AAPK</b>\n\n` +
    `📥 Download: ${AAPKMY_DOWNLOAD_LINK}\n` +
    `🏠 Club ID: <code>${AAPKMY_CLUB_ID}</code>\n\n` +
    `Une fois installé et le club rejoint, envoie-moi ton ID AAPK ici.`,
    threadId
  );
}
