import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// NOTE: getGrindhouseAgencyNet() in lib/queries.ts (war room net worth) replicates the
// agency_net formula below in aggregate form. Any change to the split or fee logic here
// MUST be mirrored there, or the war room total silently diverges from this dashboard.
//
// CURRENCY RULE (invariant #3): the waterfall (pool, shares, fees → agency_net) is
// USDT-only — sessions of non-USDT games are reported separately in `by_currency`
// (50/50 split on raw pnl, no fee attribution since expenses are USDT) and are NEVER
// summed with USDT amounts. No FX conversion (Phase 2).
export async function GET(req: NextRequest) {
  const from = req.nextUrl.searchParams.get("from") ?? "2020-01-01";
  const to = req.nextUrl.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
  const db = getDb();

  const grinders = db.prepare(`
    SELECT gg.player_id, p.name FROM grindhouse_grinders gg JOIN players p ON p.id = gg.player_id WHERE gg.status = 'active'
  `).all() as { player_id: number; name: string }[];

  let totalSessionsPnl = 0;          // USDT only
  let totalGrindFeesAttributed = 0;  // USDT (expenses)
  let totalGrinderShare = 0;         // USDT only
  let totalHours = 0;                // all sessions, any currency
  let usdtHours = 0;                 // hours on USDT games (for $/h rate)
  const byCurrencyTotals = new Map<string, { sessions_pnl: number; hours: number }>();
  const breakdown: any[] = [];

  for (const g of grinders) {
    const perCur = db.prepare(`
      SELECT COALESCE(gm.currency, 'USDT') AS currency,
             COALESCE(SUM(s.net_result_usdt), 0) AS pnl,
             COALESCE(SUM(s.duration_hours), 0) AS hours
      FROM grindhouse_sessions s
      JOIN games gm ON gm.id = s.game_id
      WHERE s.player_id = ? AND s.session_date >= ? AND s.session_date <= ?
      GROUP BY currency
    `).all(g.player_id, from, to) as { currency: string; pnl: number; hours: number }[];

    const usdtRow = perCur.find(r => r.currency === "USDT");
    const pnl = usdtRow?.pnl ?? 0;
    const hours = perCur.reduce((s, r) => s + r.hours, 0);
    const otherCur = perCur.filter(r => r.currency !== "USDT");

    const grindFees = (db.prepare(`SELECT COALESCE(SUM(amount_usdt), 0) AS v FROM grindhouse_expenses WHERE player_id = ? AND type = 'grind' AND date >= ? AND date <= ?`).get(g.player_id, from, to) as any).v;
    const poolNet = pnl - grindFees;
    const share = poolNet * 0.5;

    totalSessionsPnl += pnl;
    totalGrindFeesAttributed += grindFees;
    totalGrinderShare += share;
    totalHours += hours;
    usdtHours += usdtRow?.hours ?? 0;
    for (const r of otherCur) {
      const t = byCurrencyTotals.get(r.currency) ?? { sessions_pnl: 0, hours: 0 };
      t.sessions_pnl += r.pnl;
      t.hours += r.hours;
      byCurrencyTotals.set(r.currency, t);
    }
    breakdown.push({
      player_id: g.player_id, name: g.name, hours,
      sessions_pnl: pnl, grind_fees: grindFees, pool_net: poolNet,
      grinder_share: share, agency_share: poolNet - share,
      by_currency: otherCur.map(r => ({ currency: r.currency, pnl: r.pnl, hours: r.hours })),
    });
  }

  const generalGrindFees = (db.prepare(`SELECT COALESCE(SUM(amount_usdt), 0) AS v FROM grindhouse_expenses WHERE player_id IS NULL AND type = 'grind' AND date >= ? AND date <= ?`).get(from, to) as any).v;
  const restoFees = (db.prepare(`SELECT COALESCE(SUM(amount_usdt), 0) AS v FROM grindhouse_expenses WHERE type = 'resto' AND date >= ? AND date <= ?`).get(from, to) as any).v;
  const autreFees = (db.prepare(`SELECT COALESCE(SUM(amount_usdt), 0) AS v FROM grindhouse_expenses WHERE type = 'autre' AND date >= ? AND date <= ?`).get(from, to) as any).v;

  const agencyBrute = totalSessionsPnl - totalGrindFeesAttributed - totalGrinderShare;
  const agencyNet = agencyBrute - generalGrindFees - restoFees - autreFees;

  const perGame = db.prepare(`
    SELECT g.id AS game_id, g.name AS game_name, COALESCE(g.currency, 'USDT') AS currency,
      COALESCE(SUM(gs.duration_hours), 0) AS hours,
      COALESCE(SUM(gs.net_result_usdt), 0) AS pnl
    FROM grindhouse_sessions gs
    JOIN games g ON g.id = gs.game_id
    WHERE gs.session_date >= ? AND gs.session_date <= ?
    GROUP BY g.id ORDER BY pnl DESC
  `).all(from, to) as { game_id: number; game_name: string; currency: string; hours: number; pnl: number }[];

  return NextResponse.json({
    period: { from, to },
    total_sessions_pnl: totalSessionsPnl,
    total_grind_fees_attributed: totalGrindFeesAttributed,
    total_pool_net: totalSessionsPnl - totalGrindFeesAttributed,
    total_grinder_share: totalGrinderShare,
    agency_brute: agencyBrute,
    general_grind_fees: generalGrindFees,
    resto_fees: restoFees,
    autre_fees: autreFees,
    agency_net: agencyNet,
    total_hours: totalHours,
    usdt_hours: usdtHours,
    // non-USDT games, raw amounts per currency — displayed separately, never converted/merged
    by_currency: [...byCurrencyTotals.entries()].map(([currency, t]) => ({
      currency,
      sessions_pnl: t.sessions_pnl,
      hours: t.hours,
      grinder_share: t.sessions_pnl * 0.5,
      agency_share: t.sessions_pnl * 0.5,
    })),
    breakdown,
    per_game: perGame,
  });
}
