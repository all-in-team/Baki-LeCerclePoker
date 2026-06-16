import { getDb } from "@/lib/db";
import {
  sendMsg, sendMsgKeyboard, answerCbQuery, editMessageReplyMarkup,
  getSession, setSession, TRC20_RE, AGENT_CHAT_ID,
  type Step,
} from "@/lib/telegram-commands/helpers";
import { addPlayerCashout, addPlayerGameWallet } from "@/lib/queries";
import { sendAksPitch } from "@/lib/telegram-commands/new-members";
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

  // ── % action choisi (preset) → lance le pitch avec ce % ──
  const presetMatch = data.match(/^aks_action_(\d+(?:\.\d+)?)$/);
  if (presetMatch) {
    if (!player) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});
    const pct = parseFloat(presetMatch[1]);
    await sendAksPitch(chatId, player.id, player, pct, tid);
    return;
  }

  // ── Custom % → demande la saisie ──
  if (data === "aks_action_custom") {
    if (!player) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});
    setSession(chatId, "waiting_aks_pct" as Step, session.player_id, session.expected_tg_id);
    await sendMsg(chatId, `✏️ Tape le % d'action AKS pour <b>${playerName}</b> (nombre 1-100, ex : <b>33</b>)`, tid);
    return;
  }

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

  // ── Avec vous → show contract ──
  if (data === "aks_choice_with_us") {
    if (session.step !== ("aks_pitch_sent" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    let actionPctDisplay = "30";
    let playerPctDisplay = "70";
    if (player) {
      const deal = getAksDeal(player.id);
      if (deal) {
        actionPctDisplay = String(deal.action_pct);
        playerPctDisplay = String(100 - deal.action_pct);
      }
    }

    setSession(chatId, "aks_contract_shown" as Step, session.player_id, session.expected_tg_id);

    await sendMsg(chatId, `Bien joué. Voilà le contrat AKS, pas de surprise :`, tid);
    await sleep(2000);
    await sendMsg(chatId,
      `💰 <b>Action symétrique ${playerPctDisplay}/${actionPctDisplay}</b> :\n` +
      `- Tu gagnes 1000 → tu nous envoies ${actionPctDisplay}% (${playerPctDisplay}% pour toi)\n` +
      `- Tu perds 1000 → on couvre ${actionPctDisplay}% de tes pertes\n\n` +
      `C'est win/win, lose/lose. L'avantage : tu peux jouer plus cher sans te pénaliser.\n\n` +
      `En cas de bug / ban / dispute, on est là. C'est notre engagement.`,
      tid
    );
    await sleep(3000);
    await sendMsgKeyboard(chatId,
      `Tu valides ?`,
      [
        [{ text: "✅ Je signe", callback_data: "aks_contract_sign" }],
        [{ text: "❓ J'ai une question", callback_data: "aks_choice_question" }],
      ],
      tid
    );
    return;
  }

  // ── Je signe → wallet check ──
  if (data === "aks_contract_sign") {
    if (session.step !== ("aks_contract_shown" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    if (session.player_id) {
      db.prepare(`UPDATE players SET status = 'active' WHERE id = ?`).run(session.player_id);
    }

    setSession(chatId, "aks_wallet_check" as Step, session.player_id, session.expected_tg_id);

    await sendMsg(chatId, `✅ <b>Deal accepté !</b>`, tid);
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
      `🎉 <b>Nouveau joueur signé AKS</b>\n` +
      `Nom : <b>${playerName}</b>\n` +
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
      `Voici le lien pour rejoindre la game :\n` +
      `👉 ${AKS_GAME_LINK}\n\n` +
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

  // ── Custom action % entry (owner types a number) ──
  if (session.step === ("waiting_aks_pct" as Step)) {
    const m = text.match(/(\d+(?:\.\d+)?)/);
    const pct = m ? parseFloat(m[1]) : NaN;
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      await reply(`❌ Envoie un nombre entre 1 et 100, ex : <b>33</b>`);
      return true;
    }
    const db = getDb();
    const player = db.prepare(`SELECT id, name, telegram_id, telegram_handle FROM players WHERE id = ?`).get(session.player_id) as { id: number; name: string; telegram_id: number | null; telegram_handle: string | null } | undefined;
    if (!player) { await reply(`❌ Joueur introuvable. Contacte @baki77777`); return true; }
    await sendAksPitch(chatId, player.id, player, pct, messageThreadId);
    return true;
  }

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
