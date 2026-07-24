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

export async function saveNotesAction(leadId: number, notes: string) {
  return saveNexaNotes(leadId, notes);
}
