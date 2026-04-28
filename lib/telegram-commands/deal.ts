import { upsertPlayerGameDeal } from "@/lib/queries";
import {
  sendMsg, parseArgs, findPlayer, findGame, getPlayerFull,
  promptPlayer, promptGame, setSession, clearSession, askWalletGame,
  mentionOf, TRC20_RE,
} from "./helpers";

export async function handleDeal(rawText: string, chatId: number) {
  const p = parseArgs(rawText);

  if (!p.playerQuery) {
    await promptPlayer(chatId, "deal", rawText);
    return;
  }
  if (!p.gameName) {
    await promptGame(chatId, "deal", rawText);
    return;
  }
  if (p.action_pct === null) {
    if (p.amount !== null) { p.action_pct = p.amount; p.amount = null; }
    else {
      await sendMsg(chatId, "❌ Action % manquant.\nEx : <code>/deal hugo tele 40% action</code>");
      return;
    }
  }

  const players = findPlayer(p.playerQuery);
  if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${p.playerQuery}" introuvable`); return; }
  if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }

  const game = findGame(p.gameName);
  if (!game) { await sendMsg(chatId, `❌ Game "${p.gameName}" inconnue`); return; }

  const rb = p.rakeback_pct ?? 0;
  upsertPlayerGameDeal({ player_id: players[0].id, game_id: game.id, action_pct: p.action_pct, rakeback_pct: rb });

  await sendMsg(chatId,
    `✅ <b>Deal enregistré</b>\n<b>${players[0].name}</b> sur <b>${game.name}</b>\nAction : <b>${p.action_pct}%</b> · RB : <b>${rb}%</b>`
  );

  // If TELE → continue guided flow from where we are
  if (game.name === "TELE") {
    const player = getPlayerFull(players[0].id)!;
    const hasGame = !!(player.tron_address && TRC20_RE.test(player.tron_address));
    const hasCashout = !!(player.tele_wallet_cashout && TRC20_RE.test(player.tele_wallet_cashout));
    if (!hasGame) {
      setSession(chatId, "waiting_wallet_game", player.id, player.telegram_id);
      await askWalletGame(chatId, mentionOf(player));
    } else if (!hasCashout) {
      setSession(chatId, "waiting_wallet_cashout", player.id);
      await sendMsg(chatId,
        `💸 <b>Étape 3/3</b> — Envoie le <b>WALLET CASHOUT</b> de ${player.name}\n` +
        `<i>(son adresse Binance TRC20 pour recevoir les cashouts)</i>`
      );
    } else {
      clearSession(chatId);
      await sendMsg(chatId, `🟢 <b>${player.name} est déjà 100% configuré</b> — rien à faire.`);
    }
  }
}
