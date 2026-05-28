import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(req: NextRequest) {
  const from = req.nextUrl.searchParams.get("from") ?? "2020-01-01";
  const to = req.nextUrl.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
  const db = getDb();

  const grinders = db.prepare(`
    SELECT gg.player_id, p.name FROM grindhouse_grinders gg JOIN players p ON p.id = gg.player_id WHERE gg.status = 'active'
  `).all() as { player_id: number; name: string }[];

  let totalSessionsPnl = 0;
  let totalGrindFeesAttributed = 0;
  let totalGrinderShare = 0;
  let totalHours = 0;
  const breakdown: any[] = [];

  for (const g of grinders) {
    const pnl = (db.prepare(`SELECT COALESCE(SUM(net_result_usdt), 0) AS v FROM grindhouse_sessions WHERE player_id = ? AND session_date >= ? AND session_date <= ?`).get(g.player_id, from, to) as any).v;
    const hours = (db.prepare(`SELECT COALESCE(SUM(duration_hours), 0) AS v FROM grindhouse_sessions WHERE player_id = ? AND session_date >= ? AND session_date <= ?`).get(g.player_id, from, to) as any).v;
    const grindFees = (db.prepare(`SELECT COALESCE(SUM(amount_usdt), 0) AS v FROM grindhouse_expenses WHERE player_id = ? AND type = 'grind' AND date >= ? AND date <= ?`).get(g.player_id, from, to) as any).v;
    const poolNet = pnl - grindFees;
    const share = poolNet * 0.5;

    totalSessionsPnl += pnl;
    totalGrindFeesAttributed += grindFees;
    totalGrinderShare += share;
    totalHours += hours;
    breakdown.push({ player_id: g.player_id, name: g.name, hours, sessions_pnl: pnl, grind_fees: grindFees, pool_net: poolNet, grinder_share: share, agency_share: poolNet - share });
  }

  const generalGrindFees = (db.prepare(`SELECT COALESCE(SUM(amount_usdt), 0) AS v FROM grindhouse_expenses WHERE player_id IS NULL AND type = 'grind' AND date >= ? AND date <= ?`).get(from, to) as any).v;
  const restoFees = (db.prepare(`SELECT COALESCE(SUM(amount_usdt), 0) AS v FROM grindhouse_expenses WHERE type = 'resto' AND date >= ? AND date <= ?`).get(from, to) as any).v;
  const autreFees = (db.prepare(`SELECT COALESCE(SUM(amount_usdt), 0) AS v FROM grindhouse_expenses WHERE type = 'autre' AND date >= ? AND date <= ?`).get(from, to) as any).v;

  const agencyBrute = totalSessionsPnl - totalGrindFeesAttributed - totalGrinderShare;
  const agencyNet = agencyBrute - generalGrindFees - restoFees - autreFees;

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
    breakdown,
  });
}
