// Suivi des diffusions @LeCercle_Lebot : clics sur le bouton, réponses, audience.
//
// L'API Bot ne donne AUCUN accusé de lecture. Rien ici ne prétend dire « lu ».
// Ce qu'on sait réellement, par destinataire :
//   • envoyé / échec / bloqué   → moteur (broadcast.ts)
//   • a cliqué le bouton        → /b/<token>, filtré des robots
//   • a répondu                 → a écrit au bot dans les 72 h qui suivent
// Les réactions emoji ne sont pas suivies (phase 2, cf. rapport de l'étape 0).

import { getDb } from "@/lib/db";
import type { DbLike } from "./audience";

export const REPLY_WINDOW_HOURS = 72;

// ── Clics ─────────────────────────────────────────────────

/**
 * User-agents qui ne sont pas un humain qui clique : aperçus de lien, robots
 * d'indexation, clients HTTP en ligne de commande. Un user-agent ABSENT est
 * traité comme un robot : tous les navigateurs en envoient un.
 */
// « bot » seul ou suffixe d'un nom de robot versionné (Googlebot/2.1), mais pas
// au milieu d'un mot : « CUBOT X30 » est un téléphone, pas un robot.
const BOT_UA = /telegrambot|(^|[^a-z])(bot|crawler|spider)([^a-z]|$)|[a-z]+bot\/|crawler|spider|preview|facebookexternalhit|whatsapp|slack|discord|twitterbot|linkedin|embedly|skypeuripreview|vkshare|pinterest|curl\/|wget\/|python-requests|python-urllib|go-http-client|okhttp|java\/|libwww|httpclient|headlesschrome|phantomjs|lighthouse/i;

export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua || !ua.trim()) return true;
  return BOT_UA.test(ua);
}

/** Jeton base64url de 128 bits : 22 caractères. Tout le reste est rejeté sans requête. */
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

export interface ClickTarget {
  targetId: number;
  destination: string;
}

/**
 * Destination d'un jeton — TOUJOURS l'URL stockée pour la diffusion, jamais
 * une URL venue de la requête. `null` = jeton inconnu (redirection neutre).
 */
