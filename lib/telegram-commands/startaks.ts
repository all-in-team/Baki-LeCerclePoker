import { getDb } from "@/lib/db";
import { sendMsg, sendMsgKeyboard, setSession, AGENT_CHAT_ID, type Step } from "./helpers";
import { getPlayerGameWallets, getPlayerCashouts } from "@/lib/queries";
import { AKS_GAME_LINK, AKS_ACTION_PRESETS } from "@/lib/games/aks/config";

export async function handleStartAks(chatId: number) {
  const db = getDb();

  const player = db.prepare(
    `SELECT id, name, telegram_id, telegram_handle, onboarding_topic_id FROM players WHERE telegram_group_id = ?`
  ).get(String(chatId)) as { id: number; name: string; telegram_id: number | null; telegram_handle: string | null; onboarding_topic_id: number | null } | undefined;

  if (!player) {
    await sendMsg(chatId, `Ce groupe n'est lié à aucun joueur.`);
    return;
  }

  const aksGameId = (db.prepare(`SELECT id FROM games WHERE name = 'AKS'`).get() as { id: number } | undefined)?.id;
  if (aksGameId) {
    const existingWallets = getPlayerGameWallets(player.id, aksGameId);
    const existingCashouts = getPlayerCashouts(player.id, aksGameId);
    if (existingWallets.length > 0 || existingCashouts.length > 0) {
      await sendMsg(chatId,
        `✅ <b>${player.name}</b> a déjà AKS actif.\n` +
        `Lien : ${AKS_GAME_LINK}`
      );
      return;
    }
  }

  await sendMsg(AGENT_CHAT_ID,
    `🎮 <b>/startaks</b> triggered for <b>${player.name}</b> (id=${player.id}) in group <code>${chatId}</code>`
  );

  // Hold the player on the session so the % callbacks know who we're configuring.
  const tid = player.onboarding_topic_id ?? undefined;
  setSession(chatId, "aks_awaiting_pct" as Step, player.id, player.telegram_id);

  // Owner picks the action % for THIS player before the pitch is sent.
  const presetRow = AKS_ACTION_PRESETS.map(p => ({ text: `${p}%`, callback_data: `aks_action_${p}` }));
  await sendMsgKeyboard(chatId,
    `🎯 <b>${player.name}</b> — choisis le % d'action AKS à proposer :`,
    [
      presetRow,
      [{ text: "✏️ Custom", callback_data: "aks_action_custom" }],
    ],
    tid
  );
}
