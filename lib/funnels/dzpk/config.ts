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
 * Libellé du club tel qu'il apparaît dans les notifs (`德州扑克 ♠️❤️ @dzpk`).
 *
 * Sert d'ANCRE d'extraction du nom de joueur, pas de décoration : dans le
 * gabarit « rattaché », le nom est séparé du club par `从`, qui est un caractère
 * chinois courant pouvant appartenir à un nom (`从容`). Ancrer sur le libellé
 * complet supprime cette ambiguïté.
 *
 * Absent ⇒ le parseur bascule sur une ancre structurelle de repli (cf. club-parser).
 */
export function dzpkClubLabel(): string | null {
  const l = process.env.DZPK_CLUB_LABEL?.trim();
  return l ? l : null;
}

/**
 * Bot du club qui envoie les notifications en DM.
 *
 * C'est le SEUL peer que le userbot interroge. Aucune autre conversation privée
 * n'est jamais lue : la confidentialité tient à la portée de la requête, pas à
 * un filtre appliqué après réception.
 */
export function dzpkClubBot(): string {
  return process.env.DZPK_CLUB_BOT?.trim() || "@dp_bot";
}

/**
 * Nombre de messages demandés par passe d'ingestion.
 *
 * Pilotable par `DZPK_INGEST_BATCH` pour une raison précise : prouver en réel
 * que la pagination remonte bien les messages les PLUS ANCIENS après le curseur
 * (`reverse: true`) demande un lot volontairement petit. Sans cette variable, la
 * vérification imposerait un changement de code et un redéploiement — donc, en
 * pratique, elle ne serait jamais faite.
 *
 * Bornée à [1, 200] : une valeur aberrante dans une variable d'env ne doit pas
 * se traduire par une requête Telegram absurde.
 */
export function ingestBatch(): number {
  const raw = parseInt(process.env.DZPK_INGEST_BATCH ?? "", 10);
  if (!Number.isFinite(raw)) return 100;
  return Math.min(200, Math.max(1, raw));
}

/**
 * Au-delà de ce délai sans ingestion réussie, on alerte.
 *
 * Une session userbot morte ne produit AUCUN symptôme : elle ressemble trait
 * pour trait à une journée sans nouveau joueur. Sans cette borne, la panne se
 * découvre en comptant l'argent, des jours plus tard.
 */
export const INGEST_STALE_HOURS = 6;

/**
 * L'auto-rattachement applique-t-il ses effets ?
 *
 * DÉFAUT : NON. Le cron ingère, résout, et AFFICHE les matchs qu'il juge
 * certains — sans créditer personne. Baki regarde un lot sur ses vraies données,
 * puis pose `DZPK_AUTO_MATCH=on` pour lever le drapeau.
 *
 * Le défaut est « observer » et non « appliquer » parce que l'erreur qu'on
 * cherche à éviter est silencieuse : un crédit sur le mauvais lead ne change pas
 * le revenu total, il déplace l'attribution d'une source de pub vers une autre,
 * et rien dans les totaux ne cloche ensuite. Une variable oubliée doit donc
 * laisser le système en observation, jamais en application.
 */
export function dzpkAutoMatchEnabled(): boolean {
  const v = (process.env.DZPK_AUTO_MATCH ?? "").trim().toLowerCase();
  return v === "on" || v === "1" || v === "true" || v === "yes";
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
