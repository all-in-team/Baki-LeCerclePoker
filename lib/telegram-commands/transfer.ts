import { insertWalletTransaction } from "@/lib/queries";
import { sendMsg, parseTransferArgs, findPlayer, findGame } from "./helpers";

export async function handleTransfer(rawText: string, chatId: number) {
  const p = parseTransferArgs(rawText);

  if (!p.playerQuery) {
    await sendMsg(chatId, `❌ Usage : <code>/transfer hugo 1k tele wepoker</code>`);
    return;
  }
  if (!p.fromGame || !p.toGame) {
    await sendMsg(chatId, `❌ Spécifie les deux games : <code>/transfer hugo 1k tele wepoker</code>`);
    return;
  }
  if (!p.amount || p.amount <= 0) {
    await sendMsg(chatId, `❌ Montant invalide`);
    return;
  }

  const players = findPlayer(p.playerQuery);
  if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${p.playerQuery}" introuvable`); return; }
  if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }

  const fromGame = findGame(p.fromGame);
  if (!fromGame) { await sendMsg(chatId, `❌ Game "${p.fromGame}" inconnue`); return; }
  const toGame = findGame(p.toGame);
  if (!toGame) { await sendMsg(chatId, `❌ Game "${p.toGame}" inconnue`); return; }

  const today = new Date().toISOString().slice(0, 10);
  insertWalletTransaction({ player_id: players[0].id, game_id: fromGame.id, type: "withdrawal", amount: p.amount, currency: "USDT", tx_date: today });
  insertWalletTransaction({ player_id: players[0].id, game_id: toGame.id, type: "deposit", amount: p.amount, currency: "USDT", tx_date: today });

  await sendMsg(chatId,
    `🔄 <b>Transfer enregistré</b>\n<b>${players[0].name}</b>\n<b>${p.amount.toFixed(2)} USDT</b> : ${fromGame.name} → ${toGame.name} · ${today}`
  );
}
