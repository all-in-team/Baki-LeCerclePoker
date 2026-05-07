import { getDb } from "@/lib/db";
import { sendMsg, sendMsgKeyboard, answerCbQuery, getSession, setSession, AGENT_CHAT_ID } from "./helpers";
import {
  SOLO_RESPONSE, CONTRACT_MSG_1, CONTRACT_MSG_2, CONTRACT_MSG_3, CONTRACT_MSG_4,
  SIGNED_RESPONSE, STEP_1_ACTION_PCT, QUESTIONS_RESPONSE,
} from "./onboarding-script";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function safeSend(chatId: number | string, text: string, threadId?: number, label?: string): Promise<boolean> {
  try {
    await sendMsg(chatId, text, threadId);
    console.log(`[PITCH] sent ${label ?? "msg"} to ${chatId}`);
    return true;
  } catch (e: any) {
    console.error(`[PITCH] sendMsg failed (${label}):`, e?.message ?? e);
    try { await sendMsg(chatId, text.replace(/<[^>]+>/g, ""), threadId); } catch {}
    return false;
  }
}

function safeSetSession(chatId: number | string, step: string, playerId: number | null, expectedTgId: number | null, label: string) {
  try {
    setSession(chatId, step as any, playerId, expectedTgId);
    console.log(`[PITCH] session set: ${label} → step=${step} chatId=${chatId} playerId=${playerId}`);
  } catch (e: any) {
    console.error(`[PITCH] setSession failed (${label}):`, e?.message ?? e);
  }
}

export async function handlePitchCallback(
  callbackQueryId: string,
  data: string,
  chatId: number,
  messageThreadId?: number,
  from?: any
) {
  console.log(`[PITCH] callback received: data="${data}" chatId=${chatId} threadId=${messageThreadId} from=${from?.id}`);

  try {
    await answerCbQuery(callbackQueryId);

    const session = getSession(chatId);
    console.log(`[PITCH] session lookup: chatId=${chatId} → step=${session?.step ?? "NULL"} player_id=${session?.player_id ?? "NULL"} expected_tg_id=${session?.expected_tg_id ?? "NULL"}`);

    if (!session) {
      console.warn(`[PITCH] no session for chatId=${chatId}, aborting`);
      await sendMsg(chatId, "🔧 Petit souci technique, je te reviens dans un instant.", messageThreadId);
      await sendMsg(AGENT_CHAT_ID, `⚠️ <b>Pitch callback sans session</b>\ndata=${data}\nchatId=<code>${chatId}</code>`);
      return;
    }

    const db = getDb();
    const player = session.player_id
      ? db.prepare(`SELECT id, name FROM players WHERE id = ?`).get(session.player_id) as { id: number; name: string } | undefined
      : null;
    const playerName = player?.name ?? from?.first_name ?? "Joueur";
    console.log(`[PITCH] player: id=${player?.id ?? "NULL"} name="${playerName}"`);

    // ── Solo ──
    if (data === "onboard_choice_solo") {
      if (session.step !== "pitch_sent") {
        console.warn(`[PITCH] solo: wrong step "${session.step}", expected "pitch_sent"`);
        return;
      }
      console.log(`[PITCH] → branch: solo_declined`);
      safeSetSession(chatId, "solo_declined", session.player_id, session.expected_tg_id, "solo");
      await safeSend(chatId, SOLO_RESPONSE, messageThreadId, "SOLO_RESPONSE");
    }

    // ── Avec vous ──
    else if (data === "onboard_choice_with_us") {
      if (session.step !== "pitch_sent") {
        console.warn(`[PITCH] with_us: wrong step "${session.step}", expected "pitch_sent"`);
        return;
      }
      console.log(`[PITCH] → branch: contract_shown`);
      safeSetSession(chatId, "contract_shown", session.player_id, session.expected_tg_id, "contract");
      await safeSend(chatId, CONTRACT_MSG_1, messageThreadId, "CONTRACT_1");
      await sleep(2000);
      await safeSend(chatId, CONTRACT_MSG_2, messageThreadId, "CONTRACT_2");
      await sleep(2000);
      await safeSend(chatId, CONTRACT_MSG_3, messageThreadId, "CONTRACT_3");
      await sleep(3000);
      try {
        await sendMsgKeyboard(chatId, CONTRACT_MSG_4, [
          [{ text: "✅ Je signe", callback_data: "onboard_contract_sign" }],
          [{ text: "❌ J'ai des questions", callback_data: "onboard_contract_questions" }],
        ], messageThreadId);
        console.log(`[PITCH] sent CONTRACT_4 keyboard to ${chatId}`);
      } catch (e: any) {
        console.error(`[PITCH] sendMsgKeyboard failed (CONTRACT_4):`, e?.message ?? e);
      }
    }

    // ── Je signe ──
    else if (data === "onboard_contract_sign") {
      if (session.step !== "contract_shown") {
        console.warn(`[PITCH] sign: wrong step "${session.step}", expected "contract_shown"`);
        return;
      }
      console.log(`[PITCH] → branch: contract_signed → waiting_action_pct`);
      safeSetSession(chatId, "waiting_action_pct", session.player_id, session.expected_tg_id, "signed");
      await safeSend(chatId, SIGNED_RESPONSE, messageThreadId, "SIGNED_RESPONSE");
      await sleep(1000);
      await safeSend(chatId, STEP_1_ACTION_PCT, messageThreadId, "STEP_1_ACTION_PCT");
    }

    // ── J'ai des questions ──
    else if (data === "onboard_contract_questions") {
      if (session.step !== "contract_shown") {
        console.warn(`[PITCH] questions: wrong step "${session.step}", expected "contract_shown"`);
        return;
      }
      console.log(`[PITCH] → branch: contract_questions`);
      safeSetSession(chatId, "contract_questions", session.player_id, session.expected_tg_id, "questions");
      await safeSend(chatId, QUESTIONS_RESPONSE, messageThreadId, "QUESTIONS_RESPONSE");
      await sendMsg(AGENT_CHAT_ID,
        `⚠️ <b>Question contrat — ${playerName}</b>\n` +
        `Groupe : <code>${chatId}</code>\n\n` +
        `<i>Le joueur a des questions avant de signer. Jump in.</i>`
      );
    }

    else {
      console.warn(`[PITCH] unhandled callback data: "${data}"`);
    }

  } catch (e: any) {
    console.error(`[PITCH] UNHANDLED ERROR:`, e?.message ?? e, e?.stack ?? "");
    try {
      await sendMsg(chatId, "🔧 Petit souci technique, je te reviens dans un instant.", messageThreadId);
      await sendMsg(AGENT_CHAT_ID,
        `🔴 <b>Erreur pitch callback</b>\ndata=${data}\nchatId=<code>${chatId}</code>\n<pre>${String(e?.message ?? e).slice(0, 200)}</pre>`
      );
    } catch {}
  }
}
