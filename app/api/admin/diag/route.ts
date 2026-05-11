export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getWalletSummaryByPlayer } from "@/lib/queries";
import { executeTool } from "@/lib/agent-tools";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token || req.headers.get("x-admin-token") !== token)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const playerIds = [1, 4, 8, 12, 17]; // Hugo, Nathan, Slava, Florent, Antoine
  const dashboard = getWalletSummaryByPlayer() as any[];

  const results: any[] = [];
  for (const pid of playerIds) {
    const playerRows = dashboard.filter((r: any) => r.player_id === pid);
    const dashNet = playerRows.reduce((s: number, r: any) => s + (r.net ?? 0), 0);
    const dashMyPnl = playerRows.reduce((s: number, r: any) => s + (r.my_pnl ?? 0), 0);
    const playerName = playerRows[0]?.player_name ?? `player_${pid}`;

    const toolOutput = await executeTool("get_player_detail", { query: playerName });
    const netMatch = toolOutput.match(/Total: net ([+\-−]?[\d.]+)/);
    const pnlMatch = toolOutput.match(/mon P&L ([+\-−]?[\d.]+)/);

    results.push({
      player_id: pid,
      name: playerName,
      dashboard_net: Math.round(dashNet * 100) / 100,
      dashboard_my_pnl: Math.round(dashMyPnl * 100) / 100,
      tool_net_raw: netMatch?.[1] ?? "NOT_FOUND",
      tool_pnl_raw: pnlMatch?.[1] ?? "NOT_FOUND",
    });
  }

  return NextResponse.json({ results });
}
