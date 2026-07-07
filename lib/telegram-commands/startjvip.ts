import { getDb } from "@/lib/db";
import { sendMsg, AGENT_CHAT_ID } from "./helpers";
import { getPlayerGameWallets, getPlayerCashouts } from "@/lib/queries";
import { askActionPct } from "./action-pct-prompt";
import { getOnboardingThreadId } from "./onboarding-topic";
import { JVIP_GAME_LINK } from "@/lib/games/jvip/config";

export async function handleStartJvip(chatId: number) {
  const db = getDb();

  const player = db.prepare(
    `SELECT id, name, telegram_id, telegram_handle, onboarding_topic_id FROM players WHERE telegram_group_id = ?`
  ).get(String(chatId)) as { id: number; name: string; telegram_id: number | null; telegram_handle: string | null; onboarding_topic_id: number | null } | undefined;

  if (!player) {
    await sendMsg(chatId, `Ce groupe n'est lié à aucun joueur.`);
    return;
  }

  const jvipGameId = (db.prepare(`SELECT id FROM games WHERE name = 'JVIP'`).get() as { id: number } | undefined)?.id;
  if (jvipGameId) {
    const existingWallets = getPlayerGameWallets(player.id, jvipGameId);
    const existingCashouts = getPlayerCashouts(player.id, jvipGameId);
    if (existingWallets.length > 0 || existingCashouts.length > 0) {
      await sendMsg(chatId,
        `✅ <b>${player.name}</b> a déjà JVIP actif.` +
        (JVIP_GAME_LINK ? `\nLien : ${JVIP_GAME_LINK}` : "")
      );
      return;
    }
  }

  await sendMsg(AGENT_CHAT_ID,
    `🎮 <b>/startjvip</b> triggered for <b>${player.name}</b> (id=${player.id}) in group <code>${chatId}</code>`
  );

  // Resolve (and repair-if-missing) the Onboarding topic so the flow never posts in General.
  // tid anchors the flow to the Onboarding topic; subsequent callbacks/raw messages inherit
  // it via message_thread_id.
  const tid = await getOnboardingThreadId(chatId, player.id, "JVIP");

  // Owner types the action % for THIS player (free text) before the pitch is sent.
  await askActionPct(chatId, player.id, player, "JVIP", tid);
}
