"use server";

import { markPaid, unlockSettlement } from "@/lib/manual-settlement-engine";

/**
 * Payments hub server actions — deliberately as thin as the per-room ones
 * (app/kkpoker/pnl/actions.ts & co, invariant #2): they call the SAME engine
 * functions the rooms call, on the SAME manual_settlements rows.
 *
 * That is what makes the hub and the rooms a single source of truth: there is no
 * hub-side state to keep in sync — paying here IS paying in the room.
 *
 * All room pages are `force-dynamic`, so a payment made here shows up on the next
 * room render with no cache invalidation to orchestrate.
 */

export async function markPaidAction(settlementId: number, txHash?: string, paidDate?: string) {
  return markPaid(settlementId, txHash, paidDate);
}

/**
 * Marquage payé en lot — boucle sur le MÊME markPaid() unitaire, un règlement à la fois.
 *
 * Pas de nouvelle primitive moteur, pas de transaction englobante : chaque règlement garde son
 * état propre, et markPaid() porte déjà ses gardes (UPDATE ... WHERE status='locked', refus du
 * double paiement, validation stricte de la date). Une sélection n'est donc jamais réglée « en
 * bloc » : c'est N règlements réels réglés individuellement.
 *
 * Volontairement PAS atomique : si le 3e échoue, les 2 premiers restent payés — c'est de
 * l'argent réellement sorti, un rollback le rendrait invisible. Les échecs sont renvoyés
 * ligne par ligne pour être affichés tels quels, jamais agrégés en un « ok » global.
 *
 * txHash est appliqué à tous les règlements de la sélection : cas d'usage = un seul virement
 * qui solde plusieurs semaines.
 */
export async function markPaidBulkAction(
  settlementIds: number[],
  txHash?: string,
  paidDate?: string,
): Promise<{ paid: number; failures: { id: number; error: string }[] }> {
  const failures: { id: number; error: string }[] = [];
  let paid = 0;
  for (const id of settlementIds) {
    const res = markPaid(id, txHash, paidDate);
    if (res.ok) paid++;
    else failures.push({ id, error: res.error ?? "Erreur inconnue" });
  }
  return { paid, failures };
}

export async function unlockAction(settlementId: number) {
  return unlockSettlement(settlementId);
}
