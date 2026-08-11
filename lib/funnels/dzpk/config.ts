// Configuration du bot d'acquisition dzpk.
//
// Bot SÉPARÉ du bot principal (@LeCercle_Lebot) : token distinct, webhook
// distinct, tables distinctes. Rien ici ne touche au funnel NEXA ni au bot
// joueur — c'est la contrainte de conception n°1 de ce chantier.
//
// Toutes les valeurs sont lues à l'appel, jamais mises en cache dans un module :
// Railway peut changer une variable sans redéploiement du code, et un cache
// figerait la valeur du boot.

/** Token du bot dzpk. Absent = le bot est muet, et ça doit se voir dans les logs. */
export function dzpkBotToken(): string | null {
  const t = process.env.DZPK_BOT_TOKEN?.trim();
  return t ? t : null;
}

/**
 * Lien d'affiliation du club @dzpk, poussé par le bot au /start.
 *
 * C'est un lien UNIQUE partagé par tous les leads (confirmé par Baki) : il ne
 * porte aucun code par joueur. Le rattachement se fait donc en aval, par
 * appariement de nom sur les notifs du club — cf. phase 2.
 */
export function dzpkClubInviteUrl(): string | null {
  const u = process.env.DZPK_CLUB_INVITE_URL?.trim();
  return u ? u : null;
}

/**
 * Supergroupe « Support DZPK » (Sujets activés) où atterrissent les messages
 * des leads. Utilisé à partir de la phase 3.
 *
 * Pas de repli sur le chat admin NEXA : les deux funnels doivent rester
 * étanches. Absent ⇒ le relais est désactivé et le dit.
 */
export function dzpkAdminChatId(): string | null {
  const id = process.env.DZPK_ADMIN_CHAT_ID?.trim();
  return id ? id : null;
}

/**
 * Identifiant de l'agent dans le club (🍓).
 *
 * Sert de FILTRE en phase 2 : le flux de notifs contient potentiellement les
 * joueurs d'autres agents, et se les attribuer serait une erreur comptable.
 * Défini ici parce que la phase 1 doit déjà pouvoir échouer bruyamment si la
 * variable manque au moment où la phase 2 démarre.
 */
export function dzpkAgentName(): string | null {
  const n = process.env.DZPK_AGENT_NAME?.trim();
  return n ? n : null;
}

/**
 * Source retenue quand le deep link n'en porte aucune.
 *
 * Volontairement une valeur RÉELLE et pas NULL : un lead sans source est un
 * lead organique, pas une donnée manquante. Le distinguer permet de calculer
 * un taux de conversion organique au lieu de l'exclure des stats.
 */
export const DEFAULT_SOURCE = "organic";

/** Borne de longueur de la source. Telegram plafonne déjà à 64, on ne fait pas confiance. */
export const SOURCE_MAX_LEN = 64;
