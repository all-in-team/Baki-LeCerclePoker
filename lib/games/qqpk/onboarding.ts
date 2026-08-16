import { getDb } from "@/lib/db";
import {
  sendMsg, sendMsgKeyboard, answerCbQuery, editMessageReplyMarkup,
  getSession, setSession, TRC20_RE, AGENT_CHAT_ID,
  type Step,
} from "@/lib/telegram-commands/helpers";
import { addPlayerCashout, addPlayerGameWallet, recordDealAcceptance, upsertPlayerGameDeal } from "@/lib/queries";
import { WalletAddressError } from "@/lib/wallet-address";
import { QQPK_GAME_NAME, QQPK_GAME_LINK } from "./config";

// QQPK onboarding — mirror of AKS, but the deal is a FIXED 70/30 STAKING arrangement
// (no action % to pick). The acceptance moment becomes the rolling-cycle anchor:
// recordDealAcceptance writes deal_acceptances.accepted_at = now, which Phase 4.5's
// getQqpkPlayerStartDate reads as start_date. We also stamp player_game_deals.start_date
// with the same accepted_at so both sources agree (alignment requirement).

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function getQqpkGameId(): number | null {
  const row = getDb().prepare(`SELECT id FROM games WHERE name = ?`).get(QQPK_GAME_NAME) as { id: number } | undefined;
  return row?.id ?? null;
}

