import { sendMsg, findPlayer, getPlayerPnl, s } from "./helpers";

export async function handlePnl(rawText: string, chatId: number) {
  const query = rawText.trim();
  if (query) {
    const players = findPlayer(query);
    if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${query}" introuvable`); return; }
    if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }
    const rows = getPlayerPnl(players[0].id);
    if (rows.length === 0) { await sendMsg(chatId, `ℹ️ ${players[0].name} — aucun deal configuré`); return; }
    const lines = rows.map((r: any) =>
      `<b>${r.game_name}</b> [${r.action_pct}%]\n  Déposé: ${r.deposited.toFixed(2)} | Retiré: ${r.withdrawn.toFixed(2)}\n  Net joueur: ${s(r.net)} | <b>Mon P&L: ${s(r.my_pnl)}</b>`
    );
    await sendMsg(chatId, `📊 <b>${players[0].name}</b>\n\n${lines.join("\n\n")}`);
  } else {
    const rows = getPlayerPnl();
    if (rows.length === 0) { await sendMsg(chatId, "ℹ️ Aucune donnée"); return; }
    let total = 0;
    const lines = rows.map((r: any) => {
      total += r.my_pnl;
      return `${r.my_pnl > 0 ? "🟢" : r.my_pnl < 0 ? "🔴" : "⚪"} <b>${r.player_name}</b> / ${r.game_name} — ${s(r.my_pnl)} USDT`;
    });
    await sendMsg(chatId, `📊 <b>P&L Global</b>\n\n${lines.join("\n")}\n\n<b>Total : ${s(total)} USDT</b>`);
  }
}
