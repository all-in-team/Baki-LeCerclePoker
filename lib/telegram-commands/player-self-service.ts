import { getDb } from "@/lib/db";
import { getPlayerBalance, createCashoutRequest } from "@/lib/queries";
import { sendMsg, s } from "./helpers";

export async function handlePlayerSelfService(chatId: number, fromId: number, text: string): Promise<boolean> {
  const db = getDb();
  const linkedPlayer = db.prepare(
    `SELECT id, name FROM players WHERE telegram_id = ?`
  ).get(fromId) as { id: number; name: string } | undefined;

  if (!linkedPlayer) return false;

  const spaceIdx = text.indexOf(" ");
  const rawCmd = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
  const cmd = rawCmd.split("@")[0].toLowerCase();

  try {
    if (cmd === "/solde") {
      const balances = getPlayerBalance(linkedPlayer.id);
      if (balances.length === 0) {
        await sendMsg(chatId, `ℹ️ ${linkedPlayer.name} — aucune donnée`);
      } else {
        const bal = balances[0];
        const lines = bal.games.filter(g => Math.abs(g.net_usdt) >= 0.01).map(g => {
          const emoji = g.net_usdt > 0.01 ? "🟢" : g.net_usdt < -0.01 ? "🔴" : "⚪";
          return `${emoji} <b>${g.game_name}</b> : <b>${s(g.net_usdt)} USDT</b>`;
        });
        const total = bal.games.reduce((sum, g) => sum + g.net_usdt, 0);
        const totalLine = lines.length > 1 ? `\n\n<b>Total : ${s(total)} USDT</b>` : "";
        await sendMsg(chatId, `💰 <b>Ton solde, ${linkedPlayer.name}</b>\n\n${lines.join("\n")}${totalLine}`);
      }
    } else if (cmd === "/historique") {
      const rows = db.prepare(`
        SELECT wt.type, wt.amount, g.name AS game_name, wt.tx_date
        FROM wallet_transactions wt JOIN games g ON g.id = wt.game_id
        WHERE wt.player_id = ?
        ORDER BY wt.tx_date DESC, wt.id DESC LIMIT 10
      `).all(linkedPlayer.id) as any[];
      if (rows.length === 0) {
        await sendMsg(chatId, `ℹ️ ${linkedPlayer.name} — aucune transaction`);
      } else {
        const lines = rows.map((r: any) => {
          const emoji = r.type === "deposit" ? "📥" : "📤";
          const sign = r.type === "deposit" ? "+" : "−";
          return `${emoji} ${r.tx_date} · <b>${sign}${r.amount.toFixed(2)} USDT</b> · ${r.game_name}`;
        });
        await sendMsg(chatId, `📜 <b>${linkedPlayer.name}</b> — ${rows.length} dernière(s) transaction(s)\n\n${lines.join("\n")}`);
      }
    } else if (cmd === "/deal") {
      const deals = db.prepare(`
        SELECT g.name AS game_name, pgd.action_pct, pgd.rakeback_pct
        FROM player_game_deals pgd JOIN games g ON g.id = pgd.game_id
        WHERE pgd.player_id = ? ORDER BY g.name
      `).all(linkedPlayer.id) as { game_name: string; action_pct: number; rakeback_pct: number }[];
      if (deals.length === 0) {
        await sendMsg(chatId, `ℹ️ ${linkedPlayer.name} — aucun deal configuré`);
      } else {
        const lines = deals.map(d =>
          `• <b>${d.game_name}</b> — Action : <b>${d.action_pct}%</b>` + (d.rakeback_pct > 0 ? ` · RB : <b>${d.rakeback_pct}%</b>` : "")
        );
        await sendMsg(chatId, `📋 <b>Tes deals, ${linkedPlayer.name}</b>\n\n${lines.join("\n")}`);
      }
    } else if (cmd === "/cashout" || cmd === "/retrait") {
      const rawArgs = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
      const amount = parseFloat(rawArgs.replace(/[^\d.]/g, ""));
      if (!amount || amount <= 0) {
        await sendMsg(chatId, `❌ Usage : <code>/cashout 500</code> (montant en USDT)`);
      } else {
        const id = createCashoutRequest({ player_id: linkedPlayer.id, amount, note: `Demande Telegram par ${linkedPlayer.name}` });
        // Notify operator
        const operatorChatId = process.env.TELEGRAM_OWNER_CHAT_ID ?? process.env.AGENT_TELEGRAM_CHAT_ID;
        if (operatorChatId) {
          await sendMsg(Number(operatorChatId),
            `💸 <b>Nouvelle demande cashout</b>\n` +
            `Joueur : <b>${linkedPlayer.name}</b>\n` +
            `Montant : <b>${amount.toFixed(2)} USDT</b>\n\n` +
            `<i>→ Approuve sur /cashouts du dashboard</i>`
          );
        }
        await sendMsg(chatId,
          `✅ <b>Demande de cashout envoyée</b>\n` +
          `💰 <b>${amount.toFixed(2)} USDT</b>\n\n` +
          `<i>Tu recevras une notification quand c'est approuvé.</i>`
        );
      }
    } else {
      await sendMsg(chatId, `💡 Commandes disponibles :\n<code>/solde</code> — ton solde\n<code>/historique</code> — tes transactions\n<code>/deal</code> — tes deals\n<code>/cashout 500</code> — demander un cashout`);
    }
  } catch (e: any) {
    console.error("[TG PLAYER CMD]", e);
  }

  return true;
}