export async function handleQqpkCallback(
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
  if (data === "qqpk_choice_question") {
    if (session.step === "awaiting_human_response" as Step) {
      await sendMsg(chatId, "Ta question est en cours de traitement, on te répond bientôt 👍", tid);
      return;
    }
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});
    setSession(chatId, "awaiting_human_response" as Step, session.player_id, session.expected_tg_id, "question_pending");
    await sendMsg(chatId, `Pas de souci, pose ta question ici. Baki vient voir 👇`, tid);
    await sendMsg(AGENT_CHAT_ID,
      `💬 <b>Question QQPK onboarding — ${playerName}</b>\n` +
      `@baki77777 — réponds dans le chat <code>${chatId}</code>`
    );
    return;
  }

  // ── J'accepte le deal → record acceptance (= cycle anchor), ensure deal, THEN reveal link.
  // Anti-bypass gate: the Mini App link is sent ONLY here, after an explicit acceptance click.
  if (data === "qqpk_accept") {
    if (session.step !== ("qqpk_pitch_sent" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    const gameId = getQqpkGameId();
    if (session.player_id && gameId) {
      // accepted_at = now → the rolling-cycle start anchor (Phase 4.5 reads it).
      const accId = recordDealAcceptance(session.player_id, gameId, 0);
      const acc = db.prepare(`SELECT accepted_at FROM deal_acceptances WHERE id = ?`).get(accId) as { accepted_at: string } | undefined;
      // Normalize SQLite datetime 'YYYY-MM-DD HH:MM:SS' (UTC) → 'YYYY-MM-DDTHH:MM:SSZ' so the
      // `wt.tx_datetime >= pgd.start_date` lexical compare in getWalletSummaryByPlayer is correct
      // (tx_datetime is Z-format; a space at pos 10 would mis-order vs 'T'). Both UTC.
      const startIso = acc?.accepted_at ? acc.accepted_at.replace(" ", "T") + "Z" : null;
      // Fixed staking deal: action_pct=0 (net passes through; staking P&L is the C/T engine).
      // start_date = acceptance instant so getQqpkPlayerStartDate's deal-fallback agrees with the acceptance.
      upsertPlayerGameDeal({ player_id: session.player_id, game_id: gameId, action_pct: 0, rakeback_pct: 0, start_date: startIso });
      db.prepare(`UPDATE players SET status = 'active' WHERE id = ?`).run(session.player_id);
    }

    setSession(chatId, "qqpk_wallet_check" as Step, session.player_id, session.expected_tg_id);

    await sendMsg(chatId, `✅ <b>Deal accepté !</b>`, tid);
    await sleep(1200);
    // Link revealed ONLY now — after explicit acceptance.
    await sendMsg(chatId, `🃏 Parfait ! Rejoins QQPK 👉 ${QQPK_GAME_LINK}`, tid);
    await sleep(1500);
    await sendMsgKeyboard(chatId,
      `Avant de finaliser, question rapide : tu as déjà un wallet crypto USDT en TRC20 (réseau Tron) ?`,
      [
        [{ text: "✅ Oui j'ai un wallet", callback_data: "qqpk_wallet_yes" }],
        [{ text: "❌ Non, j'en ai pas", callback_data: "qqpk_wallet_no" }],
      ],
      tid
    );

    await sendMsg(AGENT_CHAT_ID,
      `🎉 <b>Deal accepté QQPK — ${playerName}</b>\n` +
      `Staking 70/30 · cycle démarré aujourd'hui\n` +
      `<i>En attente wallet check...</i>`
    );
    return;
  }

  // ── Wallet YES → collect wallets ──
  if (data === "qqpk_wallet_yes") {
    if (session.step !== ("qqpk_wallet_check" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    await sendMsg(chatId,
      `Top. On va te demander 2 adresses Tron USDT TRC20.\n\n` +
      `⚠️ <b>CRITIQUE</b> : utilise bien TRC20, jamais ERC20 ni BEP20. Sinon fonds perdus.\n\n` +
      `<b>Étape 1 — Ton adresse de RETRAIT</b>\n` +
      `C'est l'adresse où tu veux recevoir tes cashouts.\n` +
      `Envoie-la maintenant (format T... 34 caractères).`,
      tid
    );

    setSession(chatId, "awaiting_qqpk_cashout_wallet" as Step, session.player_id, session.expected_tg_id);
    return;
  }

  // ── Wallet NO → tutorial + bail ──
  if (data === "qqpk_wallet_no") {
    if (session.step !== ("qqpk_wallet_check" as Step)) return;
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

// ── Raw message handler for QQPK: wallet collection states ──

export async function handleQqpkRawMessage(
  text: string,
  chatId: number,
  session: { step: Step; player_id: number; expected_tg_id: number | null; pending_cmd?: string | null },
  messageThreadId?: number,
): Promise<boolean> {
  const reply = (msg: string) => sendMsg(chatId, msg, messageThreadId);

  // ── Cashout wallet (step 1 of 2) ──
  if (session.step === ("awaiting_qqpk_cashout_wallet" as Step)) {
    if (!TRC20_RE.test(text)) {
      await reply(`❌ Format incorrect. Une adresse TRON commence par T et fait 34 caractères. Réessaie.`);
      return true;
    }

    const gameId = getQqpkGameId();
    if (!gameId) {
      await reply(`❌ Erreur interne (game QQPK introuvable). Contacte @baki77777`);
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

    setSession(chatId, "awaiting_qqpk_game_wallet" as Step, session.player_id, session.expected_tg_id, text);

    await reply(`✅ Adresse de retrait enregistrée.`);
    await sleep(1500);
    await reply(
      `<b>Étape 2 — L'adresse de dépôt QQPK</b>\n\n` +
      `Ouvre l'app QQPK, va sur ton profil et clique sur "Deposit". ` +
      `L'app te donnera une adresse Tron USDT TRC20 pour déposer — copie-la et colle-la ici.\n\n` +
      `Format attendu : T... (34 caractères, TRC20).`
    );
    return true;
  }

  // ── Game wallet (step 2 of 2) ──
  if (session.step === ("awaiting_qqpk_game_wallet" as Step)) {
    if (!TRC20_RE.test(text)) {
      await reply(`❌ Format incorrect. Une adresse TRON commence par T et fait 34 caractères. Réessaie.`);
      return true;
    }

    const freshSession = getSession(chatId);
    const cashoutAddress = freshSession?.pending_cmd ?? "";
    if (text === cashoutAddress) {
      await reply(
        `⚠️ L'adresse de la game doit être différente de ton adresse de retrait. ` +
        `L'adresse game est fournie par QQPK (bouton Deposit dans l'app), pas par ta wallet perso. Réessaie.`
      );
      return true;
    }

    const gameId = getQqpkGameId();
    if (!gameId) {
      await reply(`❌ Erreur interne (game QQPK introuvable). Contacte @baki77777`);
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
      `✅ Adresse game QQPK enregistrée.\n\n` +
      `🎯 <b>Setup complet !</b>\n` +
      `- Deal : <b>STAKING 70/30</b> (Cercle porte 70% des pertes, prend 30% des gains)\n` +
      `- Cycle : démarré aujourd'hui, règlement mensuel\n` +
      `- Condition : 30 000 mains / mois pour la couverture des pertes\n` +
      `- Wallets : configurés\n\n` +
      `🎥 <b>Explication en vidéo (5 min)</b> : https://www.loom.com/share/79388c40b375467fbe1c5869d67ddc17\n\n` +
      `Tu peux jouer 🎰\n\n` +
      `Rappel : à la fin de ton cycle, on settle et tu fais un full cash out.\n\n` +
      `Support 24/7 ici.`
    );

    const db = getDb();
    const player = db.prepare(`SELECT name FROM players WHERE id = ?`).get(session.player_id) as { name: string } | undefined;
    const playerName = player?.name ?? "Joueur";

    await sendMsg(AGENT_CHAT_ID,
      `🎉 <b>Onboarding QQPK complet — ${playerName}</b>\n` +
      `Deal : STAKING 70/30 (cycle roulant démarré aujourd'hui)\n` +
      `Wallet retrait : <code>${cashoutAddress}</code>\n` +
      `Wallet game QQPK : <code>${text}</code>\n` +
      `Lien : ${QQPK_GAME_LINK}`
    );

    return true;
  }

  return false;
}
