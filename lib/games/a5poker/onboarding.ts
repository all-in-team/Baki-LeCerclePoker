import { getDb } from "@/lib/db";
import {
  sendMsg, sendMsgKeyboard, answerCbQuery, editMessageReplyMarkup,
  getSession, setSession, TRC20_RE, AGENT_CHAT_ID,
  type Step,
} from "@/lib/telegram-commands/helpers";
import { addPlayerCashout, addPlayerGameWallet, recordDealAcceptance } from "@/lib/queries";
import { WalletAddressError } from "@/lib/wallet-address";
import { A5POKER_GAME_NAME, A5POKER_GAME_LINK } from "./config";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function getA5pokerGameId(): number | null {
  const row = getDb().prepare(`SELECT id FROM games WHERE name = ?`).get(A5POKER_GAME_NAME) as { id: number } | undefined;
  return row?.id ?? null;
}

function getA5pokerDeal(playerId: number): { action_pct: number; rakeback_pct: number } | null {
  const gameId = getA5pokerGameId();
  if (!gameId) return null;
  return getDb().prepare(
    `SELECT action_pct, rakeback_pct FROM player_game_deals WHERE player_id = ? AND game_id = ?`
  ).get(playerId, gameId) as { action_pct: number; rakeback_pct: number } | undefined ?? null;
}

