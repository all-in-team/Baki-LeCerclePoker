import { getDb } from "@/lib/db";
import { sendMsg, sendMsgKeyboard, setSession, mentionOf, trackOnboardingStep, type Step } from "./helpers";
import { PITCH_MSG_1, PITCH_MSG_2, PITCH_MSG_3, PITCH_MSG_4 } from "./onboarding-script";
import { consumePendingGroupData } from "./onboarding";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function handleNewMembers(members: any[], chatTitle: string, chatId: number) {
  const db = getDb();
  for (const member of members) {
    if (member.is_bot) continue;
    const name = [member.first_name, member.last_name].filter(Boolean).join(" ") || `TG#${member.id}`;
    const existing = db.prepare(`SELECT id FROM players WHERE telegram_id = ?`).get(member.id) as { id: number } | undefined;
    let playerId: number;
    let isNew: boolean;
    if (existing) { playerId = existing.id; isNew = false; }
    else {
      const joinedVia = gameName ? `new_member_${gameName}` : "new_member_AKPOKER";
      const r = db.prepare(`INSERT INTO players (name, telegram_handle, telegram_id, telegram_chat_id, status, tier, joined_via) VALUES (@name, @handle, @telegram_id, @chat_id, 'active', 'B', @joined_via)`)
        .run({ name, handle: member.username ?? null, telegram_id: member.id, chat_id: String(chatId), joined_via: joinedVia });
      playerId = Number(r.lastInsertRowid);
      isNew = true;
    }

    // Save group data from onboarding flow (if group was just created for this player)
    const groupData = consumePendingGroupData(member.id);
    if (groupData) {
      db.prepare(`UPDATE players SET telegram_group_id = ?, alertes_topic_id = ?, liveplay_topic_id = ? WHERE id = ?`)
        .run(String(groupData.groupId), groupData.alertesTopicId, groupData.liveplayTopicId, playerId);
    }

    const gameName = groupData?.gameName;

    if (!existing) {
      db.prepare(`INSERT INTO crm_notes (player_id, content, type) VALUES (?, ?, 'note')`)
        .run(playerId, `Créé automatiquement — a rejoint "${chatTitle}"`);
    } else {
      db.prepare(`UPDATE players SET telegram_chat_id = ? WHERE id = ?`).run(String(chatId), playerId);
      db.prepare(`INSERT INTO crm_notes (player_id, content, type) VALUES (?, ?, 'note')`)
        .run(playerId, `A rejoint "${chatTitle}"`);
    }

    // KKPOKER: insert deal + send KKPOKER-specific pitch
    if (gameName === "KKPOKER") {
      const topicRow = db.prepare(`SELECT onboarding_topic_id FROM players WHERE id = ?`).get(playerId) as { onboarding_topic_id: number | null } | undefined;
      await sendKkpokerPitch(chatId, playerId, { name, telegram_id: member.id, telegram_handle: member.username ?? null }, topicRow?.onboarding_topic_id ?? undefined);
      continue;
    }

    // A5POKER: insert deal + send A5POKER-specific pitch
    if (gameName === "A5POKER") {
      const topicRow = db.prepare(`SELECT onboarding_topic_id FROM players WHERE id = ?`).get(playerId) as { onboarding_topic_id: number | null } | undefined;
      await sendA5pokerPitch(chatId, playerId, { name, telegram_id: member.id, telegram_handle: member.username ?? null }, topicRow?.onboarding_topic_id ?? undefined);
      continue;
    }

    // AKPOKER (default): existing pitch flow — unchanged
    if (isNew) {
      setSession(chatId, "pitch_sent", playerId, member.id);
      trackOnboardingStep(member.id, "pitch_sent");

      const tag = mentionOf({ name: member.first_name ?? name, telegram_handle: member.username ?? null, telegram_id: member.id });
      await sendMsg(chatId, `${tag}\n\n${PITCH_MSG_1(member.first_name ?? name)}`);
      await sleep(2000);
      await sendMsg(chatId, PITCH_MSG_2);
      await sleep(2000);
      await sendMsg(chatId, PITCH_MSG_3);
      await sleep(3000);
      await sendMsgKeyboard(chatId, PITCH_MSG_4, [
        [{ text: "🤝 J'accepte le deal", callback_data: "onboard_choice_with_us" }],
        [{ text: "❓ J'ai une question", callback_data: "onboard_choice_question" }],
      ]);
    }
  }
}

