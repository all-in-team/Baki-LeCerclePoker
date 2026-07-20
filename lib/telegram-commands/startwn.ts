import { getDb } from "@/lib/db";
import { sendMsg, AGENT_CHAT_ID } from "./helpers";
import { getPlayerGameWallets, getPlayerCashouts } from "@/lib/queries";
import { getOnboardingThreadId } from "./onboarding-topic";
import { WN_ROOM_INVITE_LINK, WN_DEFAULT_ACTION_PCT } from "@/lib/games/wn/config";

export async function handleStartWn(chatId: number) {
  const db = getDb();

  const player = db.prepare(
    `SELECT id, name, telegram_id, telegram_handle, onboarding_topic_id FROM players WHERE telegram_group_id = ?`
  ).get(String(chatId)) as { id: number; name: string; telegram_id: number | null; telegram_handle: string | null; onboarding_topic_id: number | null } | undefined;

  if (!player) {
    await sendMsg(chatId, `Ce groupe n'est lié à aucun joueur.`);
    return;
  }

  const wnGameId = (db.prepare(`SELECT id FROM games WHERE name = 'WN'`).get() as { id: number } | undefined)?.id;
  if (wnGameId) {
    const existingWallets = getPlayerGameWallets(player.id, wnGameId);
    const existingCashouts = getPlayerCashouts(player.id, wnGameId);
    if (existingWallets.length > 0 || existingCashouts.length > 0) {
      await sendMsg(chatId,
        `✅ <b>${player.name}</b> a déjà WN actif.\n` +
        `Room : <a href="${WN_ROOM_INVITE_LINK}">lien d'invitation</a>`
      );
      return;
    }
  }

  await sendMsg(AGENT_CHAT_ID,
    `🎮 <b>/startwn</b> triggered for <b>${player.name}</b> (id=${player.id}) in group <code>${chatId}</code>`
  );

  // Resolve (and repair-if-missing) the Onboarding topic so the flow never posts in General.
  const tid = await getOnboardingThreadId(chatId, player.id, "WN");

  // Deal forcé à 40% (Hugo 2026-07-20 — pas de question de %). Modifiable ensuite
  // via l'éditeur « WN % » de la page A5NUTS (indépendant du % A5/NUTS).
  const { sendWnPitch } = await import("@/lib/games/wn/onboarding");
  await sendWnPitch(chatId, player.id, player, WN_DEFAULT_ACTION_PCT, tid);
}
