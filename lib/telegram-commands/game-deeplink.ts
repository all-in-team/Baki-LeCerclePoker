import { getDb } from "@/lib/db";
import { sendMsg, AGENT_CHAT_ID } from "./helpers";
import { handleOnboardingDirect } from "./onboarding";
import { hasPitchBeenSent, markPitchConsumed, dispatchGamePitch } from "./pending-game-pitch";

// ?start=<game> deep link for the self-service games (OKPOKER / JVIP / TTPOKER).
//
// FULL in-group self-service, zero owner intervention on the nominal path:
//   click → group auto-created (createPlayerGroup userbot) → on join, the game pitch
//   auto-posts in the Onboarding topic with the default action % → J'accepte → wallets.
// The deal + wallet collection happen in the group's Onboarding topic, NEVER in DM.
//
// The pitch intent is persisted (pending_game_pitches) at group creation, so a delayed join
// or a process restart still fires it (see pending-game-pitch.ts). A re-click by a player
// who already has a group re-fires the pitch into that group (a click must never vanish),
// unless the pitch already went out (dedup → just point them to the topic).
//
// History: the earlier DM self-service flow (pseudo asked, player created + deal + wallets
// in DM) was rejected — not the LeCercle mechanic. Then a lead-capture-only version notified
// the agent but left the player in a muted group. This is the correct version: real onboarding,
// in the group, automatic.
export async function handleGameDeepLink(
  chatId: number,
  from: { id: number; first_name?: string; last_name?: string; username?: string },
  gameName: string,
) {
  const db = getDb();
  const player = db.prepare(
    `SELECT id, name, telegram_handle, telegram_group_id FROM players WHERE telegram_id = ?`
  ).get(from.id) as { id: number; name: string; telegram_handle: string | null; telegram_group_id: string | null } | undefined;

  // ── Reprise: the player already has a group ──
  if (player?.telegram_group_id) {
    const groupId = Number(player.telegram_group_id);

    if (hasPitchBeenSent(from.id, gameName)) {
      await sendMsg(chatId,
        `👉 Ton setup <b>${gameName}</b> est déjà lancé dans ton groupe LeCercle.\n` +
        `Ouvre le topic <b>Onboarding</b> pour continuer 🃏`
      );
      return;
    }

    // Pitch never fired (muted group) → fire it NOW into the existing Onboarding topic.
    // A click must never vanish into a silent group.
    const { getOnboardingThreadId } = await import("./onboarding-topic");
    const tid = await getOnboardingThreadId(groupId, player.id, gameName);
    await dispatchGamePitch(gameName, groupId, player.id,
      { name: player.name, telegram_id: from.id, telegram_handle: player.telegram_handle }, tid);
    markPitchConsumed(from.id, gameName, String(groupId));

    await sendMsg(chatId, `👉 C'est parti ! Va voir le topic <b>Onboarding</b> de ton groupe LeCercle 🃏`);
    await sendMsg(AGENT_CHAT_ID,
      `🃏 <b>Pitch ${gameName} (re)posté</b> via re-clic — ${player.name} (#${player.id}), groupe existant. Deal default, ajuste le % si besoin.`
    );
    return;
  }

  // ── Fresh: create the group. handleOnboardingDirect arms the persistent pending for
  // AUTO_PITCH_GAMES on success, so the pitch auto-fires when the player joins
  // (handleNewMembers → claimPendingGamePitch). No pseudo asked (Telegram gives the name).
  await handleOnboardingDirect(chatId, from, gameName);
}
