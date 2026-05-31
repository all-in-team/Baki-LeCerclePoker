import { getDb } from "@/lib/db";
import {
  sendMsg, findPlayer, findGame, getPlayerFull,
  promptPlayer, promptGame, setSession, clearSession,
  askWalletGame, mentionOf, GAME_NAMES,
} from "./helpers";

export async function handleReset(rawText: string, chatId: number) {
  const parts = rawText.trim().split(/\s+/).filter(Boolean);

  // Position-independent parse: scan all tokens for game / sub-type / player name
  const canonical: Record<string, string> = { tele: "TELE", wepoker: "Wepoker", xpoker: "Xpoker", clubgg: "ClubGG" };
  const subTypes = ["game", "cashout", "deal"] as const;
  type SubType = typeof subTypes[number];
  let gameName: string | null = null;
  let subType: SubType | null = null;
  const playerParts: string[] = [];
  for (const tok of parts) {
    const lower = tok.toLowerCase();
    if (!gameName && GAME_NAMES.includes(lower)) { gameName = canonical[lower]; }
    else if (!subType && (subTypes as readonly string[]).includes(lower)) { subType = lower as SubType; }
    else { playerParts.push(tok); }
  }
  const playerQuery = playerParts.join(" ").trim();

  if (!playerQuery) {
    await promptPlayer(chatId, "reset", rawText.trim());
    return;
  }
  if (!gameName) {
    await promptGame(chatId, "reset", rawText.trim());
    return;
  }

  const players = findPlayer(playerQuery);
  if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${playerQuery}" introuvable`); return; }
  if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }

  const db = getDb();
  const player = players[0];
  const full = getPlayerFull(player.id)!;
  const game = findGame(gameName);
  if (!game) { await sendMsg(chatId, `❌ Game "${gameName}" inconnue`); return; }
  clearSession(chatId);
  const firstName = player.name.split(" ")[0].toLowerCase();

  if (gameName === "TELE") {
    if (subType === "game") {
      db.prepare(`UPDATE players SET tron_address = NULL WHERE id = ?`).run(player.id);
      setSession(chatId, "waiting_wallet_game", player.id, full.telegram_id);
      await sendMsg(chatId, `🔄 WALLET GAME réinitialisé pour <b>${player.name}</b>`);
      await askWalletGame(chatId, mentionOf(full));
    } else if (subType === "cashout") {
      db.prepare(`UPDATE players SET tele_wallet_cashout = NULL WHERE id = ?`).run(player.id);
      setSession(chatId, "waiting_wallet_cashout", player.id, full.telegram_id);
      await sendMsg(chatId,
        `🔄 WALLET CASHOUT réinitialisé pour <b>${player.name}</b>\n\n` +
        `💸 ${mentionOf(full)}, envoie ton <b>WALLET CASHOUT</b>\n<i>(adresse Binance TRC20)</i>`
      );
    } else if (subType === "deal") {
      db.prepare(`DELETE FROM player_game_deals WHERE player_id = ? AND game_id = ?`).run(player.id, game.id);
      await sendMsg(chatId,
        `🔄 Deal TELE supprimé pour <b>${player.name}</b>\n` +
        `<code>/deal ${firstName} tele 40% action</code> pour reconfigurer.`
      );
    } else {
      // Full TELE reset
      db.prepare(`UPDATE players SET tron_address = NULL, tele_wallet_cashout = NULL WHERE id = ?`).run(player.id);
      db.prepare(`DELETE FROM player_game_deals WHERE player_id = ? AND game_id = ?`).run(player.id, game.id);
      setSession(chatId, "waiting_action_pct", player.id);
      await sendMsg(chatId,
        `🔄 <b>${player.name}</b> réinitialisé sur TELE (deal + wallets).\n\n` +
        `📋 <b>Étape 1/3</b> — Quel est son % action sur TELE ?`
      );
    }
  } else {
    // Other games: deal reset only
    db.prepare(`DELETE FROM player_game_deals WHERE player_id = ? AND game_id = ?`).run(player.id, game.id);
    await sendMsg(chatId,
      `🔄 Deal <b>${gameName}</b> supprimé pour <b>${player.name}</b>\n` +
      `<code>/deal ${firstName} ${gameName.toLowerCase()} 55% action</code> pour reconfigurer.`
    );
  }
}
