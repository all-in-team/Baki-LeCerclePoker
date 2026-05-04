export const dynamic = "force-dynamic";
import { getTelePlayers, getSetting } from "@/lib/queries";
import { getChinaWeekBounds, getLast12Weeks, toISODateTime, formatRangeLabel, isoWeekToOffset } from "@/lib/date-utils";
import PageHeader from "@/components/PageHeader";
import TELEClient from "./TELEClient";

function computeFilter(filter: string | undefined) {
  const f = filter ?? "current";

  if (f === "lifetime") {
    return { key: "lifetime", startDate: undefined, endDate: undefined, rangeLabel: "Toutes les transactions" };
  }

  if (f === "30d") {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    return {
      key: "30d",
      startDate: toISODateTime(start),
      endDate: toISODateTime(end),
      rangeLabel: formatRangeLabel(start, end),
    };
  }

  if (f === "last") {
    const { start, end } = getChinaWeekBounds(-1);
    return {
      key: "last",
      startDate: toISODateTime(start),
      endDate: toISODateTime(end),
      rangeLabel: formatRangeLabel(start, end),
    };
  }

  // ISO week format: 2026-W18
  if (/^\d{4}-W\d{2}$/.test(f)) {
    const offset = isoWeekToOffset(f);
    if (offset !== null && offset < 0) {
      const { start, end } = getChinaWeekBounds(offset);
      return {
        key: f,
        startDate: toISODateTime(start),
        endDate: toISODateTime(end),
        rangeLabel: formatRangeLabel(start, end),
      };
    }
  }

  // Default: current week — label shows full Mon→Sun, SQL caps to now
  const { start, end } = getChinaWeekBounds(0);
  const now = new Date();
  return {
    key: "current",
    startDate: toISODateTime(start),
    endDate: toISODateTime(now < end ? now : end),
    rangeLabel: formatRangeLabel(start, end),
  };
}

export default async function TELEPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const params = await searchParams;
  const { key, startDate, endDate, rangeLabel } = computeFilter(params.filter);
  const players = getTelePlayers(startDate, endDate);
  const walletMere = getSetting("tele_wallet_mere");
  const weeks = getLast12Weeks();

  return (
    <>
      <PageHeader
        title="TELE — Wallets"
        subtitle="Vue & vérification des adresses par joueur — WALLET GAME · WALLET CASHOUT · WALLET MÈRE"
      />
      <TELEClient
        players={players}
        walletMere={walletMere}
        activeFilter={key}
        rangeLabel={rangeLabel}
        weeks={weeks.map(w => ({ isoWeek: w.isoWeek, label: w.label }))}
      />
    </>
  );
}