export async function handleA5pokerCallback(
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

  const tid = messageThreadId;

  // ── Question ──
  if (data === "a5_choice_question") {
    if (session.step === "awaiting_human_response" as Step) {
      await sendMsg(chatId, "Ta question est en cours de traitement, on te répond bientôt 👍", tid);
      return;
    }
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});
    setSession(chatId, "awaiting_human_response" as Step, session.player_id, session.expected_tg_id, "question_pending");
    await sendMsg(chatId, `Pas de souci, pose ta question ici. Baki vient voir 👇`, tid);
    await sendMsg(AGENT_CHAT_ID,
      `💬 <b>Question A5POKER onboarding — ${playerName}</b>\n` +
      `@baki77777 — réponds dans le chat <code>${chatId}</code>`
    );
    return;
  }

  // ── Avec vous → show contract ──
  if (data === "a5_choice_with_us") {
    if (session.step !== ("a5poker_pitch_sent" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    let actionPctDisplay = "20";
    let playerPctDisplay = "80";
    if (player) {
      const deal = getA5pokerDeal(player.id);
      if (deal) {
        actionPctDisplay = String(deal.action_pct);
        playerPctDisplay = String(100 - deal.action_pct);
      }
    }

    setSession(chatId, "a5poker_contract_shown" as Step, session.player_id, session.expected_tg_id);

    await sendMsg(chatId, `Bien joué. Voilà le contrat A5POKER, pas de surprise :`, tid);
    await sleep(2000);
    await sendMsg(chatId,
      `💰 <b>Action symétrique ${playerPctDisplay}/${actionPctDisplay}</b> :\n` +
      `- Tu gagnes 1000 → tu nous envoies ${actionPctDisplay}0 (${playerPctDisplay}% pour toi)\n` +
      `- Tu perds 1000 → on t'envoie ${actionPctDisplay}0 (on couvre ${actionPctDisplay}% de tes pertes)\n\n` +
      `🛡️ <b>Liquidité garantie : 1000 USDT</b>\n` +
      `- On couvre ton float jusqu'à 1K\n` +
      `- Au-delà : tu cash out chez toi pour sécuriser\n\n` +
      `En cas de bug / ban / dispute, on rembourse jusqu'à 1000 USDT. C'est notre engagement.`,
      tid
    );
    await sleep(3000);
    await sendMsgKeyboard(chatId,
      `Tu valides ?`,
      [
        [{ text: "✅ Je signe", callback_data: "a5_contract_sign" }],
        [{ text: "❓ J'ai une question", callback_data: "a5_choice_question" }],
      ],
      tid
    );
    return;
  }

  // ── Je signe → wallet check (NEW vs KKPOKER) ──
  if (data === "a5_contract_sign") {
    if (session.step !== ("a5poker_contract_shown" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    if (session.player_id) {
      const gameId = getA5pokerGameId();
      const deal = getA5pokerDeal(session.player_id);
      if (gameId) recordDealAcceptance(session.player_id, gameId, deal?.action_pct ?? null);
      db.prepare(`UPDATE players SET status = 'active' WHERE id = ?`).run(session.player_id);
    }

    setSession(chatId, "a5poker_wallet_check" as Step, session.player_id, session.expected_tg_id);

    await sendMsg(chatId, `✅ <b>Deal accepté !</b>`, tid);
    await sleep(1500);
    await sendMsgKeyboard(chatId,
      `Avant de finaliser, question rapide : tu as déjà un wallet crypto USDT en TRC20 (réseau Tron) ?`,
      [
        [{ text: "✅ Oui j'ai un wallet", callback_data: "a5_wallet_yes" }],
        [{ text: "❌ Non, j'en ai pas", callback_data: "a5_wallet_no" }],
      ],
      tid
    );

    await sendMsg(AGENT_CHAT_ID,
      `🎉 <b>Nouveau joueur signé A5POKER</b>\n` +
      `Nom : <b>${playerName}</b>\n` +
      `<i>En attente wallet check...</i>`
    );
    return;
  }

  // ── Wallet YES → collect wallets ──
  if (data === "a5_wallet_yes") {
    if (session.step !== ("a5poker_wallet_check" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    await sendMsg(chatId,
      `Top. On va te demander 2 adresses Tron USDT TRC20.\n\n` +
      `⚠️ <b>CRITIQUE</b> : utilise bien TRC20, jamais ERC20 ni BEP20. Sinon fonds perdus.\n\n` +
      `Voici le lien pour rejoindre la game :\n` +
      `👉 ${A5POKER_GAME_LINK}\n\n` +
      `<b>Étape 1 — Ton adresse de RETRAIT</b>\n` +
      `C'est l'adresse où tu veux recevoir tes cashouts.\n` +
      `Envoie-la maintenant (format T... 34 caractères).`,
      tid
    );

    setSession(chatId, "awaiting_a5poker_cashout_wallet" as Step, session.player_id, session.expected_tg_id);
    return;
  }

  // ── Wallet NO → tutorial + bail ──
  if (data === "a5_wallet_no") {
    if (session.step !== ("a5poker_wallet_check" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    await sendMsg(chatId,
      `Pas de souci, ça se crée en 5 min :\n\n` +
      `🔹 <b>Option simple (exchange)</b> : crée un compte Binance ou Bybit (gratuit). ` +
      `Section "Wallet" → "Deposit USDT" → choisis réseau TRC20. Tu obtiens ton adresse Tron automatiquement.\n\n` +
      `🔹 <b>Option perso</b> : Trust Wallet (mobile) ou TronLink (extension Chrome). 100% à toi.\n\n` +
      `⚠️ Critique : utilise bien TRC20 (pas ERC20 ni BEP20), sinon les fonds sont perdus.\n\n` +
      `Une fois ton wallet créé, retape /starta5poker pour reprendre.`,
      tid
    );
    return;
  }
}

// ── Raw message handler for A5POKER wallet collection states ──

export async function handleA5pokerRawMessage(
  text: string,
  chatId: number,
  session: { step: Step; player_id: number; expected_tg_id: number | null },
  messageThreadId?: number,
): Promise<boolean> {
  const reply = (msg: string) => sendMsg(chatId, msg, messageThreadId);

  // ── Cashout wallet (step 1 of 2) ──
  if (session.step === ("awaiting_a5poker_cashout_wallet" as Step)) {
    if (!TRC20_RE.test(text)) {
      await reply(`❌ Format incorrect. Une adresse TRON commence par T et fait 34 caractères. Réessaie.`);
      return true;
    }

    const gameId = getA5pokerGameId();
    if (!gameId) {
      await reply(`❌ Erreur interne (game A5POKER introuvable). Contacte @baki77777`);
      return true;
    }

    try {
      addPlayerCashout(session.player_id, text, gameId);
    } catch (e) {
      // Adresse refusée par la garde (contrat de token connu, ou checksum
      // invalide). Le joueur doit pouvoir corriger : on répond et on reste
      // sur la même étape, au lieu de laisser remonter et casser le webhook.
      if (e instanceof WalletAddressError) {
        await reply(`❌ ${e.message}`);
        return true;
      }
      throw e;
    }

    const db = getDb();
    db.prepare(`UPDATE telegram_sessions SET pending_cmd = ? WHERE chat_id = ?`).run(text, String(chatId));

    setSession(chatId, "awaiting_a5poker_game_wallet" as Step, session.player_id, session.expected_tg_id, text);

    await reply(`✅ Adresse de retrait enregistrée.`);
    await sleep(1500);
    await reply(
      `<b>Étape 2 — L'adresse de dépôt A5POKER</b>\n\n` +
      `Ouvre l'app A5POKER, va sur ton profil et clique sur "Deposit" (ou 充币). ` +
      `L'app te donnera une adresse Tron USDT TRC20 pour déposer — copie-la et colle-la ici.\n\n` +
      `Format attendu : T... (34 caractères, TRC20).`
    );
    return true;
  }

  // ── Game wallet (step 2 of 2) ──
  if (session.step === ("awaiting_a5poker_game_wallet" as Step)) {
    if (!TRC20_RE.test(text)) {
      await reply(`❌ Format incorrect. Une adresse TRON commence par T et fait 34 caractères. Réessaie.`);
      return true;
    }

    const freshSession = getSession(chatId);
    const cashoutAddress = freshSession?.pending_cmd ?? "";
    if (text === cashoutAddress) {
      await reply(
        `⚠️ L'adresse de la game doit être différente de ton adresse de retrait. ` +
        `L'adresse game est fournie par A5POKER (bouton Deposit dans l'app), pas par ta wallet perso. Réessaie.`
      );
      return true;
    }

    const gameId = getA5pokerGameId();
    if (!gameId) {
      await reply(`❌ Erreur interne (game A5POKER introuvable). Contacte @baki77777`);
      return true;
    }

    try {
      addPlayerGameWallet(session.player_id, text, gameId);
    } catch (e) {
      // Adresse refusée par la garde (contrat de token connu, ou checksum
      // invalide). Le joueur doit pouvoir corriger : on répond et on reste
      // sur la même étape, au lieu de laisser remonter et casser le webhook.
      if (e instanceof WalletAddressError) {
        await reply(`❌ ${e.message}`);
        return true;
      }
      throw e;
    }

    setSession(chatId, "onboarding_complete" as Step, session.player_id, session.expected_tg_id);

    await reply(
      `✅ Adresse game A5POKER enregistrée.\n\n` +
      `🎯 <b>Setup complet !</b>\n` +
      `- Action : 20% (80/20 symétrique)\n` +
      `- Liquidité garantie : 1000 USDT\n` +
      `- Wallets : configurés\n\n` +
      `Tu peux jouer 🎰\n\n` +
      `Rappel : garde max 1K sur le compte, cash out l'extra régulièrement.\n\n` +
      `Support 24/7 ici.`
    );

    const db = getDb();
    const player = db.prepare(`SELECT name FROM players WHERE id = ?`).get(session.player_id) as { name: string } | undefined;
    const playerName = player?.name ?? "Joueur";
    const deal = getA5pokerDeal(session.player_id);
    const actionPct = deal?.action_pct ?? 20;
    const playerPct = 100 - actionPct;

    await sendMsg(AGENT_CHAT_ID,
      `🎉 <b>Onboarding A5POKER complet — ${playerName}</b>\n` +
      `Deal : ${playerPct}/${actionPct} (action_pct=${actionPct})\n` +
      `Wallet retrait : <code>${cashoutAddress}</code>\n` +
      `Wallet game A5POKER : <code>${text}</code>\n` +
      `Groupe : ${A5POKER_GAME_LINK}`
    );

    return true;
  }

  return false;
}
