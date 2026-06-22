import { getDb } from "@/lib/db";
import { sendMsg, AGENT_CHAT_ID } from "./helpers";
import { getPlayerGameWallets, getPlayerCashouts } from "@/lib/queries";
import { QQPK_GAME_LINK } from "@/lib/games/qqpk/config";
import { sendQqpkPitch } from "./new-members";

export async function handleStartQqpk(chatId: number) {
  const db = getDb();

  const player = db.prepare(
    `SELECT id, name, telegram_id, telegram_handle, onboarding_topic_id FROM players WHERE telegram_group_id = ?`
  ).get(String(chatId)) as { id: number; name: string; telegram_id: number | null; telegram_handle: string | null; onboarding_topic_id: number | null } | undefined;

  if (!player) {
    await sendMsg(chatId, `Ce groupe n'est lié à aucun joueur.`);
    return;
  }

  const qqpkGameId = (db.prepare(`SELECT id FROM games WHERE name = 'QQPK'`).get() as { id: number } | undefined)?.id;
  if (qqpkGameId) {
    const existingWallets = getPlayerGameWallets(player.id, qqpkGameId);
    const existingCashouts = getPlayerCashouts(player.id, qqpkGameId);
    if (existingWallets.length > 0 || existingCashouts.length > 0) {
      await sendMsg(chatId,
        `✅ <b>${player.name}</b> a déjà QQPK actif.\n` +
        `Lien : ${QQPK_GAME_LINK}`
      );
      return;
    }
  }

  await sendMsg(AGENT_CHAT_ID,
    `🎮 <b>/startqqpk</b> triggered for <b>${player.name}</b> (id=${player.id}) in group <code>${chatId}</code>`
  );

  // tid anchors the flow to the Onboarding topic; subsequent callbacks/raw messages inherit it.
  const tid = player.onboarding_topic_id ?? undefined;
  if (tid === undefined) {
    console.warn(`[QQPK] player ${player.id} (${player.name}) has NULL onboarding_topic_id — /startqqpk flow will post in General. Run /linkgroup again or sync-group-structure to backfill topics.`);
  }

  // Staking deal is FIXED 70/30 — no action % to pick. Go straight to the pitch.
  await sendQqpkPitch(chatId, player.id, player, tid);
}
