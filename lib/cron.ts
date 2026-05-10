import cron from "node-cron";
import {
  sendInitialReminders,
  sendEscalationReminders,
  sendFinalAlert,
} from "./telegram-commands/cashout-reminder";

const TZ = "Europe/Paris";
const opts = { timezone: TZ };

let initialized = false;

export function initCronJobs() {
  if (initialized) return;
  initialized = true;

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

  console.log("[CRON] 8 cashout reminder jobs registered (Europe/Paris)");
}
