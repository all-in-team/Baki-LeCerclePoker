import { getDb } from "@/lib/db";
import { sendMsg, AGENT_CHAT_ID } from "./helpers";
import { getPlayerGameWallets, getPlayerCashouts } from "@/lib/queries";
import { askActionPct } from "./action-pct-prompt";
import { NUTSPK_GAME_LINK } from "@/lib/games/nutspk/config";

export async function handleStartNutspk(chatId: number) {
  const db = getDb();

  const player = db.prepare(
    `SELECT id, name, telegram_id, telegram_handle, onboarding_topic_id FROM players WHERE telegram_group_id = ?`
  ).get(String(chatId)) as { id: number; name: string; telegram_id: number | null; telegram_handle: string | null; onboarding_topic_id: number | null } | undefined;

  if (!player) {
    await sendMsg(chatId, `Ce groupe n'est lié à aucun joueur.`);
    return;
  }

  const nutspkGameId = (db.prepare(`SELECT id FROM games WHERE name = 'NUTSPK'`).get() as { id: number } | undefined)?.id;
  if (nutspkGameId) {
    const existingWallets = getPlayerGameWallets(player.id, nutspkGameId);
    const existingCashouts = getPlayerCashouts(player.id, nutspkGameId);
    if (existingWallets.length > 0 || existingCashouts.length > 0) {
      await sendMsg(chatId,
        `✅ <b>${player.name}</b> a déjà NUTSPK actif.\n` +
        `Lien : ${NUTSPK_GAME_LINK}`
      );
      return;
    }
  }

  await sendMsg(AGENT_CHAT_ID,
    `🎮 <b>/startnutspk</b> triggered for <b>${player.name}</b> (id=${player.id}) in group <code>${chatId}</code>`
  );

  // Hold the player on the session so the % flow knows who we're configuring.
  // tid anchors the flow to the Onboarding topic; subsequent callbacks/raw messages
  // inherit it via message_thread_id. NULL → falls back to General (player not set up
  // via the forum-aware path, e.g. linked through an older /linkgroup).
  const tid = player.onboarding_topic_id ?? undefined;
  if (tid === undefined) {
    console.warn(`[NUTSPK] player ${player.id} (${player.name}) has NULL onboarding_topic_id — /startnutspk flow will post in General. Run /linkgroup again or sync-group-structure to backfill topics.`);
  }

  // Owner types the action % for THIS player (free text) before the pitch is sent.
  await askActionPct(chatId, player.id, player, "NUTSPK", tid);
}
