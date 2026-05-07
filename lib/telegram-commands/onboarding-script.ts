// All player-facing French text for the onboarding pitch flow.
// Edit wording here without touching logic in pitch.ts / new-members.ts.

export const GAME_LINK = "https://t.me/+SNiV3Ina_jJiOWJl";
export const VIDEO_LINK = "https://taap.it/CNg3mhC";

export const PITCH_MSG_1 = (name: string) =>
  `🃏 Bienvenue <b>${name}</b> !\n\n` +
  `Avant de t'expliquer comment ça marche chez nous, faut que tu comprennes le contexte de la game.`;

export const PITCH_MSG_2 =
  `L'app de poker sur Telegram que tu vas utiliser est très soft : il y a une politique stricte <b>anti joueurs pros</b>.\n\n` +
  `Si tu te fais flag, c'est à vie : tu ne pourras <b>plus jamais recréer de compte</b> sur cette plateforme.`;

export const PITCH_MSG_3 =
  `Donc tu as 2 options.\n\n` +
  `🎲 <b>Deal 1 — Solo</b>\n` +
  `Tu joues seul, tu prends 100% de tes gains.\n` +
  `Mais tu perds l'opportunité qu'on t'offre : protection longterm, structure, couverture.\n` +
  `Le jour où le compte est ban, tu es flag à vie. Fini.\n\n` +
  `🤝 <b>Deal 2 — Avec nous</b>\n` +
  `Tu joues 60% de ton action.\n` +
  `On prend 20%, les boss de la game prennent 20%.\n\n` +
  `C'est de l'action symétrique : <b>win/win, lose/lose</b>.\n` +
  `L'avantage : tu peux simplement jouer plus cher. Ça ne te pénalise pas, ça te protège.`;

export const PITCH_MSG_4 = `Tu choisis quoi ?`;

export const SOLO_RESPONSE =
  `Reçu, bon choix si tu te sens.\n` +
  `Bonne chance sur les tables. Si un jour tu changes d'avis, tu sais où nous trouver.`;

export const CONTRACT_MSG_1 = `Bien joué. Voilà le contrat, pas de surprise :`;

export const CONTRACT_MSG_2 =
  `📅 <b>Chaque semaine</b>\n` +
  `Tu envoies un screen recording de ta roll vide + screen recording de tes transferts.\n` +
  `Tu es compliant sur ce qu'on te demande.`;

export const CONTRACT_MSG_3 =
  `💰 <b>Le deal financier</b>\n` +
  `Action symétrique 60/20/20 :\n` +
  `- Tu gagnes 1000 → tu nous envoies 400 (60% pour toi, 40% à diviser entre nous + boss)\n` +
  `- Tu perds 1000 → on t'envoie 400 (on couvre 40% de tes pertes)`;

export const CONTRACT_MSG_4 = `Tu valides ?`;

export const SIGNED_MSG_1 = `✅ <b>Deal accepté !</b>`;

export const SIGNED_MSG_2 =
  `Voici le lien pour rejoindre la game :\n` +
  `👉 ${GAME_LINK}`;

export const SIGNED_MSG_3 =
  `🎥 Regarde cette vidéo avant de te lancer sur l'app, ça t'aidera :\n` +
  `👉 ${VIDEO_LINK}`;

export const SIGNED_MSG_4 =
  `Dernière étape : on a besoin de tes wallets crypto pour te brancher à notre dashboard.\n\n` +
  `Envoie-moi d'abord ton <b>adresse TRON USDT de DÉPÔT</b> (celle que tu utilises pour déposer sur la game).\n\n` +
  `Format attendu : commence par T, 34 caractères.`;

export const WALLET_INVALID =
  `Cette adresse ne semble pas être au bon format. Une adresse TRON commence par <b>T</b> et fait 34 caractères. Réessaie.`;

export const DEPOSIT_SAVED =
  `✅ Adresse de dépôt enregistrée.\n\n` +
  `Maintenant ton <b>adresse TRON USDT de CASHOUT</b> (celle que tu utilises pour retirer de la game).\n` +
  `Si c'est la même que celle de dépôt, écris juste "<b>même</b>".`;

export const CASHOUT_SAVED =
  `✅ Adresse de cashout enregistrée.\n\n` +
  `Tu es prêt. Tu peux commencer à jouer 🎰\n` +
  `Ton support reste disponible ici 24/7 pour toute question.`;

export const QUESTIONS_RESPONSE =
  `Pas de souci, on te répond rapidement ici. À très vite.`;

// Legacy — kept for the admin /onboard flow
export const STEP_1_ACTION_PCT =
  `📋 <b>Étape 1/3</b> — Quel est ton <b>% action sur TELE</b> ?\n` +
  `<i>(envoie juste le chiffre, ex : <b>40</b> — ou <b>40 5</b> pour 40% action + 5% RB)</i>`;
