// Schéma des diffusions du bot principal @LeCercle_Lebot.
//
// Module pur (aucun import) : lu par la migration de lib/db.ts ET par les tests,
// qui montent une base temporaire avec CE SQL-là plutôt qu'avec une recopie.

/** Le strict nécessaire de better-sqlite3, sans l'importer (module pur). */
export interface SqlDb {
  prepare(sql: string): { run(...a: any[]): any; get(...a: any[]): any; all(...a: any[]): any[] };
  transaction(fn: () => void): (...a: any[]) => unknown;
}

export const LECERCLE_MIGRATION_BROADCAST_V1 = "add_lecercle_broadcast_v1";

export const LECERCLE_BROADCAST_SCHEMA_SQL = `
  -- L'AUDIENCE du bot : qui lui a parlé en privé.
  --
  -- Jusqu'ici aucune table ne le disait. Un /start atterrit dans onboarding_leads,
  -- nexa_leads, qqpk_funnel_leads, affiliate_leads ou nulle part selon le lien
  -- d'entrée (myaffi, joueur déjà lié). Cette table est alimentée par le webhook
  -- sur CHAQUE update privé, plus une initialisation depuis les cinq sources.
  --
  -- first_seen_at NULL = inconnu (joueur dont on sait seulement qu'il a un chat
  -- privé avec le bot, sans date). Ce n'est pas « récent ».
  --
  -- blocked_at : posé par un 403 « blocked by the user » à l'envoi, ou par un
  -- my_chat_member 'kicked'. Levé par tout message entrant : on ne peut pas
  -- écrire à un bot qu'on a bloqué.
  CREATE TABLE IF NOT EXISTS lecercle_bot_users (
    telegram_id   INTEGER PRIMARY KEY,
    username      TEXT,
    first_name    TEXT,
    first_seen_at TEXT,
    last_seen_at  TEXT,
    blocked_at    TEXT,
    block_reason  TEXT,
    origin        TEXT NOT NULL CHECK (origin IN ('webhook','backfill','send')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Une diffusion. Le corps est stocké tel qu'envoyé : c'est la seule trace
  -- de ce que les gens ont reçu.
  --
  -- segment  : JSON figé à la création, jamais réévalué.
  -- excluded : JSON {motif: nombre} au moment de la création, pour que l'écran
  --            de détail dise qui a été écarté et pourquoi.
  -- scheduled_at : UTC. Saisi en UTC+8 dans l'écran, converti côté serveur.
  CREATE TABLE IF NOT EXISTS lecercle_broadcasts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT    NOT NULL,
    body          TEXT    NOT NULL,
    button_label  TEXT,
    button_url    TEXT,
    segment       TEXT    NOT NULL,
    excluded      TEXT    NOT NULL DEFAULT '{}',
    status        TEXT    NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','scheduled','running','paused','done','cancelled')),
    total         INTEGER NOT NULL DEFAULT 0,
    scheduled_at  TEXT,
    resume_after  TEXT,                      -- 429 : pas d'envoi avant cette heure (UTC)
    last_error    TEXT,
    created_by    TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    started_at    TEXT,
    finished_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_lc_bc_status ON lecercle_broadcasts(status, scheduled_at);

  -- La file d'envoi, la reprise ET le suivi, dans la même ligne.
  --
  -- UNIQUE(broadcast_id, telegram_id) : un même compte ne peut pas figurer deux
  -- fois dans une diffusion, donc ne peut pas être servi deux fois par elle.
  --
  -- click_token : 128 bits aléatoires, base64url. C'est lui qui porte le bouton
  -- (/b/<token>) ; il ne révèle ni l'id de diffusion ni le destinataire, et ne
  -- se devine pas — un clic compté est un clic sur CE message.
  --
  -- status 'skipped' : destinataire figé à la création, mais devenu exclu
  -- (bloqué, relances coupées, takeover) avant que son tour n'arrive.
  --
  -- status 'sending' : RÉSERVÉ par le drain qui tient le verrou, envoi en vol.
  -- Aucun autre drain ne peut le prendre (la réservation exige 'pending').
  --
  -- status 'unknown' : issue inconnue — le process est mort pendant l'envoi,
  -- ou Telegram n'a pas répondu (timeout, réseau, 5xx). Le message est peut-
  -- être arrivé : il n'est JAMAIS renvoyé automatiquement. Choix assumé : un
  -- destinataire possiblement privé plutôt qu'un doublon possible.
  CREATE TABLE IF NOT EXISTS lecercle_broadcast_targets (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    broadcast_id        INTEGER NOT NULL REFERENCES lecercle_broadcasts(id),
    telegram_id         INTEGER NOT NULL,
    username            TEXT,
    first_name          TEXT,
    status              TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','sending','sent','failed','blocked','skipped','unknown')),
    attempts            INTEGER NOT NULL DEFAULT 0,
    error_code          INTEGER,
    error               TEXT,
    telegram_message_id INTEGER,
    sent_at             TEXT,
    click_token         TEXT    NOT NULL UNIQUE,
    first_click_at      TEXT,
    last_click_at       TEXT,
    click_count         INTEGER NOT NULL DEFAULT 0,
    replied_at          TEXT,
    UNIQUE(broadcast_id, telegram_id)
  );
  CREATE INDEX IF NOT EXISTS idx_lc_bt_drain ON lecercle_broadcast_targets(broadcast_id, status);
  CREATE INDEX IF NOT EXISTS idx_lc_bt_reply ON lecercle_broadcast_targets(telegram_id, sent_at);
  -- Récupération des envois interrompus, à chaque tick : ne pas scanner la table.
  CREATE INDEX IF NOT EXISTS idx_lc_bt_sending ON lecercle_broadcast_targets(status) WHERE status = 'sending';

  -- Verrou de drain, en BASE et non en mémoire : Next charge ce module dans
  -- plusieurs bundles (instrumentation pour le cron, route API pour le
  -- démarrage immédiat), chacun avec ses propres variables. Un seul détenteur
  -- à la fois ; le bail est renouvelé avant chaque envoi et expire seul si le
  -- process meurt. Une seule ligne (id = 1).
  CREATE TABLE IF NOT EXISTS lecercle_broadcast_lock (
    id     INTEGER PRIMARY KEY CHECK (id = 1),
    owner  TEXT,
    until  TEXT
  );
  INSERT OR IGNORE INTO lecercle_broadcast_lock (id) VALUES (1);

  -- Un clic COMPTÉ = une ligne, avec son user-agent. Les clics de robots
  -- (aperçus, crawlers) redirigent sans rien écrire ici.
  CREATE TABLE IF NOT EXISTS lecercle_broadcast_clicks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id   INTEGER NOT NULL REFERENCES lecercle_broadcast_targets(id),
    clicked_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    user_agent  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_lc_clicks_target ON lecercle_broadcast_clicks(target_id);
`;

