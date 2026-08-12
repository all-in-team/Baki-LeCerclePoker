export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import { getReconciliationQueue, getReconciliationStats, getObservedMatches } from "@/lib/funnels/dzpk/matcher";
import { dzpkAutoMatchEnabled } from "@/lib/funnels/dzpk/config";
import DzpkReconciliationClient from "./DzpkReconciliationClient";

/**
 * Écran de rattachement manuel des notifications du club dzpk.
 *
 * Il tourne AVANT même que l'acquisition démarre : tant que le taux
 * d'auto-appariement n'est pas mesuré sur des données réelles, tout passe par
 * ici. Chaque rattachement manuel apprend un lien, donc la file s'allège d'elle-
 * même au fil de l'usage.
 */
export default function DzpkReconciliationPage() {
  const stats = getReconciliationStats();
  const queue = getReconciliationQueue();
  const observed = getObservedMatches();
  const autoMatchEnabled = dzpkAutoMatchEnabled();

  return (
    <>
      <PageHeader
        title="Réconciliation dzpk"
        subtitle="Notifications du club non rattachées — relier à la main, le lien est mémorisé"
      />
      <DzpkReconciliationClient
        initialStats={stats}
        initialQueue={queue}
        initialObserved={observed}
        autoMatchEnabled={autoMatchEnabled}
      />
    </>
  );
}
