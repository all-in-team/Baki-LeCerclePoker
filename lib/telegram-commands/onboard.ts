import { getDb } from "@/lib/db";
import { sendMsg, sendMsgKeyboard, answerCbQuery, setSession, findPlayer, findGame, mentionOf, OWNER_IDS } from "./helpers";

const GAME_INFO: Record<string, string> = {
  TELE:
    `🎰 <b>TELE AK POKER</b>\n\n` +
    `Pour jouer sur TELE, voici le process :\n\n` +
    `1️⃣ On configure ton <b>% d'action</b>\n` +
    `2️⃣ Tu envoies ton <b>Wallet Game</b> (adresse de dépôt TRON dans l'app TELE)\n` +
    `3️⃣ Tu envoies ton <b>Wallet Cashout</b> (adresse Binance TRC20)\n\n` +
    `Commençons ! Quel est ton <b>% d'action</b> ?\n` +
    `<i>(Ex: 40, 50...)</i>`,
  Wepoker:
    `🃏 <b>Wepoker</b>\n\n` +
    `Pour jouer sur Wepoker :\n\n` +
    `1️⃣ On configure ton <b>% d'action</b>\n` +
    `2️⃣ Tu envoies ton <b>Wallet Game</b>\n` +
    `3️⃣ Tu envoies ton <b>Wallet Cashout</b>\n\n` +
    `Quel est ton <b>% d'action</b> ?\n` +
    `<i>(Ex: 40, 50...)</i>`,
  Xpoker:
    `🎲 <b>Xpoker</b>\n\n` +
    `Pour jouer sur Xpoker :\n\n` +
    `1️⃣ On configure ton <b>% d'action</b>\n` +
    `2️⃣ Tu envoies ton <b>Wallet Game</b>\n` +
    `3️⃣ Tu envoies ton <b>Wallet Cashout</b>\n\n` +
    `Quel est ton <b>% d'action</b> ?\n` +
    `<i>(Ex: 40, 50...)</i>`,
  ClubGG:
    `♣️ <b>ClubGG</b>\n\n` +
    `Pour jouer sur ClubGG :\n\n` +
    `1️⃣ On configure ton <b>% d'action</b>\n` +
    `2️⃣ Tu envoies ton <b>Wallet Game</b>\n` +
    `3️⃣ Tu envoies ton <b>Wallet Cashout</b>\n\n` +
    `Quel est ton <b>% d'action</b> ?\n` +
    `<i>(Ex: 40, 50...)</i>`,
};

export async function handleOnboard(rawArgs: string, chatId: number, chatTitle?: string, messageThreadId?: number) {
  const db = getDb();
  let playerId: number | undefined;
  let playerName: string | undefined;

  if (rawArgs.trim()) {
    const results = findPlayer(rawArgs.trim());
    if (results.length === 1) {
      playerId = results[0].id;
      playerName = results[0].name;
    } else if (results.length > 1) {
      const lines = results.map(p => `• <b>${p.name}</b>`).join("\n");
      await sendMsg(chatId, `❌ Plusieurs joueurs trouvés :\n${lines}\n\nSois plus précis.`, messageThreadId);
      return;
    }
  }

  // Auto-detect from group title: "{Name} x LeCercle" or "TELE AK POKER — {Name}"
  if (!playerId && chatTitle) {
    let extractedName: string | null = null;
    const newMatch = chatTitle.match(/^(.+?)\s*x\s*LeCercle$/i);
    if (newMatch) extractedName = newMatch[1].trim();
    if (!extractedName) {
      const oldMatch = chatTitle.match(/^TELE AK POKER\s*[—–-]\s*(.+)$/i);
      if (oldMatch) extractedName = oldMatch[1].trim();
    }
    if (extractedName) {
      const results = findPlayer(extractedName);
      if (results.length === 1) {
        playerId = results[0].id;
        playerName = results[0].name;
      }
    }
  }

  // Fallback: find any non-admin player linked to this chat
  if (!playerId) {
    const allPlayers = db.prepare(
      `SELECT id, name, telegram_id FROM players WHERE telegram_id IS NOT NULL`
    ).all() as { id: number; name: string; telegram_id: number }[];
    const nonAdmin = allPlayers.filter(p => !OWNER_IDS.has(p.telegram_id));
    if (nonAdmin.length === 1) {
      playerId = nonAdmin[0].id;
      playerName = nonAdmin[0].name;
    }
  }

  if (!playerId) {
    await sendMsg(chatId, `❌ Joueur introuvable. Usage : <code>/onboard NomDuJoueur</code>`, messageThreadId);
    return;
  }

  const keyboard = [
    [
      { text: "🎰 TELE AK POKER", callback_data: `onboard:TELE:${playerId}` },
      { text: "🃏 Wepoker", callback_data: `onboard:Wepoker:${playerId}` },
    ],
    [
      { text: "🎲 Xpoker", callback_data: `onboard:Xpoker:${playerId}` },
      { text: "♣️ ClubGG", callback_data: `onboard:ClubGG:${playerId}` },
    ],
  ];

  await sendMsgKeyboard(chatId,
    `🚀 <b>Onboarding — ${playerName}</b>\n\nChoisis la game à configurer :`,
    keyboard,
    messageThreadId
  );
}

export async function handleOnboardCallback(
  callbackQueryId: string,
  data: string,
  chatId: number,
  messageThreadId?: number
) {
  const parts = data.split(":");
  if (parts.length < 3) return;
  const gameName = parts[1];
  const playerId = parseInt(parts[2], 10);

  await answerCbQuery(callbackQueryId);

  const db = getDb();
  const player = db.prepare(`SELECT id, name, telegram_id FROM players WHERE id = ?`).get(playerId) as
    { id: number; name: string; telegram_id: number | null } | undefined;
  if (!player) {
    await sendMsg(chatId, `❌ Joueur introuvable`, messageThreadId);
    return;
  }

  const game = findGame(gameName);
  if (!game) {
    await sendMsg(chatId, `❌ Game "${gameName}" introuvable`, messageThreadId);
    return;
  }

  const info = GAME_INFO[gameName];
  if (info) {
    await sendMsg(chatId, info, messageThreadId);
  }

  setSession(chatId, "waiting_action_pct", player.id, player.telegram_id);
}
