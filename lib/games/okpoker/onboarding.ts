import { getDb } from "@/lib/db";
import {
  sendMsg, sendMsgKeyboard, answerCbQuery, editMessageReplyMarkup,
  getSession, setSession, mentionOf, trackOnboardingStep, TRC20_RE, AGENT_CHAT_ID,
  type Step,
} from "@/lib/telegram-commands/helpers";
import { addPlayerCashout, addPlayerGameWallet, recordDealAcceptance } from "@/lib/queries";
import { OKPOKER_GAME_NAME, OKPOKER_GAME_LINK, OKPOKER_DEFAULT_ACTION_PCT } from "./config";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function getOkpokerGameId(): number | null {
  const row = getDb().prepare(`SELECT id FROM games WHERE name = ?`).get(OKPOKER_GAME_NAME) as { id: number } | undefined;
  return row?.id ?? null;
}

function getOkpokerDeal(playerId: number): { action_pct: number; rakeback_pct: number } | null {
  const gameId = getOkpokerGameId();
  if (!gameId) return null;
  return getDb().prepare(
    `SELECT action_pct, rakeback_pct FROM player_game_deals WHERE player_id = ? AND game_id = ?`
  ).get(playerId, gameId) as { action_pct: number; rakeback_pct: number } | undefined ?? null;
}

// OKPOKER pitch — action % is MODULABLE, chosen by the owner at /startokpoker launch
// (shared free-text prompt) and passed in here. The deal is upserted (re-running
// /startokpoker with a new % updates it). Deliberately simpler than the AKS pitch:
// the % action is stated clearly, that's it (demande Baki).
export async function sendOkpokerPitch(
  chatId: number,
  playerId: number,
  player: { name: string; telegram_id: number | null; telegram_handle: string | null },
  actionPct: number,
  onboardingTopicId?: number,
) {
  const db = getDb();
  const gameId = getOkpokerGameId();
  if (gameId) {
    db.prepare(
      `INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct) VALUES (?, ?, ?, 0)
       ON CONFLICT(player_id, game_id) DO UPDATE SET action_pct = excluded.action_pct`
    ).run(playerId, gameId, actionPct);
  }

  const playerPct = 100 - actionPct;

  setSession(chatId, "okpoker_pitch_sent" as Step, playerId, player.telegram_id);
  if (player.telegram_id) trackOnboardingStep(player.telegram_id, "pitch_sent");

  const tid = onboardingTopicId;
  const tag = mentionOf(player);
  await sendMsg(chatId,
    `${tag}\n\n🃏 <b>${player.name}</b> — on te propose OKPOKER !\n\n` +
    `Le deal est simple :\n\n` +
    `🎯 <b>Action ${playerPct}/${actionPct}</b> — Tu joues ${playerPct}% de ton action, on prend ${actionPct}%. ` +
    `C'est symétrique : win/win, lose/lose.`,
    tid
  );
  await sleep(2000);
  // Anti-bypass: le lien game n'est PAS dans le pitch. Il n'arrive qu'après
  // un clic explicite sur "J'accepte" (handleOkpokerCallback → okpoker_accept).
  await sendMsgKeyboard(chatId, `Tu valides le deal ?`, [
    [{ text: "✅ J'accepte le deal", callback_data: "okpoker_accept" }],
    [{ text: "❓ J'ai une question", callback_data: "okpoker_choice_question" }],
  ], tid);
}

