import { getDb } from "@/lib/db";
import { sendMsg, TRC20_RE } from "./helpers";

export async function handleTodo(chatId: number) {
  const players = getDb().prepare(`
    SELECT p.id, p.name, p.tron_address, p.tele_wallet_cashout,
      (SELECT COUNT(*) FROM player_game_deals pgd
       JOIN games g ON g.id = pgd.game_id
       WHERE pgd.player_id = p.id AND LOWER(g.name) = 'tele') AS has_deal
    FROM players p WHERE p.status = 'active' ORDER BY p.name
  `).all() as any[];

  const incomplete = players.filter(p => {
    const hasGame = !!(p.tron_address && TRC20_RE.test(p.tron_address));
    const hasCashout = !!(p.tele_wallet_cashout && TRC20_RE.test(p.tele_wallet_cashout));
    return !p.has_deal || !hasGame || !hasCashout;
  });

  if (incomplete.length === 0) {
    await sendMsg(chatId, `✅ <b>Tous les joueurs actifs sont configurés !</b>`);
    return;
  }

  const lines = incomplete.map(p => {
    const hasGame = !!(p.tron_address && TRC20_RE.test(p.tron_address));
    const hasCashout = !!(p.tele_wallet_cashout && TRC20_RE.test(p.tele_wallet_cashout));
    const step = !p.has_deal ? "1/3 deal" : !hasGame ? "2/3 wallet game" : "3/3 wallet cashout";
    return `• <b>${p.name}</b> — étape ${step}`;
  });
  await sendMsg(chatId,
    `📋 <b>${incomplete.length} joueur(s) à compléter</b>\n\n${lines.join("\n")}\n\n<i>Utilise <code>/check nom</code> pour le détail.</i>`
  );
}
