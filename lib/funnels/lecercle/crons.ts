// Tâche planifiée des diffusions @LeCercle_Lebot.
//
// Comme pour dzpk, le fichier partagé lib/cron.ts ne reçoit qu'un import et un
// appel. Ce tick EST la reprise : une diffusion interrompue par un redéploiement
// laisse ses destinataires en 'pending', la minute suivante les reprend. C'est
// aussi lui qui démarre les diffusions programmées arrivées à échéance.

import cron from "node-cron";

export function initLecercleBroadcastCrons() {
  cron.schedule("* * * * *", async () => {
    try {
      const { runBroadcastDrain } = await import("./broadcast");
      const res = await runBroadcastDrain();
      if (res.promoted) console.log(`[LECERCLE BROADCAST] #${res.promoted} programmée — démarrée`);
      if (res.broadcastId === null) return;

      const parts = [`envoyés ${res.sent}`];
      if (res.blocked) parts.push(`bloqués ${res.blocked}`);
      if (res.failed) parts.push(`échecs ${res.failed}`);
      if (res.skipped) parts.push(`écartés ${res.skipped}`);
      if (res.unknown) parts.push(`issue inconnue ${res.unknown}`);
      if (res.recovered) parts.push(`interrompus récupérés ${res.recovered}`);
      if (res.deferred) parts.push(`restants ${res.deferred}`);
      console.log(`[LECERCLE BROADCAST] #${res.broadcastId} — ${parts.join(" · ")}`);

      if (res.pausedReason) {
        console.error(`[LECERCLE BROADCAST] #${res.broadcastId} EN PAUSE — ${res.pausedReason}`);
        const { notifyOps } = await import("@/lib/ops-notifications");
        await notifyOps(
          `🟠 <b>Diffusion LeCercle #${res.broadcastId} en pause</b>\n\n` +
          `${res.pausedReason.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n\n` +
          `${res.deferred} destinataire(s) n'ont rien reçu. Corriger puis relancer depuis /lecercle-diffusion.`
        ).catch(() => {});
      }
      if (res.finished) console.log(`[LECERCLE BROADCAST] #${res.broadcastId} terminée`);
    } catch (e: any) {
      console.error("[LECERCLE CRON] file de diffusion:", e?.message ?? e);
    }
  }, { timezone: "Europe/Paris" });
}