export async function handleOkpokerCallback(
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
  if (data === "okpoker_choice_question") {
    if (session.step === "awaiting_human_response" as Step) {
      await sendMsg(chatId, "Ta question est en cours de traitement, on te répond bientôt 👍", tid);
      return;
    }
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});
    setSession(chatId, "awaiting_human_response" as Step, session.player_id, session.expected_tg_id, "question_pending");
    await sendMsg(chatId, `Pas de souci, pose ta question ici. Baki vient voir 👇`, tid);
    await sendMsg(AGENT_CHAT_ID,
      `💬 <b>Question OKPOKER onboarding — ${playerName}</b>\n` +
      `@baki77777 — réponds dans le chat <code>${chatId}</code>`
    );
    return;
  }

  // ── J'accepte le deal → record acceptance, THEN reveal link, then wallet check ──
  // Anti-bypass gate: the game link is sent ONLY here, after an explicit acceptance
  // click, never in the pitch.
  if (data === "okpoker_accept") {
    if (session.step !== ("okpoker_pitch_sent" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    const gameId = getOkpokerGameId();
    const deal = player ? getOkpokerDeal(player.id) : null;
    if (session.player_id) {
      if (gameId) recordDealAcceptance(session.player_id, gameId, deal?.action_pct ?? null);
      db.prepare(`UPDATE players SET status = 'active' WHERE id = ?`).run(session.player_id);
    }

    setSession(chatId, "okpoker_wallet_check" as Step, session.player_id, session.expected_tg_id);

    await sendMsg(chatId, `✅ <b>Deal accepté !</b>`, tid);
    if (OKPOKER_GAME_LINK) {
      await sleep(1200);
      // Link revealed ONLY now — after explicit acceptance.
      await sendMsg(chatId, `🃏 Parfait ! Rejoins la game OKPOKER 👉 ${OKPOKER_GAME_LINK}`, tid);
    }
    await sleep(1500);
    await sendMsgKeyboard(chatId,
      `Avant de finaliser, question rapide : tu as déjà un wallet crypto USDT en TRC20 (réseau Tron) ?`,
      [
        [{ text: "✅ Oui j'ai un wallet", callback_data: "okpoker_wallet_yes" }],
        [{ text: "❌ Non, j'en ai pas", callback_data: "okpoker_wallet_no" }],
      ],
      tid
    );

    await sendMsg(AGENT_CHAT_ID,
      `🎉 <b>Deal accepté OKPOKER — ${playerName}</b>\n` +
      `Action : ${deal?.action_pct ?? "?"}%\n` +
      `<i>En attente wallet check...</i>`
    );
    return;
  }

  // ── Wallet YES → collect wallets ──
  if (data === "okpoker_wallet_yes") {
    if (session.step !== ("okpoker_wallet_check" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    await sendMsg(chatId,
      `Top. On va te demander 2 adresses Tron USDT TRC20.\n\n` +
      `⚠️ <b>CRITIQUE</b> : utilise bien TRC20, jamais ERC20 ni BEP20. Sinon fonds perdus.\n\n` +
      `<b>Étape 1 — Ton adresse de RETRAIT</b>\n` +
      `C'est l'adresse où tu veux recevoir tes cashouts.\n` +
      `Envoie-la maintenant (format T... 34 caractères).`,
      tid
    );

    setSession(chatId, "awaiting_okpoker_cashout_wallet" as Step, session.player_id, session.expected_tg_id);
    return;
  }

  // ── Wallet NO → tutorial + bail ──
  if (data === "okpoker_wallet_no") {
    if (session.step !== ("okpoker_wallet_check" as Step)) return;
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

// ── Raw message handler for OKPOKER: wallet collection states ──

export async function handleOkpokerRawMessage(
  text: string,
  chatId: number,
  session: { step: Step; player_id: number; expected_tg_id: number | null; pending_cmd?: string | null },
  messageThreadId?: number,
): Promise<boolean> {
  const reply = (msg: string) => sendMsg(chatId, msg, messageThreadId);

  // ── Cashout wallet (step 1 of 2) ──
  if (session.step === ("awaiting_okpoker_cashout_wallet" as Step)) {
    if (!TRC20_RE.test(text)) {
      await reply(`❌ Format incorrect. Une adresse TRON commence par T et fait 34 caractères. Réessaie.`);
      return true;
    }

    const gameId = getOkpokerGameId();
    if (!gameId) {
      await reply(`❌ Erreur interne (game OKPOKER introuvable). Contacte @baki77777`);
      return true;
    }

    addPlayerCashout(session.player_id, text, gameId);

    const db = getDb();
    db.prepare(`UPDATE telegram_sessions SET pending_cmd = ? WHERE chat_id = ?`).run(text, String(chatId));

    setSession(chatId, "awaiting_okpoker_game_wallet" as Step, session.player_id, session.expected_tg_id, text);

    await reply(`✅ Adresse de retrait enregistrée.`);
    await sleep(1500);
    await reply(
      `<b>Étape 2 — L'adresse de dépôt OKPOKER</b>\n\n` +
      `Ouvre l'app OKPOKER, va sur ton profil et clique sur "Deposit" (ou 充币). ` +
      `L'app te donnera une adresse Tron USDT TRC20 pour déposer — copie-la et colle-la ici.\n\n` +
      `Format attendu : T... (34 caractères, TRC20).`
    );
    return true;
  }

  // ── Game wallet (step 2 of 2) ──
  if (session.step === ("awaiting_okpoker_game_wallet" as Step)) {
    if (!TRC20_RE.test(text)) {
      await reply(`❌ Format incorrect. Une adresse TRON commence par T et fait 34 caractères. Réessaie.`);
      return true;
    }

    const freshSession = getSession(chatId);
    const cashoutAddress = freshSession?.pending_cmd ?? "";
    if (text === cashoutAddress) {
      await reply(
        `⚠️ L'adresse de la game doit être différente de ton adresse de retrait. ` +
        `L'adresse game est fournie par OKPOKER (bouton Deposit dans l'app), pas par ta wallet perso. Réessaie.`
      );
      return true;
    }

    const gameId = getOkpokerGameId();
    if (!gameId) {
      await reply(`❌ Erreur interne (game OKPOKER introuvable). Contacte @baki77777`);
      return true;
    }

    addPlayerGameWallet(session.player_id, text, gameId);

    setSession(chatId, "onboarding_complete" as Step, session.player_id, session.expected_tg_id);

    const deal = getOkpokerDeal(session.player_id);
    const actionPct = deal?.action_pct ?? OKPOKER_DEFAULT_ACTION_PCT;
    const playerPct = 100 - actionPct;

    await reply(
      `✅ Adresse game OKPOKER enregistrée.\n\n` +
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
      `🎉 <b>Onboarding OKPOKER complet — ${playerName}</b>\n` +
      `Deal : ${playerPct}/${actionPct} (action_pct=${actionPct})\n` +
      `Wallet retrait : <code>${cashoutAddress}</code>\n` +
      `Wallet game OKPOKER : <code>${text}</code>` +
      (OKPOKER_GAME_LINK ? `\nLien : ${OKPOKER_GAME_LINK}` : "")
    );

    return true;
  }

  return false;
}
