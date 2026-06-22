export const dynamic = "force-dynamic";
import { getQqpkStakingOverview, getQqpkBlockHistory } from "@/lib/queries";
import { getCurrentMonthKey, parseMonthKey } from "@/lib/date-utils";
import PageHeader from "@/components/PageHeader";
import QqpkStakingClient from "./QqpkStakingClient";

// Last 12 calendar months (current first), anchored on the Paris current month.
function buildMonths(): { key: string; label: string }[] {
  const cur = parseMonthKey(getCurrentMonthKey());
  if (!cur) return [];
  const out: { key: string; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(cur.year, cur.month - 1 - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
    out.push({ key, label });
  }
  return out;
}

export default async function QQPKPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const params = await searchParams;
  const months = buildMonths();
  const month = params.month && parseMonthKey(params.month) ? params.month : getCurrentMonthKey();

  const { rows } = getQqpkStakingOverview(month);
  const history = getQqpkBlockHistory();
  const monthLabel = months.find((m) => m.key === month)?.label ?? month;

  return (
    <>
      <PageHeader
        title="QQPK — Staking"
        subtitle="Modèle C/T (makeup 70/30) · net on-chain mensuel · règlement par bloc"
      />
      <QqpkStakingClient
        month={month}
        monthLabel={monthLabel}
        months={months}
        rows={rows}
        history={history}
      />
    </>
  );
}
