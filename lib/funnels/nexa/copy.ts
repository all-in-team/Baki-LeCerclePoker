// Copy du funnel NEXAPOKER, par langue — TOUT le texte vu par un lead vit ici.
// Aucun littéral destiné au lead ne doit rester dans lib/nexa-funnel.ts.
//
// Hors périmètre (volontairement) :
//   • les notifs AGENT_CHAT_ID → restent en français, c'est Baki qui les lit ;
//   • TOPIC_MESSAGES (seed des topics du groupe) → les groupes restent en FR ;
//   • les libellés back-office (NEXA_STAGES, cards) → interface interne.
//
// Interpolation : de vraies fonctions plutôt qu'un moteur de templates — typé,
// sans parseur, et le compilateur attrape un argument oublié.
//
// AJOUTER UNE LANGUE : voir l'en-tête de lib/i18n/index.ts. `Record<Lang, NexaCopy>`
// fait échouer la compilation tant que le nouveau bloc n'est pas écrit.
//
// Parse mode Telegram = HTML → échapper `&` en `&amp;` (cf. « Hugo &amp; Baki »).
import { dict, type Lang } from "@/lib/i18n";

export type NexaCopy = {
  /** Libellés des boutons inline. Les OS (🪟/🤖/🍎) restent dans config.ts : neutres. */
  btn: {
    question: string;
    myId: string;
    go: string;
    deal: string;
    deposit: string;
    joinGroup: string;
  };

  /** « 7 chiffres » / « 7 digits » — la formulation est du copy, le 7 est de la config. */
  memberIdHint: (digits: number) => string;

  welcome: (o: { room: string; code: string }) => string;
  dealExplainer: string;
  downloadStep: string;
  /** En-tête du message combiné : lien de téléchargement de l'OS choisi. */
  downloadHead: (o: { label: string; url: string }) => string;
  signupBlock: (o: { code: string; hint: string }) => string;
  depositStep: (o: { room: string }) => string;
  groupReady: string;

  /** Messages courts. */
  hereIsChannel: string;
  /** Le `handle` vient de SUPPORT_HANDLE (lib/funnels/shared.ts) — jamais en dur ici. */
  allSet: (o: { handle: string }) => string;
  noLead: string;
  questionAck: (o: { handle: string }) => string;
  myIdPrompt: (o: { hint: string }) => string;
  depositPreparing: string;
  groupFailed: string;

  /** ID joueur. */
  idBadFormat: (o: { hint: string }) => string;
  idDuplicate: string;
  idAlreadyKnown: (o: { handle: string }) => string;
  idSaved: (o: { id: string }) => string;

  /** Confirmations. */
  roomConfirmed: string;
  depositConfirmed: string;

  /** Relances — `reminderInstalled` n'est qu'un chapeau, suivi du lien OS + signupBlock. */
  reminderStarted: (o: { room: string; code: string }) => string;
  reminderInstalled: string;
  reminderDeposit: string;
};

