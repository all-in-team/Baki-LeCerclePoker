export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import PeriodFilterBar from "@/components/PeriodFilterBar";
import { getSetting } from "@/lib/queries";
import { currentWeekMonday } from "@/lib/funnels/nexa/players";
import { getNexaDashboard, weekWindowFromParisDates, weekWindowLabel } from "@/lib/funnels/nexa/dashboard";
import { computePeriodFilter } from "@/lib/period-filter";
import { getLast12Weeks, toParisDate } from "@/lib/date-utils";
import NexaKpiCards from "./NexaKpiCards";
import NexaPokerClient from "./NexaPokerClient";
import SaisieClient from "./SaisieClient";

/**
 * NEXAPOKER — page de room, UNE seule page.
 *
 * Joueurs, parts d'action et réconciliation en haut ; saisie hebdomadaire
 * (extraction de screenshot + grille) en bas. Le geste du lundi et l'état des
 * joueurs sont sous les yeux au même endroit — c'était le point du regroupement.
 * /nexa/saisie redirige ici (l'URL était en favori).
 *
 * Écart assumé avec les autres pages de rooms (/kkpoker/pnl, /a5nuts/pnl,
 * /aks/pnl) : elles passent par LedgerShell + loadWalletLedger, câblés sur la
 * synchro wallet on-chain et les settlements, que NEXAPOKER n'a pas — ses
 * mouvements passent par Hugo en système d'agent. La bascule deviendra naturelle
 * au rattachement du hub /payments (étape 7).
 *
 * Les dates sont calculées CÔTÉ SERVEUR : ni la semaine d'effet d'une part
 * d'action, ni la date d'un mouvement ne doivent dépendre du fuseau du navigateur.
 */
export default async function NexaPokerPage({ searchParams }: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  // Le deal par défaut est un RÉGLAGE, jamais un taux en dur : les taux effectifs
  // sont toujours ceux parsés depuis le deal_text de chaque ligne.
  const defaultDeal = getSetting("nexa_default_deal_text") ?? "";

  // Filtre de période — MÊME barre que les pages P&L, même contrat d'URL.
  //
  // Défaut « lifetime » et non « cette semaine », contrairement à KKPOKER : les
  // données NEXA sont un report HEBDOMADAIRE qui arrive après coup. La semaine en
  // cours n'a jamais de report, donc un défaut « current » ouvrirait la page sur
  // des cartes à zéro — un écran qui a l'air de dire « tu n'as rien gagné ».
  // Une valeur inconnue est ramenée à `lifetime` AVANT d'atteindre le résolveur :
  // celui-ci retombe sur « cette semaine », et une URL malformée ouvrirait donc la
  // page sur des cartes à zéro — précisément l'écran qu'on veut éviter.
  const raw = (await searchParams).filter;
  const wanted = raw !== undefined && KNOWN_FILTER.test(raw) ? raw : "lifetime";
  // Deuxième garde : une valeur de BONNE FORME peut rester irrésoluble
  // (`2026-W99`, une semaine ISO future, un `custom:` malformé). computePeriodFilter
  // les rejette en retombant sur « cette semaine » — donc, ici, sur des cartes à
  // zéro. On détecte le rejet en comparant la clé rendue à celle demandée.
  const probe = computePeriodFilter(wanted);
  const rawFilter = probe.key === wanted ? wanted : "lifetime";
  const period = rawFilter === wanted ? probe : computePeriodFilter("lifetime");
  const window = weekWindowFromParisDates(
    period.startDate ? toParisDate(period.startDate) : undefined,
    period.endDate ? toParisDate(period.endDate) : undefined,
  );
  const dash = getNexaDashboard(window);

  return (
    <>
      <PageHeader
        title="NEXAPOKER"
        subtitle="Joueurs, parts d'action, mouvements et saisie hebdomadaire du report"
      />

      <NexaKpiCards dash={dash} rangeLabel={weekWindowLabel(window)} />
      <PeriodFilterBar
        activeFilter={rawFilter}
        rangeLabel={period.rangeLabel}
        weeks={getLast12Weeks().map(w => ({ isoWeek: w.isoWeek, label: w.label }))}
        basePath="/nexapoker"
      />

      <NexaPokerClient currentWeek={currentWeekMonday()} today={today}
                       chartWeeks={dash.weeks} periodLabel={weekWindowLabel(window)} />

      <div id="saisie" style={{ marginTop: 28, scrollMarginTop: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#E8E8EE", marginBottom: 4 }}>
          📷 Saisie de la semaine
        </div>
        <div style={{ fontSize: 12, color: "#8888A0", marginBottom: 14 }}>
          Dépose le screenshot du report NEXA : la grille se pré-remplit, tu relis, tu enregistres.
          Rien n'est écrit tant que tu n'as pas cliqué sur Enregistrer.
        </div>
        <SaisieClient defaultDeal={defaultDeal} initialWeek={lastMonday()} />
      </div>
    </>
  );
}

/** Valeurs acceptées par le contrat d'URL de PeriodFilterBar (cf. computePeriodFilter). */
const KNOWN_FILTER = /^(current|last|30d|lifetime|\d{4}-W\d{2}|\d{4}-\d{2}-\d{2}|custom:.+)$/;

/** Lundi de la semaine passée — la semaine qu'on recopie en général. */
function lastMonday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7);
  return d.toISOString().slice(0, 10);
}
