// Envoi du message d'accueil dzpk — et de la relance J+1, qui réutilise le
// même bouton et le même lien.
//
// Isolé du webhook pour une raison précise : ce sont les SEULS chemins d'envoi
// sortants du scénario, et deux constructions du clavier dans deux fichiers
// finiraient par diverger.

import { tgRetrying, isBlockedError } from "./tg";
import { dzpkClubInviteUrl } from "./config";
import {
  WELCOME, WELCOME_B, WELCOME_FOOTER, WELCOME_NO_LINK,
  JOIN_BUTTON, JOIN_BUTTON_B, FOLLOWUP_D1,
} from "./copy";

/**
 * Variante d'accueil du test A/B (étape 5 de l'optimisation).
 *
 * "A" = copie historique, "B" = angle observation (cf. copy.ts). La variante
 * est DÉRIVÉE de la parité de l'id du lead — déterministe, équilibrée à ~50/50,
 * et rejouable : un re-/start retombe sur la même variante, donc un lead ne
 * voit jamais les deux textes.
 */
export type WelcomeVariant = "A" | "B";

export function pickWelcomeVariant(leadId: number): WelcomeVariant {
  return leadId % 2 === 0 ? "B" : "A";
}

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
export function clubKeyboard(variant: WelcomeVariant = "A"):
  { inline_keyboard: Array<Array<{ text: string; url: string }>> } | null {
  const url = dzpkClubInviteUrl();
  if (!url) return null;
  return { inline_keyboard: [[{ text: variant === "B" ? JOIN_BUTTON_B : JOIN_BUTTON, url }]] };
}

/**
 * Construction PURE du message d'accueil : testable sans réseau, et c'est elle
 * qui garantit que le texte journalisé est celui qui part.
 */
export function buildWelcome(variant: WelcomeVariant): {
  text: string;
  keyboard: ReturnType<typeof clubKeyboard>;
} {
  const keyboard = clubKeyboard(variant);
  const body = variant === "B" ? WELCOME_B : WELCOME;
  const text = keyboard ? `${body}\n\n${WELCOME_FOOTER}` : WELCOME_NO_LINK;
  return { text, keyboard };
}

export async function sendWelcome(chatId: number | string, variant: WelcomeVariant = "A"): Promise<SendResult> {
  const { text, keyboard } = buildWelcome(variant);

  if (!keyboard) {
    // Anomalie de configuration : bruyante côté opérateur, invisible côté lead.
    console.error("[DZPK] DZPK_CLUB_INVITE_URL absent — accueil envoyé sans bouton");
  }

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

/**
 * Relance unique J+1 (phase 4). Même clavier que l'accueil, même variante que
 * celle vue au /start : un lead B relancé avec le bouton A verrait le libellé
 * changer sans raison.
 */
export async function sendFollowupD1(chatId: number | string, variant: WelcomeVariant = "A"): Promise<SendResult> {
  const keyboard = clubKeyboard(variant);
  const text = FOLLOWUP_D1;

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