const FR: NexaCopy = {
  btn: {
    question: "❓ J'ai une question",
    myId: "📝 Mon ID Player",
    go: "C'est parti →",
    deal: "💡 C'est quoi le deal ?",
    deposit: "💰 Faire mon premier dépôt",
    joinGroup: "🔐 Rejoindre mon canal privé",
  },

  memberIdHint: d => `${d} chiffres`,

  welcome: ({ room, code }) =>
    `🃏 <b>Bienvenue au Cercle — Onboarding ${room}</b>\n\n` +
    `On t'accompagne de A à Z. Voici les 3 étapes :\n\n` +
    `<b>1</b> — 📲 Tu télécharges l'app (30 sec)\n` +
    `<b>2</b> — 📝 Tu crées ton compte avec le code 🎁 <b>${code}</b> et tu m'envoies ton ID\n` +
    `<b>3</b> — 🤝 On crée ton groupe privé avec Hugo &amp; Baki : dépôts et retraits en direct ⚡, suivi perso, et accès à d'autres games qui peuvent te correspondre\n\n` +
    `En bonus : accès au <b>PokerDex</b> 🧠 — notre data AI sur le field pour jouer avec un coup d'avance.\n\n` +
    `Ça prend 5 minutes, on y va 👇`,

  dealExplainer:
    `💡 <b>Comment on gagne de l'argent ?</b>\n\n` +
    `La room nous reverse une part du rake que tu génères — c'est elle qui nous paye, pas toi. ` +
    `Jouer via nous te coûte <b>0</b> et te rapporte le bonus + l'accompagnement.\n\n` +
    `Et si un jour ton niveau fait que la room te tag « pro » et coupe le RB, on te proposera un ` +
    `deal d'action ensemble — on investit sur toi, on gagne quand tu gagnes… et on perd quand tu perds, ` +
    `mais j'espère plutôt que tu nous rendras riche lol 🤝\n\n` +
    `Bref : nos intérêts sont alignés avec les tiens dès le jour 1.`,

  downloadStep:
    `<b>Étape 1/3 — Télécharge l'app</b>\n\n` +
    `Sur quoi tu joues ? Choisis ta plateforme 👇`,

  downloadHead: ({ label, url }) =>
    `${label} — voici ton lien de téléchargement 👇\n${url}\n\n`,

  signupBlock: ({ code, hint }) =>
    `<b>Étape 2/3 — Crée ton compte</b>\n\n` +
    `Dans l'app, inscris-toi en entrant le code <b>${code}</b>.\n` +
    `Sans ce code, l'agent ne peut pas créditer tes dépôts.\n\n` +
    `📌 <b>Important</b> : Il faut mettre <b>Andorra</b> comme pays de résidence ` +
    `(pas de justificatif de domicile demandé)\n\n` +
    `Et ton Nom, Prénom et date de naissance doivent correspondre exactement à ton ID.\n\n` +
    `Une fois ton compte créé, envoie-moi ton <b>ID joueur</b> (visible dans ton profil) 👇\n\n` +
    `Envoie juste le numéro ici (${hint}).`,

  depositStep: ({ room }) =>
    `<b>Étape 3/3 — Ton premier dépôt + ton groupe privé</b>\n\n` +
    `${room} fonctionne en <b>système d'agent</b> : tous les dépôts et retraits passent par nous.\n\n` +
    `Clique ci-dessous : on ouvre ton canal privé avec Hugo &amp; Baki, et tu reçois ton accès <b>PokerDex</b> 🧠 pour la game 👇`,

  groupReady:
    `🎉 <b>Bienvenue en direct avec nous</b>\n\n` +
    `C'est ici que se passent <b>tes dépôts et tes retraits</b>. Rejoins le groupe et dis-nous combien tu veux déposer 👇`,

  hereIsChannel: `Voici ton canal privé 👇`,
  allSet: ({ handle }) => `Tout est bon de ton côté 🃏\nUne question ? Écris directement à @${handle}.`,
  noLead: `Envoie /start pour commencer !`,
  questionAck: ({ handle }) =>
    `👍 Pas de souci ! Écris directement à @${handle}, on te répond tout de suite.`,
  myIdPrompt: ({ hint }) => `Vas-y, envoie ton ID ici 👇 (${hint}, visible dans ton profil)`,
  depositPreparing:
    `⏳ Top ! Je te prépare ton canal privé avec Hugo &amp; Baki — ça prend jusqu'à 1 minute, ` +
    `ton lien arrive juste en dessous, bouge pas 🤙`,
  groupFailed: `On finalise ton accès — un membre de l'équipe te contacte dans la minute 👌`,

  idBadFormat: ({ hint }) =>
    `Hmm, ton ID doit faire ${hint} — tu le trouves dans ton profil dans l'app 👀 Renvoie-le moi.`,
  idDuplicate: `⚠️ Cet ID est déjà enregistré chez nous. On vérifie ça et on revient vers toi tout de suite 👌`,
  idAlreadyKnown: ({ handle }) => `👌 On a bien ton ID. Une question ? Écris directement à @${handle}.`,
  idSaved: ({ id }) => `✅ ID enregistré : <code>${id}</code>\n\nCompte créé, on passe à la suite 👇`,

  roomConfirmed:
    `✅ <b>Compte confirmé côté room</b>\n\n` +
    `On te suit maintenant automatiquement 🃏\n` +
    `Pour tout dépôt ou retrait, on est là — GL aux tables 🃏`,
  depositConfirmed: `💰 <b>Dépôt confirmé</b> — tu es prêt à jouer !\n\nGL aux tables 🃏`,

  reminderStarted: ({ room, code }) =>
    `👋 Toujours partant pour ${room} ?\n\n` +
    `Il te reste juste à télécharger l'app — 2 minutes, et le code <b><code>${code}</code></b> t'attend.`,
  reminderInstalled: `👋 Il ne manque plus que ton compte !\n\n`,
  reminderDeposit:
    `👋 On t'attend pour ton <b>premier dépôt</b> !\n\n` +
    `Chez nous les dépôts et retraits se font en direct, dans ton canal privé. On l'ouvre quand tu veux 👇`,
};

