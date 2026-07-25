export const dynamic = "force-dynamic";

import PageHeader from "@/components/PageHeader";
import PaymentsClient from "./PaymentsClient";
import { markPaidAction, unlockAction } from "./actions";
import {
  getPendingSettlements,
  getPaidSettlements,
  getOverdueBuckets,
  getPaymentsTotals,
  SETTLE_ROOMS,
  OVERDUE_GRACE_DAYS,
} from "@/lib/manual-settlement-engine";

/**
 * Paiements — cockpit de règlement centralisé, toutes rooms confondues.
 *
 * Aggregated VIEW over manual_settlements, not a parallel system: the rooms stay
 * the source (that is where a settlement is born, via "Régler la sélection" →
 * Lock), this page is where every pending one converges so none is forgotten.
 *
 * Reads only — every write goes through the shared engine via ./actions.ts.
 */
export default async function PaymentsPage() {
  const pending = getPendingSettlements();
  const overdue = getOverdueBuckets();
  // Pas de LIMIT : les filtres de l'historique sont appliqués côté client, un cap ici
  // ferait apparaître un mois ancien comme « aucun règlement » au lieu de « tronqué ».
  const paid = getPaidSettlements();
  const totals = getPaymentsTotals(pending, overdue);

  return (
    <>
      <PageHeader
        title="Paiements"
        subtitle="Tous les règlements en attente, toutes rooms — plus aucun joueur oublié"
      />
      <PaymentsClient
        pending={pending}
        overdue={overdue}
        paid={paid}
        totals={totals}
        rooms={SETTLE_ROOMS.map(r => r.label)}
        graceDays={OVERDUE_GRACE_DAYS}
        markPaidAction={markPaidAction}
        unlockAction={unlockAction}
      />
    </>
  );
}
