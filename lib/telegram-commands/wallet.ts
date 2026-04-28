import { getDb } from "@/lib/db";
import {
  sendMsg, findPlayer, getPlayerFull, clearSession,
  onboardingStatus, TRC20_RE,
} from "./helpers";

export async function handleWallet(rawText: string, chatId: number) {
  const parts = rawText.trim().split(/\s+/);
  const address = parts[parts.length - 1];
  const typeToken = parts[parts.length - 2]?.toLowerCase();

  if (!["game", "cashout"].includes(typeToken)) {
    await sendMsg(chatId,
      `❌ Usage :\n<code>/wallet hugo game TXxxx…</code>\n<code>/wallet hugo cashout TXxxx…</code>`);
    return;
  }
  if (!TRC20_RE.test(address)) {
    await sendMsg(chatId, `❌ Adresse invalide — doit commencer par T et faire 34 caractères`);
    return;
  }

  const playerQuery = parts.slice(0, parts.length - 2).join(" ").trim();
  if (!playerQuery) { await sendMsg(chatId, `❌ Nom du joueur manquant`); return; }

  const players = findPlayer(playerQuery);
  if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${playerQuery}" introuvable`); return; }
  if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }

  const db = getDb();
  const player = players[0];

  if (typeToken === "game") {
    db.prepare(`UPDATE players SET tron_address = ? WHERE id = ?`).run(address, player.id);
    clearSession(chatId);
    const full = getPlayerFull(player.id)!;
    await sendMsg(chatId, `✅ <b>WALLET GAME enregistré</b> pour <b>${player.name}</b>\n<code>${address}</code>\n\n${onboardingStatus(full)}`);
  } else {
    db.prepare(`UPDATE players SET tele_wallet_cashout = ? WHERE id = ?`).run(address, player.id);
    clearSession(chatId);
    const full = getPlayerFull(player.id)!;
    await sendMsg(chatId, `✅ <b>WALLET CASHOUT enregistré</b> pour <b>${player.name}</b>\n<code>${address}</code>\n\n${onboardingStatus(full)}`);
  }
}
