export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import { getSetting } from "@/lib/queries";
import SaisieClient from "./SaisieClient";

/** Lundi de la semaine passée — la semaine qu'on recopie en général. */
function lastMonday(): string {
  const d = new Date();
  const dow = d.getUTCDay(); // 0 = dimanche
  const backToMonday = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - backToMonday - 7);
  return d.toISOString().slice(0, 10);
}

export default function NexaSaisiePage() {
  // Le deal par défaut est un RÉGLAGE, jamais une valeur en dur : les taux
  // effectifs sont toujours ceux parsés depuis le texte de chaque ligne.
  const defaultDeal = getSetting("nexa_default_deal_text") ?? "";

  return (
    <>
      <PageHeader
        title="NEXA — saisie du report d'affiliation"
        subtitle="Recopie des screenshots · l'Affiliate Payment est recalculé et confronté à ta saisie (tolérance 0,02)"
      />
      <SaisieClient defaultDeal={defaultDeal} initialWeek={lastMonday()} />
    </>
  );
}
