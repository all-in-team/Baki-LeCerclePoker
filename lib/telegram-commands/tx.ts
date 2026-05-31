import { upsertPlayerGameDeal, insertWalletTransaction } from "@/lib/queries";
import {
  sendMsg, parseArgs, findPlayer, findGame,
  promptPlayer, promptGame,
} from "./helpers";

export async function handleTx(type: "deposit" | "withdrawal", rawText: string, chatId: number) {
  const p = parseArgs(rawText);
  const cmd = type === "deposit" ? "depot" : "retrait";

  if (!p.playerQuery) {
    await promptPlayer(chatId, cmd, rawText);
    return;
  }
  if (!p.gameName) {
    await promptGame(chatId, cmd, rawText);
    return;
  }
  if (!p.amount || p.amount <= 0) {
    await sendMsg(chatId, "❌ Montant invalide");
    return;
  }

  const players = findPlayer(p.playerQuery);
  if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${p.playerQuery}" introuvable`); return; }
  if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }

  const game = findGame(p.gameName);
  if (!game) { await sendMsg(chatId, `❌ Game "${p.gameName}" inconnue`); return; }

  let dealMsg = "";
  if (p.action_pct !== null) {
    const rb = p.rakeback_pct ?? 0;
    upsertPlayerGameDeal({ player_id: players[0].id, game_id: game.id, action_pct: p.action_pct, rakeback_pct: rb });
    dealMsg = `\nDeal : <b>${p.action_pct}% action</b> · <b>${rb}% RB</b>`;
  }

  const today = new Date().toISOString().slice(0, 10);
  insertWalletTransaction({ player_id: players[0].id, game_id: game.id, type, amount: p.amount, currency: "USDT", tx_date: today });

  const emoji = type === "deposit" ? "📥" : "📤";
  const label = type === "deposit" ? "Dépôt" : "Retrait";
  await sendMsg(chatId,
    `${emoji} <b>${label} enregistré</b>\n<b>${players[0].name}</b> · ${game.name}\n<b>${p.amount.toFixed(2)} USDT</b> · ${today}${dealMsg}`
  );
}
