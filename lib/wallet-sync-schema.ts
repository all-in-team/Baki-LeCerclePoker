// Trace des passages de sync wallet (lib/wallet-sync.ts) — module SANS import, joué par
// lib/db.ts (migration add_wallet_sync_runs_v1) et par les tests. Une ligne par passage :
// ok = 1 seulement si le passage est allé au bout sans aucune erreur de wallet.
export const WALLET_SYNC_RUNS_V1 = "add_wallet_sync_runs_v1";
export const WALLET_SYNC_RUNS_SQL = `
  CREATE TABLE IF NOT EXISTS wallet_sync_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id       INTEGER NOT NULL REFERENCES games(id),
    trigger       TEXT NOT NULL CHECK (trigger IN ('manual', 'nightly', 'sunday')),
    started_at    TEXT NOT NULL,
    finished_at   TEXT NOT NULL,
    ok            INTEGER NOT NULL CHECK (ok IN (0, 1)),
    wallet_errors INTEGER NOT NULL DEFAULT 0,
    imported      INTEGER,
    error         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wallet_sync_runs_game_ok ON wallet_sync_runs (game_id, ok, finished_at);
`;
