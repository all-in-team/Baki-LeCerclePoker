export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import PeriodFilterBar from "@/components/PeriodFilterBar";
import { getDb } from "@/lib/db";
import { computePeriodFilter } from "@/lib/period-filter";
import { getLast12Weeks, toParisDate } from "@/lib/date-utils";
import { getXpokerDashboardOn, weekWindowFromParisDates, weekWindowLabel } from "@/lib/games/xpoker/dashboard";
import { XPOKER_GAME_LABEL, XPOKER_CLUB_ID, XPOKER_CLUB_NAME, XPOKER_AGENT_ID, XPOKER_FORMAT } from "@/lib/games/xpoker/config";
import XpokerKpiCards from "./XpokerKpiCards";
import XpokerClient from "./XpokerClient";

/**
 * XPoker Twd — page de room, UNE seule page (brief §7) : joueurs, deals, comptes,
 * réconciliation, grand livre chips, import hebdo. Détail déplié INLINE sous la
 * ligne du joueur, graphe en haut suivant le filtre de période.
 *
 * Même écart assumé que NEXAPOKER avec les pages LedgerShell (KKPOKER, A5NUTS) :
 * pas de synchro on-chain ici, la room est réglée EN CHIPS par le club et
 * l'agence est dépositaire des jetons (lib/games/xpoker/schema.ts).
 *
 * L'IMPORT HEBDO N'EST PAS CÂBLÉ : la source (classeur, club 246579 = 花順 ?,
 * format) attend la confirmation du club. Le moteur (commitImportOn) et le
 * parseur existent et sont testés sur fixtures ; la route d'import viendra avec
 * la confirmation. L'écran le dit, plutôt que d'offrir un bouton qui ment.
 *
 * Défaut « lifetime » comme NEXAPOKER : les données arrivent par report hebdo
 * après coup ; « cette semaine » ouvrirait sur des cartes à zéro.
 */
export default async function XpokerPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const raw = (await searchParams).filter;
  const wanted = raw !== undefined && KNOWN_FILTER.test(raw) ? raw : "lifetime";
  const probe = computePeriodFilter(wanted);
  const rawFilter = probe.key === wanted ? wanted : "lifetime";
  const period = rawFilter === wanted ? probe : computePeriodFilter("lifetime");
  const window = weekWindowFromParisDates(
    period.startDate ? toParisDate(period.startDate) : undefined,
    period.endDate ? toParisDate(period.endDate) : undefined,
  );
  const dash = getXpokerDashboardOn(getDb(), window);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title={XPOKER_GAME_LABEL}
        subtitle={`Club ${XPOKER_CLUB_NAME} (${XPOKER_CLUB_ID}) · agent ${XPOKER_AGENT_ID} · ${XPOKER_FORMAT} · tout en chips (TWD), équivalent USD indicatif`}
      />
      <XpokerKpiCards dash={dash} rangeLabel={weekWindowLabel(window)} />
      <PeriodFilterBar
        activeFilter={rawFilter}
        rangeLabel={period.rangeLabel}
        weeks={getLast12Weeks().map(w => ({ isoWeek: w.isoWeek, label: w.label }))}
        basePath="/xpoker"
      />
      <XpokerClient dash={dash} today={today} periodLabel={weekWindowLabel(window)} />
    </>
  );
}

const KNOWN_FILTER = /^(current|last|30d|lifetime|\d{4}-W\d{2}|\d{4}-\d{2}-\d{2}|custom:.+)$/;
