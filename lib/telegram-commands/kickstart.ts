import {
  sendMsg, mentionOf, getIncompleteTelePlayers, startNextWalletFlow, TRC20_RE,
} from "./helpers";

export async function handleKickstart(chatId: number) {
  const incomplete = getIncompleteTelePlayers();

  if (incomplete.length === 0) {
    await sendMsg(chatId, `✅ <b>Tous les joueurs TELE ont leurs wallets configurés !</b>`);
    return;
  }

  const lines = incomplete.map(p => {
    const hasGame = !!(p.tron_address && TRC20_RE.test(p.tron_address));
    const step = !hasGame ? "wallet game" : "wallet cashout";
    return `• ${mentionOf(p)} — manque ${step}`;
  });

  await sendMsg(chatId,
    `🚀 <b>Kickstart TELE — ${incomplete.length} joueur(s) à compléter</b>\n\n${lines.join("\n")}\n\n<i>Collecte démarrée joueur par joueur…</i>`
  );
  await startNextWalletFlow(chatId);
}
