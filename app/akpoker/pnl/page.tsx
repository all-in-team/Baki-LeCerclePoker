export const dynamic = "force-dynamic";
import { getDb } from "@/lib/db";
import { getWalletTransactions, getPlayers, getGames, getPlayerCashouts, getPlayerGameWallets, getWalletMeresForGame, getLockAwareSummaryByPlayer, getLockAwareKPIs } from "@/lib/queries";
import { getWeekBounds, getLast12Weeks, toUTCISO, toParisDate, formatRangeLabel, isoWeekToOffset } from "@/lib/date-utils";
import PageHeader from "@/components/PageHeader";
import TELEClient from "./TELEClient";
import AgencyExtras from "@/components/AgencyExtras";

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

export default async function TELEPage({ searchParams }: { searchParams: Promise<{ filter?: string; player?: string }> }) {
  const params = await searchParams;
  const playerFilter = params.player ? parseInt(params.player) : undefined;
  const { key, startDate, endDate, rangeLabel } = computeFilter(params.filter);
  const weeks = getLast12Weeks();

  const filters = { game_name: "TELE" as const, since_date: startDate, end_date: endDate };
  let summary = getLockAwareSummaryByPlayer(filters) as any[];
  let kpis = getLockAwareKPIs(filters) ?? { total_deposited: 0, total_withdrawn: 0, total_net: 0, my_total_pnl: 0 };
  let transactions = getWalletTransactions({ ...filters, limit: 500 }) as any[];

  if (playerFilter) {
    summary = summary.filter((r: any) => r.player_id === playerFilter);
    transactions = transactions.filter((t: any) => t.player_id === playerFilter);
    const filtered = summary;
    kpis = {
      total_deposited: filtered.reduce((s: number, r: any) => s + (r.total_deposited ?? 0), 0),
      total_withdrawn: filtered.reduce((s: number, r: any) => s + (r.total_withdrawn ?? 0), 0),
      total_net: filtered.reduce((s: number, r: any) => s + (r.net ?? 0), 0),
      my_total_pnl: filtered.reduce((s: number, r: any) => s + (r.my_pnl ?? 0), 0),
    };
  }
  const players = getPlayers() as any[];
  const games = (getGames() as any[]).filter((g) => g.name === "TELE");
  const teleGameId = (getDb().prepare(`SELECT id FROM games WHERE name = 'TELE'`).get() as { id: number } | undefined)?.id;
  const walletMeres = teleGameId ? getWalletMeresForGame(teleGameId) : [];

  const cashoutsByPlayer: Record<number, { id: number; address: string; label: string | null }[]> = {};
  const gameWalletsByPlayer: Record<number, { id: number; address: string; label: string | null }[]> = {};
  for (const p of players) {
    cashoutsByPlayer[p.id] = getPlayerCashouts(p.id);
    gameWalletsByPlayer[p.id] = getPlayerGameWallets(p.id);
  }

  const filterPlayerName = playerFilter ? (players.find((p: any) => p.id === playerFilter)?.name ?? `#${playerFilter}`) : null;

  return (
    <>
      <PageHeader
        title="AKPOKER — P&L"
        subtitle="Dépôts & retraits par joueur — P&L calculé selon le deal de chaque joueur"
      />
      {filterPlayerName && (
        <div style={{ padding: "0 28px 12px", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ background: "rgba(212,175,55,0.15)", color: "#D4AF37", padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
            Filtré : {filterPlayerName}
          </span>
          <a href="/akpoker/pnl" style={{ fontSize: 11, color: "var(--text-muted)", textDecoration: "none" }}>✕ Retirer le filtre</a>
        </div>
      )}
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
        archived
        gameId={teleGameId ?? 1}
      />
      <AgencyExtras gameKey="akpoker" />
    </>
  );
}
