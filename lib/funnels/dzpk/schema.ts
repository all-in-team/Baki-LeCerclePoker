// DDL du funnel dzpk, dans UN seul endroit.
//
// Ce module n'importe rien — ni `lib/db`, ni quoi que ce soit d'autre — pour
// pouvoir être consommé à la fois par la migration (`lib/db.ts`) et par les
// tests, sans cycle et sans amorcer la base de production.
//
// ┌─ POURQUOI PAS DEUX COPIES DU SQL ──────────────────────────────────────────┐
// │ Un test qui recopie le CREATE TABLE au lieu d'exécuter celui de la         │
// │ migration valide sa propre copie, pas la base réelle. Le repo s'est déjà   │
// │ fait avoir sur `row_key` (cf. affiliate-ingest.ts:34) — d'où un garde-fou  │
// │ dédié à l'époque. Ici on supprime le problème à la racine : une chaîne,    │
// │ deux consommateurs.                                                        │
// └────────────────────────────────────────────────────────────────────────────┘

/** Nom de la migration dans `_applied_fixes`. */
export const DZPK_MIGRATION_V1 = "add_dzpk_leads_v1";

export const DZPK_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS dzpk_leads (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id      INTEGER NOT NULL UNIQUE,
    username         TEXT,                    -- sans @, tel que Telegram le donne
    first_name       TEXT,
    last_name        TEXT,
    source           TEXT NOT NULL,           -- first-touch, 'organic' si deep link nu
    source_raw       TEXT,                    -- payload brut avant nettoyage
    started_at       TEXT NOT NULL DEFAULT (datetime('now')),
    last_start_at    TEXT NOT NULL DEFAULT (datetime('now')),
    start_count      INTEGER NOT NULL DEFAULT 1,
    last_message_at  TEXT,                    -- dernier message écrit PAR le lead
    first_reply_at   TEXT,                    -- premier message écrit par le lead
    club_joined_at   TEXT,                    -- notif 已进群        (phase 2)
    bound_at         TEXT,                    -- notif 已绑定为代理  (phase 2) = revenu
    banned_at        TEXT,                    -- notif 已被封号/冻结 (phase 2)
    converted_at     TEXT,                    -- marquage manuel back-office
    last_followup_at TEXT,                    -- relance J+1 (phase 4), unicité
    blocked          INTEGER NOT NULL DEFAULT 0,
    notes            TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_dzpk_leads_source  ON dzpk_leads(source);
  CREATE INDEX IF NOT EXISTS idx_dzpk_leads_started ON dzpk_leads(started_at);
  CREATE INDEX IF NOT EXISTS idx_dzpk_leads_bound   ON dzpk_leads(bound_at);

  CREATE TABLE IF NOT EXISTS dzpk_lead_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id     INTEGER NOT NULL REFERENCES dzpk_leads(id),
    kind        TEXT NOT NULL,   -- start | restart | message | command | blocked | ...
    source      TEXT,            -- source vue sur CE contact (≠ source first-touch)
    username    TEXT,            -- identité OBSERVÉE à cet instant : sert de
    first_name  TEXT,            -- filet à l'appariement par nom de la phase 2
    last_name   TEXT,
    payload     TEXT,            -- JSON libre (texte du message, brut du deep link…)
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_dzpk_events_lead ON dzpk_lead_events(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_dzpk_events_kind ON dzpk_lead_events(kind, created_at);

  CREATE TABLE IF NOT EXISTS dzpk_updates (
    update_id  INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

/** Migration du matching nom-de-club ↔ lead (phase 2). */
export const DZPK_MIGRATION_MATCH_V1 = "add_dzpk_matching_v1";

export const DZPK_MATCH_SCHEMA_SQL = `
  -- display_name : le nom du compte Telegram, que le club reprend AUTOMATIQUEMENT
  -- quand le joueur rejoint (le joueur ne saisit aucun pseudo). C'est donc LA clé
  -- d'appariement, et elle est capturée dès le /start.
  --
  -- display_name_key est la forme normalisée (CJK préservé, casse et espaces
  -- insensibles). Stockée et indexée plutôt que calculée à la lecture : sans
  -- index, chaque notification imposerait un balayage complet de la table.
  ALTER TABLE dzpk_leads ADD COLUMN display_name TEXT;
`;

export const DZPK_MATCH_SCHEMA_SQL_2 = `
  ALTER TABLE dzpk_leads ADD COLUMN display_name_key TEXT;
`;

export const DZPK_MATCH_SCHEMA_SQL_3 = `
  CREATE INDEX IF NOT EXISTS idx_dzpk_leads_dnkey ON dzpk_leads(display_name_key);

  -- Liens APPRIS. Une réconciliation manuelle en crée un, et toute notification
  -- ultérieure portant la même clé se rattache seule (self-learning).
  --
  -- contested : une clé déjà liée qui devient ambiguë (un second lead apparaît
  -- avec le même nom) est SIGNALÉE, pas conservée en silence.
  CREATE TABLE IF NOT EXISTS dzpk_name_links (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name_key   TEXT    NOT NULL UNIQUE,
    lead_id    INTEGER NOT NULL REFERENCES dzpk_leads(id),
    origin     TEXT    NOT NULL,            -- manual | auto
    contested  INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_dzpk_links_lead ON dzpk_name_links(lead_id);

  -- Résolution d'UNE notification vers un lead. Une ligne par message
  -- rattachable (join / bound / banned), y compris quand elle échoue : un
  -- message non résolu doit apparaître dans la file de réconciliation, pas
  -- disparaître.
  CREATE TABLE IF NOT EXISTS dzpk_club_matches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    club_message_id INTEGER NOT NULL UNIQUE REFERENCES dzpk_club_messages(id),
    lead_id         INTEGER REFERENCES dzpk_leads(id),
    status          TEXT    NOT NULL,   -- auto | manual | ambiguous | unmatched
    method          TEXT,               -- link | display_name | display_name_dated
    candidates      TEXT,               -- JSON : leads envisagés, pour l'écran
    applied         INTEGER NOT NULL DEFAULT 0,  -- l'effet sur le lead a-t-il été posé
    resolved_by     TEXT,
    resolved_at     TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_dzpk_matches_status ON dzpk_club_matches(status);
  CREATE INDEX IF NOT EXISTS idx_dzpk_matches_lead   ON dzpk_club_matches(lead_id);
`;

/** Migration de l'ingestion des notifications du club (phase 2). */
export const DZPK_MIGRATION_INGEST_V1 = "add_dzpk_ingest_v1";

export const DZPK_INGEST_SCHEMA_SQL = `
  -- Le BRUT, écrit avant toute interprétation. Un gabarit changera un jour :
  -- ce jour-là, le parseur corrigé se rejoue sur cette table, et rien n'aura
  -- été perdu entre-temps. C'est la source de vérité, le parsing n'en est
  -- qu'une lecture datée (parser_version).
  CREATE TABLE IF NOT EXISTS dzpk_club_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    peer            TEXT    NOT NULL,          -- @dp_bot
    src_msg_id      INTEGER NOT NULL,          -- id Telegram du message
    posted_at       TEXT,                      -- heure TELEGRAM, pas l'heure d'ingestion
    raw_text        TEXT    NOT NULL,
    -- CHECK et pas seulement une convention : parsed_kind est interpolé dans un
    -- nom de colonne côté matcher (UPDATE dzpk_leads SET <col>). Le garde applicatif
    -- suffit aujourd'hui, mais une contrainte de base est ce qui rend l'ensemble
    -- clos par construction plutôt que par vigilance.
    parsed_kind     TEXT    NOT NULL
      CHECK (parsed_kind IN ('join','bound','commission','banned','unparsed')),
    parser_version  INTEGER NOT NULL,
    agent_name_raw  TEXT,                      -- figé : un changement de pseudo ne réécrit rien
    agent_is_mine   INTEGER,                   -- 1 | 0 | NULL (indéterminable : gabarit join)
    player_name_raw TEXT,                      -- EXACTEMENT ce qu'écrit le club
    name_key        TEXT,
    name_key_tight  TEXT,
    unparsed_reason TEXT,
    ingested_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(peer, src_msg_id)                   -- dédup exacte, indépendante du contenu
  );
  CREATE INDEX IF NOT EXISTS idx_dzpk_cm_kind  ON dzpk_club_messages(parsed_kind, posted_at);
  CREATE INDEX IF NOT EXISTS idx_dzpk_cm_key   ON dzpk_club_messages(name_key);
  CREATE INDEX IF NOT EXISTS idx_dzpk_cm_post  ON dzpk_club_messages(posted_at);

  -- Commissions : niveau AGENT, rattachées à aucun lead.
  --
  -- N'alimente NI wallet_transactions, NI les P&L, NI les settlements. Le
  -- rapprochement avec les USDT réellement reçus est une tâche séparée, à
  -- décider explicitement (arbitrage Baki).
  --
  -- Une ligne n'est créée QUE si agent_is_mine = 1. Les commissions d'un autre
  -- agent restent visibles dans dzpk_club_messages pour la traçabilité, mais
  -- n'entrent jamais dans un agrégat de revenu.
  CREATE TABLE IF NOT EXISTS dzpk_commissions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    club_message_id   INTEGER NOT NULL UNIQUE REFERENCES dzpk_club_messages(id),
    posted_at         TEXT,
    requested_amount  REAL    NOT NULL,
    requested_raw     TEXT    NOT NULL,        -- source de vérité, à l'octet près
    paid_amount       REAL    NOT NULL,
    paid_raw          TEXT    NOT NULL,
    currency          TEXT    NOT NULL DEFAULT 'USDT',
    agent_name_raw    TEXT,
    parser_version    INTEGER NOT NULL,
    note              TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  -- (currency, posted_at) : aucun agrégat ne doit pouvoir traverser deux
  -- devises sans le vouloir (invariant #3).
  CREATE INDEX IF NOT EXISTS idx_dzpk_comm_cur  ON dzpk_commissions(currency, posted_at);
  CREATE INDEX IF NOT EXISTS idx_dzpk_comm_post ON dzpk_commissions(posted_at);

  -- Curseur du pull. La colonne last_success_at pilote l'alarme de fraîcheur :
  -- une session userbot morte est indistinguable d'une journée sans joueur.
  -- (Pas de backtick dans ce bloc : il est porté par un template literal JS.)
  CREATE TABLE IF NOT EXISTS dzpk_ingest_state (
    peer            TEXT PRIMARY KEY,
    last_msg_id     INTEGER NOT NULL DEFAULT 0,
    last_run_at     TEXT,
    last_success_at TEXT,
    messages_seen   INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT
  );
`;

/** Migration des diffusions vers les leads (phase 3a). */
export const DZPK_MIGRATION_BROADCAST_V1 = "add_dzpk_broadcast_v1";

export const DZPK_BROADCAST_SCHEMA_SQL = `
  -- Une diffusion. Le CORPS est stocké ici, pas seulement un identifiant de
  -- message Telegram à recopier : c'est ce qui rend l'envoi auditable après
  -- coup. Un broadcast qui ne sait pas dire ce qu'il a envoyé ne prouve rien,
  -- et sur un canal chinois que Baki ne relit pas, c'est la seule trace.
  --
  -- segment : JSON FIGÉ à la création, jamais réévalué. Un lead qui change
  -- d'étape pendant la diffusion sortirait sinon d'un envoi déjà annoncé, sans
  -- bruit, et les compteurs ne se réconcilieraient plus jamais.
  CREATE TABLE IF NOT EXISTS dzpk_broadcasts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT    NOT NULL,          -- libellé interne, jamais envoyé
    body          TEXT    NOT NULL,          -- HTML Telegram, tel qu'envoyé
    button_label  TEXT,
    button_url    TEXT,
    segment       TEXT    NOT NULL,          -- JSON {sources, stages}
    status        TEXT    NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','running','paused','done','cancelled')),
    total         INTEGER NOT NULL DEFAULT 0,-- destinataires figés à la création
    last_error    TEXT,                      -- motif d'une pause automatique
    created_by    TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    started_at    TEXT,
    finished_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_dzpk_bc_status ON dzpk_broadcasts(status, created_at);

  -- LA file d'envoi ET la reprise, dans la même table.
  --
  -- Le statut est commité destinataire par destinataire : un redéploiement en
  -- pleine diffusion laisse le reste en 'pending', et le tick suivant repart
  -- exactement là. Rien à reconstruire, aucun curseur à réparer.
  --
  -- UNIQUE(broadcast_id, lead_id) : le double-envoi devient impossible par
  -- construction, même si deux drains se chevauchaient.
  --
  -- telegram_id est FIGÉ ici plutôt que relu sur dzpk_leads : si un lead change
  -- de compte, l'audit doit dire à quel compte le message est réellement parti.
  CREATE TABLE IF NOT EXISTS dzpk_broadcast_targets (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    broadcast_id        INTEGER NOT NULL REFERENCES dzpk_broadcasts(id),
    lead_id             INTEGER NOT NULL REFERENCES dzpk_leads(id),
    telegram_id         INTEGER NOT NULL,
    status              TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','sent','blocked','failed')),
    attempts            INTEGER NOT NULL DEFAULT 0,
    error               TEXT,
    telegram_message_id INTEGER,
    sent_at             TEXT,
    UNIQUE(broadcast_id, lead_id)
  );
  CREATE INDEX IF NOT EXISTS idx_dzpk_bt_drain ON dzpk_broadcast_targets(broadcast_id, status);
  CREATE INDEX IF NOT EXISTS idx_dzpk_bt_lead  ON dzpk_broadcast_targets(lead_id);
`;

/** Migration du fil de conversation lead ↔ opérateur (phase 3b). */
export const DZPK_MIGRATION_TAKEOVER_V1 = "add_dzpk_takeover_v1";

export const DZPK_TAKEOVER_SCHEMA_SQL = `
  -- Le FIL de conversation, distinct de dzpk_lead_events.
  --
  -- dzpk_lead_events reste ce qu'il est : un journal d'événements append-only qui
  -- porte l'identité observée à chaque contact, dont dépend l'appariement par nom.
  -- Il ne sait pas dire qui a parlé à qui : ni direction, ni message sortant, ni
  -- id Telegram. Une conversation ne s'en déduit pas — d'où cette table.
  --
  -- created_at à la MILLISECONDE (%f) : deux messages envoyés dans la même
  -- seconde — un lead qui écrit deux lignes d'affilée — s'ordonneraient sinon au
  -- hasard de l'id, et le fil afficherait la réponse avant la question.
  CREATE TABLE IF NOT EXISTS dzpk_bot_messages (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id             INTEGER NOT NULL REFERENCES dzpk_leads(id),
    direction           TEXT    NOT NULL CHECK (direction IN ('in','out')),
    sender              TEXT    NOT NULL,   -- 'lead' | 'bot' | 'operator:<nom>'
    kind                TEXT    NOT NULL DEFAULT 'text',
    text                TEXT,
    telegram_message_id INTEGER,
    created_at          TEXT    NOT NULL
                        DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_dzpk_bm_lead ON dzpk_bot_messages(lead_id, created_at);

  -- L'idempotence par MESSAGE, en plus de celle par update (dzpk_updates).
  --
  -- Les deux ne couvrent pas la même chose : dzpk_updates protège d'un update
  -- rejoué par Telegram, cet index protège d'un même message reinjecte par un
  -- autre chemin. C'est aussi lui qui garantira qu'un relais futur ne poste
  -- jamais deux fois le meme message — la garantie doit vivre en base, pas dans
  -- la prudence de l'appelant.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_dzpk_bm_in_unique
    ON dzpk_bot_messages(lead_id, telegram_message_id)
    WHERE direction = 'in' AND telegram_message_id IS NOT NULL;
`;

/** Curseur de lecture du back-office : pilote la pastille « non lu ». */
export const DZPK_TAKEOVER_ALTER_READ =
  `ALTER TABLE dzpk_leads ADD COLUMN last_read_msg_id INTEGER NOT NULL DEFAULT 0`;

/**
 * Curseur du relais Telegram, posé AVANT que le relais existe.
 *
 * Ce n'est pas de l'anticipation gratuite : c'est la seule pièce du dispositif
 * qui coûte cher à ajouter après coup. NEXA l'a payé — la migration
 * `add_live_takeover_topics_v1` a dû backfiller ce curseur sur `MAX(id)`, avec
 * ce motif : « sinon le premier drain reposterait l'historique complet de chaque
 * lead dans son tout nouveau topic » (lib/db.ts).
 *
 * Ici le curseur avance tout seul tant qu'aucun chat admin n'est configuré (cf.
 * captureInbound). Le jour où DZPK_ADMIN_CHAT_ID est posée, il pointe déjà sur
 * « maintenant » : le relais démarre sur les messages suivants, sans déversement
 * d'historique et sans migration de rattrapage à écrire.
 */
export const DZPK_TAKEOVER_ALTER_RELAY =
  `ALTER TABLE dzpk_leads ADD COLUMN last_relayed_msg_id INTEGER NOT NULL DEFAULT 0`;

/** Migration des postbacks S2S de conversion (phase 5). */
export const DZPK_MIGRATION_POSTBACK_V1 = "add_dzpk_postback_v1";

/**
 * Click id du réseau publicitaire, capté au /start via le deep link.
 *
 * C'est la SEULE clé que Propeller et RichAds savent lire : sans elle, un
 * postback part dans le vide — le réseau répond 200 et ne crédite rien. Elle est
 * donc figée à la CRÉATION du lead, exactement comme `source`, et jamais
 * réécrite par un re-/start.
 *
 * Le figeage n'est pas de la prudence, c'est une contrainte de cohérence : le
 * réseau à qui l'on poste est déduit de `source` (first-touch), et le click id
 * doit provenir du MÊME clic. Remplir cette colonne plus tard, sur un re-/start
 * venu d'une autre campagne, enverrait un click id RichAds à l'endpoint
 * Propeller — accepté, compté nulle part, et introuvable ensuite.
 *
 * Conséquence assumée : un lead créé AVANT cette migration n'a pas de click id
 * et ne postera jamais. Il n'y a pas de rattrapage possible — le click id
 * n'existait nulle part côté lead au moment de son /start.
 */
export const DZPK_POSTBACK_ALTER_CLICK =
  `ALTER TABLE dzpk_leads ADD COLUMN click_id TEXT`;

/**
 * Horodatage du postback — et, du même coup, LE verrou d'unicité.
 *
 * Posé AVANT l'appel réseau, par un UPDATE conditionnel
 * (`WHERE postback_sent_at IS NULL`) : c'est la seule façon de garantir qu'un
 * lead ne poste jamais deux fois. Le poser après la réponse laisserait deux
 * passes du cron entrer ensemble dans la fenêtre d'appel — et un doublon de
 * conversion, côté réseau, corrompt un chiffre sur lequel on achète du trafic.
 *
 * Le prix : un envoi qui échoue n'est PAS rejoué automatiquement. C'est le
 * compromis voulu — un postback manquant se voit dans `postback_result` et se
 * rejoue à la main ; un postback en double ne se voit pas du tout.
 */
export const DZPK_POSTBACK_ALTER_SENT =
  `ALTER TABLE dzpk_leads ADD COLUMN postback_sent_at TEXT`;

/**
 * Ce que le réseau a répondu : `propeller 200`, `richads 502`, `propeller
 * timeout`… Une colonne de diagnostic, jamais lue par la logique.
 *
 * Sans elle, « envoyé » et « tenté puis échoué » sont indistinguables : les deux
 * portent un `postback_sent_at`. C'est précisément la différence qui décide s'il
 * faut rejouer à la main.
 */
export const DZPK_POSTBACK_ALTER_RESULT =
  `ALTER TABLE dzpk_leads ADD COLUMN postback_result TEXT`;

/**
 * Migration du goal SECONDAIRE de conversion (join), étape 2 de l'optimisation.
 *
 * Depuis cette étape, le goal PRINCIPAL part au /start (webhook) — c'est le
 * seul événement avec assez de volume pour nourrir le SmartCPC. Le join devient
 * un goal séparé, remonté sur ses propres colonnes : les deux goals d'un même
 * lead se verrouillent et se rejouent indépendamment, avec le même schéma de
 * verrou conditionnel que le goal principal.
 */
export const DZPK_MIGRATION_POSTBACK_V2 = "add_dzpk_postback_v2";

export const DZPK_POSTBACK_ALTER_JOIN_SENT =
  `ALTER TABLE dzpk_leads ADD COLUMN join_postback_sent_at TEXT`;

export const DZPK_POSTBACK_ALTER_JOIN_RESULT =
  `ALTER TABLE dzpk_leads ADD COLUMN join_postback_result TEXT`;

/**
 * Migration du test A/B d'accueil (étape 5 de l'optimisation).
 *
 * La variante est DÉRIVABLE de la parité de l'id (cf. pickWelcomeVariant), mais
 * elle est quand même ÉCRITE au moment de l'envoi : c'est ce qui distingue les
 * leads réellement exposés au test des leads antérieurs, et ce qui restera vrai
 * si la règle d'affectation change un jour. NULL = accueilli avant le test.
 */
export const DZPK_MIGRATION_WELCOME_AB_V1 = "add_dzpk_welcome_ab_v1";

export const DZPK_WELCOME_AB_ALTER =
  `ALTER TABLE dzpk_leads ADD COLUMN welcome_variant TEXT`;
