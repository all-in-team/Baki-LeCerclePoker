import { getDb } from "@/lib/db";
import { sendMsg, AGENT_CHAT_ID } from "./helpers";
import { AAPKMY_GAME_NAME, AAPKMY_CLUB_ID } from "@/lib/games/aapkmy/config";
import { askActionPct } from "./action-pct-prompt";

export async function handleStartAapkmy(chatId: number, threadId?: number) {
  const db = getDb();

  const player = db.prepare(
    `SELECT id, name, telegram_id, telegram_handle, onboarding_topic_id FROM players WHERE telegram_group_id = ?`
  ).get(String(chatId)) as { id: number; name: string; telegram_id: number | null; telegram_handle: string | null; onboarding_topic_id: number | null } | undefined;

  if (!player) {
    await sendMsg(chatId, `Ce groupe n'est lié à aucun joueur.`, threadId);
    return;
  }

  const tid = player.onboarding_topic_id ?? threadId;

  const gameId = (db.prepare(`SELECT id FROM games WHERE name = ?`).get(AAPKMY_GAME_NAME) as { id: number } | undefined)?.id;
  if (gameId) {
    const existing = db.prepare(
      `SELECT external_id FROM player_game_ids WHERE player_id = ? AND game_id = ?`
    ).get(player.id, gameId) as { external_id: string } | undefined;
    if (existing) {
      await sendMsg(chatId,
        `✅ <b>${player.name}</b> a déjà AAPK actif (ID: <code>${existing.external_id}</code>).\n` +
        `Club ID: ${AAPKMY_CLUB_ID}`,
        tid
      );
      return;
    }
  }

  await sendMsg(AGENT_CHAT_ID,
    `🎮 <b>/startaapkmy</b> triggered for <b>${player.name}</b> (id=${player.id}) in group <code>${chatId}</code>`
  );

  // Owner types the action % for THIS player (free text); the pitch fires after
  // a valid % via sendAapkmyPitch (handleActionPctRawMessage dispatch).
  await askActionPct(chatId, player.id, player, "AAPKMY", tid);
}
