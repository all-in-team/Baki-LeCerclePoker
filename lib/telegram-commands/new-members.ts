import { getDb } from "@/lib/db";
import { sendMsg, sendMsgKeyboard, setSession, mentionOf, trackOnboardingStep } from "./helpers";
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
      const r = db.prepare(`INSERT INTO players (name, telegram_handle, telegram_id, telegram_chat_id, status, tier) VALUES (@name, @handle, @telegram_id, @chat_id, 'active', 'B')`)
        .run({ name, handle: member.username ?? null, telegram_id: member.id, chat_id: String(chatId) });
      playerId = Number(r.lastInsertRowid);
      isNew = true;
    }

    // Save group data from onboarding flow (if group was just created for this player)
    const groupData = consumePendingGroupData(member.id);
    if (groupData) {
      db.prepare(`UPDATE players SET telegram_group_id = ?, alertes_topic_id = ?, liveplay_topic_id = ? WHERE id = ?`)
        .run(String(groupData.groupId), groupData.alertesTopicId, groupData.liveplayTopicId, playerId);
    }

    if (!existing) {
      db.prepare(`INSERT INTO crm_notes (player_id, content, type) VALUES (?, ?, 'note')`)
        .run(playerId, `Créé automatiquement — a rejoint "${chatTitle}"`);
    } else {
      db.prepare(`UPDATE players SET telegram_chat_id = ? WHERE id = ?`).run(String(chatId), playerId);
      db.prepare(`INSERT INTO crm_notes (player_id, content, type) VALUES (?, ?, 'note')`)
        .run(playerId, `A rejoint "${chatTitle}"`);
    }

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
