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
