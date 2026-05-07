import { getDb } from "@/lib/db";
import { sendMsg, sendMsgKeyboard, setSession } from "./helpers";
import { PITCH_MSG_1, PITCH_MSG_2, PITCH_MSG_3, PITCH_MSG_4 } from "./onboarding-script";

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

      await sendMsg(chatId, PITCH_MSG_1(member.first_name ?? name));
      await sleep(2000);
      await sendMsg(chatId, PITCH_MSG_2);
      await sleep(2000);
      await sendMsg(chatId, PITCH_MSG_3);
      await sleep(3000);
      await sendMsgKeyboard(chatId, PITCH_MSG_4, [
        [{ text: "🎲 Solo", callback_data: "onboard_choice_solo" }],
        [{ text: "🤝 Avec vous", callback_data: "onboard_choice_with_us" }],
      ]);
    }
  }
}
