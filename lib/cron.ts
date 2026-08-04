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

  // Purge hebdo des shells "x LeCercle" morts — lundi 10h Paris (Hugo 2026-07-19).
  // Kick équipe + bot puis le userbot sort ; rapport posté dans le chat agent.
  if (process.env.SHELL_PURGE_ENABLED !== "false") {
    cron.schedule("0 10 * * 1", async () => {
      console.log("[CRON] shell-purge firing");
      try {
        const { purgeDeadShells, reportShellPurge } = await import("./shell-purge");
        const result = await purgeDeadShells();
        console.log(`[CRON] shell-purge done: purged=${result.purged.length} skipped=${result.skipped.length} remaining=${result.remaining_candidates}`);
        await reportShellPurge(result);
      } catch (e: any) {
        console.error("[CRON] shell-purge failed:", e);
      }
    }, opts);
    console.log("[CRON] shell-purge registered (lundi 10h Paris)");
  } else {
    console.log("[CRON] shell-purge DISABLED");
  }

  // Groupes non rejoints — 1×/jour à 5h40 Paris (Hugo 2026-07-29, avant : toutes les heures).
  // Le seuil de nettoyage reste 24 h : c'est la latence de détection qui passe à 24-48 h.
  // Un groupe créé sans join depuis plus de 24 h est supprimé (kick équipe + sortie du
  // userbot) ou tagué « abandonné » si le kick échoue, et son lead repasse à l'étape
  // précédente avec le flag « groupe non rejoint » pour rester relançable.
  // Le job ne voit QUE les groupes tracés dans `group_creations` (donc créés après ce
  // déploiement) : rayon d'action borné par construction.
  if (process.env.GROUP_CLEANUP_ENABLED !== "false") {
    cron.schedule("40 5 * * *", async () => {
      try {
        const { runGhostGroupCleanup, reportGhostCleanup } = await import("./group-lifecycle");
        const result = await runGhostGroupCleanup();
        if (result.scanned > 0 || !result.ok) {
          console.log(`[CRON] ghost-group-cleanup: purged=${result.purged.length} tagged=${result.tagged.length} healed=${result.self_healed.length} skipped=${result.skipped.length}`);
        }
        await reportGhostCleanup(result);
      } catch (e: any) {
        console.error("[CRON] ghost-group-cleanup failed:", e);
      }
    }, opts);
    console.log("[CRON] ghost-group-cleanup registered (tous les jours à 5h40 Paris)");
  } else {
    console.log("[CRON] ghost-group-cleanup DISABLED");
  }

  // Snapshot quotidien de trésorerie — 23h50 Paris (graph "Trésorerie · évolution").
  if (process.env.TREASURY_SNAPSHOT_ENABLED !== "false") {
    cron.schedule("50 23 * * *", async () => {
      console.log("[CRON] treasury-snapshot firing");
      try {
        const { snapshotTreasuryToday } = await import("./treasury");
        const r = await snapshotTreasuryToday();
        console.log(`[CRON] treasury-snapshot done: written=${r.written}${r.errors.length ? ` errors=${r.errors.join("; ")}` : ""}`);
      } catch (e: any) {
        console.error("[CRON] treasury-snapshot failed:", e);
      }
    }, opts);
    console.log("[CRON] treasury-snapshot registered (23h50 Paris)");
  } else {
    console.log("[CRON] treasury-snapshot DISABLED");
  }

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

  // Relances QQPK Funnel — toutes les heures. Leads bloqués à une étape < 4 :
  // J+1 / J+3 / J+7 (max 3 relances), 403 → blocked. Aucun lien avec players.
  if (process.env.QQPK_FUNNEL_REMINDERS_ENABLED !== "false") {
    cron.schedule("15 * * * *", async () => {
      console.log("[CRON] qqpk-funnel-reminders firing");
      try {
        const { runQqpkFunnelReminders } = await import("./qqpk-funnel");
        const r = await runQqpkFunnelReminders();
        console.log(`[CRON] qqpk-funnel-reminders done: sent=${r.sent} blocked=${r.blocked} skipped=${r.skipped}`);
      } catch (e: any) {
        console.error("[CRON] qqpk-funnel-reminders failed:", e);
      }
    }, opts);
    console.log("[CRON] qqpk-funnel-reminders registered (hourly :15)");
  } else {
    console.log("[CRON] qqpk-funnel-reminders DISABLED");
  }

  // Relances Nexa Funnel — toutes les heures (décalé de QQPK pour ne pas cumuler
  // les envois Telegram). Leads bloqués sur started/app_installed/account_created :
  // J+1 / J+3 / J+7, puis flag `cold`. 403 → blocked.
  if (process.env.NEXA_FUNNEL_REMINDERS_ENABLED !== "false") {
    cron.schedule("35 * * * *", async () => {
      console.log("[CRON] nexa-funnel-reminders firing");
      try {
        const { runNexaFunnelReminders } = await import("./nexa-funnel");
        const r = await runNexaFunnelReminders();
        console.log(`[CRON] nexa-funnel-reminders done: sent=${r.sent} blocked=${r.blocked} cold=${r.cold} skipped=${r.skipped}`);
      } catch (e: any) {
        console.error("[CRON] nexa-funnel-reminders failed:", e);
      }
    }, opts);
    console.log("[CRON] nexa-funnel-reminders registered (hourly :35)");
  } else {
    console.log("[CRON] nexa-funnel-reminders DISABLED");
  }

  // Purge de relay_map — tous les jours à 5h50 Paris, juste après le nettoyage des
  // groupes fantômes. Une entrée de plus de 30 j n'a plus d'usage : personne ne
  // répond à un post admin d'il y a un mois, et Telegram lui-même ne permet plus de
  // citer un message aussi ancien de façon fiable. bot_messages n'est PAS purgé :
  // c'est l'historique de conversation, il doit rester complet.
  //
  // La fermeture des sujets inactifs (30 j) est enchaînée ici : même cadence, même
  // notion de « plus personne ne s'en sert ». Rien n'est supprimé — le premier
  // message du lead rouvre son sujet automatiquement.
  cron.schedule("50 5 * * *", async () => {
    try {
      const { purgeRelayMap } = await import("./funnels/live-takeover");
      const r = purgeRelayMap();
      if (r.deleted > 0) console.log(`[CRON] relay-map-purge: ${r.deleted} entrée(s) supprimée(s)`);
    } catch (e: any) {
      console.error("[CRON] relay-map-purge failed:", e);
    }
    try {
      const { closeIdleTopics } = await import("./funnels/live-takeover-topics");
      const t = await closeIdleTopics();
      if (t.closed > 0 || t.errors > 0) {
        console.log(`[CRON] idle-topics-close: closed=${t.closed} errors=${t.errors}`);
      }
    } catch (e: any) {
      console.error("[CRON] idle-topics-close failed:", e);
    }
  }, opts);
  console.log("[CRON] relay-map-purge + idle-topics-close registered (tous les jours à 5h50 Paris)");

  // Reprise des relais en attente — toutes les 5 min.
  //
  // C'est le filet qui rend vraie la promesse « aucun message de lead n'est perdu ».
  // Un rate limit sur createForumTopic, un sujet supprimé, une coupure Telegram :
  // dans tous ces cas le curseur `last_relayed_msg_id` n'a pas avancé, et cette
  // passe reprend exactement là où le webhook s'était arrêté. Silencieux quand il
  // n'y a rien à faire — ce qui est le cas normal.
  cron.schedule("*/5 * * * *", async () => {
    try {
      const { drainPendingRelays } = await import("./funnels/live-takeover");
      const r = await drainPendingRelays();
      if (r.leads > 0) {
        console.log(`[CRON] relay-drain: leads=${r.leads} posted=${r.posted} deferred=${r.deferred}`);
      }
    } catch (e: any) {
      console.error("[CRON] relay-drain failed:", e);
    }
  }, opts);
  console.log("[CRON] relay-drain registered (toutes les 5 min)");

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
