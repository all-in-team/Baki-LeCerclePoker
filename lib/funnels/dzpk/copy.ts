// Tous les textes du bot dzpk, en un seul endroit.
//
// Le bot s'adresse à une audience 100 % chinoise : aucun repli anglais, aucune
// détection de langue. Ajouter une langue plus tard voudra dire ajouter un
// paramètre ici, pas disséminer des chaînes dans les handlers.
//
// ⚠️ Les textes partent en parse_mode HTML. Toute valeur interpolée venant de
// Telegram (prénom, pseudo) DOIT passer par esc() — un simple « < » dans un
// prénom ferait échouer l'envoi en silence.

/** Message d'accueil au /start. Un seul message, un seul bouton. */
export const WELCOME = [
  "🃏 欢迎来到德州扑克俱乐部！",
  "♠️ USDT上下分 · 免下载免注册 · 公群上押300万U担保",
  "♥️ 各级别都有桌，700+人同时在线",
  "",
  "👇 点击下方按钮加入牌局群",
].join("\n");

/**
 * Ligne posée sous le bouton : ouvre explicitement la porte à la conversation.
 *
 * C'est LA phrase dont dépend le fil de conversation du back-office. Le parcours
 * nominal ne donne aucune raison d'écrire — l'accueil pousse un bouton vers le
 * club, le lead clique et s'en va. Sans invitation explicite, le bot n'est qu'un
 * redirecteur et l'écran de conversation reste vide.
 *
 * Bilingue, alors que le reste de la copie ne l'est pas : les pseudos observés
 * ne sont pas tous chinois (« Hakim AMIRUL », « Goon KK »), et une invitation
 * qu'on ne comprend pas ne produit aucun message.
 */
export const WELCOME_FOOTER = [
  "有任何问题，直接在这里回复我 💬",
  "🎧 Any question? Just write to me here.",
].join("\n");

/** Libellé du bouton d'entrée au club. */
export const JOIN_BUTTON = "♠️ 加入牌局群";

/**
 * Relance unique à J+1 (phase 4). Vit ici dès maintenant pour que la totalité
 * de la copie chinoise soit relisible d'un seul coup d'œil par Baki.
 */
export const FOLLOWUP_D1 = [
  "👋 牌局正热，随时可以上桌！",
  "",
  "有问题直接回复我",
].join("\n");

/**
 * Réponse quand le lien du club n'est pas configuré.
 *
 * On répond quand même : un lead qui a cliqué sur une pub payante ne doit
 * jamais tomber sur le silence. Le message reste crédible côté lead, et
 * l'anomalie part dans les logs côté opérateur.
 */
export const WELCOME_NO_LINK = [
  "🃏 欢迎来到德州扑克俱乐部！",
  "",
  "稍等一下，马上给你发送入群链接 🙏",
].join("\n");
