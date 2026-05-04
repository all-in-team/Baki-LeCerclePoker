import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getPlayerBalance, toUsdt } from "@/lib/queries";

const TOLERANCE = 5;

interface LegacyRow {
  player_id: number;
  player_name: string;
  app_currency: string;
  my_net: number;
}

function getLegacyBalances(): Map<number, { name: string; net_usdt: number }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      ae.player_id,
      p.name AS player_name,
      pa.currency AS app_currency,
      COALESCE(SUM(ae.my_net), 0) AS my_net
    FROM accounting_entries ae
    JOIN players p ON p.id = ae.player_id
    JOIN poker_apps pa ON pa.id = ae.app_id
    WHERE ae.player_id IS NOT NULL
    GROUP BY ae.player_id, pa.currency
  `).all() as LegacyRow[];

  const map = new Map<number, { name: string; net_usdt: number }>();
  for (const r of rows) {
    const existing = map.get(r.player_id);
    const usdt = toUsdt(r.my_net, r.app_currency);
    if (existing) {
      existing.net_usdt += usdt;
    } else {
      map.set(r.player_id, { name: r.player_name, net_usdt: usdt });
    }
  }
  return map;
}

export async function GET(req: Request) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "ADMIN_RECONCILE_TOKEN env var is not set on the server" },
      { status: 503 }
    );
  }

  const provided = req.headers.get("x-admin-token");
  if (provided !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const allPlayers = db.prepare(`SELECT id, name FROM players ORDER BY name`).all() as { id: number; name: string }[];
  const legacy = getLegacyBalances();

  const newBalances = getPlayerBalance();
  const newMap = new Map<number, { total_usdt: number; reports_usdt: number; wallets_usdt: number }>();
  for (const pb of newBalances) {
    let reports_usdt = 0;
    let wallets_usdt = 0;
    for (const g of pb.games) {
      reports_usdt += g.winnings_player_usdt + g.rakeback_player_usdt;
      wallets_usdt += g.wallet_withdrawn_usdt - g.wallet_deposited_usdt;
    }
    newMap.set(pb.player_id, { total_usdt: pb.total_usdt, reports_usdt, wallets_usdt });
  }

  let totalChecked = 0;
  let withinTolerance = 0;
  let overTolerance = 0;
  let totalAbsDrift = 0;

  const players: {
    player_id: number;
    name: string;
    legacy_usdt: number;
    new_reports_usdt: number;
    new_wallets_usdt: number;
    new_total_usdt: number;
    diff: number;
    flagged: boolean;
  }[] = [];

  for (const p of allPlayers) {
    const leg = legacy.get(p.id);
    const nw = newMap.get(p.id);

    const legacyVal = leg?.net_usdt ?? 0;
    const reportsVal = nw?.reports_usdt ?? 0;
    const walletsVal = nw?.wallets_usdt ?? 0;
    const totalVal = nw?.total_usdt ?? 0;

    if (legacyVal === 0 && totalVal === 0) continue;

    totalChecked++;
    const diff = Math.round((legacyVal - reportsVal) * 100) / 100;
    const absDiff = Math.abs(diff);
    totalAbsDrift += absDiff;

    const flagged = absDiff > TOLERANCE;
    if (flagged) overTolerance++;
    else withinTolerance++;

    players.push({
      player_id: p.id,
      name: p.name,
      legacy_usdt: Math.round(legacyVal * 100) / 100,
      new_reports_usdt: Math.round(reportsVal * 100) / 100,
      new_wallets_usdt: Math.round(walletsVal * 100) / 100,
      new_total_usdt: Math.round(totalVal * 100) / 100,
      diff,
      flagged,
    });
  }

  return NextResponse.json({
    summary: {
      tolerance_usdt: TOLERANCE,
      total_checked: totalChecked,
      within_tolerance: withinTolerance,
      over_tolerance: overTolerance,
      total_abs_drift_usdt: Math.round(totalAbsDrift * 100) / 100,
    },
    players,
  });
}
