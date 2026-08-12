// Tâches planifiées du funnel dzpk.
//
// Regroupées ici plutôt que dispersées dans `lib/cron.ts` : le fichier partagé
// ne reçoit qu'un import et un appel, ce qui garde la surface de contact avec
// le reste du projet à deux lignes.

import cron from "node-cron";
import { runDzpkIngest, getIngestState, isIngestStale } from "./ingest";
import { runMatching, flagContestedLinks } from "./matcher";
import { dzpkClubBot, dzpkAgentName, INGEST_STALE_HOURS } from "./config";
import { isDzpkUserbotConfigured } from "./userbot";

export function initDzpkCrons() {
  // ── Ingestion des notifs du club — toutes les 3 minutes ────────────────────
  //
  // Cadence choisie par ce qu'on attend, pas par prudence : l'attribution d'un
  // rattachement n'a aucune valeur temps réel. Trois minutes de latence ne
  // coûtent rien ; une notif perdue, si. Le curseur rend chaque passe
  // rattrapable, donc un tick manqué se répare tout seul au suivant.
  //
  // Décalé de la minute 1 pour ne pas tomber en même temps que les autres
  // tâches à la minute 0 (une seule base SQLite, écritures sérialisées).
  cron.schedule("1-59/3 * * * *", async () => {
    if (!dzpkAgentName()) return; // non configuré : silence, pas d'erreur en boucle
    // Idem pour la session dédiée : sans elle l'ingestion refuse de tourner, et
    // relancer toutes les 3 min produirait une erreur en boucle dans les logs.
    if (!isDzpkUserbotConfigured()) return;
    try {
      await runDzpkIngest();

      // ── Résolution, enchaînée sur l'ingestion ────────────────────────────
      //
      // Sans cet appel, RIEN ne crée de ligne dans `dzpk_club_matches` : la file
      // de réconciliation reste vide, l'écran affiche « Rien à rattacher » et la
      // tuile « En attente » montre 0 — pendant que les notifications
      // s'accumulent sans crédit. L'état normal aurait été « tout va bien ».
      // (audit money du 2026-08-12, F2)
      //
      // Les liens devenus ambigus sont recalculés d'abord : un lien appris quand
      // le nom était unique ne doit pas continuer à rattacher après l'arrivée
      // d'un homonyme.
      flagContestedLinks();
      const m = runMatching();
      if (m.examined > 0) {
        console.log(
          `[DZPK MATCH] ${m.examined} examinés — ${m.auto} certains ` +
          `(${m.applying ? `${m.applied} appliqués` : `${m.observed} EN OBSERVATION, non appliqués`}), ` +
          `${m.ambiguous} ambigus, ${m.unmatched} sans correspondance`
        );
      }
    } catch (e: any) {
      console.error("[DZPK CRON] ingestion:", e?.message ?? e);
    }
  }, { timezone: "Europe/Paris" });

  // ── Alarme de fraîcheur — toutes les heures ────────────────────────────────
  //
  // LA tâche qui rend une panne visible. Une session userbot invalidée n'émet
  // aucun signal : elle ressemble trait pour trait à une journée sans nouveau
  // joueur. Sans cette alarme, la panne se découvre en comptant l'argent.
  //
  // Ne se déclenche pas si l'agent n'est pas configuré : dans ce cas
  // l'ingestion est volontairement à l'arrêt, ce n'est pas une panne.
  cron.schedule("7 * * * *", async () => {
    if (!dzpkAgentName() || !isDzpkUserbotConfigured()) return;
    try {
      const peer = dzpkClubBot();
      const state = getIngestState(peer);
      if (!isIngestStale(state)) return;

      const detail = state.last_success_at
        ? `dernière ingestion réussie : ${state.last_success_at}`
        : "aucune ingestion réussie depuis la mise en service";
      const err = state.last_error ? `\nDernière erreur : ${state.last_error}` : "";
      const { notifyOps } = await import("@/lib/ops-notifications");
      await notifyOps(
        `🔴 <b>Ingestion dzpk à l'arrêt</b>\n\n` +
        `Aucune notification du club lue depuis plus de ${INGEST_STALE_HOURS} h.\n` +
        `Peer : ${peer}\n${detail}${err}\n\n` +
        `Cause la plus probable : session userbot invalidée. ` +
        `Vérifier <code>/api/admin/userbot-health</code>.`
      ).catch(() => {});
      console.error(`[DZPK ALARME] ingestion périmée — ${detail}`);
    } catch (e: any) {
      console.error("[DZPK CRON] alarme de fraîcheur:", e?.message ?? e);
    }
  }, { timezone: "Europe/Paris" });
}
