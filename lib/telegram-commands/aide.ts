import { sendMsg } from "./helpers";

export async function handleAide(chatId: number) {
  await sendMsg(chatId, `🃏 <b>Le Cercle Bot</b>

<b>— Onboarding joueur —</b>
Quand un joueur rejoint → auto-créé. Puis :
<code>/deal hugo tele 40% action</code>
→ le bot demande ensuite les wallets directement

<b>— Override / correction —</b>
<code>/wallet hugo game TXxxx…</code>
<code>/wallet hugo cashout TXxxx…</code>
<code>/reset hugo tele</code> — reset complet TELE (deal + wallets)
<code>/reset hugo tele game</code> — wallet game seulement
<code>/reset hugo tele cashout</code> — wallet cashout seulement
<code>/reset hugo tele deal</code> — deal TELE seulement
<code>/reset hugo wepoker</code> — deal Wepoker · idem pour xpoker, clubgg

<b>— Vérifier un joueur —</b>
<code>/check hugo</code>

<b>— Transactions manuelles —</b>
<code>/depot hugo 2000$ wepoker</code>
<code>/depot hugo 2k wepoker</code>
<code>/retrait hugo 500$ wepoker</code>
<code>/transfer hugo 1k tele wepoker</code>

<b>— Deal seul —</b>
<code>/deal hugo wepoker 55% action 5% RB</code>

<b>— P&L & Solde —</b>
<code>/pnl</code> — tous · <code>/pnl hugo</code> — un joueur
<code>/solde hugo</code> — solde net par game
<code>/solde hugo wepoker</code> — solde sur une game

<b>— Historique —</b>
<code>/historique hugo</code> — 5 dernières transactions
<code>/historique hugo wepoker 10</code> — 10 dernières sur une game

<b>— Rapports —</b>
<code>/rapports</code> — vérifie les rapports en retard

<b>— Onboarding en attente —</b>
<code>/todo</code> — liste les joueurs incomplets
<code>/kickstart</code> — collecte les wallets TELE manquants (joueur par joueur)

Games : <b>TELE · Wepoker · Xpoker · ClubGG</b>`);
}