export function resolveClickToken(token: string, dbOverride?: DbLike): ClickTarget | null {
  if (!TOKEN_RE.test(token ?? "")) return null;
  const db = dbOverride ?? getDb();
  const row = db.prepare(
    `SELECT t.id AS targetId, b.button_url AS destination
       FROM lecercle_broadcast_targets t
       JOIN lecercle_broadcasts b ON b.id = t.broadcast_id
      WHERE t.click_token = ?`
  ).get(token) as { targetId: number; destination: string | null } | undefined;
  if (!row?.destination || !/^https?:\/\//i.test(row.destination)) return null;
  return { targetId: row.targetId, destination: row.destination };
}

/**
 * Compte un clic humain. Les robots ne sont pas comptés (et le user-agent
 * n'est journalisé que pour les clics comptés, comme demandé).
 */
export function recordClick(targetId: number, userAgent: string | null, dbOverride?: DbLike): boolean {
  if (isBotUserAgent(userAgent)) return false;
  const db = dbOverride ?? getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE lecercle_broadcast_targets
          SET first_click_at = COALESCE(first_click_at, datetime('now')),
              last_click_at  = datetime('now'),
              click_count    = click_count + 1
        WHERE id = ?`
    ).run(targetId);
    db.prepare(`INSERT INTO lecercle_broadcast_clicks (target_id, user_agent) VALUES (?, ?)`)
      .run(targetId, (userAgent ?? "").slice(0, 500));
  })();
  return true;
}

/** Où envoyer un jeton inconnu : le bot lui-même, jamais une URL de la requête. */
export function fallbackUrl(): string {
  const bot = (process.env.TELEGRAM_BOT_USERNAME || "LeCercle_Lebot").replace(/^@/, "");
  return `https://t.me/${bot}`;
}

// ── Entrants (webhook) ────────────────────────────────────

function sqlTime(unixSeconds: unknown): string {
  const n = typeof unixSeconds === "number" && Number.isFinite(unixSeconds) ? unixSeconds * 1000 : Date.now();
  return new Date(n).toISOString().slice(0, 19).replace("T", " ");
}

function upsertSeen(from: any, at: string, db: DbLike): void {
  db.prepare(
    `INSERT INTO lecercle_bot_users (telegram_id, username, first_name, first_seen_at, last_seen_at, origin)
     VALUES (@id, @username, @first_name, @at, @at, 'webhook')
     ON CONFLICT(telegram_id) DO UPDATE SET
       username      = COALESCE(excluded.username, lecercle_bot_users.username),
       first_name    = COALESCE(excluded.first_name, lecercle_bot_users.first_name),
       first_seen_at = COALESCE(lecercle_bot_users.first_seen_at, excluded.first_seen_at),
       last_seen_at  = CASE WHEN lecercle_bot_users.last_seen_at IS NULL
                              OR excluded.last_seen_at > lecercle_bot_users.last_seen_at
                            THEN excluded.last_seen_at ELSE lecercle_bot_users.last_seen_at END,
       blocked_at    = NULL,
       block_reason  = NULL`
  ).run({ id: from.id, username: from.username ?? null, first_name: from.first_name ?? null, at });
}

/**
 * Attribue une réponse à la diffusion la PLUS RÉCENTE reçue par ce compte
 * dans les 72 h précédant le message — et à elle seule.
 *
 * Fenêtre évaluée sur l'heure du MESSAGE (`message.date`), pas sur l'heure de
 * traitement : un update rejoué en retard par Telegram ne doit pas être compté
 * comme une réponse à une diffusion partie après qu'il a été écrit.
 */
export function attributeReply(telegramId: number, at: string, dbOverride?: DbLike): boolean {
  const db = dbOverride ?? getDb();
  // Même règle que la fenêtre du relais (relay.ts) : envoyée OU issue inconnue,
  // datée à la réservation (claimed_at) quand elle existe — sent_at n'est écrit
  // qu'après la réponse de Telegram. Sans la colonne (migration du relais pas
  // appliquée), on retombe sur sent_at et les seules lignes envoyées.
  const hasClaimed = (db.prepare(
    `SELECT COUNT(*) AS n FROM pragma_table_info('lecercle_broadcast_targets') WHERE name = 'claimed_at'`
  ).get() as { n: number }).n > 0;
  const ts = hasClaimed ? "COALESCE(claimed_at, sent_at)" : "sent_at";
  const statuses = hasClaimed ? "('sent','unknown')" : "('sent')";
  const info = db.prepare(
    `UPDATE lecercle_broadcast_targets SET replied_at = ?
      WHERE id = (SELECT id FROM lecercle_broadcast_targets
                   WHERE telegram_id = ? AND status IN ${statuses}
                     AND ${ts} IS NOT NULL AND ${ts} <= ? AND ${ts} >= datetime(?, ?)
                   ORDER BY ${ts} DESC, id DESC LIMIT 1)
        AND replied_at IS NULL`
  ).run(at, telegramId, at, at, `-${REPLY_WINDOW_HOURS} hours`);
  return info.changes > 0;
}

/**
 * Point d'entrée du webhook principal. N'interagit avec Telegram en rien :
 * lit l'update, écrit deux tables, rend la main. L'appelant l'enveloppe dans
 * un try/catch : un échec ici ne doit jamais bloquer le traitement du message.
 *
 *  • message privé   → compte vu (+ débloqué), réponse attribuée ;
 *  • callback privé  → compte vu (+ débloqué), PAS une réponse (cliquer un
 *                      bouton d'un autre flux n'est pas écrire au bot) ;
 *  • my_chat_member privé 'kicked' → compte bloqué ; 'member' → débloqué.
 */
export function recordInboundForBroadcast(update: any, dbOverride?: DbLike): void {
  const db = dbOverride ?? getDb();

  const msg = update?.message;
  if (msg?.chat?.type === "private" && msg.from && !msg.from.is_bot && typeof msg.from.id === "number") {
    const at = sqlTime(msg.date);
    upsertSeen(msg.from, at, db);
    attributeReply(msg.from.id, at, db);
    return;
  }

  const cb = update?.callback_query;
  if (cb?.message?.chat?.type === "private" && cb.from && !cb.from.is_bot && typeof cb.from.id === "number") {
    upsertSeen(cb.from, sqlTime(undefined), db);
    return;
  }

  const mcm = update?.my_chat_member;
  if (mcm?.chat?.type === "private" && mcm.from && !mcm.from.is_bot && typeof mcm.from.id === "number") {
    const status = mcm.new_chat_member?.status;
    const at = sqlTime(mcm.date);
    if (status === "kicked") {
      db.prepare(
        `INSERT INTO lecercle_bot_users (telegram_id, username, first_name, first_seen_at, blocked_at, block_reason, origin)
         VALUES (@id, @username, @first_name, NULL, @at, 'my_chat_member:kicked', 'webhook')
         ON CONFLICT(telegram_id) DO UPDATE SET
           blocked_at = @at, block_reason = 'my_chat_member:kicked',
           username = COALESCE(excluded.username, lecercle_bot_users.username),
           first_name = COALESCE(excluded.first_name, lecercle_bot_users.first_name)`
      ).run({ id: mcm.from.id, username: mcm.from.username ?? null, first_name: mcm.from.first_name ?? null, at });
    } else if (status === "member") {
      upsertSeen(mcm.from, at, db);
    }
  }
}
