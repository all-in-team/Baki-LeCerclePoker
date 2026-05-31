import { getDb } from "../lib/db";
import { getPlayerBalance, toUsdt } from "../lib/queries";

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

function getAllPlayerIds(): { id: number; name: string }[] {
  const db = getDb();
  return db.prepare(`SELECT id, name FROM players ORDER BY name`).all() as { id: number; name: string }[];
}

const TOLERANCE = 5;

function main() {
  const allPlayers = getAllPlayerIds();
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

  const header = [
    pad("Player", 20),
    pad("Legacy (USDT)", 15),
    pad("New reports", 15),
    pad("New wallets", 15),
    pad("New total", 15),
    pad("Diff (L vs NR)", 16),
    "Flag",
  ].join(" | ");

  const sep = "-".repeat(header.length);

  console.log("\n=== LeCerclePoker Accounting Reconciliation ===\n");
  console.log(header);
  console.log(sep);

  let totalChecked = 0;
  let withinTolerance = 0;
  let overTolerance = 0;
  let totalAbsDrift = 0;
  const flagged: string[] = [];

  for (const p of allPlayers) {
    const leg = legacy.get(p.id);
    const nw = newMap.get(p.id);

    const legacyVal = leg?.net_usdt ?? 0;
    const reportsVal = nw?.reports_usdt ?? 0;
    const walletsVal = nw?.wallets_usdt ?? 0;
    const totalVal = nw?.total_usdt ?? 0;

    if (legacyVal === 0 && totalVal === 0) continue;

    totalChecked++;
    const diff = legacyVal - reportsVal;
    const absDiff = Math.abs(diff);
    totalAbsDrift += absDiff;
    const flag = absDiff > TOLERANCE ? "  !!!" : "";

    if (absDiff > TOLERANCE) {
      overTolerance++;
      flagged.push(`${p.name}: diff $${absDiff.toFixed(2)}`);
    } else {
      withinTolerance++;
    }

    console.log([
      pad(p.name, 20),
      pad(fmt(legacyVal), 15),
      pad(fmt(reportsVal), 15),
      pad(fmt(walletsVal), 15),
      pad(fmt(totalVal), 15),
      pad(fmt(diff), 16),
      flag,
    ].join(" | "));
  }

  console.log(sep);
  console.log(`\n=== Summary ===`);
  console.log(`  Players checked:       ${totalChecked}`);
  console.log(`  Within $${TOLERANCE} tolerance:  ${withinTolerance}`);
  console.log(`  Over $${TOLERANCE} tolerance:    ${overTolerance}`);
  console.log(`  Total absolute drift:  $${totalAbsDrift.toFixed(2)} USDT`);

  if (flagged.length > 0) {
    console.log(`\n  Flagged players:`);
    for (const f of flagged) console.log(`    - ${f}`);
  }

  console.log();
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

main();