// ── Initialisation depuis les cinq sources ────────────────

/**
 * Remplit `lecercle_bot_users` depuis les tables qui gardaient trace d'un /start.
 *
 * IDEMPOTENTE, rejouable à volonté :
 *  • un compte déjà présent n'est jamais dupliqué (clé primaire telegram_id) ;
 *  • `last_seen_at`, `blocked_at`, `block_reason` et `origin` d'une ligne
 *    existante ne sont JAMAIS touchés — ce sont des faits observés par le
 *    webhook ou l'envoi, plus fiables que ce qu'on reconstitue ici ;
 *  • `first_seen_at` ne peut que reculer (la plus ancienne date connue gagne) ;
 *  • username / first_name ne sont remplis que s'ils manquaient.
 *
 * Retourne le nombre de comptes AJOUTÉS.
 */
export function backfillBotUsers(db: SqlDb): number {
  const before = (db.prepare(`SELECT COUNT(*) AS n FROM lecercle_bot_users`).get() as { n: number }).n;

  // Les cinq sources en UNE requête, agrégée par compte : premier contact = la
  // plus ancienne date connue, dernière activité = la plus récente. (Agréger
  // source par source ferait gagner la première source lue, pas la bonne.)
  // MIN/MAX d'agrégat ignorent les NULL ; `username` : n'importe quelle valeur
  // non nulle (MAX), il n'y a pas d'ordre de préférence entre sources.
  const run = () => db.prepare(`
    INSERT INTO lecercle_bot_users (telegram_id, username, first_name, first_seen_at, last_seen_at, origin)
    SELECT telegram_id, MAX(username), MAX(first_name), MIN(first_seen), MAX(last_seen), 'backfill'
      FROM (
        SELECT telegram_id, telegram_username AS username, first_name, created_at AS first_seen, last_seen AS last_seen
          FROM onboarding_leads
        UNION ALL SELECT telegram_id, NULL, NULL, NULL, last_player_activity_at FROM onboarding_leads
        UNION ALL SELECT tg_user_id, tg_username, first_name, COALESCE(started_at, created_at), last_interaction_at FROM nexa_leads
        UNION ALL SELECT tg_user_id, NULL, NULL, NULL, last_lead_msg_at FROM nexa_leads
        UNION ALL SELECT tg_user_id, NULL, NULL, NULL, started_at FROM nexa_leads
        -- qqpk : updated_at bouge aussi sur une relance du bot, pas une activité du lead.
        UNION ALL SELECT telegram_id, username, first_name, created_at, created_at FROM qqpk_funnel_leads
        -- « tg:<id> » est un identifiant de repli, pas un @handle.
        UNION ALL SELECT referred_telegram_id,
                         CASE WHEN referred_handle LIKE 'tg:%' THEN NULL ELSE referred_handle END,
                         NULL, created_at, created_at
                    FROM affiliate_leads WHERE referred_telegram_id IS NOT NULL
        -- Joueur dont le chat privé avec le bot est connu (posé par /start).
        -- Aucune date fiable : players.created_at date la fiche, pas le /start.
        UNION ALL SELECT telegram_id, telegram_handle, name, NULL, NULL
                    FROM players
                   WHERE telegram_id IS NOT NULL AND CAST(telegram_chat_id AS INTEGER) = telegram_id
      )
     WHERE telegram_id IS NOT NULL
     GROUP BY telegram_id
    ON CONFLICT(telegram_id) DO UPDATE SET
      username   = COALESCE(lecercle_bot_users.username, excluded.username),
      first_name = COALESCE(lecercle_bot_users.first_name, excluded.first_name),
      first_seen_at = CASE
        WHEN lecercle_bot_users.first_seen_at IS NULL THEN excluded.first_seen_at
        WHEN excluded.first_seen_at IS NULL THEN lecercle_bot_users.first_seen_at
        ELSE MIN(lecercle_bot_users.first_seen_at, excluded.first_seen_at) END
  `).run();
  db.transaction(run)();

  const after = (db.prepare(`SELECT COUNT(*) AS n FROM lecercle_bot_users`).get() as { n: number }).n;
  return after - before;
}
