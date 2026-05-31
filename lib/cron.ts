import cron from "node-cron";
import {
  sendInitialReminders,
  sendEscalationReminders,
  sendFinalAlert,
  getCurrentWeekStart,
} from "./telegram-commands/cashout-reminder";
import { notifyOps } from "./ops-notifications";
import { getDb } from "./db";

const TZ = "Europe/Paris";
const opts = { timezone: TZ };

let initialized = false;

export function initCronJobs() {
  if (initialized) return;
  initialized = true;

  // Daily summary at 9h Paris — always on, not gated by CASHOUT_CRONS_ENABLED
  cron.schedule("0 9 * * *", async () => {
    console.log("[CRON] daily-summary firing");
    try {
      const { sendDailySummary } = await import("./daily-summary");
      await sendDailySummary();
      console.log("[CRON] daily-summary sent");
    } catch (e: any) {
      console.error("[CRON] daily-summary failed:", e);
    }
  }, opts);

  console.log("[CRON] daily-summary registered (9h Paris, every day)");

  // Onboarding auto-reminders — every 30 min
  if (process.env.ONBOARDING_REMINDERS_ENABLED !== "false") {
    cron.schedule("*/30 * * * *", async () => {
      console.log("[CRON] onboarding-reminders firing");
      try {
        const { runOnboardingReminders } = await import("./onboarding-reminders");
        const results = await runOnboardingReminders();
        console.log("[CRON] onboarding-reminders done:", results.length, "actions");
      } catch (e: any) {
        console.error("[CRON] onboarding-reminders failed:", e);
      }
    }, opts);
    console.log("[CRON] onboarding-reminders registered (every 30 min)");
  } else {
    console.log("[CRON] onboarding-reminders DISABLED");
  }

  if (process.env.CASHOUT_CRONS_ENABLED !== "true") {
    console.log("[CRON] cashout crons DISABLED (set CASHOUT_CRONS_ENABLED=true to enable)");
    return;
  }

  // Sunday 12h00 — initial cashout reminder
  cron.schedule("0 12 * * 0", async () => {
    console.log("[CRON] cashout-reminder-initial firing");
    const result = await sendInitialReminders();
    console.log("[CRON] cashout-reminder-initial done:", result);
  }, opts);

  // Sunday 20h00 — first escalation
  cron.schedule("0 20 * * 0", async () => {
    console.log("[CRON] cashout-escalation 20h00 firing");
    const result = await sendEscalationReminders();
    console.log("[CRON] cashout-escalation 20h00 done:", result);
  }, opts);

  // Sunday 20h30
  cron.schedule("30 20 * * 0", async () => {
    console.log("[CRON] cashout-escalation 20h30 firing");
    const result = await sendEscalationReminders();
    console.log("[CRON] cashout-escalation 20h30 done:", result);
  }, opts);

  // Sunday 21h00
  cron.schedule("0 21 * * 0", async () => {
    console.log("[CRON] cashout-escalation 21h00 firing");
    const result = await sendEscalationReminders();
    console.log("[CRON] cashout-escalation 21h00 done:", result);
  }, opts);

  // Sunday 21h30
  cron.schedule("30 21 * * 0", async () => {
    console.log("[CRON] cashout-escalation 21h30 firing");
    const result = await sendEscalationReminders();
    console.log("[CRON] cashout-escalation 21h30 done:", result);
  }, opts);

  // Sunday 22h00
  cron.schedule("0 22 * * 0", async () => {
    console.log("[CRON] cashout-escalation 22h00 firing");
    const result = await sendEscalationReminders();
    console.log("[CRON] cashout-escalation 22h00 done:", result);
  }, opts);

  // Sunday 22h30
  cron.schedule("30 22 * * 0", async () => {
    console.log("[CRON] cashout-escalation 22h30 firing");
    const result = await sendEscalationReminders();
    console.log("[CRON] cashout-escalation 22h30 done:", result);
  }, opts);

  // Sunday 23h00 — final escalation + ops alert
  cron.schedule("0 23 * * 0", async () => {
    console.log("[CRON] cashout-final-alert firing");
    const escalation = await sendEscalationReminders();
    const alert = await sendFinalAlert();
    console.log("[CRON] cashout-final-alert done:", { escalation, alert });
  }, opts);

  // Sunday 14h, 16h, 18h — 6h pending cashout alert
  cron.schedule("0 14,16,18 * * 0", async () => {
    console.log("[CRON] 6h-pending-check firing");
    try {
      const weekStart = getCurrentWeekStart();
      const rows = getDb().prepare(`
        SELECT p.name,
          ROUND((julianday('now') - julianday(wcs.reminder_sent_at)) * 24, 1) AS hours_since
        FROM weekly_cashout_state wcs
        JOIN players p ON p.id = wcs.player_id
        WHERE wcs.week_start = ?
          AND wcs.cashout_confirmed = 0
          AND wcs.not_played = 0
          AND wcs.reminder_sent_at IS NOT NULL
          AND (julianday('now') - julianday(wcs.reminder_sent_at)) * 24 >= 6
      `).all(weekStart) as Array<{ name: string; hours_since: number }>;

      if (rows.length > 0) {
        const lines = rows.map(r => `• ${r.name} — ${r.hours_since.toFixed(0)}h`);
        await notifyOps(`⏰ <b>${rows.length} joueur(s) en attente depuis 6h+</b>\n\n${lines.join("\n")}`);
      }
      console.log("[CRON] 6h-pending-check done:", rows.length, "pending");
    } catch (e: any) {
      console.error("[CRON] 6h-pending-check failed:", e);
    }
  }, opts);

  console.log("[CRON] 8 cashout + 1 pending-alert jobs registered (Europe/Paris)");
}
