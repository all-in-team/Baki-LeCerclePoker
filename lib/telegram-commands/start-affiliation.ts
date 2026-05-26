import { getDb } from "@/lib/db";
import {
  sendMsg, sendMsgKeyboard, answerCbQuery, editMessageReplyMarkup,
  getSession, setSession, clearSession, AGENT_CHAT_ID,
  type Step,
} from "./helpers";

export async function handleStartAffiliation(chatId: number, fromId: number) {
  const db = getDb();

  const player = db.prepare(`SELECT id, name, telegram_handle FROM players WHERE telegram_id = ?`).get(fromId) as
    { id: number; name: string; telegram_handle: string | null } | undefined;

  if (!player) {
    await sendMsg(chatId,
      `Tu dois être joueur chez nous d'abord.\n` +
      `Lance /startkkpoker ou /starta5poker pour rejoindre, puis reviens ici.`
    );
    return;
  }

  setSession(chatId, "affiliation_awaiting_handle" as Step, player.id, fromId);

  await sendMsg(chatId,
    `🎯 <b>PROGRAMME AFFILIATE — LECERCLEPOKER</b>\n\n` +
    `Tu peux désormais gagner sur les joueurs que tu nous ramènes.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `💰 <b>LE DEAL</b>\n\n` +
    `Tu ramènes un joueur. Sur tout ce que l'agence gagne grâce à lui, <b>tu touches 50%</b>.\n\n` +
    `📌 <i>Exemple concret</i>\n` +
    `Tu ramènes ton pote sur KKPOKER. Sur la semaine, l'agence fait +1 000 USDT grâce à lui.\n` +
    `→ Tu reçois <b>500 USDT</b> direct sur ton wallet.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🎮 <b>LES TAUX EN DÉTAIL</b>\n\n` +
    `▪️ <b>Le game où tu l'as ramené</b> (game d'origine) → <b>50% à vie</b>\n` +
    `▪️ <b>Les autres games où il commence à jouer</b> :\n` +
    `   ├─ Dans les <b>30 premiers jours</b> → 50% aussi 🔥\n` +
    `   └─ Au-delà → 10% passif (revenu récurrent sans rien faire)\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📅 <b>PAIEMENT</b>\n\n` +
    `Versé chaque <b>lundi</b> directement sur ton wallet USDT.\n` +
    `Tu suis en live tes gains dans ton dashboard perso.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⚖️ <b>LA SEULE PETITE RÈGLE</b>\n\n` +
    `On partage les profits, pas les pertes.\n\n` +
    `Si ton filleul fait une grosse semaine (= l'agence est dans le rouge sur lui), tu touches 0 cette semaine-là. ` +
    `On récupère la perte sur les semaines suivantes, puis ta commission repart normalement.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🚀 <b>POUR COMMENCER</b>\n\n` +
    `Envoie-moi le <b>@handle Telegram</b> du joueur que tu veux ramener 👇`
  );
}

export async function handleAffiliationRawMessage(
  text: string,
  chatId: number,
  session: { step: Step; player_id: number; expected_tg_id: number | null; pending_cmd: string | null },
  messageThreadId?: number,
): Promise<boolean> {
  if (session.step !== ("affiliation_awaiting_handle" as Step)) return false;

  const db = getDb();
  const handle = text.trim().replace(/^@/, "").toLowerCase();
  if (!handle) {
    await sendMsg(chatId, `Envoie-moi un @handle Telegram valide.`, messageThreadId);
    return true;
  }

  const referred = db.prepare(`SELECT id, name, telegram_handle FROM players WHERE LOWER(telegram_handle) = ?`).get(handle) as
    { id: number; name: string; telegram_handle: string | null } | undefined;

  if (!referred) {
    await sendMsg(chatId,
      `❌ Ce joueur n'est pas encore dans nos groupes.\n` +
      `Demande-lui de rejoindre via /startkkpoker ou /starta5poker d'abord, puis reviens ici 👋`,
      messageThreadId
    );
    clearSession(chatId);
    return true;
  }

  if (referred.id === session.player_id) {
    await sendMsg(chatId, `Tu peux pas t'affilier toi-même 😄`, messageThreadId);
    clearSession(chatId);
    return true;
  }

  const existing = db.prepare(`SELECT 1 FROM affiliate_relationships WHERE referred_player_id = ? AND status = 'active'`).get(referred.id);
  if (existing) {
    await sendMsg(chatId, `❌ Ce joueur a déjà un affiliate. Désolé !`, messageThreadId);
    clearSession(chatId);
    return true;
  }

  const activeGames = db.prepare(`SELECT id, name FROM games WHERE status = 'active' ORDER BY id`).all() as { id: number; name: string }[];
  if (activeGames.length === 0) {
    await sendMsg(chatId, `❌ Aucun game actif pour le moment.`, messageThreadId);
    clearSession(chatId);
    return true;
  }

  const buttons = activeGames.map(g => [{ text: `🃏 ${g.name}`, callback_data: `affiliation:game:${g.id}:${referred.id}` }]);

  await sendMsgKeyboard(chatId,
    `✅ Trouvé ! <i>@${referred.telegram_handle}</i> est dispo.\n\nSur quel game tu le pousses ?`,
    buttons,
    messageThreadId
  );

  setSession(chatId, "affiliation_awaiting_game" as Step, session.player_id, session.expected_tg_id, String(referred.id));
  return true;
}

