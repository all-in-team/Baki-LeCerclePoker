export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  getPlayerDealsForGame,
  getAkpokerPnL,
  getWepokerPnL,
  getAgencyTotalPnL,
  getActivePlayersCount,
  getTopContributors,
  getPnLOverTime,
  getWalletSummaryByPlayer,
} from "@/lib/queries";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token || req.headers.get("x-admin-token") !== token)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const d7 = new Date(); d7.setDate(d7.getDate() - 7);
  const d30 = new Date(); d30.setDate(d30.getDate() - 30);
  const day7 = d7.toISOString().slice(0, 10);
  const day30 = d30.toISOString().slice(0, 10);

  const result: Record<string, any> = {};

  // Find Hugo (player_id=1)
  const hugoId = 1;
  result.hugo_akpoker = {
    deal: getPlayerDealsForGame(hugoId, "TELE"),
    pnl_all_time: getAkpokerPnL(hugoId),
    pnl_30d: getAkpokerPnL(hugoId, { from: day30, to: today }),
    pnl_7d: getAkpokerPnL(hugoId, { from: day7, to: today }),
  };

  // Cross-check: what does the current dashboard function return for Hugo?
  const dashboardRows = getWalletSummaryByPlayer({ game_name: "TELE" }) as any[];
  const hugoDashboard = dashboardRows.find((r: any) => r.player_id === hugoId);
  result.hugo_dashboard_crosscheck = hugoDashboard ? {
    net: hugoDashboard.net,
    my_pnl: hugoDashboard.my_pnl,
    deposited: hugoDashboard.total_deposited,
    withdrawn: hugoDashboard.total_withdrawn,
  } : null;

  // Find a WEPOKER player from rakeback_entries
  const wpPlayer = db.prepare(`
    SELECT DISTINCT re.player_id, p.name
    FROM rakeback_entries re
    JOIN players p ON p.id = re.player_id
    WHERE re.player_id IS NOT NULL
    LIMIT 1
  `).get() as { player_id: number; name: string } | undefined;

  if (wpPlayer) {
    result.wepoker_player = {
      id: wpPlayer.player_id,
      name: wpPlayer.name,
      deal: getPlayerDealsForGame(wpPlayer.player_id, "Wepoker"),
      pnl_all_time: getWepokerPnL(wpPlayer.player_id),
    };

    // Cross-check: raw rakeback_entries for this player
    const rawEntries = db.prepare(`
      SELECT re.amount AS rake, re.insurance_amount AS insurance, re.winnings_amount AS winnings, re.currency
      FROM rakeback_entries re
      JOIN rakeback_reports rr ON rr.id = re.report_id
      WHERE re.player_id = ?
    `).all(wpPlayer.player_id) as any[];
    const rawTotals = rawEntries.reduce((acc: any, r: any) => ({
      rake: acc.rake + r.rake,
      insurance: acc.insurance + r.insurance,
      winnings: acc.winnings + r.winnings,
    }), { rake: 0, insurance: 0, winnings: 0 });
    result.wepoker_raw_crosscheck = { entries: rawEntries.length, totals: rawTotals };
  } else {
    result.wepoker_player = "NO WEPOKER PLAYERS FOUND";
  }

  // Agency totals
  result.agency_total = {
    all_time: getAgencyTotalPnL(),
    last_30d: getAgencyTotalPnL({ from: day30, to: today }),
    last_7d: getAgencyTotalPnL({ from: day7, to: today }),
  };

  // Active players
  result.active_players_7d = getActivePlayersCount({ from: day7, to: today });
  result.active_players_30d = getActivePlayersCount({ from: day30, to: today });

  // Top contributors
  result.top_contributors_30d = getTopContributors({ from: day30, to: today }, 5);

  // P&L over time (last 30d, first 5 + last 5 rows)
  const timeline = getPnLOverTime({ from: day30, to: today });
  result.pnl_timeline = {
    total_days: timeline.length,
    first_5: timeline.slice(0, 5),
    last_5: timeline.slice(-5),
  };

  return NextResponse.json(result, { status: 200 });
}
