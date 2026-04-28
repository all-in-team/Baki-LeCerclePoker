import { sendMsg, findPlayer, getPlayerFull, getTeleDeal, TRC20_RE } from "./helpers";

export async function handleCheck(rawText: string, chatId: number) {
  const query = rawText.trim();
  if (!query) {
    await sendMsg(chatId, `❌ Usage : <code>/check hugo</code>`);
    return;
  }
  const players = findPlayer(query);
  if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${query}" introuvable`); return; }
  if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }

  const player = getPlayerFull(players[0].id)!;
  const deal = getTeleDeal(player.id);
  const hasGame = !!(player.tron_address && TRC20_RE.test(player.tron_address));
  const hasCashout = !!(player.tele_wallet_cashout && TRC20_RE.test(player.tele_wallet_cashout));

  const dealLine = deal ? `✅ Deal : <b>${deal.action_pct}% action · ${deal.rakeback_pct}% RB</b>` : `❌ Pas de deal TELE`;
  const gameLine = hasGame ? `✅ WALLET GAME : <code>${player.tron_address!.slice(0, 8)}…${player.tron_address!.slice(-6)}</code>` : `❌ WALLET GAME manquant`;
  const cashoutLine = hasCashout ? `✅ WALLET CASHOUT : <code>${player.tele_wallet_cashout!.slice(0, 8)}…${player.tele_wallet_cashout!.slice(-6)}</code>` : `❌ WALLET CASHOUT manquant`;

  await sendMsg(chatId, `🔎 <b>Statut de ${player.name}</b>\n\n${dealLine}\n${gameLine}\n${cashoutLine}`);
}