export async function handleAffiliationCallback(
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
    await sendMsg(chatId, "🔧 Session expirée. Relance /startaffiliation.");
    return;
  }

  const db = getDb();

  // Game selection: affiliation:game:<gameId>:<referredId>
  const gameMatch = data.match(/^affiliation:game:(\d+):(\d+)$/);
  if (gameMatch && session.step === ("affiliation_awaiting_game" as Step)) {
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    const gameId = parseInt(gameMatch[1]);
    const referredId = parseInt(gameMatch[2]);
    const game = db.prepare(`SELECT id, name FROM games WHERE id = ? AND status = 'active'`).get(gameId) as { id: number; name: string } | undefined;
    const referred = db.prepare(`SELECT id, name, telegram_handle FROM players WHERE id = ?`).get(referredId) as { id: number; name: string; telegram_handle: string | null } | undefined;
    const affiliate = db.prepare(`SELECT name, telegram_handle FROM players WHERE id = ?`).get(session.player_id) as { name: string; telegram_handle: string | null } | undefined;

    if (!game || !referred || !affiliate) {
      await sendMsg(chatId, "❌ Erreur interne. Relance /startaffiliation.");
      clearSession(chatId);
      return;
    }

    const today = new Date().toISOString().slice(0, 10);

    await sendMsgKeyboard(chatId,
      `📋 <b>Récap</b>\n\n` +
      `- Affiliate: @${affiliate.telegram_handle ?? affiliate.name}\n` +
      `- Filleul: @${referred.telegram_handle ?? referred.name}\n` +
      `- Origin game: <b>${game.name}</b>\n` +
      `- Taux: 50% à vie sur ce game\n` +
      `- Date démarrage: ${today}\n\n` +
      `Confirmer ?`,
      [
        [{ text: "✅ Confirmer", callback_data: `affiliation:confirm:${gameId}:${referredId}` }],
        [{ text: "❌ Annuler", callback_data: "affiliation:cancel" }],
      ],
      messageThreadId
    );

    setSession(chatId, "affiliation_awaiting_confirm" as Step, session.player_id, session.expected_tg_id, `${referredId}:${gameId}`);
    return;
  }

  // Cancel
  if (data === "affiliation:cancel") {
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});
    await sendMsg(chatId, "OK, annulé. À bientôt 👋", messageThreadId);
    clearSession(chatId);
    return;
  }

  // Confirm: affiliation:confirm:<gameId>:<referredId>
  const confirmMatch = data.match(/^affiliation:confirm:(\d+):(\d+)$/);
  if (confirmMatch && session.step === ("affiliation_awaiting_confirm" as Step)) {
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    const gameId = parseInt(confirmMatch[1]);
    const referredId = parseInt(confirmMatch[2]);
    const game = db.prepare(`SELECT name FROM games WHERE id = ?`).get(gameId) as { name: string } | undefined;
    const referred = db.prepare(`SELECT name, telegram_handle FROM players WHERE id = ?`).get(referredId) as { name: string; telegram_handle: string | null } | undefined;

    if (!game || !referred) {
      await sendMsg(chatId, "❌ Erreur interne. Relance /startaffiliation.");
      clearSession(chatId);
      return;
    }

    try {
      db.prepare(`
        INSERT INTO affiliate_relationships (affiliate_player_id, referred_player_id, origin_game_id, start_date)
        VALUES (?, ?, ?, date('now'))
      `).run(session.player_id, referredId, gameId);
    } catch (e: any) {
      if (e.message?.includes("UNIQUE constraint failed")) {
        await sendMsg(chatId, `❌ Quelqu'un vient d'affilier ce joueur. Désolé !`, messageThreadId);
      } else {
        await sendMsg(chatId, `❌ Erreur : ${e.message}`, messageThreadId);
      }
      clearSession(chatId);
      return;
    }

    await sendMsg(chatId,
      `✅ <b>Affiliation enregistrée !</b>\n\n` +
      `Tu touches désormais <b>50% des profits agency</b> sur <i>@${referred.telegram_handle ?? referred.name}</i> pour <b>${game.name}</b>.\n\n` +
      `Bonne chance 💰\n\n` +
      `<i>(Ton dashboard /myaffi sera dispo très bientôt)</i>`,
      messageThreadId
    );

    await sendMsg(AGENT_CHAT_ID,
      `🤝 <b>Nouvelle affiliation</b>\n` +
      `Affiliate: <b>${(db.prepare(`SELECT name FROM players WHERE id = ?`).get(session.player_id) as any)?.name}</b>\n` +
      `Filleul: <b>${referred.name}</b> (@${referred.telegram_handle})\n` +
      `Game: <b>${game.name}</b>`
    );

    clearSession(chatId);
  }
}
