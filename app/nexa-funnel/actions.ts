"use server";

import {
  markNexaDepositDone, sendNexaManualReminder, ensureNexaGroup, saveNexaNotes,
} from "@/lib/nexa-funnel";

// Wrappers fins — toute la logique vit dans lib/nexa-funnel.ts.

/** Le dépôt n'est JAMAIS déclaré par le lead : c'est l'agent qui confirme l'encaissement. */
export async function markDepositAction(leadId: number) {
  return markNexaDepositDone(leadId);
}

export async function relanceAction(leadId: number) {
  return sendNexaManualReminder(leadId);
}

/** Retry de création du groupe privé (userbot HS, CHANNELS_TOO_MUCH…). Idempotent. */
export async function createGroupAction(leadId: number) {
  return ensureNexaGroup(leadId, "admin");
}

/**
 * Ce que ferait le bouton, sans rien faire — le dashboard l'affiche AVANT d'agir :
 * « ce contact a déjà un groupe (créé le X) → le rattacher » vs « créer un nouveau
 * groupe ». Aucune écriture, aucun appel Telegram de création.
 */
export async function previewGroupAction(leadId: number) {
  const { previewNexaGroup } = await import("@/lib/nexa-funnel");
  return previewNexaGroup(leadId);
}

export async function saveNotesAction(leadId: number, notes: string) {
  return saveNexaNotes(leadId, notes);
}

// ── Live takeover ─────────────────────────────────────────
// Équivalents back-office de /bot et /stop du chat admin — même fonctions, donc
// impossible que les deux chemins divergent.

/** Rend la main au scénario automatique immédiatement (= /bot). */
export async function handoverToBotAction(leadId: number) {
  const { handoverToBot } = await import("@/lib/funnels/live-takeover");
  return handoverToBot(leadId, "dashboard");
}

/** Désactive définitivement les relances de ce lead (= /stop). */
export async function stopRelancesAction(leadId: number) {
  const { stopRelances } = await import("@/lib/funnels/live-takeover");
  return stopRelances(leadId, "dashboard");
}
