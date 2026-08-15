// Relance unique J+1 des leads restés en « Started » (phase 4).
//
// ┌─ LE CONTRAT, ET CE QU'IL REFUSE ───────────────────────────────────────────┐
// │ UNE relance, une seule, à J+1, aux leads qui ont fait /start sans jamais   │
// │ rejoindre le club. Pas de séquence, pas d'escalade : au-delà d'un message, │
// │ on n'est plus une relance, on est du spam — et le canal Telegram punit le  │
// │ spam par des blocages qui, eux, sont définitifs.                           │
// │                                                                            │
// │ Les exclusions sont aussi importantes que la cible :                       │
// │  • bloqués : injoignables par définition — les relancer produirait un      │
// │    appel réseau en échec par lead et par passe, pour toujours ;            │
// │  • déjà rejoints/rattachés : la relance pousse vers le club, ils y sont ;  │
// │  • bannis : les faire revenir est le contraire du but ;                    │
// │  • déjà relancés : `last_followup_at` est LE verrou d'unicité, posé par un │
// │    UPDATE conditionnel AVANT l'envoi — même garantie que les postbacks.    │
// └────────────────────────────────────────────────────────────────────────────┘

import { getDb } from "@/lib/db";
import { logLeadEvent, markBlocked, type DbLike } from "./leads";
import { sendFollowupD1, type SendResult, type WelcomeVariant } from "./welcome";

/** Fenêtre d'éligibilité, en heures depuis le /start. */
export const FOLLOWUP_MIN_HOURS = 20;
export const FOLLOWUP_MAX_HOURS = 72;

/**
 * Heures d'envoi autorisées, en UTC : 02:00–13:59 UTC = 10:00–21:59 en UTC+8
 * (Malaisie / Singapour / Chine — le fuseau de toute l'audience).
 *
 * Une relance à 4 h du matin locale n'est pas une relance, c'est une raison de
 * bloquer le bot. Les leads éligibles pendant les heures de silence ne sont PAS
 * perdus : la fenêtre de 20–72 h les garde éligibles jusqu'à la passe suivante.
 */
export const FOLLOWUP_UTC_HOUR_MIN = 2;
export const FOLLOWUP_UTC_HOUR_MAX = 14; // exclu

/** Plafond par passe : borne le pire cas, et lisse l'envoi sur la journée. */
export const FOLLOWUP_BATCH_MAX = 40;

export interface FollowupRunResult {
  /** Passe sautée : heures de silence (10h–22h locales uniquement). */
  quiet: boolean;
  examined: number;
  sent: number;
  blocked: number;
  failed: number;
}

interface FollowupCandidate {
  id: number;
  telegram_id: number;
  welcome_variant: string | null;
}

/** Injectable pour les tests — la vraie implémentation appelle Telegram. */
export type FollowupSender = (telegramId: number, variant: WelcomeVariant) => Promise<SendResult>;

/**
 * Une passe de relance. Idempotente et reprennable : chaque lead est verrouillé
 * individuellement AVANT son envoi, donc une passe interrompue ne renvoie rien
 * en double au tick suivant — elle continue simplement où elle en était.
 */
export async function runFollowupD1(
  opts: {
    dbOverride?: DbLike;
    sender?: FollowupSender;
    /** Heure UTC forcée (tests). Défaut : l'heure courante. */
    nowUtcHour?: number;
  } = {},
): Promise<FollowupRunResult> {
  const db = opts.dbOverride ?? getDb();
  const hour = opts.nowUtcHour ?? new Date().getUTCHours();

  if (hour < FOLLOWUP_UTC_HOUR_MIN || hour >= FOLLOWUP_UTC_HOUR_MAX) {
    return { quiet: true, examined: 0, sent: 0, blocked: 0, failed: 0 };
  }

  // La borne basse de la fenêtre EXPIRE les leads trop vieux : un lead de 5
  // jours découvert par une panne de cron ne doit pas recevoir une « relance
  // J+1 » qui n'a plus aucun sens pour lui.
  const candidates = db.prepare(
    `SELECT id, telegram_id, welcome_variant
       FROM dzpk_leads
      WHERE club_joined_at IS NULL
        AND bound_at IS NULL
        AND banned_at IS NULL
        AND blocked = 0
        AND last_followup_at IS NULL
        AND started_at <= datetime('now', '-' || ? || ' hours')
        AND started_at >  datetime('now', '-' || ? || ' hours')
      ORDER BY started_at
      LIMIT ?`
  ).all(FOLLOWUP_MIN_HOURS, FOLLOWUP_MAX_HOURS, FOLLOWUP_BATCH_MAX) as FollowupCandidate[];

  const send = opts.sender ?? ((tgId: number, v: WelcomeVariant) => sendFollowupD1(tgId, v));
  let sent = 0, blocked = 0, failed = 0;

  for (const lead of candidates) {
    // Verrou AVANT l'envoi — même asymétrie assumée que les postbacks : mieux
    // vaut une relance perdue sur un crash qu'une relance en double. `changes = 0`
    // signifie qu'une passe concurrente a déjà pris ce lead.
    const claimed = db.prepare(
      `UPDATE dzpk_leads SET last_followup_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND last_followup_at IS NULL`
    ).run(lead.id);
    if (claimed.changes === 0) continue;

    const variant: WelcomeVariant = lead.welcome_variant === "B" ? "B" : "A";
    let res: SendResult;
    try {
      res = await send(lead.telegram_id, variant);
    } catch (e: any) {
      res = { ok: false, blocked: false, error: e?.message ?? String(e) };
    }

    if (res.ok) {
      sent++;
      logLeadEvent(lead.id, "followup_d1", { payload: { variant } }, opts.dbOverride);
      // La relance entre dans le fil de conversation, comme l'accueil : un
      // opérateur qui relit l'échange doit voir ce que le lead a reçu.
      try {
        const { logMessage } = await import("./takeover");
        logMessage(
          {
            leadId: lead.id, direction: "out", sender: "bot", kind: "text",
            text: res.text ?? null, telegramMessageId: res.messageId ?? null,
          },
          opts.dbOverride,
        );
      } catch (e: any) {
        console.error(`[DZPK FOLLOWUP] lead=${lead.id} — fil non journalisé:`, e?.message ?? e);
      }
    } else if (res.blocked) {
      // Découvert bloqué À la relance : marqué maintenant, exclu pour toujours.
      blocked++;
      markBlocked(lead.id, opts.dbOverride);
      console.log(`[DZPK FOLLOWUP] lead=${lead.id} a bloqué le bot — marqué, plus jamais contacté`);
    } else {
      // Échec transitoire : le verrou reste posé, PAS de rejeu automatique —
      // exactement le même arbitrage que les postbacks. `followup_failed` dans
      // le journal est ce qui permet un rejeu manuel informé.
      failed++;
      logLeadEvent(lead.id, "followup_failed", { payload: { error: res.error ?? null } }, opts.dbOverride);
      console.error(`[DZPK FOLLOWUP] lead=${lead.id} — échec d'envoi: ${res.error ?? "inconnu"}`);
    }
  }

  return { quiet: false, examined: candidates.length, sent, blocked, failed };
}
