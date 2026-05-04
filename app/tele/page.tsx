export const dynamic = "force-dynamic";
import { getWalletSummaryByPlayer, getWalletKPIs, getWalletTransactions, getPlayers, getGames, getPlayerCashouts, getPlayerGameWallets, getWalletMeres } from "@/lib/queries";
import { getChinaWeekBounds, getLast12Weeks, toISODateTime, formatRangeLabel, isoWeekToOffset, toISODate } from "@/lib/date-utils";
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
      startDate: toISODate(start),
      endDate: toISODateTime(end),
      rangeLabel: formatRangeLabel(start, end),
    };
  }

  if (f === "last") {
    const { start, end } = getChinaWeekBounds(-1);
    return {
      key: "last",
      startDate: toISODate(start),
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
        startDate: toISODate(start),
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
    startDate: toISODate(start),
    endDate: toISODateTime(now < end ? now : end),
    rangeLabel: formatRangeLabel(start, end),
  };
}

export default async function TELEPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const params = await searchParams;
  const { key, startDate, endDate, rangeLabel } = computeFilter(params.filter);
  const weeks = getLast12Weeks();

  const filters = { game_name: "TELE" as const, since_date: startDate, end_date: endDate };
  const summary = getWalletSummaryByPlayer(filters) as any[];
  const kpis = getWalletKPIs(filters) ?? { total_deposited: 0, total_withdrawn: 0, total_net: 0, my_total_pnl: 0 };
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
