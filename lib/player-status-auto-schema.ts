// Schéma du statut automatique (lib/player-status-auto.ts) — module SANS import, pour que
// lib/db.ts le joue sans cycle. Migration add_player_status_auto_v1 :
//   • players.status_manual (0/1) : 1 = « statut manuel », l'automate ne touche pas au statut ;
//   • player_status_changes : trace append-only de chaque bascule faite par l'automate.
export const PLAYER_STATUS_AUTO_V1 = "add_player_status_auto_v1";
export const PLAYER_STATUS_CHANGES_SQL = `
  CREATE TABLE IF NOT EXISTS player_status_changes (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id            INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    kind                 TEXT NOT NULL CHECK (kind IN ('status', 'unarchive')),
    old_value            TEXT,
    new_value            TEXT,
    reason               TEXT NOT NULL,
    last_activity_at     TEXT,
    last_activity_source TEXT,
    trigger              TEXT NOT NULL CHECK (trigger IN ('nightly', 'sunday', 'manual')),
    changed_at           TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_player_status_changes_player ON player_status_changes (player_id, changed_at);
`;
export const PLAYER_STATUS_MANUAL_SQL = `ALTER TABLE players ADD COLUMN status_manual INTEGER NOT NULL DEFAULT 0 CHECK (status_manual IN (0, 1))`;
