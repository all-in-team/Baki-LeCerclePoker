import { getPlayerBalance } from "@/lib/queries";
import { sendMsg, parseArgs, findPlayer, s } from "./helpers";

export async function handleSolde(rawText: string, chatId: number) {
  const p = parseArgs(rawText);
  if (!p.playerQuery) {
    await sendMsg(chatId, `❌ Usage : <code>/solde hugo</code> ou <code>/solde hugo wepoker</code>`);
    return;
  }
  const players = findPlayer(p.playerQuery);
  if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${p.playerQuery}" introuvable`); return; }
  if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }

  const balances = getPlayerBalance(players[0].id);
  if (balances.length === 0) {
    await sendMsg(chatId, `ℹ️ ${players[0].name} — aucune donnée (ni rapport ni transaction)`);
    return;
  }

  const bal = balances[0];
  let games = bal.games;
  if (p.gameName) {
    games = games.filter(g => g.game_name.toLowerCase() === p.gameName!.toLowerCase());
    if (games.length === 0) {
      await sendMsg(chatId, `ℹ️ ${players[0].name} — aucune donnée sur ${p.gameName}`);
      return;
    }
  }

  const lines = games.map(g => {
    const emoji = g.net_usdt > 0.01 ? "🟢" : g.net_usdt < -0.01 ? "🔴" : "⚪";
    const parts: string[] = [];
    if (g.winnings_player_usdt !== 0) parts.push(`Gains: ${s(g.winnings_player_usdt)}`);
    if (g.rakeback_player_usdt !== 0) parts.push(`RB: ${s(g.rakeback_player_usdt)}`);
    if (g.wallet_deposited_usdt !== 0 || g.wallet_withdrawn_usdt !== 0) {
      parts.push(`📥 ${g.wallet_deposited_usdt.toFixed(2)} / 📤 ${g.wallet_withdrawn_usdt.toFixed(2)}`);
    }
    const detail = parts.length > 0 ? `\n  ${parts.join(" · ")}` : "";
    return `${emoji} <b>${g.game_name}</b> : <b>${s(g.net_usdt)} USDT</b>${detail}`;
  });

  const total = games.reduce((sum, g) => sum + g.net_usdt, 0);
  const totalLine = games.length > 1 ? `\n\n<b>Total : ${s(total)} USDT</b>` : "";
  await sendMsg(chatId, `💰 <b>Solde — ${bal.player_name}</b>\n\n${lines.join("\n\n")}${totalLine}`);
}
