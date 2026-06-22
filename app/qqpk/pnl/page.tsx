export const dynamic = "force-dynamic";
import { getQqpkStakingOverview, getQqpkBlockHistory } from "@/lib/queries";
import PageHeader from "@/components/PageHeader";
import QqpkStakingClient from "./QqpkStakingClient";

export default async function QQPKPage() {
  const { rows } = getQqpkStakingOverview();
  const history = getQqpkBlockHistory();

  return (
    <>
      <PageHeader
        title="QQPK — Staking"
        subtitle="Cycle roulant par joueur (date d'onboarding +1 mois) · reset sec · 70/30"
      />
      <QqpkStakingClient rows={rows} history={history} />
    </>
  );
}