// Adaptation, pas traduction mot-à-mot (validé Hugo 2026-07-28). Deux écarts
// assumés par rapport au français :
//   • « ID » FR = pièce d'identité ET numéro joueur. En anglais on désambiguïse :
//     « ID document » vs « player ID », sinon l'étape 2 est incompréhensible.
//   • « deal d'action » → « staking deal », le terme natif côté joueur anglophone.
// Identiques au FR par consigne : BONUSBLAST, les URLs, Hugo & Baki, PokerDex,
// NEXAPOKER, et la numérotation Step 1/3 · 2/3 · 3/3.
const EN: NexaCopy = {
  btn: {
    question: "❓ I have a question",
    myId: "📝 My Player ID",
    go: "Let's go →",
    deal: "💡 What's the catch?",
    deposit: "💰 Make my first deposit",
    joinGroup: "🔐 Join my private channel",
  },

  memberIdHint: d => `${d} digits`,

  welcome: ({ room, code }) =>
    `🃏 <b>Welcome to Le Cercle — ${room} Onboarding</b>\n\n` +
    `We'll walk you through the whole thing. Three steps:\n\n` +
    `<b>1</b> — 📲 Download the app (30 seconds)\n` +
    `<b>2</b> — 📝 Create your account with code 🎁 <b>${code}</b> and send me your ID\n` +
    `<b>3</b> — 🤝 We open your private group with Hugo &amp; Baki: instant deposits and withdrawals ⚡, personal support, and access to other games that might fit your profile\n\n` +
    `Plus: you get <b>PokerDex</b> 🧠 — our AI read on the field, so you sit down already a step ahead.\n\n` +
    `Five minutes, let's go 👇`,

  dealExplainer:
    `💡 <b>So how do we make money?</b>\n\n` +
    `The room pays us a cut of the rake you generate — <b>they</b> pay us, not you. ` +
    `Coming through us costs you <b>nothing</b> and gets you the bonus plus full support.\n\n` +
    `And if you ever get good enough that the room tags you a "pro" and kills your rakeback, ` +
    `we'll offer you a staking deal — we back you, we win when you win… and we eat it when you lose, ` +
    `though honestly I'm hoping you make us rich lol 🤝\n\n` +
    `Bottom line: we're on your side of the table from day one.`,

  downloadStep:
    `<b>Step 1/3 — Download the app</b>\n\n` +
    `What do you play on? Pick your platform 👇`,

  downloadHead: ({ label, url }) =>
    `${label} — here's your download link 👇\n${url}\n\n`,

  signupBlock: ({ code, hint }) =>
    `<b>Step 2/3 — Create your account</b>\n\n` +
    `Sign up in the app using code <b>${code}</b>.\n` +
    `Without it, the agent can't credit your deposits.\n\n` +
    `📌 <b>Important</b>: set <b>Andorra</b> as your country of residence ` +
    `(no proof of address required)\n\n` +
    `Your first name, last name and date of birth must match your ID document exactly.\n\n` +
    `Once your account is live, send me your <b>player ID</b> (you'll find it in your profile) 👇\n\n` +
    `Just drop the number here (${hint}).`,

  depositStep: ({ room }) =>
    `<b>Step 3/3 — Your first deposit + your private group</b>\n\n` +
    `${room} runs on an <b>agent system</b>: every deposit and withdrawal goes through us.\n\n` +
    `Tap below and we'll open your private channel with Hugo &amp; Baki — and unlock your <b>PokerDex</b> 🧠 access for the game 👇`,

  groupReady:
    `🎉 <b>You're in — direct line to us</b>\n\n` +
    `This is where <b>your deposits and withdrawals</b> happen. Join the group and tell us how much you want to put in 👇`,

  hereIsChannel: `Here's your private channel 👇`,
  allSet: ({ handle }) => `You're all set 🃏\nAnything you need? Message @${handle} directly.`,
  noLead: `Send /start to get going!`,
  questionAck: ({ handle }) =>
    `👍 No worries! Message @${handle} directly and we'll get right back to you.`,
  myIdPrompt: ({ hint }) => `Go ahead, drop your ID here 👇 (${hint}, it's in your profile)`,
  depositPreparing:
    `⏳ Nice! Setting up your private channel with Hugo &amp; Baki — takes up to a minute, ` +
    `your link lands right below. Hang tight 🤙`,
  groupFailed: `We're finalising your access — someone from the team will reach out within the minute 👌`,

  idBadFormat: ({ hint }) =>
    `Hmm, your ID should be ${hint} — you'll find it in your profile in the app 👀 Send it again.`,
  idDuplicate: `⚠️ That ID is already registered on our side. We're checking it and coming right back to you 👌`,
  idAlreadyKnown: ({ handle }) => `👌 We've got your ID. Any questions? Message @${handle} directly.`,
  idSaved: ({ id }) => `✅ ID saved: <code>${id}</code>\n\nAccount's live — next step 👇`,

  roomConfirmed:
    `✅ <b>Account confirmed by the room</b>\n\n` +
    `You're tracked on our side automatically now 🃏\n` +
    `Need a deposit or a withdrawal? We're here — GL at the tables 🃏`,
  depositConfirmed: `💰 <b>Deposit confirmed</b> — you're good to play!\n\nGL at the tables 🃏`,

  reminderStarted: ({ room, code }) =>
    `👋 Still up for ${room}?\n\n` +
    `All that's left is downloading the app — 2 minutes, and code <b><code>${code}</code></b> is waiting for you.`,
  reminderInstalled: `👋 Just your account left to set up!\n\n`,
  reminderDeposit:
    `👋 We're just waiting on your <b>first deposit</b>!\n\n` +
    `Deposits and withdrawals happen live with us, in your own private channel. We'll open it whenever you're ready 👇`,
};

export const NEXA_COPY: Record<Lang, NexaCopy> = { fr: FR, en: EN };

/** `nexaCopy(lead.lang)` → le bloc de la bonne langue (repli DEFAULT_LANG). */
export const nexaCopy = dict(NEXA_COPY);

/** Préfixe des callbacks du sélecteur de langue Nexa (`nf_lang:fr`, `nf_lang:en`). */
export const NEXA_LANG_CB_PREFIX = "nf_lang:";
