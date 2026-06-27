import { getDb } from "@/lib/db";
import {
  sendMsg, sendMsgKeyboard, answerCbQuery, editMessageReplyMarkup,
  getSession, setSession, TRC20_RE, AGENT_CHAT_ID,
  type Step,
} from "@/lib/telegram-commands/helpers";
import { addPlayerCashout, addPlayerGameWallet, recordDealAcceptance } from "@/lib/queries";
import { AKS_GAME_NAME, AKS_GAME_LINK } from "./config";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function getAksGameId(): number | null {
  const row = getDb().prepare(`SELECT id FROM games WHERE name = ?`).get(AKS_GAME_NAME) as { id: number } | undefined;
  return row?.id ?? null;
}

function getAksDeal(playerId: number): { action_pct: number; rakeback_pct: number } | null {
  const gameId = getAksGameId();
  if (!gameId) return null;
  return getDb().prepare(
    `SELECT action_pct, rakeback_pct FROM player_game_deals WHERE player_id = ? AND game_id = ?`
  ).get(playerId, gameId) as { action_pct: number; rakeback_pct: number } | undefined ?? null;
}

export async function handleAksCallback(
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
    ? db.prepare(`SELECT id, name, telegram_id, telegram_handle FROM players WHERE id = ?`).get(session.player_id) as { id: number; name: string; telegram_id: number | null; telegram_handle: string | null } | undefined
    : null;
  const playerName = player?.name ?? from?.first_name ?? "Joueur";

  const tid = messageThreadId;

  // ── Question ──
  if (data === "aks_choice_question") {
    if (session.step === "awaiting_human_response" as Step) {
      await sendMsg(chatId, "Ta question est en cours de traitement, on te répond bientôt 👍", tid);
      return;
    }
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});
    setSession(chatId, "awaiting_human_response" as Step, session.player_id, session.expected_tg_id, "question_pending");
    await sendMsg(chatId, `Pas de souci, pose ta question ici. Baki vient voir 👇`, tid);
    await sendMsg(AGENT_CHAT_ID,
      `💬 <b>Question AKS onboarding — ${playerName}</b>\n` +
      `@baki77777 — réponds dans le chat <code>${chatId}</code>`
    );
    return;
  }

  // ── J'accepte le deal → record acceptance, THEN reveal link, then wallet check ──
  // This is the anti-bypass gate: the Mini App link is sent ONLY here, after an
  // explicit acceptance click, never in the pitch.
  if (data === "aks_accept") {
    if (session.step !== ("aks_pitch_sent" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    const gameId = getAksGameId();
    const deal = player ? getAksDeal(player.id) : null;
    if (session.player_id) {
      if (gameId) recordDealAcceptance(session.player_id, gameId, deal?.action_pct ?? null);
      db.prepare(`UPDATE players SET status = 'active' WHERE id = ?`).run(session.player_id);
    }

    setSession(chatId, "aks_wallet_check" as Step, session.player_id, session.expected_tg_id);

    await sendMsg(chatId, `✅ <b>Deal accepté !</b>`, tid);
    await sleep(1200);
    // Link revealed ONLY now — after explicit acceptance.
    await sendMsg(chatId, `🃏 Parfait ! Rejoins la game AKS 👉 ${AKS_GAME_LINK}`, tid);
    await sleep(1500);
    await sendMsgKeyboard(chatId,
      `Avant de finaliser, question rapide : tu as déjà un wallet crypto USDT en TRC20 (réseau Tron) ?`,
      [
        [{ text: "✅ Oui j'ai un wallet", callback_data: "aks_wallet_yes" }],
        [{ text: "❌ Non, j'en ai pas", callback_data: "aks_wallet_no" }],
      ],
      tid
    );

    await sendMsg(AGENT_CHAT_ID,
      `🎉 <b>Deal accepté AKS — ${playerName}</b>\n` +
      `Action : ${deal?.action_pct ?? "?"}%\n` +
      `<i>En attente wallet check...</i>`
    );
    return;
  }

  // ── Wallet YES → collect wallets ──
  if (data === "aks_wallet_yes") {
    if (session.step !== ("aks_wallet_check" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    await sendMsg(chatId,
      `Top. On va te demander 2 adresses Tron USDT TRC20.\n\n` +
      `⚠️ <b>CRITIQUE</b> : utilise bien TRC20, jamais ERC20 ni BEP20. Sinon fonds perdus.\n\n` +
      `<b>Étape 1 — Ton adresse de RETRAIT</b>\n` +
      `C'est l'adresse où tu veux recevoir tes cashouts.\n` +
      `Envoie-la maintenant (format T... 34 caractères).`,
      tid
    );

    setSession(chatId, "awaiting_aks_cashout_wallet" as Step, session.player_id, session.expected_tg_id);
    return;
  }

  // ── Wallet NO → tutorial + bail ──
  if (data === "aks_wallet_no") {
    if (session.step !== ("aks_wallet_check" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    await sendMsg(chatId,
      `Pas de souci, ça se crée en 5 min :\n\n` +
      `🔹 <b>Option simple (exchange)</b> : crée un compte Binance ou Bybit (gratuit). ` +
      `Section "Wallet" → "Deposit USDT" → choisis réseau TRC20. Tu obtiens ton adresse Tron automatiquement.\n\n` +
      `🔹 <b>Option perso</b> : Trust Wallet (mobile) ou TronLink (extension Chrome). 100% à toi.\n\n` +
      `⚠️ Critique : utilise bien TRC20 (pas ERC20 ni BEP20), sinon les fonds sont perdus.\n\n` +
      `Une fois ton wallet créé, préviens Baki pour reprendre le setup.`,
      tid
    );
    return;
  }
}

// ── Raw message handler for AKS: custom % + wallet collection states ──

export async function handleAksRawMessage(
  text: string,
  chatId: number,
  session: { step: Step; player_id: number; expected_tg_id: number | null; pending_cmd?: string | null },
  messageThreadId?: number,
): Promise<boolean> {
  const reply = (msg: string) => sendMsg(chatId, msg, messageThreadId);

  // ── Cashout wallet (step 1 of 2) ──
  if (session.step === ("awaiting_aks_cashout_wallet" as Step)) {
    if (!TRC20_RE.test(text)) {
      await reply(`❌ Format incorrect. Une adresse TRON commence par T et fait 34 caractères. Réessaie.`);
      return true;
    }

    const gameId = getAksGameId();
    if (!gameId) {
      await reply(`❌ Erreur interne (game AKS introuvable). Contacte @baki77777`);
      return true;
    }

    addPlayerCashout(session.player_id, text, gameId);

    const db = getDb();
    db.prepare(`UPDATE telegram_sessions SET pending_cmd = ? WHERE chat_id = ?`).run(text, String(chatId));

    setSession(chatId, "awaiting_aks_game_wallet" as Step, session.player_id, session.expected_tg_id, text);

    await reply(`✅ Adresse de retrait enregistrée.`);
    await sleep(1500);
    await reply(
      `<b>Étape 2 — L'adresse de dépôt AKS</b>\n\n` +
      `Ouvre l'app AKS, va sur ton profil et clique sur "Deposit" (ou 充币). ` +
      `L'app te donnera une adresse Tron USDT TRC20 pour déposer — copie-la et colle-la ici.\n\n` +
      `Format attendu : T... (34 caractères, TRC20).`
    );
    return true;
  }

  // ── Game wallet (step 2 of 2) ──
  if (session.step === ("awaiting_aks_game_wallet" as Step)) {
    if (!TRC20_RE.test(text)) {
      await reply(`❌ Format incorrect. Une adresse TRON commence par T et fait 34 caractères. Réessaie.`);
      return true;
    }

    const freshSession = getSession(chatId);
    const cashoutAddress = freshSession?.pending_cmd ?? "";
    if (text === cashoutAddress) {
      await reply(
        `⚠️ L'adresse de la game doit être différente de ton adresse de retrait. ` +
        `L'adresse game est fournie par AKS (bouton Deposit dans l'app), pas par ta wallet perso. Réessaie.`
      );
      return true;
    }

    const gameId = getAksGameId();
    if (!gameId) {
      await reply(`❌ Erreur interne (game AKS introuvable). Contacte @baki77777`);
      return true;
    }

    addPlayerGameWallet(session.player_id, text, gameId);

    setSession(chatId, "onboarding_complete" as Step, session.player_id, session.expected_tg_id);

    const deal = getAksDeal(session.player_id);
    const actionPct = deal?.action_pct ?? 30;
    const playerPct = 100 - actionPct;

    await reply(
      `✅ Adresse game AKS enregistrée.\n\n` +
      `🎯 <b>Setup complet !</b>\n` +
      `- Action : ${actionPct}% (${playerPct}/${actionPct} symétrique)\n` +
      `- Wallets : configurés\n\n` +
      `Tu peux jouer 🎰\n\n` +
      `Rappel : cash out l'extra régulièrement.\n\n` +
      `Support 24/7 ici.`
    );

    const db = getDb();
    const player = db.prepare(`SELECT name FROM players WHERE id = ?`).get(session.player_id) as { name: string } | undefined;
    const playerName = player?.name ?? "Joueur";

    await sendMsg(AGENT_CHAT_ID,
      `🎉 <b>Onboarding AKS complet — ${playerName}</b>\n` +
      `Deal : ${playerPct}/${actionPct} (action_pct=${actionPct})\n` +
      `Wallet retrait : <code>${cashoutAddress}</code>\n` +
      `Wallet game AKS : <code>${text}</code>\n` +
      `Lien : ${AKS_GAME_LINK}`
    );

    return true;
  }

  return false;
}
