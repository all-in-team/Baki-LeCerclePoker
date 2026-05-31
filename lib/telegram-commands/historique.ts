import { getDb } from "@/lib/db";
import { sendMsg, parseArgs, findPlayer, findGame } from "./helpers";

export async function handleHistorique(rawText: string, chatId: number) {
  const p = parseArgs(rawText);
  const limit = p.amount !== null ? Math.min(Math.max(1, Math.round(p.amount)), 20) : 5;

  if (!p.playerQuery) {
    await sendMsg(chatId, `❌ Usage : <code>/historique hugo</code> ou <code>/historique hugo wepoker 10</code>`);
    return;
  }
  const players = findPlayer(p.playerQuery);
  if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${p.playerQuery}" introuvable`); return; }
  if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }

  const db = getDb();
  let rows: any[];
  if (p.gameName) {
    const game = findGame(p.gameName);
    if (!game) { await sendMsg(chatId, `❌ Game "${p.gameName}" inconnue`); return; }
    rows = db.prepare(`
      SELECT wt.type, wt.amount, g.name AS game_name, wt.tx_date
      FROM wallet_transactions wt JOIN games g ON g.id = wt.game_id
      WHERE wt.player_id = ? AND wt.game_id = ?
      ORDER BY wt.tx_date DESC, wt.id DESC LIMIT ?
    `).all(players[0].id, game.id, limit) as any[];
  } else {
    rows = db.prepare(`
      SELECT wt.type, wt.amount, g.name AS game_name, wt.tx_date
      FROM wallet_transactions wt JOIN games g ON g.id = wt.game_id
      WHERE wt.player_id = ?
      ORDER BY wt.tx_date DESC, wt.id DESC LIMIT ?
    `).all(players[0].id, limit) as any[];
  }

  if (rows.length === 0) {
    await sendMsg(chatId, `ℹ️ ${players[0].name} — aucune transaction enregistrée`);
    return;
  }

  const lines = rows.map((r: any) => {
    const emoji = r.type === "deposit" ? "📥" : "📤";
    const sign = r.type === "deposit" ? "+" : "−";
    return `${emoji} ${r.tx_date} · <b>${sign}${r.amount.toFixed(2)} USDT</b> · ${r.game_name}`;
  });
  const gameLabel = p.gameName ? ` / ${p.gameName}` : "";
  await sendMsg(chatId, `📜 <b>${players[0].name}${gameLabel}</b> — ${rows.length} transaction(s)\n\n${lines.join("\n")}`);
}
