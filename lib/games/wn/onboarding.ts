import { getDb } from "@/lib/db";
import {
  sendMsg, sendMsgKeyboard, answerCbQuery, editMessageReplyMarkup,
  getSession, setSession, mentionOf, trackOnboardingStep, TRC20_RE, AGENT_CHAT_ID,
  type Step,
} from "@/lib/telegram-commands/helpers";
import { addPlayerCashout, addPlayerGameWallet, recordDealAcceptance } from "@/lib/queries";
import { WalletAddressError } from "@/lib/wallet-address";
import { WN_GAME_NAME, WN_ROOM_INVITE_LINK, WN_ROOM_INVITE_HASH, WN_DEFAULT_ACTION_PCT } from "./config";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function getWnGameId(): number | null {
  const row = getDb().prepare(`SELECT id FROM games WHERE name = ?`).get(WN_GAME_NAME) as { id: number } | undefined;
  return row?.id ?? null;
}

function getWnDeal(playerId: number): { action_pct: number; rakeback_pct: number } | null {
  const gameId = getWnGameId();
  if (!gameId) return null;
  return getDb().prepare(
    `SELECT action_pct, rakeback_pct FROM player_game_deals WHERE player_id = ? AND game_id = ?`
  ).get(playerId, gameId) as { action_pct: number; rakeback_pct: number } | undefined ?? null;
}

// WN pitch — même mécanique que TTPOKER (deal upserté, % modulable). Le % WN est
// INDÉPENDANT du deal A5/NUTS (decision Hugo 2026-07-20 — l'ancienne règle d'alignement
// écrasait le % tapé) : les règlements WN et A5/NUTS sont séparés côté CRM.
// Room = lien d'invitation direct, révélé APRÈS "J'accepte" uniquement (anti-bypass).
export async function sendWnPitch(
  chatId: number,
  playerId: number,
  player: { name: string; telegram_id: number | null; telegram_handle: string | null },
  actionPct: number,
  onboardingTopicId?: number,
) {
  const db = getDb();
  const pct = actionPct;

  const gameId = getWnGameId();
  if (gameId) {
    db.prepare(
      `INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct) VALUES (?, ?, ?, 0)
       ON CONFLICT(player_id, game_id) DO UPDATE SET action_pct = excluded.action_pct`
    ).run(playerId, gameId, pct);
  }

  const playerPct = 100 - pct;

  setSession(chatId, "wn_pitch_sent" as Step, playerId, player.telegram_id);
  if (player.telegram_id) trackOnboardingStep(player.telegram_id, "pitch_sent");

  const tid = onboardingTopicId;
  const tag = mentionOf(player);
  await sendMsg(chatId,
    `${tag}\n\n🃏 <b>${player.name}</b> — on te propose la room WN !\n\n` +
    `Le deal est simple :\n\n` +
    `🎯 <b>Action ${playerPct}/${pct}</b> — Tu joues ${playerPct}% de ton action, on prend ${pct}%. ` +
    `C'est symétrique : win/win, lose/lose.`,
    tid
  );
  await sleep(2000);
  // Anti-bypass : le lien room n'est PAS dans le pitch — révélé après "J'accepte" only.
  await sendMsgKeyboard(chatId, `Tu valides le deal ?`, [
    [{ text: "✅ J'accepte le deal", callback_data: "wn_accept" }],
    [{ text: "❓ J'ai une question", callback_data: "wn_choice_question" }],
  ], tid);
}

