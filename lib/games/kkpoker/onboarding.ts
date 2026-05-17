import { getDb } from "@/lib/db";
import {
  sendMsg, sendMsgKeyboard, sendPhoto, answerCbQuery, editMessageReplyMarkup,
  getSession, setSession, TRC20_RE, AGENT_CHAT_ID,
  type Step,
} from "@/lib/telegram-commands/helpers";
import { getPlayerCashouts, getPlayerGameWallets, addPlayerCashout, addPlayerGameWallet } from "@/lib/queries";
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

// ── Entry point: called from /start when payload=kkpoker ──

export async function handleKkpokerOnboarding(
  chatId: number,
  from: { id: number; first_name?: string; last_name?: string; username?: string }
) {
  const db = getDb();
  const firstName = from.first_name ?? "Joueur";
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ") || firstName;
  const gameId = getKkpokerGameId();

  // Check if player already exists
  const existing = db.prepare(`SELECT id, name FROM players WHERE telegram_id = ?`).get(from.id) as { id: number; name: string } | undefined;

  if (existing && gameId) {
    // Re-onboarding edge case: check if player already has KKPOKER wallets
    const existingGameWallets = getPlayerGameWallets(existing.id, gameId);
    const existingCashouts = getPlayerCashouts(existing.id, gameId);
    if (existingGameWallets.length > 0 || existingCashouts.length > 0) {
      await sendMsg(chatId,
        `👋 <b>${existing.name}</b>, tu es déjà inscrit sur KKPOKER !\n\n` +
        `Si tu as besoin de modifier tes infos, contacte @baki77777`
      );
      await sendMsg(AGENT_CHAT_ID,
        `⚠️ <b>Re-onboarding KKPOKER bloqué</b>\n` +
        `Joueur : <b>${existing.name}</b> (ID ${existing.id})\n` +
        `🆔 TG: <code>${from.id}</code>\n` +
        `Wallets KKPOKER existants — intervention manuelle requise si le joueur veut changer.`
      );
      return;
    }
  }

  // Upsert onboarding lead
  db.prepare(`
    INSERT INTO onboarding_leads (telegram_id, telegram_username, first_name, stage)
    VALUES (?, ?, ?, 'kkpoker_started')
    ON CONFLICT(telegram_id) DO UPDATE SET
      telegram_username = excluded.telegram_username,
      first_name = excluded.first_name,
      stage = 'kkpoker_started',
      last_seen = datetime('now')
  `).run(from.id, from.username ?? null, firstName);

  // Send pitch
  await sendMsg(chatId,
    `🃏 <b>Bienvenue sur Le Cercle — KKPOKER !</b>\n\n` +
    `On t'explique comment ça marche et on te setup en quelques minutes.`
  );

  await sleep(2000);

  // Get deal terms dynamically
  let actionPctDisplay = "40";
  let playerPctDisplay = "60";
  if (existing) {
    const deal = getKkpokerDeal(existing.id);
    if (deal) {
      actionPctDisplay = String(deal.action_pct);
      playerPctDisplay = String(100 - deal.action_pct);
    }
  }

  await sendMsg(chatId,
    `Voilà le deal qu'on propose :\n\n` +
    `🤝 Tu joues <b>${playerPctDisplay}%</b> de ton action.\n` +
    `On prend les ${actionPctDisplay}% restants.\n\n` +
    `C'est de l'action symétrique : <b>win/win, lose/lose</b>.\n` +
    `L'avantage : tu peux simplement jouer plus cher. Ça ne te pénalise pas, ça te protège.`
  );

  await sleep(3000);

  // Create or get player
  let playerId: number;
  if (existing) {
    playerId = existing.id;
  } else {
    const result = db.prepare(
      `INSERT INTO players (name, telegram_id, telegram_handle, telegram_chat_id, status) VALUES (?, ?, ?, ?, 'active')`
    ).run(fullName, from.id, from.username ?? null, String(chatId));
    playerId = Number(result.lastInsertRowid);
  }

  // Ensure player has KKPOKER deal (should already exist from Phase 1.5 cloning, but safety net)
  if (gameId) {
    db.prepare(`
      INSERT OR IGNORE INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct)
      VALUES (?, ?, 40, 0)
    `).run(playerId, gameId);
  }

  setSession(chatId, "kkpoker_pitch_sent" as Step, playerId, from.id);

  await sendMsgKeyboard(chatId,
    `Qu'est-ce que tu en penses ?`,
    [
      [{ text: "🤝 Avec vous", callback_data: "kk_choice_with_us" }],
      [{ text: "❓ J'ai une question", callback_data: "kk_choice_question" }],
    ]
  );
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

  // ── Question ──
  if (data === "kk_choice_question") {
    if (session.step === "awaiting_human_response" as Step) {
      await sendMsg(chatId, "Ta question est en cours de traitement, on te répond bientôt 👍");
      return;
    }
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});
    setSession(chatId, "awaiting_human_response" as Step, session.player_id, session.expected_tg_id, "question_pending");
    await sendMsg(chatId, `Pas de souci, pose ta question ici. Baki vient voir 👇`);
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

    await sendMsg(chatId, `Bien joué. Voilà le contrat, pas de surprise :`);
    await sleep(2000);
    await sendMsg(chatId,
      `💰 <b>Le deal financier — KKPOKER</b>\n` +
      `Action symétrique ${playerPctDisplay}/${actionPctDisplay} :\n` +
      `- Tu gagnes 1000 → tu nous envoies ${actionPctDisplay}0 (${playerPctDisplay}% pour toi)\n` +
      `- Tu perds 1000 → on t'envoie ${actionPctDisplay}0 (on couvre ${actionPctDisplay}% de tes pertes)`
    );
    await sleep(3000);
    await sendMsgKeyboard(chatId,
      `Tu valides ?`,
      [
        [{ text: "✅ Je signe", callback_data: "kk_contract_sign" }],
        [{ text: "❓ J'ai une question", callback_data: "kk_choice_question" }],
      ]
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

    // MSG 1
    await sendMsg(chatId, `✅ <b>Deal accepté !</b>`);

    // MSG 2 — game link or pending
    await sleep(1500);
    if (KKPOKER_GAME_LINK !== "<PENDING>") {
      await sendMsg(chatId,
        `Voici le lien pour rejoindre la game :\n` +
        `👉 ${KKPOKER_GAME_LINK}`
      );
    } else {
      await sendMsg(chatId,
        `Le lien de la game arrive très bientôt, on te tient au courant ici 👍`
      );
      await sendMsg(AGENT_CHAT_ID,
        `⚠️ Player <b>${playerName}</b> onboarded but KKPOKER gameLink is still PENDING — set it in config`
      );
    }

    // MSG 3 — wallet explanation
    await sleep(2500);
    await sendMsg(chatId,
      `On a besoin de 2 adresses TRON USDT pour te brancher au dashboard :\n\n` +
      `1️⃣ Ton <b>adresse de retrait</b> = ta wallet perso (Exodus, Binance, Kraken, n'importe laquelle). C'est là où on t'envoie ton cash quand tu retires.\n\n` +
      `2️⃣ L'<b>adresse de la game</b> = fournie par KKPOKER dans l'app, tu nous la copies.\n\n` +
      `⚠️ TRC20 (réseau TRON) UNIQUEMENT.\n` +
      `Si tu utilises Binance/Exodus, choisis bien le réseau TRON (TRC20), pas BEP20 ni ERC20 — sinon tes fonds sont perdus.\n\n` +
      `On y va, étape par étape 👇`
    );

    // MSG 4 — ask cashout wallet (step 1)
    await sleep(2000);
    await sendMsg(chatId,
      `<b>Étape 1 — ton adresse de retrait</b>\n\n` +
      `Envoie-moi ton adresse TRC20 USDT (depuis Exodus, Binance, Kraken, etc.).\n` +
      `Format : commence par T, 34 caractères.`
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
      `Groupe : ${KKPOKER_GAME_LINK !== "<PENDING>" ? KKPOKER_GAME_LINK : "<PENDING>"}`
    );

    return true;
  }

  return false;
}
