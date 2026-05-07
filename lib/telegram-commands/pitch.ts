import { getDb } from "@/lib/db";
import { sendMsg, sendMsgKeyboard, answerCbQuery, getSession, setSession, AGENT_CHAT_ID } from "./helpers";
import {
  SOLO_RESPONSE, CONTRACT_MSG_1, CONTRACT_MSG_2, CONTRACT_MSG_3, CONTRACT_MSG_4,
  SIGNED_RESPONSE, STEP_1_ACTION_PCT, QUESTIONS_RESPONSE,
} from "./onboarding-script";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function handlePitchCallback(
  callbackQueryId: string,
  data: string,
  chatId: number,
  messageThreadId?: number,
  from?: any
) {
  await answerCbQuery(callbackQueryId);
  const session = getSession(chatId);
  if (!session) return;

  const db = getDb();
  const player = session.player_id
    ? db.prepare(`SELECT id, name FROM players WHERE id = ?`).get(session.player_id) as { id: number; name: string } | undefined
    : null;
  const playerName = player?.name ?? from?.first_name ?? "Joueur";

  if (data === "onboard_choice_solo" && session.step === "pitch_sent") {
    setSession(chatId, "solo_declined", session.player_id, session.expected_tg_id);
    await sendMsg(chatId, SOLO_RESPONSE, messageThreadId);
  }

  else if (data === "onboard_choice_with_us" && session.step === "pitch_sent") {
    setSession(chatId, "contract_shown", session.player_id, session.expected_tg_id);
    await sendMsg(chatId, CONTRACT_MSG_1, messageThreadId);
    await sleep(2000);
    await sendMsg(chatId, CONTRACT_MSG_2, messageThreadId);
    await sleep(2000);
    await sendMsg(chatId, CONTRACT_MSG_3, messageThreadId);
    await sleep(3000);
    await sendMsgKeyboard(chatId, CONTRACT_MSG_4, [
      [{ text: "✅ Je signe", callback_data: "onboard_contract_sign" }],
      [{ text: "❌ J'ai des questions", callback_data: "onboard_contract_questions" }],
    ], messageThreadId);
  }

  else if (data === "onboard_contract_sign" && session.step === "contract_shown") {
    setSession(chatId, "waiting_action_pct", session.player_id, session.expected_tg_id);
    await sendMsg(chatId, SIGNED_RESPONSE, messageThreadId);
    await sleep(1000);
    await sendMsg(chatId, STEP_1_ACTION_PCT, messageThreadId);
  }

  else if (data === "onboard_contract_questions" && session.step === "contract_shown") {
    setSession(chatId, "contract_questions", session.player_id, session.expected_tg_id);
    await sendMsg(chatId, QUESTIONS_RESPONSE, messageThreadId);
    await sendMsg(AGENT_CHAT_ID,
      `⚠️ <b>Question contrat — ${playerName}</b>\n` +
      `Groupe : <code>${chatId}</code>\n\n` +
      `<i>Le joueur a des questions avant de signer. Jump in.</i>`
    );
  }
}