export async function sendKkpokerPitch(
  chatId: number,
  playerId: number,
  player: { name: string; telegram_id: number | null; telegram_handle: string | null },
  onboardingTopicId?: number,
) {
  const db = getDb();
  const kkGameId = (db.prepare(`SELECT id FROM games WHERE name = 'KKPOKER'`).get() as { id: number } | undefined)?.id;
  if (kkGameId) {
    db.prepare(`INSERT OR IGNORE INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct) VALUES (?, ?, 40, 0)`).run(playerId, kkGameId);
  }

  setSession(chatId, "kkpoker_pitch_sent" as Step, playerId, player.telegram_id);
  if (player.telegram_id) trackOnboardingStep(player.telegram_id, "pitch_sent");

  const tid = onboardingTopicId;
  const tag = mentionOf(player);
  await sendMsg(chatId,
    `${tag}\n\n🃏 <b>${player.name}</b> — on te propose KKPOKER !\n\n` +
    `On t'explique comment ça marche et on te setup en quelques minutes.`,
    tid
  );
  await sleep(2000);
  await sendMsg(chatId,
    `Voilà le deal qu'on propose :\n\n` +
    `🤝 Tu joues <b>60%</b> de ton action.\n` +
    `On prend les 40% restants.\n\n` +
    `C'est de l'action symétrique : <b>win/win, lose/lose</b>.\n` +
    `L'avantage : tu peux simplement jouer plus cher. Ça ne te pénalise pas, ça te protège.`,
    tid
  );
  await sleep(3000);
  await sendMsgKeyboard(chatId, `Qu'est-ce que tu en penses ?`, [
    [{ text: "🤝 Avec vous", callback_data: "kk_choice_with_us" }],
    [{ text: "❓ J'ai une question", callback_data: "kk_choice_question" }],
  ], tid);
}

export async function sendA5pokerPitch(
  chatId: number,
  playerId: number,
  player: { name: string; telegram_id: number | null; telegram_handle: string | null },
  onboardingTopicId?: number,
) {
  const db = getDb();
  const a5GameId = (db.prepare(`SELECT id FROM games WHERE name = 'A5POKER'`).get() as { id: number } | undefined)?.id;
  if (a5GameId) {
    db.prepare(`INSERT OR IGNORE INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct) VALUES (?, ?, 20, 0)`).run(playerId, a5GameId);
  }

  setSession(chatId, "a5poker_pitch_sent" as Step, playerId, player.telegram_id);
  if (player.telegram_id) trackOnboardingStep(player.telegram_id, "pitch_sent");

  const tid = onboardingTopicId;
  const tag = mentionOf(player);
  await sendMsg(chatId,
    `${tag}\n\n🃏 <b>${player.name}</b> — on te propose A5POKER !\n\n` +
    `Nouveau cercle, fresh action. On t'explique comment ça marche et on te setup en quelques minutes.`,
    tid
  );
  await sleep(2000);
  await sendMsg(chatId,
    `Voilà le deal qu'on propose A5POKER :\n\n` +
    `🎯 <b>Action 80/20</b> — Tu joues 80% de ton action, on prend 20%. C'est symétrique : win/win, lose/lose.\n\n` +
    `🛡️ <b>1000 USDT de liquidité garantie</b> — On couvre ton float jusqu'à 1K. Tu joues, on gère le risque.\n\n` +
    `⚡ <b>Règle d'or</b> : max 1K sur le compte. Tout l'extra → cash out direct chez toi. ` +
    `Pourquoi ? On couvre 1K en cas de bug site / ban / dispute. Au-dessus, c'est ton risque, donc sécurise.`,
    tid
  );
  await sleep(3000);
  await sendMsgKeyboard(chatId, `Qu'est-ce que tu en penses ?`, [
    [{ text: "🤝 Avec vous", callback_data: "a5_choice_with_us" }],
    [{ text: "❓ J'ai une question", callback_data: "a5_choice_question" }],
  ], tid);
}
