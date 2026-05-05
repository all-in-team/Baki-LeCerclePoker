export const dynamic = "force-dynamic";
import { getWalletTransactions, getPlayers, getGames, getPlayerCashouts, getPlayerGameWallets, getWalletMeres, getLockAwareSummaryByPlayer, getLockAwareKPIs } from "@/lib/queries";
import { getWeekBounds, getLast12Weeks, toUTCISO, toParisDate, formatRangeLabel, isoWeekToOffset } from "@/lib/date-utils";
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
      startDate: toUTCISO(start),
      endDate: toUTCISO(end),
      rangeLabel: formatRangeLabel(start, end),
    };
  }

  if (f === "last") {
    const { start, end } = getWeekBounds(-1);
    return {
      key: "last",
      startDate: toUTCISO(start),
      endDate: toUTCISO(end),
      rangeLabel: formatRangeLabel(start, end),
    };
  }

  // ISO week format: 2026-W18
  if (/^\d{4}-W\d{2}$/.test(f)) {
    const offset = isoWeekToOffset(f);
    if (offset !== null && offset < 0) {
      const { start, end } = getWeekBounds(offset);
      return {
        key: f,
        startDate: toUTCISO(start),
        endDate: toUTCISO(end),
        rangeLabel: formatRangeLabel(start, end),
      };
    }
  }

  // Date format: 2026-04-27 (Monday of the week)
  if (/^\d{4}-\d{2}-\d{2}$/.test(f)) {
    const target = new Date(f + "T00:00:00Z");
    const { start: currentWeekStart } = getWeekBounds(0);
    const currentMonday = new Date(toParisDate(toUTCISO(currentWeekStart)) + "T00:00:00Z");
    let offset = Math.round((target.getTime() - currentMonday.getTime()) / (7 * 86400000));
    let bounds = getWeekBounds(offset);
    if (toParisDate(toUTCISO(bounds.start)) !== f) {
      offset += toParisDate(toUTCISO(bounds.start)) < f ? 1 : -1;
      bounds = getWeekBounds(offset);
    }
    return {
      key: f,
      startDate: toUTCISO(bounds.start),
      endDate: toUTCISO(bounds.end),
      rangeLabel: formatRangeLabel(bounds.start, bounds.end),
    };
  }

  // Default: current week — label shows full Mon→Sun, SQL caps to now
  const { start, end } = getWeekBounds(0);
  const now = new Date();
  return {
    key: "current",
    startDate: toUTCISO(start),
    endDate: toUTCISO(now < end ? now : end),
    rangeLabel: formatRangeLabel(start, end),
  };
}

export default async function TELEPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const params = await searchParams;
  const { key, startDate, endDate, rangeLabel } = computeFilter(params.filter);
  const weeks = getLast12Weeks();

  const filters = { game_name: "TELE" as const, since_date: startDate, end_date: endDate };
  const summary = getLockAwareSummaryByPlayer(filters) as any[];
  const kpis = getLockAwareKPIs(filters) ?? { total_deposited: 0, total_withdrawn: 0, total_net: 0, my_total_pnl: 0 };
  const transactions = getWalletTransactions({ ...filters, limit: 500 }) as any[];
  const players = getPlayers() as any[];
  const games = (getGames() as any[]).filter((g) => g.name === "TELE");
  const walletMeres = getWalletMeres();

  const cashoutsByPlayer: Record<number, { id: number; address: string; label: string | null }[]> = {};
  const gameWalletsByPlayer: Record<number, { id: number; address: string; label: string | null }[]> = {};
  for (const p of players) {
    cashoutsByPlayer[p.id] = getPlayerCashouts(p.id);
    gameWalletsByPlayer[p.id] = getPlayerGameWallets(p.id);
  }

  return (
    <>
      <PageHeader
        title="TELE AKPOKER"
        subtitle="Dépôts & retraits par joueur — P&L calculé selon le deal de chaque joueur"
      />
      <TELEClient
        initialSummary={summary}
        kpis={kpis}
        initialTransactions={transactions}
        players={players}
        games={games}
        cashoutsByPlayer={cashoutsByPlayer}
        gameWalletsByPlayer={gameWalletsByPlayer}
        walletMeres={walletMeres}
        activeFilter={key}
        rangeLabel={rangeLabel}
        weeks={weeks.map(w => ({ isoWeek: w.isoWeek, label: w.label }))}
      />
    </>
  );
}
