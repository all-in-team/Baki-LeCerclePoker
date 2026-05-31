import { getDb } from "@/lib/db";
import {
  sendMsg, sendMsgKeyboard, sendPhoto, answerCbQuery, editMessageReplyMarkup,
  getSession, setSession, TRC20_RE, AGENT_CHAT_ID,
  type Step,
} from "@/lib/telegram-commands/helpers";
import { addPlayerCashout, addPlayerGameWallet } from "@/lib/queries";
import { KKPOKER_GAME_NAME, KKPOKER_GAME_LINK } from "./config";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function getKkpokerGameId(): number | null {
  const row = getDb().prepare(`SELECT id FROM games WHERE name = ?`).get(KKPOKER_GAME_NAME) as { id: number } | undefined;
  return row?.id ?? null;
}

function getKkpokerDeal(playerId: number): { action_pct: number; rakeback_pct: number } | null {
  const gameId = getKkpokerGameId();
  if (!gameId) return null;
  return getDb().prepare(
    `SELECT action_pct, rakeback_pct FROM player_game_deals WHERE player_id = ? AND game_id = ?`
  ).get(playerId, gameId) as { action_pct: number; rakeback_pct: number } | undefined ?? null;
}

// ── Callback handler for KKPOKER onboarding buttons ──

export async function handleKkpokerCallback(
  callbackQueryId: string,
  data: string,
  chatId: number,
  messageThreadId?: number,
  from?: any,
  messageId?: number,
) {
  await answerCbQuery(callbackQueryId);

  const session = getSession(chatId);
  if (!session) {
    await sendMsg(chatId, "🔧 Petit souci technique, je te reviens dans un instant.");
    return;
  }

  const db = getDb();
  const player = session.player_id
    ? db.prepare(`SELECT id, name FROM players WHERE id = ?`).get(session.player_id) as { id: number; name: string } | undefined
    : null;
  const playerName = player?.name ?? from?.first_name ?? "Joueur";
  const tgId = session.expected_tg_id ?? from?.id;

  const tid = messageThreadId;

  // ── Question ──
  if (data === "kk_choice_question") {
    if (session.step === "awaiting_human_response" as Step) {
      await sendMsg(chatId, "Ta question est en cours de traitement, on te répond bientôt 👍", tid);
      return;
    }
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});
    setSession(chatId, "awaiting_human_response" as Step, session.player_id, session.expected_tg_id, "question_pending");
    await sendMsg(chatId, `Pas de souci, pose ta question ici. Baki vient voir 👇`, tid);
    await sendMsg(AGENT_CHAT_ID,
      `💬 <b>Question KKPOKER onboarding — ${playerName}</b>\n` +
      `@baki77777 — réponds dans le chat <code>${chatId}</code>`
    );
    return;
  }

  // ── Avec vous → show contract ──
  if (data === "kk_choice_with_us") {
    if (session.step !== ("kkpoker_pitch_sent" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    let actionPctDisplay = "40";
    let playerPctDisplay = "60";
    if (player) {
      const deal = getKkpokerDeal(player.id);
      if (deal) {
        actionPctDisplay = String(deal.action_pct);
        playerPctDisplay = String(100 - deal.action_pct);
      }
    }

    setSession(chatId, "kkpoker_contract_shown" as Step, session.player_id, session.expected_tg_id);

    await sendMsg(chatId, `Bien joué. Voilà le contrat, pas de surprise :`, tid);
    await sleep(2000);
    await sendMsg(chatId,
      `💰 <b>Le deal financier — KKPOKER</b>\n` +
      `Action symétrique ${playerPctDisplay}/${actionPctDisplay} :\n` +
      `- Tu gagnes 1000 → tu nous envoies ${actionPctDisplay}0 (${playerPctDisplay}% pour toi)\n` +
      `- Tu perds 1000 → on t'envoie ${actionPctDisplay}0 (on couvre ${actionPctDisplay}% de tes pertes)`,
      tid
    );
    await sleep(3000);
    await sendMsgKeyboard(chatId,
      `Tu valides ?`,
      [
        [{ text: "✅ Je signe", callback_data: "kk_contract_sign" }],
        [{ text: "❓ J'ai une question", callback_data: "kk_choice_question" }],
      ],
      tid
    );
    return;
  }

  // ── Je signe → wallet collection ──
  if (data === "kk_contract_sign") {
    if (session.step !== ("kkpoker_contract_shown" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    if (session.player_id) {
      db.prepare(`UPDATE players SET status = 'active' WHERE id = ?`).run(session.player_id);
    }

    await sendMsg(chatId, `✅ <b>Deal accepté !</b>`, tid);

    await sleep(1500);
    await sendMsg(chatId,
      `Voici le lien pour rejoindre la game :\n` +
      `👉 ${KKPOKER_GAME_LINK}`,
      tid
    );

    await sleep(2500);
    await sendMsg(chatId,
      `On a besoin de 2 adresses TRON USDT pour te brancher au dashboard :\n\n` +
      `1️⃣ Ton <b>adresse de retrait</b> = ta wallet perso (Exodus, Binance, Kraken, n'importe laquelle). C'est là où on t'envoie ton cash quand tu retires.\n\n` +
      `2️⃣ L'<b>adresse de la game</b> = fournie par KKPOKER dans l'app, tu nous la copies.\n\n` +
      `⚠️ TRC20 (réseau TRON) UNIQUEMENT.\n` +
      `Si tu utilises Binance/Exodus, choisis bien le réseau TRON (TRC20), pas BEP20 ni ERC20 — sinon tes fonds sont perdus.\n\n` +
      `On y va, étape par étape 👇`,
      tid
    );

    await sleep(2000);
    await sendMsg(chatId,
      `<b>Étape 1 — ton adresse de retrait</b>\n\n` +
      `Envoie-moi ton adresse TRC20 USDT (depuis Exodus, Binance, Kraken, etc.).\n` +
      `Format : commence par T, 34 caractères.`,
      tid
    );

    setSession(chatId, "awaiting_kkpoker_cashout_wallet" as Step, session.player_id, session.expected_tg_id);

    await sendMsg(AGENT_CHAT_ID,
      `🎉 <b>Nouveau joueur signé KKPOKER</b>\n` +
      `Nom : <b>${playerName}</b>\n` +
      `<i>En attente des wallets...</i>`
    );
    return;
  }
}

// ── Raw message handler for KKPOKER wallet collection states ──

export async function handleKkpokerRawMessage(
  text: string,
  chatId: number,
  session: { step: Step; player_id: number; expected_tg_id: number | null },
  messageThreadId?: number,
): Promise<boolean> {
  const reply = (msg: string) => sendMsg(chatId, msg, messageThreadId);

  // ── Cashout wallet (step 1 of 2) ──
  if (session.step === ("awaiting_kkpoker_cashout_wallet" as Step)) {
    if (!TRC20_RE.test(text)) {
      await reply(`❌ Format incorrect. Une adresse TRON commence par T et fait 34 caractères. Réessaie.`);
      return true;
    }

    const gameId = getKkpokerGameId();
    if (!gameId) {
      await reply(`❌ Erreur interne (game KKPOKER introuvable). Contacte @baki77777`);
      return true;
    }

    // Save cashout wallet
    addPlayerCashout(session.player_id, text, gameId);

    // Store address in session context for duplicate check later
    const db = getDb();
    db.prepare(`UPDATE telegram_sessions SET pending_cmd = ? WHERE chat_id = ?`).run(text, String(chatId));

    setSession(chatId, "awaiting_kkpoker_game_wallet" as Step, session.player_id, session.expected_tg_id, text);

    await reply(`✅ Adresse de retrait enregistrée.`);
    await sleep(1500);
    await reply(
      `<b>Étape 2 — l'adresse de la game KKPOKER</b>\n\n` +
      `Ouvre l'app KKPOKER, va sur ta page profil, clique sur le bouton <b>充币</b> (Deposit) — c'est celui entouré sur cette image 👇`
    );

    try {
      await sendPhoto(chatId, "kkpoker_deposit_button.png",
        `Copie l'adresse TRC20 USDT qui s'affiche et envoie-la-moi ici.`,
        messageThreadId
      );
    } catch {
      await reply(`Copie l'adresse TRC20 USDT qui s'affiche et envoie-la-moi ici.`);
      await sendMsg(AGENT_CHAT_ID, `⚠️ TODO: kkpoker_deposit_button.png failed to send for ${session.player_id}`);
    }
    return true;
  }

  // ── Game wallet (step 2 of 2) ──
  if (session.step === ("awaiting_kkpoker_game_wallet" as Step)) {
    if (!TRC20_RE.test(text)) {
      await reply(`❌ Format incorrect. Une adresse TRON commence par T et fait 34 caractères. Réessaie.`);
      return true;
    }

    // Check different from cashout
    const freshSession = getSession(chatId);
    const cashoutAddress = freshSession?.pending_cmd ?? "";
    if (text === cashoutAddress) {
      await reply(
        `⚠️ L'adresse de la game doit être différente de ton adresse de retrait. ` +
        `L'adresse game est fournie par KKPOKER (bouton 充币 dans l'app), pas par ta wallet perso. Réessaie.`
      );
      return true;
    }

    const gameId = getKkpokerGameId();
    if (!gameId) {
      await reply(`❌ Erreur interne (game KKPOKER introuvable). Contacte @baki77777`);
      return true;
    }

    // Save game wallet
    addPlayerGameWallet(session.player_id, text, gameId);

    setSession(chatId, "onboarding_complete" as Step, session.player_id, session.expected_tg_id);

    await reply(
      `✅ Adresse de la game enregistrée.\n\n` +
      `Tu es prêt. Tu peux commencer à jouer 🎰\n` +
      `Ton support reste disponible ici 24/7 pour toute question.`
    );

    // Ops alert
    const db = getDb();
    const player = db.prepare(`SELECT name FROM players WHERE id = ?`).get(session.player_id) as { name: string } | undefined;
    const playerName = player?.name ?? "Joueur";
    const deal = getKkpokerDeal(session.player_id);
    const actionPct = deal?.action_pct ?? 40;
    const playerPct = 100 - actionPct;

    await sendMsg(AGENT_CHAT_ID,
      `🎉 <b>Onboarding KKPOKER complet — ${playerName}</b>\n` +
      `Deal : ${playerPct}/${actionPct} (action_pct=${actionPct})\n` +
      `Wallet retrait : <code>${cashoutAddress}</code>\n` +
      `Wallet game KKPOKER : <code>${text}</code>\n` +
      `Groupe : ${KKPOKER_GAME_LINK}`
    );

    return true;
  }

  return false;
}
