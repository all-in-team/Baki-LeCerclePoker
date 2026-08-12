// Envoi du message d'accueil dzpk.
//
// Isolé du webhook pour une raison précise : c'est le SEUL chemin d'envoi de
// l'accueil, et la relance J+1 (phase 4) réutilisera le même bouton et le même
// lien. Deux constructions du clavier dans deux fichiers finiraient par diverger.

import { tgRetrying, isBlockedError } from "./tg";
import { dzpkClubInviteUrl } from "./config";
import { WELCOME, WELCOME_FOOTER, WELCOME_NO_LINK, JOIN_BUTTON } from "./copy";

export interface SendResult {
  ok: boolean;
  /** Le lead a bloqué le bot : définitif, à marquer sur la fiche. */
  blocked: boolean;
  error?: string;
  /** Id Telegram du message envoyé, pour l'ancrer dans le fil de conversation. */
  messageId?: number;
  /** Texte réellement parti — journalisé tel quel, pas reconstruit à la lecture. */
  text?: string;
}

/**
 * Bouton inline vers le club.
 *
 * `null` quand le lien n'est pas configuré : Telegram REFUSE un bouton dont
 * l'url est vide, et l'envoi entier échouerait — le lead ne recevrait alors
 * strictement rien. Mieux vaut un accueil sans bouton qu'un silence.
 */
export function clubKeyboard(): { inline_keyboard: Array<Array<{ text: string; url: string }>> } | null {
  const url = dzpkClubInviteUrl();
  if (!url) return null;
  return { inline_keyboard: [[{ text: JOIN_BUTTON, url }]] };
}

export async function sendWelcome(chatId: number | string): Promise<SendResult> {
  const keyboard = clubKeyboard();

  if (!keyboard) {
    // Anomalie de configuration : bruyante côté opérateur, invisible côté lead.
    console.error("[DZPK] DZPK_CLUB_INVITE_URL absent — accueil envoyé sans bouton");
  }

  const text = keyboard ? `${WELCOME}\n\n${WELCOME_FOOTER}` : WELCOME_NO_LINK;

  const res = await tgRetrying<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });

  if (res.ok) return { ok: true, blocked: false, messageId: res.result?.message_id, text };
  return { ok: false, blocked: isBlockedError(res), error: res.description };
}