export async function handleWnCallback(
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
  if (data === "wn_choice_question") {
    if (session.step === "awaiting_human_response" as Step) {
      await sendMsg(chatId, "Ta question est en cours de traitement, on te répond bientôt 👍", tid);
      return;
    }
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});
    setSession(chatId, "awaiting_human_response" as Step, session.player_id, session.expected_tg_id, "question_pending");
    await sendMsg(chatId, `Pas de souci, pose ta question ici. Baki vient voir 👇`, tid);
    await sendMsg(AGENT_CHAT_ID,
      `💬 <b>Question WN onboarding — ${playerName}</b>\n` +
      `@baki77777 — réponds dans le chat <code>${chatId}</code>`
    );
    return;
  }

  // ── J'accepte le deal → record acceptance, THEN reveal room link, then wallet check ──
  if (data === "wn_accept") {
    if (session.step !== ("wn_pitch_sent" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    const gameId = getWnGameId();
    const deal = player ? getWnDeal(player.id) : null;
    if (session.player_id) {
      if (gameId) recordDealAcceptance(session.player_id, gameId, deal?.action_pct ?? null);
      db.prepare(`UPDATE players SET status = 'active' WHERE id = ?`).run(session.player_id);
    }

    setSession(chatId, "wn_room_join_check" as Step, session.player_id, session.expected_tg_id);

    await sendMsg(chatId, `✅ <b>Deal accepté !</b>`, tid);
    await sleep(1200);
    // Room access — révélé UNIQUEMENT ici, après acceptation explicite. Le join est
    // CRITIQUE (Hugo 2026-07-20) : sans clic sur "Request to Join" le joueur n'est
    // pas rattaché à notre ligne → gate explicite avant de passer aux wallets.
    await sendMsg(chatId,
      `🃏 <b>Accès à la room WN</b> — étape OBLIGATOIRE :\n\n` +
      `<b>1️⃣ Clique sur le lien</b> 👉 <a href="${WN_ROOM_INVITE_LINK}">entrer dans la room</a>\n` +
      `<b>2️⃣ PUIS clique sur « REQUEST TO JOIN »</b> dans le groupe.\n\n` +
      `⚠️ <b>Sans le clic JOIN tu n'es pas rattaché à nous</b> — ne saute pas cette étape.`,
      tid
    );
    await sleep(1500);
    await sendMsgKeyboard(chatId,
      `Quand c'est fait, confirme 👇`,
      [[{ text: "✅ Fait, j'ai rejoint le groupe", callback_data: "wn_room_joined" }]],
      tid
    );

    await sendMsg(AGENT_CHAT_ID,
      `🎉 <b>Deal accepté WN — ${playerName}</b>\n` +
      `Action : ${deal?.action_pct ?? "?"}%\n` +
      `<i>En attente wallet check...</i>`
    );
    return;
  }

  // ── Room rejointe confirmée → instructions wallet WN dédiée (Hugo 2026-07-20) ──
  // Pas de question "as-tu un wallet ?" : WN exige une wallet DÉDIÉE (pas forcément
  // vierge — assouplissement Hugo — mais jamais la wallet A5 du joueur) : c'est elle
  // qui sépare le tracking WN du tracking A5 (même wallet game de dépôt).
  if (data === "wn_room_joined") {
    if (session.step !== ("wn_room_join_check" as Step)) return;

    // VÉRIFICATION RÉELLE du join (Hugo 2026-07-20) via le compte userbot (le bot ne
    // peut pas être invité dans le groupe room). Membre → on continue ; pas membre →
    // blocage avec ré-explication (une demande "Request to Join" pas encore approuvée
    // compte comme non-membre). Vérification impossible (userbot down / pas membre du
    // groupe / telegram_id inconnu) → FAIL-OPEN : on ne bloque jamais un onboarding
    // sur une panne infra, mais on alerte le chat agent pour contrôle manuel.
    const playerTgId = player?.telegram_id ?? session.expected_tg_id ?? null;
    const check = await verifyWnRoomMembership(playerTgId);
    if (check.checked && !check.member) {
      await sendMsg(chatId,
        `🔍 Je ne te vois pas encore dans le groupe de la room.\n\n` +
        `1️⃣ <a href="${WN_ROOM_INVITE_LINK}">Clique le lien</a>\n` +
        `2️⃣ Clique <b>« REQUEST TO JOIN »</b>\n\n` +
        `<i>Si tu as déjà fait la demande, attends qu'elle soit approuvée puis re-clique le bouton ci-dessous.</i>`,
        tid
      );
      await sendMsgKeyboard(chatId, `Quand c'est fait, confirme 👇`,
        [[{ text: "✅ Fait, j'ai rejoint le groupe", callback_data: "wn_room_joined" }]], tid);
      return;
    }
    if (!check.checked) {
      await sendMsg(AGENT_CHAT_ID,
        `⚠️ <b>WN onboarding — ${playerName}</b> : vérification du join room impossible (${check.error ?? "?"}) — ` +
        `flow continué sans contrôle, vérifie à la main qu'il est bien dans le groupe.`
      );
    }

    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    await sendMsg(chatId,
      `👌 Dernière étape : ta wallet dédiée WN.\n\n` +
      `⚠️ <b>Il te faut une wallet DÉDIÉE à cette game</b> — pas besoin qu'elle soit neuve, ` +
      `mais elle ne doit <b>PAS être ta wallet A5</b> ni servir pour A5. GasFee autorisé sur cette game.\n\n` +
      `👉 Le plus simple : crée-en une dans ton <b>TronLink</b> et <b>nomme-la « WNPK »</b> pour ne pas te tromper par la suite.\n\n` +
      `🔒 <b>Règle absolue</b> : TOUS tes cash in et cash out WN doivent partir et arriver de CETTE wallet. ` +
      `Sinon ton tracking sera mélangé avec l'autre game (la wallet game de dépôt est la même pour les deux).\n\n` +
      `Envoie-moi maintenant l'adresse de ta wallet WN (format T... 34 caractères, TRC20).`,
      tid
    );

    setSession(chatId, "awaiting_wn_cashout_wallet" as Step, session.player_id, session.expected_tg_id);
    return;
  }
}

// Vérifie l'appartenance du joueur au groupe room WN via le userbot. Le chat id est
// résolu une fois depuis le hash du lien d'invitation (exige le userbot membre) puis
// caché dans settings ('wn_room_chat_id').
async function verifyWnRoomMembership(playerTgId: number | null): Promise<{ member: boolean; checked: boolean; error: string | null }> {
  if (!playerTgId) return { member: false, checked: false, error: "telegram_id joueur inconnu" };
  try {
    const db = getDb();
    let chatId = (db.prepare(`SELECT value FROM settings WHERE key = 'wn_room_chat_id'`).get() as { value: string } | undefined)?.value ?? null;
    if (!chatId) {
      const { resolveInviteHash } = await import("@/lib/telegram-userbot");
      const r = await resolveInviteHash(WN_ROOM_INVITE_HASH);
      if (!r.chatId) return { member: false, checked: false, error: r.error };
      chatId = r.chatId;
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('wn_room_chat_id', ?)`).run(chatId);
    }
    const { isUserInChannel } = await import("@/lib/telegram-userbot");
    return await isUserInChannel(chatId, playerTgId);
  } catch (e: any) {
    return { member: false, checked: false, error: e?.message ?? String(e) };
  }
}

// ── Raw message handler for WN: wallet collection states ──

export async function handleWnRawMessage(
  text: string,
  chatId: number,
  session: { step: Step; player_id: number; expected_tg_id: number | null; pending_cmd?: string | null },
  messageThreadId?: number,
): Promise<boolean> {
  const reply = (msg: string) => sendMsg(chatId, msg, messageThreadId);

  // ── Cashout wallet (step 1 of 2) ──
  if (session.step === ("awaiting_wn_cashout_wallet" as Step)) {
    if (!TRC20_RE.test(text)) {
      await reply(`❌ Format incorrect. Une adresse TRON commence par T et fait 34 caractères. Réessaie.`);
      return true;
    }

    const gameId = getWnGameId();
    if (!gameId) {
      await reply(`❌ Erreur interne (game WN introuvable). Contacte @baki77777`);
      return true;
    }

    // RÈGLE DURE (Hugo 2026-07-20) : la wallet WN doit être DIFFÉRENTE des wallets
    // A5/NUTS du joueur — c'est elle qui dissocie les flux (cashouts WN par destination,
    // dépôts WN par expéditeur). Une adresse déjà enregistrée en A5/NUTS = refus.
    const clashA5 = getDb().prepare(`
      SELECT 1 FROM player_wallet_cashouts pwc
      JOIN games g ON g.id = pwc.game_id AND g.name IN ('A5POKER', 'NUTSPK')
      WHERE pwc.player_id = ? AND LOWER(pwc.address) = LOWER(?)
      LIMIT 1
    `).get(session.player_id, text);
    if (clashA5) {
      await reply(
        `⚠️ Cette adresse est déjà ta wallet A5. Pour WN il faut une <b>NOUVELLE adresse</b>, différente ` +
        `de ta wallet A5 — c'est elle qui permet de séparer tes deux deals. Envoie une autre adresse TRC20.`
      );
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

    setSession(chatId, "awaiting_wn_game_wallet" as Step, session.player_id, session.expected_tg_id, text);

    await reply(`✅ Adresse de retrait enregistrée.`);
    await sleep(1500);
    await reply(
      `<b>Étape 2 — L'adresse de dépôt WN</b>\n\n` +
      `Ouvre l'app, va sur ton profil et clique sur "Deposit" (ou 充币). ` +
      `L'app te donnera une adresse Tron USDT TRC20 pour déposer — copie-la et colle-la ici.\n\n` +
      `Format attendu : T... (34 caractères, TRC20).`
    );
    return true;
  }

  // ── Game wallet (step 2 of 2) ──
  if (session.step === ("awaiting_wn_game_wallet" as Step)) {
    if (!TRC20_RE.test(text)) {
      await reply(`❌ Format incorrect. Une adresse TRON commence par T et fait 34 caractères. Réessaie.`);
      return true;
    }

    const freshSession = getSession(chatId);
    const cashoutAddress = freshSession?.pending_cmd ?? "";
    if (text === cashoutAddress) {
      await reply(
        `⚠️ L'adresse de la game doit être différente de ton adresse de retrait. ` +
        `L'adresse game est fournie par l'app WN (bouton Deposit), pas par ta wallet perso. Réessaie.`
      );
      return true;
    }

    const gameId = getWnGameId();
    if (!gameId) {
      await reply(`❌ Erreur interne (game WN introuvable). Contacte @baki77777`);
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

    const deal = getWnDeal(session.player_id);
    const actionPct = deal?.action_pct ?? WN_DEFAULT_ACTION_PCT;
    const playerPct = 100 - actionPct;

    await reply(
      `✅ Adresse game WN enregistrée.\n\n` +
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

    // DM chat ids are positive (= the user id), group ids are negative — a positive
    // chatId means the flow ran via the ?start=wn deep link, not a linked group.
    const viaDeepLink = chatId > 0;
    await sendMsg(AGENT_CHAT_ID,
      (viaDeepLink
        ? `🎉 <b>${playerName} onboardé WN via deep link</b> — % actuel : ${actionPct} (ajuste si besoin)\n`
        : `🎉 <b>Onboarding WN complet — ${playerName}</b>\n`) +
      `Deal : ${playerPct}/${actionPct} (action_pct=${actionPct})\n` +
      `Wallet retrait : <code>${cashoutAddress}</code>\n` +
      `Wallet game WN : <code>${text}</code>\n` +
      `Accès room : ${WN_ROOM_INVITE_LINK}`
    );

    return true;
  }

  return false;
}
