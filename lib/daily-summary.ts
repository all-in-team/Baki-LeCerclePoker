import { getDb } from "./db";
import { sendMsg, AGENT_CHAT_ID } from "./telegram-commands/helpers";
import { getWeekBounds, toUTCISO, toParisDate } from "./date-utils";
import { getCurrentWeekStart } from "./telegram-commands/cashout-reminder";
import { todayCost } from "./agent-cost";

function sign(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(0);
}

export async function sendDailySummary(): Promise<void> {
  const db = getDb();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const yesterdayTx = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END), 0) AS deposits,
      COALESCE(SUM(CASE WHEN type='withdrawal' THEN amount ELSE 0 END), 0) AS withdrawals,
      COUNT(*) AS tx_count
    FROM wallet_transactions
    WHERE date(created_at) = ? AND (source IS NULL OR source != 'unknown')
  `).get(yesterdayStr) as { deposits: number; withdrawals: number; tx_count: number };

  const yesterdayPnl = db.prepare(`
    SELECT COALESCE(SUM(
      CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END
    * pgd.action_pct / 100.0), 0) AS my_pnl
    FROM wallet_transactions wt
    JOIN player_game_deals pgd ON pgd.player_id = wt.player_id AND pgd.game_id = wt.game_id
    WHERE date(wt.created_at) = ? AND (wt.source IS NULL OR wt.source != 'unknown')
  `).get(yesterdayStr) as { my_pnl: number };

  const { start, end } = getWeekBounds(0);
  const weekSince = toUTCISO(start);
  const weekUntil = toUTCISO(end);
  const weekKpis = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN wt.type='deposit' THEN wt.amount ELSE 0 END), 0) AS deposited,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE 0 END), 0) AS withdrawn,
      COALESCE(SUM(
        CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END
      * pgd.action_pct / 100.0), 0) AS my_pnl
    FROM wallet_transactions wt
    JOIN player_game_deals pgd ON pgd.player_id = wt.player_id AND pgd.game_id = wt.game_id
    WHERE wt.tx_datetime >= ? AND wt.tx_datetime <= ?
      AND (wt.source IS NULL OR wt.source != 'unknown')
  `).get(weekSince, weekUntil) as { deposited: number; withdrawn: number; my_pnl: number };

  const activeCount = (db.prepare(
    `SELECT COUNT(*) AS n FROM players WHERE status = 'active'`
  ).get() as { n: number }).n;

  const recentLeads = (db.prepare(
    `SELECT COUNT(*) AS n FROM onboarding_leads WHERE created_at >= date('now', '-7 days')`
  ).get() as { n: number }).n;

  const weekStart = getCurrentWeekStart();
  const cashoutStatus = db.prepare(`
    SELECT
      COALESCE(SUM(cashout_confirmed = 1), 0) AS confirmed,
      COALESCE(SUM(not_played = 1), 0) AS not_played,
      COALESCE(SUM(cashout_confirmed = 0 AND not_played = 0), 0) AS pending
    FROM weekly_cashout_state WHERE week_start = ?
  `).get(weekStart) as { confirmed: number; not_played: number; pending: number };

  const yesterdayCost = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS calls
    FROM agent_usage WHERE date(created_at) = ?
  `).get(yesterdayStr) as { cost: number; calls: number };

  const lines = [
    `📊 <b>Résumé quotidien — ${yesterdayStr}</b>`,
    ``,
    `<b>Hier</b>`,
    `💰 Dépôts: ${yesterdayTx.deposits.toFixed(0)} · Retraits: ${yesterdayTx.withdrawals.toFixed(0)} USDT (${yesterdayTx.tx_count} tx)`,
    `📈 Mon P&L hier: ${sign(yesterdayPnl.my_pnl)} USDT`,
    ``,
    `<b>Semaine en cours</b> (${toParisDate(weekSince)} → ${toParisDate(weekUntil)})`,
    `💰 Dépôts: ${weekKpis.deposited.toFixed(0)} · Retraits: ${weekKpis.withdrawn.toFixed(0)} USDT`,
    `📈 Mon P&L semaine: ${sign(weekKpis.my_pnl)} USDT`,
    ``,
    `<b>Cashout</b>`,
    `✅ ${cashoutStatus.confirmed} · ⏸️ ${cashoutStatus.not_played} · ⏳ ${cashoutStatus.pending}`,
    ``,
    `<b>Ops</b>`,
    `👥 ${activeCount} joueurs actifs · 🆕 ${recentLeads} leads (7j) · 🤖 Claude hier: $${yesterdayCost.cost.toFixed(3)}`,
    ``,
    `🔗 <a href="https://lecerclepoker-production.up.railway.app">Dashboard</a>`,
  ];

  await sendMsg(AGENT_CHAT_ID, lines.join("\n"));
}
