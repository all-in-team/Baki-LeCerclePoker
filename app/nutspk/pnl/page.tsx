export const dynamic = "force-dynamic";
import { getDb } from "@/lib/db";
import { getLockAwareSummaryByPlayer, getLockAwareKPIsWithExtras, getWalletTransactions, getPlayers, getGames, getPlayerCashouts, getPlayerGameWallets, getWalletMeresForGame, getNetPnlSeries } from "@/lib/queries";
import { getWeekBounds, getLast12Weeks, toUTCISO, toParisDate, formatRangeLabel, isoWeekToOffset, parisLocalToUTC } from "@/lib/date-utils";
import PageHeader from "@/components/PageHeader";
import TELEClient from "@/app/akpoker/pnl/TELEClient";
import AgencyExtras from "@/components/AgencyExtras";

function computeFilter(filter: string | undefined) {
  const f = filter ?? "current";
  if (f === "lifetime") return { key: "lifetime", startDate: undefined, endDate: undefined, rangeLabel: "Toutes les transactions" };
  if (f === "30d") {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86400000);
    return { key: "30d", startDate: toUTCISO(start), endDate: toUTCISO(end), rangeLabel: formatRangeLabel(start, end) };
  }
  if (f === "last") {
    const { start, end } = getWeekBounds(-1);
    return { key: "last", startDate: toUTCISO(start), endDate: toUTCISO(end), rangeLabel: formatRangeLabel(start, end) };
  }
  if (/^\d{4}-W\d{2}$/.test(f)) {
    const offset = isoWeekToOffset(f);
    if (offset !== null && offset < 0) {
      const { start, end } = getWeekBounds(offset);
      return { key: f, startDate: toUTCISO(start), endDate: toUTCISO(end), rangeLabel: formatRangeLabel(start, end) };
    }
  }
  if (f.startsWith("custom:")) {
    const parts = f.slice(7).split("~");
    if (parts.length === 2) {
      const [sd, ed] = parts;
      const sm = sd.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
      const em = ed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
      if (sm && em) {
        const start = parisLocalToUTC(+sm[1], +sm[2], +sm[3], +sm[4], +sm[5], 0, 0);
        const end = parisLocalToUTC(+em[1], +em[2], +em[3], +em[4], +em[5], 59, 0);
        if (end >= start) {
          return { key: f, startDate: toUTCISO(start), endDate: toUTCISO(end), rangeLabel: `${sd.replace("T", " ")} → ${ed.replace("T", " ")} (Paris)` };
        }
      }
    }
  }
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
    return { key: f, startDate: toUTCISO(bounds.start), endDate: toUTCISO(bounds.end), rangeLabel: formatRangeLabel(bounds.start, bounds.end) };
  }
  const { start, end } = getWeekBounds(0);
  const now = new Date();
  return { key: "current", startDate: toUTCISO(start), endDate: toUTCISO(now < end ? now : end), rangeLabel: formatRangeLabel(start, end) };
}

export default async function NUTSPKPage({ searchParams }: { searchParams: Promise<{ filter?: string; player?: string }> }) {
  const params = await searchParams;
  const playerFilter = params.player ? parseInt(params.player) : undefined;
  const { key, startDate, endDate, rangeLabel } = computeFilter(params.filter);
  const weeks = getLast12Weeks();

  const filters = { game_name: "NUTSPK" as const, since_date: startDate, end_date: endDate };
  let summary = getLockAwareSummaryByPlayer(filters) as any[];
  // my_total_pnl includes agency extras (game-level wins/losses outside deals)
  let kpis = getLockAwareKPIsWithExtras(filters, "nutspk");
  let transactions = getWalletTransactions({ ...filters, limit: 500 }) as any[];

  if (playerFilter) {
    summary = summary.filter((r: any) => r.player_id === playerFilter);
    transactions = transactions.filter((t: any) => t.player_id === playerFilter);
    // per-player view: extras are agency-level (no player_id) → excluded here
    kpis = {
      total_deposited: summary.reduce((s: number, r: any) => s + (r.total_deposited ?? 0), 0),
      total_withdrawn: summary.reduce((s: number, r: any) => s + (r.total_withdrawn ?? 0), 0),
      total_net: summary.reduce((s: number, r: any) => s + (r.net ?? 0), 0),
      my_total_pnl: summary.reduce((s: number, r: any) => s + (r.my_pnl ?? 0), 0),
      extras_net: 0,
    };
  }

  const netSeries = getNetPnlSeries({ ...filters, player_id: playerFilter }) as { day: string; cumulative_net: number }[];

  const players = getPlayers() as any[];
  const games = (getGames() as any[]).filter((g) => g.name === "NUTSPK");
  const nutspkGameId = (getDb().prepare(`SELECT id FROM games WHERE name = 'NUTSPK'`).get() as { id: number } | undefined)?.id;
  const walletMeres = nutspkGameId ? getWalletMeresForGame(nutspkGameId) : [];

  const cashoutsByPlayer: Record<number, { id: number; address: string; label: string | null }[]> = {};
  const gameWalletsByPlayer: Record<number, { id: number; address: string; label: string | null }[]> = {};
  for (const p of players) {
    cashoutsByPlayer[p.id] = nutspkGameId ? getPlayerCashouts(p.id, nutspkGameId) : [];
    gameWalletsByPlayer[p.id] = nutspkGameId ? getPlayerGameWallets(p.id, nutspkGameId) : [];
  }

  const filterPlayerName = playerFilter ? (players.find((p: any) => p.id === playerFilter)?.name ?? `#${playerFilter}`) : null;

  return (
    <>
      <PageHeader
        title="NUTSPK — P&L"
        subtitle="Dépôts & retraits par joueur — P&L calculé selon le deal de chaque joueur"
      />
      {filterPlayerName && (
        <div style={{ padding: "0 28px 12px", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ background: "rgba(212,175,55,0.15)", color: "#D4AF37", padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
            Filtré : {filterPlayerName}
          </span>
          <a href="/nutspk/pnl" style={{ fontSize: 11, color: "var(--text-muted)", textDecoration: "none" }}>✕ Retirer le filtre</a>
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
        basePath="/nutspk/pnl"
        gameLabel="NUTSPK"
        useLegacyWalletFallback={false}
        gameId={nutspkGameId ?? 0}
        netSeries={netSeries}
      />
      <AgencyExtras gameKey="nutspk" />
    </>
  );
}
