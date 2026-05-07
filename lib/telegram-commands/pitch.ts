import { getDb } from "@/lib/db";
import { sendMsg, sendMsgKeyboard, sendPhoto, answerCbQuery, getSession, setSession, AGENT_CHAT_ID } from "./helpers";
import {
  SOLO_RESPONSE, CONTRACT_MSG_1, CONTRACT_MSG_2, CONTRACT_MSG_3, CONTRACT_MSG_4,
  SIGNED_MSG_1, SIGNED_MSG_2, SIGNED_MSG_3, SIGNED_MSG_4, QUESTIONS_RESPONSE,
  HAS_WALLET_MSG_1, HAS_WALLET_DEPOSIT_CAPTION_1, HAS_WALLET_DEPOSIT_CAPTION_2, HAS_WALLET_ASK_DEPOSIT,
  HELP_WALLET_MSG_1, HELP_WALLET_STEP_1_CAPTION, HELP_WALLET_STEP_2,
  HELP_WALLET_STEP_3_CAPTION, HELP_WALLET_STEP_4_CAPTION, HELP_WALLET_STEP_5,
  HELP_WALLET_TRANSITION, HELP_WALLET_DEPOSIT_CAPTION_1, HELP_WALLET_DEPOSIT_CAPTION_2, HELP_WALLET_ASK_DEPOSIT,
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
      console.log(`[PITCH] → branch: signed → wallet choice`);

      if (session.player_id) {
        try {
          db.prepare(`UPDATE players SET status = 'active' WHERE id = ?`).run(session.player_id);
        } catch (e: any) {
          console.error(`[PITCH] failed to update player status:`, e?.message ?? e);
        }
      }

      safeSetSession(chatId, "signed_active", session.player_id, session.expected_tg_id, "signed");

      await safeSend(chatId, SIGNED_MSG_1, messageThreadId, "SIGNED_1");
      await sleep(1500);
      await safeSend(chatId, SIGNED_MSG_2, messageThreadId, "SIGNED_2");
      await sleep(2000);
      await safeSend(chatId, SIGNED_MSG_3, messageThreadId, "SIGNED_3");
      await sleep(2500);
      try {
        await sendMsgKeyboard(chatId, SIGNED_MSG_4, [
          [{ text: "💼 Oui, j'en ai déjà une", callback_data: "onboard_wallet_has" }],
          [{ text: "🆕 Non, j'aimerais savoir comment faire", callback_data: "onboard_wallet_help" }],
        ], messageThreadId);
      } catch (e: any) {
        console.error(`[PITCH] sendMsgKeyboard failed (wallet choice):`, e?.message ?? e);
      }

      await sendMsg(AGENT_CHAT_ID,
        `🎉 <b>Nouveau joueur signé</b>\n` +
        `Nom : <b>${playerName}</b>\n` +
        `Deal : 60/20/20\n` +
        `Groupe : <code>${chatId}</code>\n` +
        `<i>En attente du wallet...</i>`
      );
    }

    // ── Already has wallet ──
    else if (data === "onboard_wallet_has") {
      if (session.step !== "signed_active") {
        console.warn(`[PITCH] wallet_has: wrong step "${session.step}", expected "signed_active"`);
        return;
      }
      console.log(`[PITCH] → branch A: has wallet → deposit collection`);
      await safeSend(chatId, HAS_WALLET_MSG_1, messageThreadId, "HAS_1");
      await sleep(2000);
      await sendPhoto(chatId, "case1_profile.png", HAS_WALLET_DEPOSIT_CAPTION_1, messageThreadId);
      await sleep(2000);
      await sendPhoto(chatId, "case1_deposit.png", HAS_WALLET_DEPOSIT_CAPTION_2, messageThreadId);
      await sleep(2000);
      safeSetSession(chatId, "awaiting_deposit_wallet", session.player_id, session.expected_tg_id, "deposit_A");
      await safeSend(chatId, HAS_WALLET_ASK_DEPOSIT, messageThreadId, "HAS_ASK_DEPOSIT");
    }

    // ── Needs wallet help ──
    else if (data === "onboard_wallet_help") {
      if (session.step !== "signed_active") {
        console.warn(`[PITCH] wallet_help: wrong step "${session.step}", expected "signed_active"`);
        return;
      }
      console.log(`[PITCH] → branch B: needs wallet → TronLink setup + deposit collection`);
      await safeSend(chatId, HELP_WALLET_MSG_1, messageThreadId, "HELP_1");
      await sleep(2000);
      await sendPhoto(chatId, "case2_step1_download.png", HELP_WALLET_STEP_1_CAPTION, messageThreadId);
      await sleep(2500);
      await safeSend(chatId, HELP_WALLET_STEP_2, messageThreadId, "HELP_STEP2");
      await sleep(2500);
      await sendPhoto(chatId, "case2_step3_gasfree.png", HELP_WALLET_STEP_3_CAPTION, messageThreadId);
      await sleep(2500);
      await sendPhoto(chatId, "case2_step5_wallet.png", HELP_WALLET_STEP_4_CAPTION, messageThreadId);
      await sleep(2000);
      await safeSend(chatId, HELP_WALLET_STEP_5, messageThreadId, "HELP_STEP5");
      await sleep(2000);
      await safeSend(chatId, HELP_WALLET_TRANSITION, messageThreadId, "HELP_TRANSITION");
      await sleep(2000);
      await sendPhoto(chatId, "case1_profile.png", HELP_WALLET_DEPOSIT_CAPTION_1, messageThreadId);
      await sleep(2000);
      await sendPhoto(chatId, "case1_deposit.png", HELP_WALLET_DEPOSIT_CAPTION_2, messageThreadId);
      await sleep(2000);
      safeSetSession(chatId, "awaiting_deposit_wallet", session.player_id, session.expected_tg_id, "deposit_B");
      await safeSend(chatId, HELP_WALLET_ASK_DEPOSIT, messageThreadId, "HELP_ASK_DEPOSIT");
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
