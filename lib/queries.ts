import { getDb } from "./db";
import { toParisDate, toUTCISO, parisLocalToUTC, addMonthsParis } from "./date-utils";
import { computeStakingBlock, projectStakingBlock, operatorPnlFromReglement } from "./qqpk-staking-engine";

// ── Players ──────────────────────────────────────────────
export function getPlayers() {
  const db = getDb();
  return db.prepare(`
    SELECT p.*,
      COUNT(DISTINCT paa.app_id) AS app_count,
      SUM(CASE WHEN paa.status='active' THEN 1 ELSE 0 END) AS active_apps
    FROM players p
    LEFT JOIN player_app_assignments paa ON paa.player_id = p.id
    GROUP BY p.id
    ORDER BY p.name
  `).all();
}

export function getPlayerById(id: number) {
  const db = getDb();
  return db.prepare(`SELECT * FROM players WHERE id = ?`).get(id);
}

export function getPlayerAssignments(playerId: number) {
  const db = getDb();
  return db.prepare(`
    SELECT paa.*, pa.name AS app_name, pa.club_name, pa.currency
    FROM player_app_assignments paa
    JOIN poker_apps pa ON pa.id = paa.app_id
    WHERE paa.player_id = ?
    ORDER BY paa.status DESC, pa.name
  `).all(playerId);
}

export function deleteAssignment(id: number) {
  getDb().prepare(`DELETE FROM player_app_assignments WHERE id = ?`).run(id);
}

export function insertPlayer(data: { name: string; telegram_handle?: string; telegram_phone?: string; status?: string; notes?: string; tron_address?: string; tron_app_id?: number; tier?: string }) {
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO players (name, telegram_handle, telegram_phone, status, notes, tron_address, tron_app_id, tier)
    VALUES (@name, @telegram_handle, @telegram_phone, @status, @notes, @tron_address, @tron_app_id, @tier)
  `).run({ status: "active", telegram_handle: null, telegram_phone: null, notes: null, tron_address: null, tron_app_id: null, tier: "A", ...data });
  return r.lastInsertRowid;
}

export function updatePlayer(id: number, data: Partial<{ name: string; telegram_handle: string; telegram_phone: string; status: string; notes: string; action_pct: number; tron_address: string; tron_app_id: number; tier: string }>) {
  const db = getDb();
  const sets = Object.keys(data).map(k => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE players SET ${sets} WHERE id = @id`).run({ ...data, id });
}

export function deletePlayer(id: number) {
  const db = getDb();
  const tx = db.transaction(() => {
    // Money-history guard: a player with financial history must NOT be hard-deleted —
    // the ON DELETE CASCADE on wallet_transactions / player_game_deals / manual_settlements
    // would silently wipe his ledger. Refuse with an explicit reason instead.
    // (History: the old code was a bare DELETE that either nuked history or crashed on
    // the FK of the six tables declared without ON DELETE — the CRM then swallowed the
    // 500 and the player "reappeared" on refresh.)
    const guards: [string, string][] = [
      ["wallet_transactions", "transactions wallet"],
      ["manual_settlements", "règlements manuels"],
      ["weekly_settlements", "settlements hebdo"],
      ["qqpk_staking_blocks", "blocs staking QQPK"],
      ["grindhouse_settlements", "settlements grindhouse"],
      ["grindhouse_expenses", "frais grindhouse"],
      ["rakeback_entries", "lignes de rapport (rakeback)"],
      ["accounting_entries", "écritures accounting (legacy)"],
    ];
    const blocking: string[] = [];
    for (const [table, label] of guards) {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE player_id = ?`).get(id) as { n: number }).n;
      if (n > 0) blocking.push(`${n} ${label}`);
    }
    if (blocking.length > 0) {
      throw new Error(`Suppression refusée : ce joueur a un historique financier (${blocking.join(", ")}). Archive-le (status) ou nettoie son historique d'abord — le supprimer effacerait son ledger.`);
    }
    // Referencing tables declared WITHOUT ON DELETE (would block the FK) — all non-money
    // at this point thanks to the guard above.
    db.prepare(`DELETE FROM grindhouse_sessions WHERE player_id = ?`).run(id);
    db.prepare(`DELETE FROM grindhouse_grinders WHERE player_id = ?`).run(id);
    db.prepare(`DELETE FROM qqpk_entry_log WHERE player_id = ?`).run(id);
    db.prepare(`DELETE FROM qqpk_cycle_rakeback WHERE player_id = ?`).run(id);
    db.prepare(`UPDATE affiliate_leads SET converted_player_id = NULL WHERE converted_player_id = ?`).run(id);
    db.prepare(`DELETE FROM players WHERE id = ?`).run(id);
  });
  tx();
}

export function upsertPlayerFromTelegram(data: {
  telegram_id: number;
  name: string;
  telegram_handle?: string | null;
  joined_via?: string | null;
}): { id: number; isNew: boolean } {
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM players WHERE telegram_id = ?`).get(data.telegram_id) as { id: number } | undefined;
  if (existing) return { id: existing.id, isNew: false };
  const r = db.prepare(`
    INSERT INTO players (name, telegram_handle, telegram_id, status, tier, joined_via)
    VALUES (@name, @telegram_handle, @telegram_id, 'active', 'B', @joined_via)
  `).run({ name: data.name, telegram_handle: data.telegram_handle ?? null, telegram_id: data.telegram_id, joined_via: data.joined_via ?? null });
  return { id: Number(r.lastInsertRowid), isNew: true };
}

// ── Games ─────────────────────────────────────────────────
export function getGames() {
  return getDb().prepare(`SELECT * FROM games ORDER BY id`).all() as { id: number; name: string; status?: string; default_action_pct: number | null }[];
}

export function isGameArchived(gameName: string): boolean {
  const row = getDb().prepare(`SELECT status FROM games WHERE name = ? OR LOWER(name) = LOWER(?)`).get(gameName, gameName) as { status: string } | undefined;
  return row?.status === "archived";
}

export function getPlayerGameDeals(playerId: number) {
  return getDb().prepare(`
    SELECT pgd.*, g.name AS game_name
    FROM player_game_deals pgd
    JOIN games g ON g.id = pgd.game_id
    WHERE pgd.player_id = ?
    ORDER BY g.id
  `).all(playerId);
}

// ── Player Wallet Cashouts (multi) ───────────────────────
export function getPlayerCashouts(playerId: number, gameId?: number) {
  if (gameId != null) {
    return getDb().prepare(`SELECT id, address, label FROM player_wallet_cashouts WHERE player_id = ? AND game_id = ? ORDER BY id`).all(playerId, gameId) as { id: number; address: string; label: string | null }[];
  }
  return getDb().prepare(`SELECT id, address, label FROM player_wallet_cashouts WHERE player_id = ? ORDER BY id`).all(playerId) as { id: number; address: string; label: string | null }[];
}

export function setPlayerCashouts(playerId: number, addresses: { address: string; label?: string | null }[], gameId?: number) {
  const db = getDb();
  const teleGameId = (db.prepare(`SELECT id FROM games WHERE name = 'TELE'`).get() as { id: number } | undefined)?.id;
  const tx = db.transaction(() => {
    if (gameId != null) {
      db.prepare(`DELETE FROM player_wallet_cashouts WHERE player_id = ? AND game_id = ?`).run(playerId, gameId);
    } else {
      db.prepare(`DELETE FROM player_wallet_cashouts WHERE player_id = ?`).run(playerId);
    }
    const ins = gameId != null
      ? db.prepare(`INSERT OR IGNORE INTO player_wallet_cashouts (player_id, address, label, game_id) VALUES (?, ?, ?, ?)`)
      : db.prepare(`INSERT OR IGNORE INTO player_wallet_cashouts (player_id, address, label) VALUES (?, ?, ?)`);
    for (const c of addresses) {
      const a = c.address.trim();
      if (!a) continue;
      if (gameId != null) ins.run(playerId, a, c.label ?? null, gameId);
      else ins.run(playerId, a, c.label ?? null);
    }
    if (gameId == null || gameId === teleGameId) {
      const first = addresses.find(c => c.address.trim());
      db.prepare(`UPDATE players SET tele_wallet_cashout = ? WHERE id = ?`).run(first ? first.address.trim() : null, playerId);
    }
  });
  tx();
}

// ── Player Wallet Games (multi) ──────────────────────────
export function getPlayerGameWallets(playerId: number, gameId?: number) {
  if (gameId != null) {
    return getDb().prepare(`SELECT id, address, label FROM player_wallet_games WHERE player_id = ? AND game_id = ? ORDER BY id`).all(playerId, gameId) as { id: number; address: string; label: string | null }[];
  }
  return getDb().prepare(`SELECT id, address, label FROM player_wallet_games WHERE player_id = ? ORDER BY id`).all(playerId) as { id: number; address: string; label: string | null }[];
}

export function setPlayerGameWallets(playerId: number, addresses: { address: string; label?: string | null }[], gameId?: number) {
  const db = getDb();
  const teleGameId = (db.prepare(`SELECT id FROM games WHERE name = 'TELE'`).get() as { id: number } | undefined)?.id;
  const tx = db.transaction(() => {
    if (gameId != null) {
      db.prepare(`DELETE FROM player_wallet_games WHERE player_id = ? AND game_id = ?`).run(playerId, gameId);
    } else {
      db.prepare(`DELETE FROM player_wallet_games WHERE player_id = ?`).run(playerId);
    }
    const ins = gameId != null
      ? db.prepare(`INSERT OR IGNORE INTO player_wallet_games (player_id, address, label, game_id) VALUES (?, ?, ?, ?)`)
      : db.prepare(`INSERT OR IGNORE INTO player_wallet_games (player_id, address, label) VALUES (?, ?, ?)`);
    for (const c of addresses) {
      const a = c.address.trim();
      if (!a) continue;
      if (gameId != null) ins.run(playerId, a, c.label ?? null, gameId);
      else ins.run(playerId, a, c.label ?? null);
    }
    if (gameId == null || gameId === teleGameId) {
      const first = addresses.find(c => c.address.trim());
      db.prepare(`UPDATE players SET tron_address = ? WHERE id = ?`).run(first ? first.address.trim() : null, playerId);
    }
  });
  tx();
}

export function addPlayerGameWallet(playerId: number, address: string, gameId: number, label?: string | null) {
  getDb().prepare(
    `INSERT OR IGNORE INTO player_wallet_games (player_id, address, game_id, label) VALUES (?, ?, ?, ?)`
  ).run(playerId, address.trim(), gameId, label ?? null);
}

export function addPlayerCashout(playerId: number, address: string, gameId: number, label?: string | null) {
  getDb().prepare(
    `INSERT OR IGNORE INTO player_wallet_cashouts (player_id, address, game_id, label) VALUES (?, ?, ?, ?)`
  ).run(playerId, address.trim(), gameId, label ?? null);
}

export function getAllGameWalletsByPlayer(gameName: string) {
  const db = getDb();
  if (gameName === "TELE") {
    return db.prepare(`
      SELECT player_id, address FROM player_wallet_games
      WHERE (game_id IS NULL OR game_id = (SELECT id FROM games WHERE name = 'TELE'))
        AND player_id IN (
          SELECT pgd.player_id FROM player_game_deals pgd
          JOIN games g ON g.id = pgd.game_id AND g.name = 'TELE'
        )
      UNION
      SELECT p.id AS player_id, p.tron_address AS address FROM players p
      JOIN player_game_deals pgd ON pgd.player_id = p.id
      JOIN games g ON g.id = pgd.game_id AND g.name = 'TELE'
      WHERE p.tron_address IS NOT NULL AND p.tron_address != ''
    `).all() as { player_id: number; address: string }[];
  }
  return db.prepare(`
    SELECT pwg.player_id, pwg.address FROM player_wallet_games pwg
    JOIN games g ON g.id = pwg.game_id AND g.name = ?
    WHERE pwg.player_id IN (
      SELECT pgd.player_id FROM player_game_deals pgd
      JOIN games g2 ON g2.id = pgd.game_id AND g2.name = ?
    )
  `).all(gameName, gameName) as { player_id: number; address: string }[];
}

export function getAllCashoutsByPlayer(gameName: string) {
  const db = getDb();
  if (gameName === "TELE") {
    return db.prepare(`
      SELECT player_id, address FROM player_wallet_cashouts
      WHERE game_id IS NULL OR game_id = (SELECT id FROM games WHERE name = 'TELE')
      UNION
      SELECT id AS player_id, tele_wallet_cashout AS address FROM players
      WHERE tele_wallet_cashout IS NOT NULL AND tele_wallet_cashout != ''
    `).all() as { player_id: number; address: string }[];
  }
  return db.prepare(`
    SELECT pwc.player_id, pwc.address FROM player_wallet_cashouts pwc
    JOIN games g ON g.id = pwc.game_id AND g.name = ?
    WHERE pwc.player_id IN (
      SELECT pgd.player_id FROM player_game_deals pgd
      JOIN games g2 ON g2.id = pgd.game_id AND g2.name = ?
    )
  `).all(gameName, gameName) as { player_id: number; address: string }[];
}

// Player ids holding a deal on a game — powers the sync's deposit-by-sender attribution
// (A5/WN partagent l'app : un dépôt de source inconnue tombe en A5 si le joueur a un deal A5).
export function getPlayerIdsWithDealOnGame(gameName: string): Set<number> {
  const rows = getDb().prepare(`
    SELECT pgd.player_id FROM player_game_deals pgd
    JOIN games g ON g.id = pgd.game_id AND g.name = ?
  `).all(gameName) as { player_id: number }[];
  return new Set(rows.map((r) => r.player_id));
}

export function getPlayersOnGame(gameName: string) {
  return getDb().prepare(`
    SELECT DISTINCT p.id, p.name
    FROM players p
    JOIN player_game_deals pgd ON pgd.player_id = p.id
    JOIN games g ON g.id = pgd.game_id AND g.name = ?
  `).all(gameName) as { id: number; name: string }[];
}

export function getAllTeleGameWalletsByPlayer() {
  return getAllGameWalletsByPlayer("TELE");
}

export function getAllTeleCashoutsByPlayer() {
  return getAllCashoutsByPlayer("TELE");
}

export function upsertPlayerGameDeal(data: { player_id: number; game_id: number; action_pct: number; rakeback_pct: number; start_date?: string | null; end_date?: string | null }) {
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct, start_date, end_date)
    VALUES (@player_id, @game_id, @action_pct, @rakeback_pct, @start_date, @end_date)
    ON CONFLICT(player_id, game_id) DO UPDATE SET
      action_pct = excluded.action_pct,
      rakeback_pct = excluded.rakeback_pct,
      start_date = excluded.start_date,
      end_date = excluded.end_date
  `).run({ ...data, start_date: data.start_date ?? null, end_date: data.end_date ?? null });
  return r.lastInsertRowid;
}

export function deletePlayerGameDeal(id: number) {
  getDb().prepare(`DELETE FROM player_game_deals WHERE id = ?`).run(id);
}

// Distinct action_pct values held by the player across a game scope. Length > 1 = divergent
// deals (settlement blocked until aligned); length 1 = uniform. Used to decide the true no-op.
export function getScopeActionPcts(playerId: number, gameIds: number[]): number[] {
  const db = getDb();
  const ph = gameIds.map(() => "?").join(", ");
  return (db.prepare(
    `SELECT DISTINCT action_pct FROM player_game_deals WHERE player_id = ? AND game_id IN (${ph})`
  ).all(playerId, ...gameIds) as { action_pct: number }[]).map((r) => r.action_pct);
}

// Update ONLY action_pct on the player's EXISTING deals across a game scope — nothing else
// touched (rakeback_pct, dates preserved), no deal created. On a merged view (A5NUTS, AKS/OK)
// this aligns every game in scope to the same pct, which is exactly what the settlement engine's
// divergent-deal guard (getDealActionPct) requires to allow a lock. Returns the distinct old
// pcts and the number of rows updated. Money-adjacent (action_pct drives the agency cut).
export function updatePlayerActionPct(playerId: number, gameIds: number[], newPct: number): { updated: number; oldPcts: number[] } {
  const db = getDb();
  const ph = gameIds.map(() => "?").join(", ");
  const oldRows = db.prepare(
    `SELECT DISTINCT action_pct FROM player_game_deals WHERE player_id = ? AND game_id IN (${ph})`
  ).all(playerId, ...gameIds) as { action_pct: number }[];
  const r = db.prepare(
    `UPDATE player_game_deals SET action_pct = ? WHERE player_id = ? AND game_id IN (${ph})`
  ).run(newPct, playerId, ...gameIds);
  return { updated: r.changes, oldPcts: oldRows.map((o) => o.action_pct) };
}

// Append-only trace of explicit deal acceptances (anti-bypass gate proof).
// Audit log of explicit deal acceptances. NOTE (Phase 2): for QQPK this is ALSO the source of
// truth for the rolling-cycle anchor — getQqpkPlayerStartDate reads MIN(accepted_at). For other
// games it remains audit-only and is not read by any P&L computation.
export function recordDealAcceptance(playerId: number, gameId: number, actionPct: number | null) {
  return getDb().prepare(
    `INSERT INTO deal_acceptances (player_id, game_id, action_pct) VALUES (?, ?, ?)`
  ).run(playerId, gameId, actionPct).lastInsertRowid;
}

// ── Apps ─────────────────────────────────────────────────
export function getApps() {
  const db = getDb();
  return db.prepare(`
    SELECT pa.*,
      COUNT(DISTINCT paa.player_id) AS player_count
    FROM poker_apps pa
    LEFT JOIN player_app_assignments paa ON paa.app_id = pa.id AND paa.status='active'
    GROUP BY pa.id
    ORDER BY pa.name
  `).all();
}

export function getAppById(id: number) {
  return getDb().prepare(`SELECT * FROM poker_apps WHERE id = ?`).get(id);
}

export function insertApp(data: { name: string; deal_type: string; deal_value: number; currency?: string; payout_schedule?: string; club_id?: string; club_name?: string; notes?: string }) {
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO poker_apps (name, deal_type, deal_value, currency, payout_schedule, club_id, club_name, notes)
    VALUES (@name, @deal_type, @deal_value, @currency, @payout_schedule, @club_id, @club_name, @notes)
  `).run({ currency: "EUR", payout_schedule: "monthly", club_id: null, club_name: null, notes: null, ...data });
  return r.lastInsertRowid;
}

export function updateApp(id: number, data: Partial<{ name: string; deal_type: string; deal_value: number; currency: string; payout_schedule: string; club_id: string; club_name: string; notes: string }>) {
  const db = getDb();
  const sets = Object.keys(data).map(k => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE poker_apps SET ${sets} WHERE id = @id`).run({ ...data, id });
}

export function deleteApp(id: number) {
  getDb().prepare(`DELETE FROM poker_apps WHERE id = ?`).run(id);
}

export function upsertAssignment(data: { player_id: number; app_id: number; deal_type: string; deal_value: number; status?: string; joined_at?: string }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO player_app_assignments (player_id, app_id, deal_type, deal_value, status, joined_at)
    VALUES (@player_id, @app_id, @deal_type, @deal_value, @status, @joined_at)
    ON CONFLICT(player_id, app_id) DO UPDATE SET
      deal_type = excluded.deal_type,
      deal_value = excluded.deal_value,
      status = excluded.status
  `).run({ status: "active", joined_at: new Date().toISOString().slice(0, 10), ...data });
}

// ── (Legacy reports + accounting_entries removed — tables dropped in migration drop_unused_legacy_tables_v1) ──

// ── Telegram Ledger ───────────────────────────────────────
export function getLedger(limit = 200) {
  const db = getDb();
  return db.prepare(`
    SELECT tt.*, p.name AS player_name
    FROM telegram_transactions tt
    LEFT JOIN players p ON p.id = tt.player_id
    ORDER BY tt.tx_date DESC, tt.created_at DESC
    LIMIT ?
  `).all(limit);
}

export function insertTransaction(data: {
  player_id?: number;
  direction: "in" | "out";
  amount: number;
  currency?: string;
  note?: string;
  tx_date: string;
}) {
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO telegram_transactions (player_id, direction, amount, currency, note, tx_date)
    VALUES (@player_id, @direction, @amount, @currency, @note, @tx_date)
  `).run({ player_id: null, currency: "EUR", note: null, ...data });
  return r.lastInsertRowid;
}

export function deleteTransaction(id: number) {
  getDb().prepare(`DELETE FROM telegram_transactions WHERE id = ?`).run(id);
}

// ── (Legacy dashboard aggregates removed — used accounting_entries which is now dropped) ──

// ── Wallet Transactions ───────────────────────────────────
export function getWalletTransactions(filters?: { player_id?: number; game_id?: number; game_name?: string; limit?: number; since_date?: string; end_date?: string }) {
  const db = getDb();
  let q = `
    SELECT wt.*, p.name AS player_name,
      COALESCE(g.name, pa.name, 'Unknown') AS game_name
    FROM wallet_transactions wt
    JOIN players p ON p.id = wt.player_id
    LEFT JOIN games g ON g.id = wt.game_id
    LEFT JOIN poker_apps pa ON pa.id = wt.app_id
    WHERE (wt.source IS NULL OR wt.source != 'unknown')
  `;
  const params: Record<string, unknown> = {};
  if (filters?.player_id) { q += ` AND wt.player_id = @player_id`; params.player_id = filters.player_id; }
  if (filters?.game_id)   { q += ` AND wt.game_id = @game_id`;    params.game_id = filters.game_id; }
  if (filters?.game_name) { q += ` AND COALESCE(g.name, pa.name) = @game_name`; params.game_name = filters.game_name; }
  if (filters?.since_date) { q += ` AND wt.tx_datetime >= @since_date`; params.since_date = filters.since_date; }
  if (filters?.end_date)   { q += ` AND wt.tx_datetime <= @end_date`;   params.end_date = filters.end_date; }
  q += ` ORDER BY wt.tx_datetime DESC, wt.created_at DESC`;
  if (filters?.limit)     { q += ` LIMIT @limit`;                  params.limit = filters.limit; }
  return db.prepare(q).all(params);
}

// game_names: multi-game union (A5NUTS = A5POKER + NUTSPK merged view). Each deal row still
// joins ONLY its own game's transactions (wt.game_id = pgd.game_id), so the union is a strict
// per-(player,game) sum — no cross-game double counting. Takes precedence over game_name.
function pushGameCondition(
  conditions: string[],
  params: Record<string, unknown>,
  filters?: { game_name?: string; game_names?: string[] },
) {
  if (filters?.game_names?.length) {
    conditions.push(`g.name IN (${filters.game_names.map((_, i) => `@gn${i}`).join(", ")})`);
    filters.game_names.forEach((n, i) => { params[`gn${i}`] = n; });
  } else if (filters?.game_name) {
    conditions.push(`g.name = @game_name`);
    params.game_name = filters.game_name;
  }
}

export function getWalletSummaryByPlayer(filters?: { game_name?: string; game_names?: string[]; since_date?: string; end_date?: string }) {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  pushGameCondition(conditions, params, filters);
  const srcFilter = `AND (wt.source IS NULL OR wt.source != 'unknown')`;
  const startDateCond = `AND (pgd.start_date IS NULL OR wt.tx_datetime >= pgd.start_date)`;
  const dealEndCond = `AND (pgd.end_date IS NULL OR wt.tx_datetime <= pgd.end_date)`;
  const endDateCond = filters?.end_date ? `AND wt.tx_datetime <= @end_date` : "";
  const dateJoin = filters?.since_date
    ? `LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id ${srcFilter} AND wt.tx_datetime >= @since_date ${endDateCond} ${startDateCond} ${dealEndCond}`
    : `LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id ${srcFilter} ${endDateCond} ${startDateCond} ${dealEndCond}`;
  if (filters?.since_date) params.since_date = filters.since_date;
  if (filters?.end_date) params.end_date = filters.end_date;
  const q = `
    SELECT
      pgd.id AS deal_id,
      p.id AS player_id, p.name AS player_name,
      g.id AS game_id, g.name AS game_name,
      pgd.action_pct, pgd.rakeback_pct, pgd.start_date,
      COALESCE(SUM(CASE WHEN wt.type='deposit'    THEN wt.amount ELSE 0 END), 0) AS total_deposited,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE 0 END), 0) AS total_withdrawn,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) AS net,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) * pgd.action_pct / 100 AS my_pnl
    FROM players p
    JOIN player_game_deals pgd ON pgd.player_id = p.id
    JOIN games g ON g.id = pgd.game_id
    ${dateJoin}
    ${conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : ""}
    GROUP BY p.id, pgd.game_id ORDER BY my_pnl DESC
  `;
  return db.prepare(q).all(params);
}

export function getWalletKPIs(filters?: { game_name?: string; game_names?: string[]; since_date?: string; end_date?: string }) {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  pushGameCondition(conditions, params, filters);
  const srcF = `AND (wt.source IS NULL OR wt.source != 'unknown')`;
  const sdCond = `AND (pgd.start_date IS NULL OR wt.tx_datetime >= pgd.start_date)`;
  const deCond = `AND (pgd.end_date IS NULL OR wt.tx_datetime <= pgd.end_date)`;
  const edCond = filters?.end_date ? `AND wt.tx_datetime <= @end_date` : "";
  const dateJoin = filters?.since_date
    ? `LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id ${srcF} AND wt.tx_datetime >= @since_date ${edCond} ${sdCond} ${deCond}`
    : `LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id ${srcF} ${edCond} ${sdCond} ${deCond}`;
  if (filters?.since_date) params.since_date = filters.since_date;
  if (filters?.end_date) params.end_date = filters.end_date;
  const inner = `
    SELECT
      COALESCE(SUM(CASE WHEN wt.type='deposit'    THEN wt.amount ELSE 0 END), 0) AS total_deposited,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE 0 END), 0) AS total_withdrawn,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) AS net,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) * pgd.action_pct / 100 AS my_pnl
    FROM players p
    JOIN player_game_deals pgd ON pgd.player_id = p.id
    JOIN games g ON g.id = pgd.game_id
    ${dateJoin}
    ${conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : ""}
    GROUP BY p.id, pgd.game_id
  `;

  return db.prepare(`
    SELECT
      COALESCE(SUM(total_deposited), 0) AS total_deposited,
      COALESCE(SUM(total_withdrawn), 0) AS total_withdrawn,
      COALESCE(SUM(net), 0) AS total_net,
      COALESCE(SUM(my_pnl), 0) AS my_total_pnl
    FROM (${inner})
  `).get(params) as { total_deposited: number; total_withdrawn: number; total_net: number; my_total_pnl: number };
}

// Volume = total money moved (deposits + withdrawals, absolute) per game over a period, in USDT.
// Display-only metric for the dashboard volume pie — NOT P&L, NOT net. Source-guarded like every
// other wallet aggregate. Each (game, currency) bucket is converted to USDT via toUsdt() so we never
// sum raw amounts across currencies (invariant #3). missing_rate flags a game whose currency has no
// configured exchange rate (its USDT contribution is dropped to 0 but the flag surfaces in the UI).
// NOTE: unlike getWalletKPIs / getWalletSummaryByPlayer (which scope to the player_game_deals
// window), this counts ALL wallet movement per game regardless of deal start/end. It's a raw
// "how much money flowed" lens, so for games with non-null deal dates the pie may exceed the
// deposits+withdrawals shown on the P&L card. In practice most deals have start_date = NULL.
export interface GameVolume { game_name: string; volume_usdt: number; missing_rate: boolean }
export function getVolumeByGame(filters?: { since_date?: string; end_date?: string }): GameVolume[] {
  const db = getDb();
  const params: Record<string, unknown> = {};
  let dateCond = "";
  if (filters?.since_date) { dateCond += ` AND wt.tx_datetime >= @since_date`; params.since_date = filters.since_date; }
  if (filters?.end_date)   { dateCond += ` AND wt.tx_datetime <= @end_date`;   params.end_date = filters.end_date; }
  const rows = db.prepare(`
    SELECT COALESCE(g.name, pa.name, 'Unknown') AS game_name,
           wt.currency AS currency,
           COALESCE(SUM(ABS(wt.amount)), 0) AS raw_volume
    FROM wallet_transactions wt
    LEFT JOIN games g ON g.id = wt.game_id
    LEFT JOIN poker_apps pa ON pa.id = wt.app_id
    WHERE (wt.source IS NULL OR wt.source != 'unknown') ${dateCond}
    GROUP BY game_name, wt.currency
  `).all(params) as { game_name: string; currency: string; raw_volume: number }[];

  const acc: Record<string, { volume_usdt: number; missing_rate: boolean }> = {};
  for (const r of rows) {
    if (!acc[r.game_name]) acc[r.game_name] = { volume_usdt: 0, missing_rate: false };
    const rate = getExchangeRate(r.currency);
    if (rate === 0 && r.raw_volume > 0) acc[r.game_name].missing_rate = true;
    acc[r.game_name].volume_usdt += toUsdt(r.raw_volume, r.currency);
  }
  return Object.entries(acc)
    .map(([game_name, v]) => ({ game_name, volume_usdt: v.volume_usdt, missing_rate: v.missing_rate }))
    .filter(r => r.volume_usdt > 0 || r.missing_rate)
    .sort((a, b) => b.volume_usdt - a.volume_usdt);
}

// Cumulative Players Net P&L time series over the active period — day-grouped version of the
// EXACT getWalletKPIs net (Σ withdrawal − deposit, joined to the deal window, source-guarded,
// game-currency raw). The last cumulative point == getWalletKPIs.total_net for the same filters
// (non-locked periods). Game currency, no toUsdt (matches the card, which sums raw too).
export function getNetPnlSeries(filters?: { game_name?: string; game_names?: string[]; since_date?: string; end_date?: string; player_id?: number }) {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  pushGameCondition(conditions, params, filters);
  if (filters?.player_id) { conditions.push(`p.id = @player_id`); params.player_id = filters.player_id; }
  const srcF = `AND (wt.source IS NULL OR wt.source != 'unknown')`;
  const sdCond = `AND (pgd.start_date IS NULL OR wt.tx_datetime >= pgd.start_date)`;
  const deCond = `AND (pgd.end_date IS NULL OR wt.tx_datetime <= pgd.end_date)`;
  const sinceCond = filters?.since_date ? `AND wt.tx_datetime >= @since_date` : "";
  const endCond = filters?.end_date ? `AND wt.tx_datetime <= @end_date` : "";
  if (filters?.since_date) params.since_date = filters.since_date;
  if (filters?.end_date) params.end_date = filters.end_date;

  const rows = db.prepare(`
    SELECT substr(COALESCE(wt.tx_datetime, wt.tx_date), 1, 10) AS day,
           COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) AS net_day
    FROM players p
    JOIN player_game_deals pgd ON pgd.player_id = p.id
    JOIN games g ON g.id = pgd.game_id
    JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id ${srcF} ${sinceCond} ${endCond} ${sdCond} ${deCond}
    ${conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : ""}
    GROUP BY day ORDER BY day
  `).all(params) as { day: string; net_day: number }[];

  let cum = 0;
  return rows.map(r => { cum += r.net_day; return { day: r.day, cumulative_net: cum }; });
}

export function getPlayerWalletStats(playerId: number) {
  const db = getDb();
  return db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN wt.type='deposit' THEN wt.amount ELSE 0 END), 0) AS deposited,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE 0 END), 0) AS withdrawn,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) AS net,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal'
        THEN wt.amount * pgd.action_pct / 100
        ELSE -wt.amount * pgd.action_pct / 100 END), 0) AS my_pnl
    FROM wallet_transactions wt
    JOIN player_game_deals pgd ON pgd.player_id = wt.player_id AND pgd.game_id = wt.game_id
    WHERE wt.player_id = ?
      AND (wt.source IS NULL OR wt.source != 'unknown')
      AND (pgd.start_date IS NULL OR wt.tx_datetime >= pgd.start_date)
      AND (pgd.end_date IS NULL OR wt.tx_datetime <= pgd.end_date)
  `).get(playerId) as { deposited: number; withdrawn: number; net: number; my_pnl: number } | undefined;
}

export function insertWalletTransaction(data: {
  player_id: number; game_id: number; type: "deposit" | "withdrawal";
  amount: number; currency?: string; note?: string; tx_date: string; tx_datetime?: string;
}) {
  const db = getDb();
  const tx_datetime = data.tx_datetime || data.tx_date.slice(0, 10) + "T00:00:00Z";
  const r = db.prepare(`
    INSERT INTO wallet_transactions (player_id, game_id, type, amount, currency, note, tx_date, tx_datetime, source)
    VALUES (@player_id, @game_id, @type, @amount, @currency, @note, @tx_date, @tx_datetime, 'manual')
  `).run({ currency: "USDT", note: null, ...data, tx_datetime });
  return r.lastInsertRowid;
}

export function deleteWalletTransaction(id: number) {
  getDb().prepare(`DELETE FROM wallet_transactions WHERE id = ?`).run(id);
}

export function getPlayersWithTronAddress() {
  return getDb().prepare(`
    SELECT id, name, tron_address, tron_app_id, action_pct
    FROM players
    WHERE tron_address IS NOT NULL AND tron_address != ''
  `).all() as { id: number; name: string; tron_address: string; tron_app_id: number | null; action_pct: number }[];
}

// ── CRM ───────────────────────────────────────────────────
export function getCrmNotes(player_id?: number) {
  const db = getDb();
  if (player_id) {
    return db.prepare(`
      SELECT n.*, p.name AS player_name
      FROM crm_notes n JOIN players p ON p.id = n.player_id
      WHERE n.player_id = ? ORDER BY n.created_at DESC
    `).all(player_id);
  }
  return db.prepare(`
    SELECT n.*, p.name AS player_name
    FROM crm_notes n JOIN players p ON p.id = n.player_id
    ORDER BY n.created_at DESC LIMIT 200
  `).all();
}

export function insertCrmNote(data: { player_id: number; content: string; type?: string }) {
  const db = getDb();
  const r = db.prepare(`INSERT INTO crm_notes (player_id, content, type) VALUES (@player_id, @content, @type)`)
    .run({ type: "note", ...data });
  return r.lastInsertRowid;
}

export function deleteCrmNote(id: number) {
  getDb().prepare(`DELETE FROM crm_notes WHERE id = ?`).run(id);
}

export function getCrmOverview() {
  const db = getDb();
  return db.prepare(`
    SELECT
      p.id, p.name, p.telegram_handle, p.telegram_phone, p.status, p.tier, p.notes,
      (SELECT content FROM crm_notes WHERE player_id = p.id ORDER BY created_at DESC LIMIT 1) AS last_note,
      (SELECT created_at FROM crm_notes WHERE player_id = p.id ORDER BY created_at DESC LIMIT 1) AS last_activity,
      (SELECT COUNT(*) FROM crm_notes WHERE player_id = p.id) AS note_count,
      (SELECT COUNT(*) FROM tg_messages WHERE player_id = p.id) AS msg_count,
      (SELECT msg_date FROM tg_messages WHERE player_id = p.id ORDER BY msg_date DESC LIMIT 1) AS last_msg_date
    FROM players p
    GROUP BY p.id ORDER BY p.name
  `).all();
}

export function getTgMessages(player_id: number, limit = 50) {
  return getDb().prepare(`
    SELECT * FROM tg_messages WHERE player_id = ? ORDER BY msg_date DESC LIMIT ?
  `).all(player_id, limit);
}

export function insertTgMessage(data: { player_id: number | null; tg_chat_id: string; tg_msg_id: number; direction: "in" | "out"; content: string; msg_date: string }) {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO tg_messages (player_id, tg_chat_id, tg_msg_id, direction, content, msg_date)
    VALUES (@player_id, @tg_chat_id, @tg_msg_id, @direction, @content, @msg_date)
  `).run(data);
}

// ── TELE Players overview ────────────────────────────────
export function getTelePlayers(startDate?: string, endDate?: string) {
  const dateFilter = startDate && endDate
    ? `AND wt.tx_datetime >= @startDate AND wt.tx_datetime <= @endDate`
    : "";
  return getDb().prepare(`
    SELECT
      p.id, p.name, p.tron_address AS wallet_game, p.tele_wallet_cashout AS wallet_cashout,
      pgd.action_pct, pgd.rakeback_pct,
      COALESCE(SUM(CASE WHEN wt.type='deposit'    THEN wt.amount ELSE 0 END), 0) AS total_deposited,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE 0 END), 0) AS total_withdrawn,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) AS net,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) * pgd.action_pct / 100 AS my_pnl,
      COUNT(wt.id) AS tx_count,
      MAX(wt.tx_datetime) AS last_tx
    FROM players p
    JOIN player_game_deals pgd ON pgd.player_id = p.id
    JOIN games g ON g.id = pgd.game_id AND g.name = 'TELE'
    LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = g.id AND (wt.source IS NULL OR wt.source != 'unknown') ${dateFilter}
    GROUP BY p.id
    ORDER BY p.name
  `).all(startDate && endDate ? { startDate, endDate } : {}) as {
    id: number; name: string; wallet_game: string | null; wallet_cashout: string | null;
    action_pct: number; rakeback_pct: number;
    total_deposited: number; total_withdrawn: number; net: number; my_pnl: number;
    tx_count: number; last_tx: string | null;
  }[];
}

// ── Settings ──────────────────────────────────────────────
export function getSetting(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  getDb().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function deleteSetting(key: string) {
  getDb().prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}

export function getExchangeRate(currency: string): number {
  const normalized = currency.toUpperCase();
  if (normalized === "USDT" || normalized === "USD") return 1;
  const key = `exchange_rate_${normalized.toLowerCase()}_usdt`;
  const val = getSetting(key);
  if (!val) return 0;
  return parseFloat(val) || 0;
}

export function toUsdt(amount: number, currency: string): number {
  const rate = getExchangeRate(currency);
  if (rate === 0) return 0;
  return amount * rate;
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb().prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ── Wallet Mères ────────────────────────────────────────
export interface WalletMere {
  id: number;
  address: string;
  label: string | null;
  game_id: number | null;
  game_name?: string;
  status?: string;
  retired_at?: string | null;
  created_at: string;
}

export function getWalletMeres(): WalletMere[] {
  return getDb().prepare(`
    SELECT wm.id, wm.address, wm.label, wm.game_id, wm.status, wm.created_at, g.name AS game_name
    FROM wallet_meres wm LEFT JOIN games g ON g.id = wm.game_id
    WHERE wm.status = 'active'
    ORDER BY wm.id
  `).all() as WalletMere[];
}

export function getWalletMeresForGame(gameId: number): WalletMere[] {
  return getDb().prepare(`
    SELECT wm.id, wm.address, wm.label, wm.game_id, wm.status, wm.created_at, g.name AS game_name
    FROM wallet_meres wm LEFT JOIN games g ON g.id = wm.game_id
    WHERE wm.status = 'active' AND wm.game_id = ?
    ORDER BY wm.id
  `).all(gameId) as WalletMere[];
}

export function getActiveWalletMeresForGame(gameId: number): Set<string> {
  const rows = getDb().prepare(`
    SELECT address FROM wallet_meres WHERE game_id = ? AND status = 'active'
  `).all(gameId) as { address: string }[];
  return new Set(rows.map(r => r.address.toLowerCase()));
}

export function getAllActiveWalletMereAddresses(): Set<string> {
  const rows = getDb().prepare(
    `SELECT address FROM wallet_meres WHERE status = 'active'`
  ).all() as { address: string }[];
  return new Set(rows.map(r => r.address.toLowerCase()));
}

// ALL mère addresses regardless of status — a retired mère is still operator
// money: an incoming transfer from it is never a player deposit. Used by the
// sync's Pass 1 skip rule (a transfer from a mère that is not an active mère
// of the scanned game must not be imported under that game).
export function getAllWalletMereAddressesAnyStatus(): Set<string> {
  const rows = getDb().prepare(`SELECT address FROM wallet_meres`).all() as { address: string }[];
  return new Set(rows.map(r => r.address.toLowerCase()));
}

// Each player's OWN cashout addresses (all games + legacy TELE column), lowercased.
// Exception to the Pass 1 skip rule above: money arriving on a game wallet FROM the
// player's own cashout address is the player re-injecting his cashed-out funds — a
// real buy-in, even when that address is (also) registered in wallet_meres. (Baki
// 2026-07-15: TJLB… is Max's cashout address; its dual registration as retired KK
// mère made the sync silently skip 10 real AKS buy-ins.)
export function getOwnCashoutAddrsByPlayer(): Map<number, Set<string>> {
  const rows = getDb().prepare(`
    SELECT player_id, address FROM player_wallet_cashouts
    UNION
    SELECT id AS player_id, tele_wallet_cashout AS address FROM players
    WHERE tele_wallet_cashout IS NOT NULL AND tele_wallet_cashout != ''
  `).all() as { player_id: number; address: string }[];
  const map = new Map<number, Set<string>>();
  for (const r of rows) {
    let set = map.get(r.player_id);
    if (!set) map.set(r.player_id, (set = new Set()));
    set.add(r.address.toLowerCase());
  }
  return map;
}

export function listAllWalletMeres(): WalletMere[] {
  return getDb().prepare(`
    SELECT wm.id, wm.address, wm.label, wm.game_id, wm.status, wm.retired_at, wm.created_at, g.name AS game_name
    FROM wallet_meres wm LEFT JOIN games g ON g.id = wm.game_id
    ORDER BY g.name, wm.status, wm.id
  `).all() as WalletMere[];
}

export function addWalletMere(address: string, label: string | null, gameId?: number): WalletMere {
  const result = getDb().prepare(`INSERT INTO wallet_meres (address, label, game_id, status) VALUES (?, ?, ?, 'active')`)
    .run(address, label || null, gameId ?? null);
  return { id: Number(result.lastInsertRowid), address, label: label || null, game_id: gameId ?? null, status: "active", created_at: new Date().toISOString() };
}

export function retireWalletMere(id: number): boolean {
  const result = getDb().prepare(`UPDATE wallet_meres SET status = 'retired', retired_at = datetime('now') WHERE id = ? AND status = 'active'`).run(id);
  return result.changes > 0;
}

export function deleteWalletMere(id: number): boolean {
  const result = getDb().prepare(`DELETE FROM wallet_meres WHERE id = ?`).run(id);
  return result.changes > 0;
}

// ── Cashout Requests ─────────────────────────────────────
export interface CashoutRequest {
  id: number;
  player_id: number;
  player_name: string;
  amount: number;
  currency: string;
  status: string;
  note: string | null;
  created_at: string;
  approved_at: string | null;
  paid_at: string | null;
}

export function getCashoutRequests(status?: string): CashoutRequest[] {
  const db = getDb();
  let q = `
    SELECT cr.*, p.name AS player_name
    FROM cashout_requests cr
    JOIN players p ON p.id = cr.player_id
  `;
  const params: Record<string, unknown> = {};
  if (status) { q += ` WHERE cr.status = @status`; params.status = status; }
  q += ` ORDER BY cr.created_at DESC`;
  return db.prepare(q).all(params) as CashoutRequest[];
}

export function createCashoutRequest(data: { player_id: number; amount: number; currency?: string; note?: string }) {
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO cashout_requests (player_id, amount, currency, note)
    VALUES (@player_id, @amount, @currency, @note)
  `).run({ currency: "USDT", note: null, ...data });
  return Number(r.lastInsertRowid);
}

export function updateCashoutStatus(id: number, status: "approved" | "paid" | "cancelled"): CashoutRequest | null {
  const db = getDb();
  const ts = new Date().toISOString();
  if (status === "approved") {
    db.prepare(`UPDATE cashout_requests SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'pending'`).run(ts, id);
  } else if (status === "paid") {
    db.prepare(`UPDATE cashout_requests SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'approved'`).run(ts, id);
  } else if (status === "cancelled") {
    db.prepare(`UPDATE cashout_requests SET status = 'cancelled' WHERE id = ? AND status IN ('pending','approved')`).run(id);
  }
  return db.prepare(`SELECT cr.*, p.name AS player_name FROM cashout_requests cr JOIN players p ON p.id = cr.player_id WHERE cr.id = ?`).get(id) as CashoutRequest | null;
}

// ── Smart Alerts ─────────────────────────────────────────
export interface AlertPlayer {
  player_id: number;
  player_name: string;
  total_usdt: number;
}

export function getPlayersOverLossThreshold(): AlertPlayer[] {
  const thresholdStr = getSetting("alert_loss_threshold_usdt");
  if (!thresholdStr) return [];
  const threshold = parseFloat(thresholdStr);
  if (isNaN(threshold) || threshold >= 0) return [];

  const balances = getPlayerBalance();
  return balances
    .filter(b => b.total_usdt < threshold)
    .map(b => ({ player_id: b.player_id, player_name: b.player_name, total_usdt: b.total_usdt }));
}

// ── Stale Report Detection ───────────────────────────────
export interface StaleGame {
  game_id: number;
  game_name: string;
  active_player_count: number;
  last_report_date: string | null;
  days_since_report: number | null;
}

export function getStaleReports(staleDays = 7): StaleGame[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      g.id AS game_id,
      g.name AS game_name,
      COUNT(DISTINCT pgd.player_id) AS active_player_count,
      MAX(COALESCE(rr.report_date, substr(rr.created_at, 1, 10))) AS last_report_date,
      CAST(julianday('now') - julianday(MAX(COALESCE(rr.report_date, substr(rr.created_at, 1, 10)))) AS INTEGER) AS days_since_report
    FROM games g
    JOIN player_game_deals pgd ON pgd.game_id = g.id
    JOIN players p ON p.id = pgd.player_id AND p.status = 'active'
    LEFT JOIN rakeback_reports rr ON rr.game_id = g.id
    GROUP BY g.id
    HAVING active_player_count > 0
      AND (last_report_date IS NULL OR days_since_report >= ?)
    ORDER BY days_since_report DESC
  `).all(staleDays) as StaleGame[];
}

// ── Unified P&L ──────────────────────────────────────────
export interface PnLReportRow {
  player_id: number;
  player_name: string;
  game_id: number;
  game_name: string;
  currency: string;
  rakeback: number;
  insurance: number;
  winnings: number;
  action_pct: number;
  rakeback_pct: number;
}

export interface PnLWalletRow {
  player_id: number;
  player_name: string;
  game_id: number;
  game_name: string;
  currency: string;
  deposited: number;
  withdrawn: number;
}

export interface PlayerBalance {
  player_id: number;
  player_name: string;
  games: {
    game_name: string;
    currency: string;
    winnings_player: number;
    winnings_player_usdt: number;
    rakeback_player: number;
    rakeback_player_usdt: number;
    wallet_deposited: number;
    wallet_deposited_usdt: number;
    wallet_withdrawn: number;
    wallet_withdrawn_usdt: number;
    net_usdt: number;
  }[];
  total_usdt: number;
}

export function getReportPnL(playerId?: number): PnLReportRow[] {
  const db = getDb();
  let q = `
    SELECT
      re.player_id,
      p.name AS player_name,
      rr.game_id,
      g.name AS game_name,
      re.currency,
      COALESCE(SUM(re.amount), 0) AS rakeback,
      COALESCE(SUM(re.insurance_amount), 0) AS insurance,
      COALESCE(SUM(re.winnings_amount), 0) AS winnings,
      COALESCE(pgd.action_pct, 0) AS action_pct,
      COALESCE(pgd.rakeback_pct, 0) AS rakeback_pct
    FROM rakeback_entries re
    JOIN rakeback_reports rr ON rr.id = re.report_id
    JOIN players p ON p.id = re.player_id
    JOIN games g ON g.id = rr.game_id
    LEFT JOIN player_game_deals pgd ON pgd.player_id = re.player_id AND pgd.game_id = rr.game_id
    WHERE re.player_id IS NOT NULL
      AND (pgd.start_date IS NULL OR COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) >= pgd.start_date)
  `;
  const params: Record<string, unknown> = {};
  if (playerId) { q += ` AND re.player_id = @playerId`; params.playerId = playerId; }
  q += ` GROUP BY re.player_id, rr.game_id, re.currency`;
  return db.prepare(q).all(params) as PnLReportRow[];
}

export function getWalletPnL(playerId?: number): PnLWalletRow[] {
  const db = getDb();
  let q = `
    SELECT
      wt.player_id,
      p.name AS player_name,
      wt.game_id,
      g.name AS game_name,
      wt.currency,
      COALESCE(SUM(CASE WHEN wt.type='deposit' THEN wt.amount ELSE 0 END), 0) AS deposited,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE 0 END), 0) AS withdrawn
    FROM wallet_transactions wt
    JOIN players p ON p.id = wt.player_id
    JOIN games g ON g.id = wt.game_id
    LEFT JOIN player_game_deals pgd ON pgd.player_id = wt.player_id AND pgd.game_id = wt.game_id
    WHERE wt.game_id IS NOT NULL
      AND (wt.source IS NULL OR wt.source != 'unknown')
      AND (pgd.start_date IS NULL OR wt.tx_datetime >= pgd.start_date)
      AND (pgd.end_date IS NULL OR wt.tx_datetime <= pgd.end_date)
  `;
  const params: Record<string, unknown> = {};
  if (playerId) { q += ` AND wt.player_id = @playerId`; params.playerId = playerId; }
  q += ` GROUP BY wt.player_id, wt.game_id, wt.currency`;
  return db.prepare(q).all(params) as PnLWalletRow[];
}

export function getPlayerBalance(playerId?: number): PlayerBalance[] {
  const reports = getReportPnL(playerId);
  const wallets = getWalletPnL(playerId);

  const playerMap = new Map<number, { name: string; games: Map<string, PlayerBalance["games"][0]> }>();

  function ensure(pid: number, pname: string, gameName: string, currency: string) {
    if (!playerMap.has(pid)) playerMap.set(pid, { name: pname, games: new Map() });
    const p = playerMap.get(pid)!;
    const key = `${gameName}:${currency}`;
    if (!p.games.has(key)) {
      p.games.set(key, {
        game_name: gameName, currency,
        winnings_player: 0, winnings_player_usdt: 0,
        rakeback_player: 0, rakeback_player_usdt: 0,
        wallet_deposited: 0, wallet_deposited_usdt: 0,
        wallet_withdrawn: 0, wallet_withdrawn_usdt: 0,
        net_usdt: 0,
      });
    }
    return p.games.get(key)!;
  }

  for (const r of reports) {
    const g = ensure(r.player_id, r.player_name, r.game_name, r.currency);
    const playerWinnings = r.winnings * (1 - r.action_pct / 100);
    const playerRb = (r.rakeback + r.insurance) * r.rakeback_pct / 100;
    g.winnings_player += playerWinnings;
    g.winnings_player_usdt += toUsdt(playerWinnings, r.currency);
    g.rakeback_player += playerRb;
    g.rakeback_player_usdt += toUsdt(playerRb, r.currency);
  }

  for (const w of wallets) {
    const g = ensure(w.player_id, w.player_name, w.game_name, w.currency);
    g.wallet_deposited += w.deposited;
    g.wallet_deposited_usdt += toUsdt(w.deposited, w.currency);
    g.wallet_withdrawn += w.withdrawn;
    g.wallet_withdrawn_usdt += toUsdt(w.withdrawn, w.currency);
  }

  const result: PlayerBalance[] = [];
  for (const [pid, p] of playerMap) {
    const games = Array.from(p.games.values()).map(g => ({
      ...g,
      net_usdt: g.winnings_player_usdt + g.rakeback_player_usdt + g.wallet_withdrawn_usdt - g.wallet_deposited_usdt,
    }));
    result.push({
      player_id: pid,
      player_name: p.name,
      games,
      total_usdt: games.reduce((s, g) => s + g.net_usdt, 0),
    });
  }

  result.sort((a, b) => b.total_usdt - a.total_usdt);
  return result;
}

export function insertWalletTransactionByHash(data: {
  player_id: number; game_id: number; type: "deposit" | "withdrawal";
  amount: number; currency: string; tx_date: string; tx_datetime: string; tron_tx_hash: string;
  counterparty_address?: string | null;
}) {
  const db = getDb();
  const params = { note: "auto-sync", counterparty_address: null, ...data };
  // Reassignment guard (money-critical): an on-chain tx already attributed to
  // ANOTHER player is never imported a second time. When a game wallet changes
  // owner, its history stays with the owner of the time — only NEW txs land on
  // the new owner. The UNIQUE index is (tron_tx_hash, player_id), so without
  // this check a re-registered address re-imports its full history under the
  // new player. (History 2026-07-14: 3 AKS wallets moved Paul ☀️ → Max Legreen
  // duplicated 1 800 USDT of Paul's already-settled buy-ins under Max.)
  const dup = db.prepare(
    `SELECT 1 FROM wallet_transactions WHERE tron_tx_hash = ? AND player_id != ? LIMIT 1`
  ).get(params.tron_tx_hash, params.player_id);
  if (dup) {
    if (params.counterparty_address) {
      db.prepare(`
        UPDATE wallet_transactions
        SET counterparty_address = @counterparty_address
        WHERE tron_tx_hash = @tron_tx_hash AND counterparty_address IS NULL
      `).run(params);
    }
    return 0;
  }
  // First: try insert. INSERT OR IGNORE returns 0 changes on conflict (existing hash).
  const ins = db.prepare(`
    INSERT OR IGNORE INTO wallet_transactions (player_id, game_id, type, amount, currency, tx_date, tx_datetime, tron_tx_hash, counterparty_address, note, source)
    VALUES (@player_id, @game_id, @type, @amount, @currency, @tx_date, @tx_datetime, @tron_tx_hash, @counterparty_address, @note, 'sync')
  `).run(params);
  if (ins.changes > 0) return ins.changes; // new transaction inserted
  // Existing row — backfill counterparty_address if it's still NULL (one-time fill, never overwrite)
  if (params.counterparty_address) {
    db.prepare(`
      UPDATE wallet_transactions
      SET counterparty_address = @counterparty_address
      WHERE tron_tx_hash = @tron_tx_hash AND counterparty_address IS NULL
    `).run(params);
  }
  return 0; // no new row imported (caller's "deposits++" counter stays accurate)
}

// ── Report Schedule Tracking ────────────────────────────────
export function getClubSchedules() {
  return getDb().prepare(`
    SELECT crs.*, c.club_name, g.name AS game_name
    FROM club_report_schedules crs
    LEFT JOIN clubs c ON c.external_club_id = crs.club_id AND c.game_id = crs.game_id
    JOIN games g ON g.id = crs.game_id
    WHERE crs.active = 1
    ORDER BY g.name, c.club_name
  `).all() as {
    id: number; club_id: string; game_id: number; cadence: string;
    start_date: string; active: number; club_name: string | null; game_name: string;
  }[];
}

export function upsertClubSchedule(data: { club_id: string; game_id: number; cadence: string; start_date: string }) {
  return getDb().prepare(`
    INSERT INTO club_report_schedules (club_id, game_id, cadence, start_date)
    VALUES (@club_id, @game_id, @cadence, @start_date)
    ON CONFLICT(game_id, club_id) DO UPDATE SET
      cadence = excluded.cadence,
      start_date = excluded.start_date,
      active = 1
  `).run(data);
}

export function deleteClubSchedule(id: number) {
  getDb().prepare(`DELETE FROM club_report_schedules WHERE id = ?`).run(id);
}

export function getReportSkipDays(filters?: { club_id?: string; game_id?: number }) {
  let q = `SELECT * FROM report_skip_days WHERE 1=1`;
  const params: Record<string, unknown> = {};
  if (filters?.club_id) { q += ` AND club_id = @club_id`; params.club_id = filters.club_id; }
  if (filters?.game_id) { q += ` AND game_id = @game_id`; params.game_id = filters.game_id; }
  return getDb().prepare(q).all(params) as { id: number; club_id: string; game_id: number; skip_date: string; reason: string | null }[];
}

export function upsertReportSkipDay(data: { club_id: string; game_id: number; skip_date: string; reason?: string }) {
  return getDb().prepare(`
    INSERT INTO report_skip_days (club_id, game_id, skip_date, reason)
    VALUES (@club_id, @game_id, @skip_date, @reason)
    ON CONFLICT(game_id, club_id, skip_date) DO UPDATE SET reason = excluded.reason
  `).run({ ...data, reason: data.reason ?? null });
}

export function deleteReportSkipDay(id: number) {
  getDb().prepare(`DELETE FROM report_skip_days WHERE id = ?`).run(id);
}

export function getReportDatesForClub(clubId: string, gameId: number): string[] {
  return getDb().prepare(`
    SELECT DISTINCT report_date FROM rakeback_reports
    WHERE club_id = ? AND game_id = ? AND report_date IS NOT NULL
  `).all(clubId, gameId).map((r: any) => r.report_date);
}

function getExpectedDates(startDate: string, endDate: string, cadence: string): string[] {
  const dates: string[] = [];
  const d = new Date(startDate);
  const end = new Date(endDate);

  if (cadence === "daily") {
    while (d <= end) { dates.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
  } else if (cadence === "weekdays") {
    while (d <= end) {
      const dow = d.getDay();
      if (dow >= 1 && dow <= 5) dates.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
  } else if (cadence === "weekly") {
    while (d <= end) { dates.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 7); }
  } else if (cadence === "biweekly") {
    while (d <= end) { dates.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 14); }
  } else if (cadence === "monthly") {
    while (d <= end) { dates.push(d.toISOString().slice(0, 10)); d.setMonth(d.getMonth() + 1); }
  }

  return dates;
}

export function getMissingReports() {
  const schedules = getClubSchedules();
  const today = new Date().toISOString().slice(0, 10);
  const missing: { club_id: string; game_id: number; club_name: string; game_name: string; date: string }[] = [];

  for (const sched of schedules) {
    const reportDates = new Set(getReportDatesForClub(sched.club_id, sched.game_id));
    const skipDays = new Set(
      getReportSkipDays({ club_id: sched.club_id, game_id: sched.game_id }).map(s => s.skip_date)
    );

    const expectedDates = getExpectedDates(sched.start_date, today, sched.cadence);
    for (const ds of expectedDates) {
      if (!reportDates.has(ds) && !skipDays.has(ds)) {
        missing.push({
          club_id: sched.club_id,
          game_id: sched.game_id,
          club_name: sched.club_name ?? sched.club_id,
          game_name: sched.game_name,
          date: ds,
        });
      }
    }
  }

  return missing.sort((a, b) => b.date.localeCompare(a.date));
}

// ── Lock-aware settlement helpers ────────────────────────

function isWeekLocked(weekStart: string): boolean {
  const row = getDb().prepare(`SELECT status FROM weekly_settlement_periods WHERE week_start = ?`).get(weekStart) as { status: string } | undefined;
  return row?.status === "locked";
}

function getWeekStartFromDates(sinceDate: string, endDate: string): string | null {
  const startDate = toParisDate(sinceDate);
  const endDateParis = toParisDate(endDate);
  const startD = new Date(startDate + "T12:00:00Z");
  const endD = new Date(endDateParis + "T12:00:00Z");
  const diffDays = Math.round((endD.getTime() - startD.getTime()) / 86400000);
  if (diffDays >= 6 && diffDays <= 7 && startD.getUTCDay() === 1) return startDate;
  return null;
}

export function getLockedSummaryByPlayer(weekStart: string, gameName?: string, gameNames?: string[]) {
  const names = gameNames?.length ? gameNames : [gameName ?? "TELE"];
  const placeholders = names.map(() => "?").join(", ");
  return getDb().prepare(`
    SELECT
      ws.player_id, p.name AS player_name,
      g.id AS game_id, g.name AS game_name,
      ws.action_pct_snapshot AS action_pct, pgd.rakeback_pct, pgd.start_date,
      CASE WHEN ws.pnl_player < 0 THEN ABS(ws.pnl_player) ELSE 0 END AS total_deposited,
      CASE WHEN ws.pnl_player >= 0 THEN ws.pnl_player ELSE 0 END AS total_withdrawn,
      ws.pnl_player AS net,
      ws.pnl_operator AS my_pnl
    FROM weekly_settlements ws
    JOIN players p ON p.id = ws.player_id
    JOIN player_game_deals pgd ON pgd.player_id = ws.player_id
    JOIN games g ON g.id = pgd.game_id AND g.name IN (${placeholders})
    WHERE ws.week_start = ?
    ORDER BY ws.pnl_operator DESC
  `).all(...names, weekStart);
}

export function getLockedKPIs(weekStart: string) {
  const row = getDb().prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN pnl_player < 0 THEN ABS(pnl_player) ELSE 0 END), 0) AS total_deposited,
      COALESCE(SUM(CASE WHEN pnl_player >= 0 THEN pnl_player ELSE 0 END), 0) AS total_withdrawn,
      COALESCE(SUM(pnl_player), 0) AS total_net,
      COALESCE(SUM(pnl_operator), 0) AS my_total_pnl
    FROM weekly_settlements WHERE week_start = ?
  `).get(weekStart) as { total_deposited: number; total_withdrawn: number; total_net: number; my_total_pnl: number };
  return row;
}

export function getLockAwareSummaryByPlayer(filters?: { game_name?: string; game_names?: string[]; since_date?: string; end_date?: string }) {
  if (filters?.since_date && filters?.end_date) {
    const weekStart = getWeekStartFromDates(filters.since_date, filters.end_date);
    if (weekStart && isWeekLocked(weekStart)) {
      return getLockedSummaryByPlayer(weekStart, filters?.game_name, filters?.game_names);
    }
  }
  return getWalletSummaryByPlayer(filters);
}

export function getLockAwareKPIs(filters?: { game_name?: string; game_names?: string[]; since_date?: string; end_date?: string }) {
  if (filters?.since_date && filters?.end_date) {
    const weekStart = getWeekStartFromDates(filters.since_date, filters.end_date);
    if (weekStart && isWeekLocked(weekStart)) {
      return getLockedKPIs(weekStart);
    }
  }
  return getWalletKPIs(filters);
}

// KPIs for a game's P&L page, with agency extras (wins/losses outside player deals) folded
// into my_total_pnl — same composition as the war room (getAgencyTotalPnL = cuts + extras).
// Extras carry no player_id, so the per-player filtered view must NOT use this.
export function getLockAwareKPIsWithExtras(
  filters: { game_name?: string; game_names?: string[]; since_date?: string; end_date?: string },
  gameKey: string | string[],
) {
  const kpis = getLockAwareKPIs(filters) ?? { total_deposited: 0, total_withdrawn: 0, total_net: 0, my_total_pnl: 0 };
  const keys = Array.isArray(gameKey) ? gameKey : [gameKey];
  const extras = keys.reduce((sum, k) => sum + getAgencyExtrasNet(k, {
    from: filters.since_date?.slice(0, 10),
    to: filters.end_date?.slice(0, 10),
  }), 0);
  return { ...kpis, my_total_pnl: kpis.my_total_pnl + extras, extras_net: extras };
}

// ════════════════════════════════════════════════════════════
// CANONICAL P&L FUNCTIONS — single source of truth
// Every page, tool, and bot MUST use these. No ad-hoc P&L SQL.
// ════════════════════════════════════════════════════════════

import { convertCnyToUsdt, getCnyRate } from "./currency";

export interface Period { from?: string; to?: string }

function periodToDateRange(period?: Period): { since?: string; until?: string } {
  if (!period) return {};
  return { since: period.from ? period.from + "T00:00:00Z" : undefined, until: period.to ? period.to + "T23:59:59Z" : undefined };
}

function daysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// A) Deal lookup
export function getPlayerDealsForGame(playerId: number, gameKey: string) {
  return getDb().prepare(`
    SELECT pgd.*, g.name AS game_name
    FROM player_game_deals pgd
    JOIN games g ON g.id = pgd.game_id
    WHERE pgd.player_id = ? AND LOWER(g.name) = LOWER(?)
  `).get(playerId, gameKey) as any | undefined;
}

// B) AKPOKER P&L (wallet-based, USDT)
export interface AkpokerPnLRow {
  player_id: number; player_name: string; action_pct: number;
  deposited: number; withdrawn: number; net_usdt: number; agency_cut_usdt: number;
}
export function getAkpokerPnL(playerId?: number, period?: Period): AkpokerPnLRow[] {
  const { since, until } = periodToDateRange(period);
  const rows = getWalletSummaryByPlayer({
    game_name: "TELE",
    since_date: since,
    end_date: until,
  }) as any[];
  let filtered = rows;
  if (playerId) filtered = rows.filter((r: any) => r.player_id === playerId);
  return filtered.map((r: any) => ({
    player_id: r.player_id,
    player_name: r.player_name,
    action_pct: r.action_pct ?? 0,
    deposited: r.total_deposited ?? 0,
    withdrawn: r.total_withdrawn ?? 0,
    net_usdt: r.net ?? 0,
    agency_cut_usdt: r.my_pnl ?? 0,
  }));
}

// B2) KKPOKER P&L (wallet-based, USDT) — same pattern as AKPOKER
export function getKkpokerPnL(playerId?: number, period?: Period): AkpokerPnLRow[] {
  const { since, until } = periodToDateRange(period);
  const rows = getWalletSummaryByPlayer({
    game_name: "KKPOKER",
    since_date: since,
    end_date: until,
  }) as any[];
  let filtered = rows;
  if (playerId) filtered = rows.filter((r: any) => r.player_id === playerId);
  return filtered.map((r: any) => ({
    player_id: r.player_id,
    player_name: r.player_name,
    action_pct: r.action_pct ?? 0,
    deposited: r.total_deposited ?? 0,
    withdrawn: r.total_withdrawn ?? 0,
    net_usdt: r.net ?? 0,
    agency_cut_usdt: r.my_pnl ?? 0,
  }));
}

// B3) A5POKER P&L (wallet-based, USDT) — same pattern as KKPOKER
export function getA5pokerPnL(playerId?: number, period?: Period): AkpokerPnLRow[] {
  const { since, until } = periodToDateRange(period);
  const rows = getWalletSummaryByPlayer({
    game_name: "A5POKER",
    since_date: since,
    end_date: until,
  }) as any[];
  let filtered = rows;
  if (playerId) filtered = rows.filter((r: any) => r.player_id === playerId);
  return filtered.map((r: any) => ({
    player_id: r.player_id,
    player_name: r.player_name,
    action_pct: r.action_pct ?? 0,
    deposited: r.total_deposited ?? 0,
    withdrawn: r.total_withdrawn ?? 0,
    net_usdt: r.net ?? 0,
    agency_cut_usdt: r.my_pnl ?? 0,
  }));
}

// B4) AKS P&L (wallet-based, USDT) — same pattern as A5POKER
export function getAksPnL(playerId?: number, period?: Period): AkpokerPnLRow[] {
  const { since, until } = periodToDateRange(period);
  const rows = getWalletSummaryByPlayer({
    game_name: "AKS",
    since_date: since,
    end_date: until,
  }) as any[];
  let filtered = rows;
  if (playerId) filtered = rows.filter((r: any) => r.player_id === playerId);
  return filtered.map((r: any) => ({
    player_id: r.player_id,
    player_name: r.player_name,
    action_pct: r.action_pct ?? 0,
    deposited: r.total_deposited ?? 0,
    withdrawn: r.total_withdrawn ?? 0,
    net_usdt: r.net ?? 0,
    agency_cut_usdt: r.my_pnl ?? 0,
  }));
}

// B5) NUTSPK P&L (wallet-based, USDT) — same pattern as AKS
export function getNutspkPnL(playerId?: number, period?: Period): AkpokerPnLRow[] {
  const { since, until } = periodToDateRange(period);
  const rows = getWalletSummaryByPlayer({
    game_name: "NUTSPK",
    since_date: since,
    end_date: until,
  }) as any[];
  let filtered = rows;
  if (playerId) filtered = rows.filter((r: any) => r.player_id === playerId);
  return filtered.map((r: any) => ({
    player_id: r.player_id,
    player_name: r.player_name,
    action_pct: r.action_pct ?? 0,
    deposited: r.total_deposited ?? 0,
    withdrawn: r.total_withdrawn ?? 0,
    net_usdt: r.net ?? 0,
    agency_cut_usdt: r.my_pnl ?? 0,
  }));
}

// C) WEPOKER P&L (rakeback-based, CNY, 3-component)
export interface WepokerPnLRow {
  player_id: number; player_name: string;
  action_pct: number; rakeback_pct: number; insurance_pct: number;
  winnings_cny: number; rake_cny: number; insurance_cny: number;
  player_pnl_cny: number;
  agency_winnings_split_cny: number;
  agency_rakeback_split_cny: number;
  agency_insurance_split_cny: number;
  total_agency_cny: number;
  total_agency_usdt: number;
}
export function getWepokerPnL(playerId?: number, period?: Period): WepokerPnLRow[] {
  const db = getDb();
  const params: any[] = [];
  let dateFilter = "";
  if (period?.from) { dateFilter += ` AND COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) >= ?`; params.push(period.from); }
  if (period?.to) { dateFilter += ` AND COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) <= ?`; params.push(period.to); }
  let playerFilter = "";
  if (playerId) { playerFilter = ` AND re.player_id = ?`; params.push(playerId); }

  const rows = db.prepare(`
    SELECT
      re.player_id,
      p.name AS player_name,
      COALESCE(pgd.action_pct, 0) AS action_pct,
      COALESCE(pgd.rakeback_pct, 0) AS rakeback_pct,
      COALESCE(pgd.insurance_pct, 0) AS insurance_pct,
      COALESCE(SUM(re.winnings_amount), 0) AS winnings_cny,
      COALESCE(SUM(re.amount), 0) AS rake_cny,
      COALESCE(SUM(re.insurance_amount), 0) AS insurance_cny
    FROM rakeback_entries re
    JOIN rakeback_reports rr ON rr.id = re.report_id
    JOIN players p ON p.id = re.player_id
    LEFT JOIN player_game_deals pgd ON pgd.player_id = re.player_id AND pgd.game_id = rr.game_id
    WHERE re.player_id IS NOT NULL
      AND (pgd.start_date IS NULL OR COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) >= pgd.start_date)
      ${dateFilter}${playerFilter}
    GROUP BY re.player_id
  `).all(...params) as any[];

  const rate = getCnyRate();
  return rows.map((r: any) => {
    const agencyWinnings = r.winnings_cny * (r.action_pct / 100);
    const agencyRakeback = r.rake_cny * (r.rakeback_pct / 100);
    const agencyInsurance = r.insurance_cny * (r.insurance_pct / 100);
    const totalAgency = agencyWinnings + agencyRakeback + agencyInsurance;
    const playerPnl = r.winnings_cny * (1 - r.action_pct / 100);
    return {
      player_id: r.player_id,
      player_name: r.player_name,
      action_pct: r.action_pct,
      rakeback_pct: r.rakeback_pct,
      insurance_pct: r.insurance_pct,
      winnings_cny: r.winnings_cny,
      rake_cny: r.rake_cny,
      insurance_cny: r.insurance_cny,
      player_pnl_cny: playerPnl,
      agency_winnings_split_cny: agencyWinnings,
      agency_rakeback_split_cny: agencyRakeback,
      agency_insurance_split_cny: agencyInsurance,
      total_agency_cny: totalAgency,
      total_agency_usdt: convertCnyToUsdt(totalAgency, rate),
    };
  });
}

// D) Agency extras helper
export interface AgencyExtra {
  id: number; game_key: string; type: string; amount: number; currency: string;
  description: string | null; recorded_at: string; recorded_by: string | null; notes: string | null;
}
export function getAgencyExtras(gameKey: string, period?: Period): AgencyExtra[] {
  const db = getDb();
  let sql = `SELECT * FROM agency_extras WHERE game_key = ? AND deleted_at IS NULL`;
  const params: any[] = [gameKey];
  if (period?.from) { sql += ` AND substr(recorded_at, 1, 10) >= ?`; params.push(period.from); }
  if (period?.to) { sql += ` AND substr(recorded_at, 1, 10) <= ?`; params.push(period.to); }
  sql += ` ORDER BY recorded_at DESC`;
  return db.prepare(sql).all(...params) as AgencyExtra[];
}
export function getAgencyExtrasNet(gameKey: string, period?: Period): number {
  const extras = getAgencyExtras(gameKey, period);
  return extras.reduce((s, e) => s + (e.type === "win" ? e.amount : -e.amount), 0);
}

// D-bis) Grindhouse agency net — same formula as /grindhouse/dashboard "Rentabilité nette"
// (app/api/grindhouse-profitability): per active grinder pool_net = sessions_pnl - attributed
// grind fees, agency keeps 50% of each pool; then general grind fees (player_id NULL),
// resto and autres come off the agency side. Expenses are USDT.
// CURRENCY: non-USDT sessions are converted to USDT via toUsdt() (manual rate in settings,
// invariant #3). A currency with NO configured rate contributes 0 (excluded, never summed raw)
// — the grindhouse dashboard surfaces the missing rate.
export function getGrindhouseAgencyNet(period?: Period): number {
  const db = getDb();
  try {
    const sessParams: string[] = [];
    let sessSql = `
      SELECT COALESCE(gm.currency, 'USDT') AS currency, COALESCE(SUM(s.net_result_usdt), 0) AS v
      FROM grindhouse_sessions s
      JOIN grindhouse_grinders gg ON gg.player_id = s.player_id AND gg.status = 'active'
      JOIN games gm ON gm.id = s.game_id
      WHERE 1=1`;
    if (period?.from) { sessSql += ` AND s.session_date >= ?`; sessParams.push(period.from); }
    if (period?.to) { sessSql += ` AND s.session_date <= ?`; sessParams.push(period.to); }
    sessSql += ` GROUP BY currency`;
    const sessRows = db.prepare(sessSql).all(...sessParams) as { currency: string; v: number }[];
    const sessionsPnl = sessRows.reduce((s, r) => s + toUsdt(r.v, r.currency), 0);

    const attParams: string[] = [];
    let attSql = `
      SELECT COALESCE(SUM(e.amount_usdt), 0) AS v
      FROM grindhouse_expenses e
      JOIN grindhouse_grinders gg ON gg.player_id = e.player_id AND gg.status = 'active'
      WHERE e.type = 'grind'`;
    if (period?.from) { attSql += ` AND e.date >= ?`; attParams.push(period.from); }
    if (period?.to) { attSql += ` AND e.date <= ?`; attParams.push(period.to); }
    const attributedGrindFees = (db.prepare(attSql).get(...attParams) as { v: number }).v;

    const feeParams: string[] = [];
    let feeSql = `
      SELECT COALESCE(SUM(CASE WHEN e.player_id IS NULL AND e.type = 'grind' THEN e.amount_usdt ELSE 0 END), 0) AS general_grind,
             COALESCE(SUM(CASE WHEN e.type IN ('resto', 'autre') THEN e.amount_usdt ELSE 0 END), 0) AS other_fees
      FROM grindhouse_expenses e
      WHERE 1=1`;
    if (period?.from) { feeSql += ` AND e.date >= ?`; feeParams.push(period.from); }
    if (period?.to) { feeSql += ` AND e.date <= ?`; feeParams.push(period.to); }
    const fees = db.prepare(feeSql).get(...feeParams) as { general_grind: number; other_fees: number };

    return (sessionsPnl - attributedGrindFees) * 0.5 - fees.general_grind - fees.other_fees;
  } catch {
    return 0; // grindhouse tables absent on fresh DB before migration
  }
}

// Daily decomposition of getGrindhouseAgencyNet — the formula is linear in sessions and
// expenses, so per-day terms sum exactly to the period total.
export interface GrindhouseDailyNet { date: string; net: number }
export function getGrindhouseNetOverTime(period?: Period): GrindhouseDailyNet[] {
  const db = getDb();
  try {
    const dayMap = new Map<string, number>();
    const add = (day: string, v: number) => dayMap.set(day, (dayMap.get(day) ?? 0) + v);
    const range = (col: string, params: string[]) => {
      let sql = "";
      if (period?.from) { sql += ` AND ${col} >= ?`; params.push(period.from); }
      if (period?.to) { sql += ` AND ${col} <= ?`; params.push(period.to); }
      return sql;
    };

    const sessParams: string[] = [];
    const sessions = db.prepare(`
      SELECT s.session_date AS day, COALESCE(gm.currency, 'USDT') AS currency,
             COALESCE(SUM(s.net_result_usdt), 0) AS v
      FROM grindhouse_sessions s
      JOIN grindhouse_grinders gg ON gg.player_id = s.player_id AND gg.status = 'active'
      JOIN games gm ON gm.id = s.game_id
      WHERE 1=1${range("s.session_date", sessParams)}
      GROUP BY day, currency
    `).all(...sessParams) as { day: string; currency: string; v: number }[];
    for (const r of sessions) add(r.day, toUsdt(r.v, r.currency) * 0.5);

    const attParams: string[] = [];
    const attributed = db.prepare(`
      SELECT e.date AS day, COALESCE(SUM(e.amount_usdt), 0) AS v
      FROM grindhouse_expenses e
      JOIN grindhouse_grinders gg ON gg.player_id = e.player_id AND gg.status = 'active'
      WHERE e.type = 'grind'${range("e.date", attParams)}
      GROUP BY day
    `).all(...attParams) as { day: string; v: number }[];
    for (const r of attributed) add(r.day, -r.v * 0.5);

    const feeParams: string[] = [];
    const agencyFees = db.prepare(`
      SELECT e.date AS day, COALESCE(SUM(e.amount_usdt), 0) AS v
      FROM grindhouse_expenses e
      WHERE ((e.player_id IS NULL AND e.type = 'grind') OR e.type IN ('resto', 'autre'))${range("e.date", feeParams)}
      GROUP BY day
    `).all(...feeParams) as { day: string; v: number }[];
    for (const r of agencyFees) add(r.day, -r.v);

    return [...dayMap.entries()]
      .map(([date, net]) => ({ date, net }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return []; // grindhouse tables absent on fresh DB before migration
  }
}

// D-ter) Per-grinder grindhouse profitability for ONE player — the same per-grinder math as the
// /grindhouse/dashboard breakdown rows (app/api/grindhouse-profitability/route.ts). Reused on the
// CRM player page. Returns sessions P&L ("winnings") and the agency share for THIS grinder only.
//   sessions_pnl_usdt = Σ_currency toUsdt(SUM(net_result_usdt), currency)  (rates per invariant #3;
//     currencies with no configured rate are EXCLUDED and reported in `unconverted`, never summed raw)
//   agency_share_usdt = poolNet - (poolNet * 0.5), poolNet = sessions_pnl_usdt - attributed grind fees
// NOTE: the 50/50 split is HARDCODED to 0.5 to match the dashboard route exactly (it ignores
// grindhouse_grinders.deal_percentage). The per-grinder agency share does NOT include the global
// general-grind / resto / autre fees (those are agency-level, subtracted once in getGrindhouseAgencyNet).
export interface GrinderProfitability {
  is_grinder: boolean;
  sessions_pnl_usdt: number;   // "Winnings grindhouse"
  agency_share_usdt: number;   // "P&L agence (grindhouse)"
  grind_fees_usdt: number;     // attributed 'grind' expenses for this grinder
  hours: number;
  unconverted: { currency: string; pnl: number; hours: number }[]; // excluded from USDT (no rate)
}
export function getGrinderProfitability(playerId: number, period?: Period): GrinderProfitability {
  const empty: GrinderProfitability = { is_grinder: false, sessions_pnl_usdt: 0, agency_share_usdt: 0, grind_fees_usdt: 0, hours: 0, unconverted: [] };
  const db = getDb();
  try {
    const isGrinder = !!db.prepare(`SELECT 1 FROM grindhouse_grinders WHERE player_id = ?`).get(playerId);
    if (!isGrinder) return empty;

    const from = period?.from ?? "2020-01-01";
    const to = period?.to ?? new Date().toISOString().slice(0, 10);

    const perCur = db.prepare(`
      SELECT COALESCE(gm.currency, 'USDT') AS currency,
             COALESCE(SUM(s.net_result_usdt), 0) AS pnl,
             COALESCE(SUM(s.duration_hours), 0) AS hours
      FROM grindhouse_sessions s
      JOIN games gm ON gm.id = s.game_id
      WHERE s.player_id = ? AND s.session_date >= ? AND s.session_date <= ?
      GROUP BY currency
    `).all(playerId, from, to) as { currency: string; pnl: number; hours: number }[];

    let pnl = 0;
    const unconverted: { currency: string; pnl: number; hours: number }[] = [];
    for (const r of perCur) {
      if (r.currency === "USDT" || getExchangeRate(r.currency) > 0) pnl += toUsdt(r.pnl, r.currency);
      else unconverted.push({ currency: r.currency, pnl: r.pnl, hours: r.hours });
    }
    const hours = perCur.reduce((s, r) => s + r.hours, 0);

    const grindFees = (db.prepare(`SELECT COALESCE(SUM(amount_usdt), 0) AS v FROM grindhouse_expenses WHERE player_id = ? AND type = 'grind' AND date >= ? AND date <= ?`).get(playerId, from, to) as any).v;
    const poolNet = pnl - grindFees;
    const share = poolNet * 0.5;

    return { is_grinder: true, sessions_pnl_usdt: pnl, agency_share_usdt: poolNet - share, grind_fees_usdt: grindFees, hours, unconverted };
  } catch {
    return empty; // grindhouse tables absent on fresh DB before migration
  }
}

// Daily decomposition of getGrinderProfitability.agency_share_usdt for ONE grinder — per-grinder
// analog of getGrindhouseNetOverTime, WITHOUT the global agency fees (general-grind/resto/autre),
// since those aren't attributable to a single grinder. Linear, so the sum over the period equals
// getGrinderProfitability(playerId, period).agency_share_usdt. Feeds the CRM agency-cut graph.
export function getGrinderNetOverTime(playerId: number, period?: Period): GrindhouseDailyNet[] {
  const db = getDb();
  try {
    const isGrinder = !!db.prepare(`SELECT 1 FROM grindhouse_grinders WHERE player_id = ?`).get(playerId);
    if (!isGrinder) return [];
    const from = period?.from ?? "2020-01-01";
    const to = period?.to ?? new Date().toISOString().slice(0, 10);
    const dayMap = new Map<string, number>();
    const add = (d: string, v: number) => dayMap.set(d, (dayMap.get(d) ?? 0) + v);

    // Sessions per day per currency → toUsdt (rate-missing → 0, matching getGrinderProfitability) × 0.5
    const sess = db.prepare(`
      SELECT s.session_date AS day, COALESCE(gm.currency, 'USDT') AS currency, COALESCE(SUM(s.net_result_usdt), 0) AS v
      FROM grindhouse_sessions s
      JOIN games gm ON gm.id = s.game_id
      WHERE s.player_id = ? AND s.session_date >= ? AND s.session_date <= ?
      GROUP BY day, currency
    `).all(playerId, from, to) as { day: string; currency: string; v: number }[];
    for (const r of sess) add(r.day, toUsdt(r.v, r.currency) * 0.5);

    // Attributed 'grind' fees per day → −0.5 (the grinder eats half of their attributed grind fees)
    const att = db.prepare(`
      SELECT e.date AS day, COALESCE(SUM(e.amount_usdt), 0) AS v
      FROM grindhouse_expenses e
      WHERE e.player_id = ? AND e.type = 'grind' AND e.date >= ? AND e.date <= ?
      GROUP BY day
    `).all(playerId, from, to) as { day: string; v: number }[];
    for (const r of att) add(r.day, -r.v * 0.5);

    return [...dayMap.entries()].map(([date, net]) => ({ date, net })).sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

// E) Total agency P&L across all games
export interface AgencyTotalPnL {
  total_usdt: number;
  games_usdt: number;          // game agency cuts only (no extras, no grindhouse)
  extras_usdt: number;         // all agency extras, USDT
  grindhouse_usdt: number;     // grindhouse agency net ("Rentabilité nette")
  akpoker_usdt: number;
  akpoker_extras_usdt: number;
  kkpoker_usdt: number;
  kkpoker_extras_usdt: number;
  a5poker_usdt: number;
  a5poker_extras_usdt: number;
  aks_usdt: number;
  aks_extras_usdt: number;
  nutspk_usdt: number;
  nutspk_extras_usdt: number;
  wepoker_cny: number;
  wepoker_extras_cny: number;
  wepoker_usdt: number;
}
// NOTE: the games summed here define the agency P&L scope — keep aligned with AGENCY_GAMES /
// getPlayerPnLAllGames (CRM player page) and getTopContributors so all four stay consistent.
export function getAgencyTotalPnL(period?: Period): AgencyTotalPnL {
  const ak = getAkpokerPnL(undefined, period);
  const kk = getKkpokerPnL(undefined, period);
  const a5 = getA5pokerPnL(undefined, period);
  const aks = getAksPnL(undefined, period);
  const nutspk = getNutspkPnL(undefined, period);
  const wp = getWepokerPnL(undefined, period);
  const akTotal = ak.reduce((s, r) => s + r.agency_cut_usdt, 0);
  const kkTotal = kk.reduce((s, r) => s + r.agency_cut_usdt, 0);
  const a5Total = a5.reduce((s, r) => s + r.agency_cut_usdt, 0);
  const aksTotal = aks.reduce((s, r) => s + r.agency_cut_usdt, 0);
  const nutspkTotal = nutspk.reduce((s, r) => s + r.agency_cut_usdt, 0);
  const wpTotalCny = wp.reduce((s, r) => s + r.total_agency_cny, 0);
  const wpTotalUsdt = wp.reduce((s, r) => s + r.total_agency_usdt, 0);
  const akExtras = getAgencyExtrasNet("akpoker", period);
  const kkExtras = getAgencyExtrasNet("kkpoker", period);
  const a5Extras = getAgencyExtrasNet("a5poker", period);
  const aksExtras = getAgencyExtrasNet("aks", period);
  const nutspkExtras = getAgencyExtrasNet("nutspk", period);
  const wpExtrasCny = getAgencyExtrasNet("wepoker", period);
  const rate = getCnyRate();
  const wpExtrasUsdt = convertCnyToUsdt(wpExtrasCny, rate);
  const grindhouse = getGrindhouseAgencyNet(period);
  const gamesUsdt = akTotal + kkTotal + a5Total + aksTotal + nutspkTotal + wpTotalUsdt;
  const extrasUsdt = akExtras + kkExtras + a5Extras + aksExtras + nutspkExtras + wpExtrasUsdt;
  return {
    total_usdt: gamesUsdt + extrasUsdt + grindhouse,
    games_usdt: gamesUsdt,
    extras_usdt: extrasUsdt,
    grindhouse_usdt: grindhouse,
    akpoker_usdt: akTotal + akExtras,
    akpoker_extras_usdt: akExtras,
    kkpoker_usdt: kkTotal + kkExtras,
    kkpoker_extras_usdt: kkExtras,
    a5poker_usdt: a5Total + a5Extras,
    a5poker_extras_usdt: a5Extras,
    aks_usdt: aksTotal + aksExtras,
    aks_extras_usdt: aksExtras,
    nutspk_usdt: nutspkTotal + nutspkExtras,
    nutspk_extras_usdt: nutspkExtras,
    wepoker_cny: wpTotalCny + wpExtrasCny,
    wepoker_extras_cny: wpExtrasCny,
    wepoker_usdt: wpTotalUsdt + wpExtrasUsdt,
  };
}

// E) Active player count in a period
export function getActivePlayersCount(period: Period): number {
  const db = getDb();
  const { since, until } = periodToDateRange(period);
  let akCount = 0;
  let wpCount = 0;

  if (since && until) {
    akCount = (db.prepare(`
      SELECT COUNT(DISTINCT wt.player_id) AS n
      FROM wallet_transactions wt
      JOIN games g ON g.id = wt.game_id AND LOWER(g.name) = 'tele'
      WHERE wt.tx_datetime >= ? AND wt.tx_datetime <= ?
        AND (wt.source IS NULL OR wt.source != 'unknown')
    `).get(since, until) as { n: number }).n;
  }

  if (period.from && period.to) {
    wpCount = (db.prepare(`
      SELECT COUNT(DISTINCT re.player_id) AS n
      FROM rakeback_entries re
      JOIN rakeback_reports rr ON rr.id = re.report_id
      WHERE COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) >= ?
        AND COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) <= ?
        AND re.player_id IS NOT NULL
    `).get(period.from, period.to) as { n: number }).n;
  }

  const combined = new Set<number>();
  if (since && until) {
    const walletPlayers = db.prepare(`
      SELECT DISTINCT wt.player_id FROM wallet_transactions wt
      WHERE wt.tx_datetime >= ? AND wt.tx_datetime <= ?
        AND (wt.source IS NULL OR wt.source != 'unknown')
    `).all(since, until) as { player_id: number }[];
    walletPlayers.forEach(r => combined.add(r.player_id));
  }
  if (period.from && period.to) {
    const wpPlayers = db.prepare(`
      SELECT DISTINCT re.player_id FROM rakeback_entries re
      JOIN rakeback_reports rr ON rr.id = re.report_id
      WHERE COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) >= ?
        AND COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) <= ?
        AND re.player_id IS NOT NULL
    `).all(period.from, period.to) as { player_id: number }[];
    wpPlayers.forEach(r => combined.add(r.player_id));
  }

  return combined.size;
}

// E-bis) Canonical agency-games config + per-player P&L across all of them.
//
// IMPORTANT — this is the SINGLE source of truth for "which games count toward agency P&L".
// It is NOT the full `games` table: Xpoker / ClubGG / AAPKMY exist in `games` but are
// deliberately EXCLUDED from agency aggregates (no deal/settlement flow, not in net worth).
// Deriving the list from `games WHERE status='active'` would over-include them and break the
// invariant that "CRM player total == Top Contributors == per-game pages == net worth".
//
// To add a game to agency P&L: add ONE entry here.
//   kind 'wallet'  → wallet-based USDT P&L via getWalletSummaryByPlayer (action_pct on net)
//   kind 'wepoker' → rakeback-based CNY P&L via getWepokerPnL (3-component, converted to USDT)
// Keep getAgencyTotalPnL (net worth card) and getTopContributors in sync with this list.
//   kind 'staking' → QQPK staking model. Phase 1: contributes 0 to net worth (the real
//     C/T-based agency P&L is wired in Phase 5). It is NOT summed in getAgencyTotalPnL
//     (hardcoded list) and is excluded from getPlayerAgencyCutSeries (wallet-only filter);
//     in getPlayerPnLAllGames it falls through the wallet branch, but the seeded deal has
//     action_pct=0 so the agency cut is 0 — only the raw net is surfaced for display.
export type AgencyGameKind = "wallet" | "wepoker" | "staking";
export interface AgencyGameConfig {
  key: string;        // games.name, matched EXACTLY (case-sensitive in getWalletSummaryByPlayer)
  label: string;      // user-facing label
  kind: AgencyGameKind;
  basePath: string;   // route base; links use `${basePath}/pnl` and `${basePath}/settlements`
  archived?: boolean; // kept for historical P&L even though archived (e.g. AKPOKER/TELE)
}
export const AGENCY_GAMES: AgencyGameConfig[] = [
  { key: "TELE",    label: "AKPOKER", kind: "wallet",  basePath: "/akpoker", archived: true },
  { key: "KKPOKER", label: "KKPOKER", kind: "wallet",  basePath: "/kkpoker" },
  { key: "A5POKER", label: "A5POKER", kind: "wallet",  basePath: "/a5poker" },
  { key: "AKS",     label: "AKS",     kind: "wallet",  basePath: "/aks" },
  { key: "NUTSPK",  label: "NUTSPK",  kind: "wallet",  basePath: "/nutspk" },
  { key: "QQPK",    label: "QQPK",    kind: "staking", basePath: "/qqpk" },
  { key: "Wepoker", label: "WEPOKER", kind: "wepoker", basePath: "/wepoker" },
];

// Generic per-player wallet P&L for ONE game — same math as getAkpokerPnL/getKkpokerPnL/etc
// (those are thin wrappers over getWalletSummaryByPlayer with a hard-coded game_name), so this
// stays byte-for-byte consistent with Top Contributors and the per-game P&L pages.
function walletPlayerPnL(gameKey: string, playerId: number, period?: Period): AkpokerPnLRow | undefined {
  const { since, until } = periodToDateRange(period);
  const rows = getWalletSummaryByPlayer({ game_name: gameKey, since_date: since, end_date: until }) as any[];
  const r = rows.find((x) => x.player_id === playerId);
  if (!r) return undefined;
  return {
    player_id: r.player_id, player_name: r.player_name, action_pct: r.action_pct ?? 0,
    deposited: r.total_deposited ?? 0, withdrawn: r.total_withdrawn ?? 0,
    net_usdt: r.net ?? 0, agency_cut_usdt: r.my_pnl ?? 0,
  };
}

export interface PlayerGamePnL {
  game_key: string; label: string; kind: AgencyGameKind; basePath: string; archived: boolean;
  has_deal: boolean;
  deal: any | null;                 // player_game_deals row (action_pct, rakeback_pct, insurance_pct, start_date)
  currency: string;                 // player-side display currency: "USDT" | "CNY"
  player_pnl_all: number; player_pnl_30d: number; player_pnl_7d: number;   // in `currency`
  agency_cut_usdt_all: number; agency_cut_usdt_30d: number; agency_cut_usdt_7d: number; // USDT (net-worth contribution)
  deposited: number; withdrawn: number;
  // wepoker-only breakdown (CNY), null for wallet games
  wp: {
    agency_cut_cny: number; agency_cut_usdt: number;
    agency_winnings_cny: number; agency_rakeback_cny: number; agency_insurance_cny: number;
    winnings_cny: number; rake_cny: number; insurance_cny: number;
  } | null;
}
export interface PlayerPnLAllGames {
  games: PlayerGamePnL[];           // only games where the player has a deal or any activity
  // Per-player grindhouse agency share (= getGrinderProfitability.agency_share_usdt), 0 if not a grinder.
  grindhouse_usdt_all: number;
  grindhouse_usdt_30d: number;
  grindhouse_usdt_7d: number;
  // Per-player agency cut = the 5 poker games + grindhouse share, for each window. By design this
  // matches getTopContributors (which now also adds the per-grinder grind share) for the same period,
  // so the CRM card / graph endpoint == the player's Top Contributors row.
  // NOTE: summed across all players this does NOT equal getAgencyTotalPnL.total_usdt — the per-player
  // grind share is GROSS of the global general-grind/resto/autre fees (operator-level, not attributable
  // to one grinder), and agency_extras are operator-level too. Same class of gap as extras.
  total_agency_usdt_all: number;
  total_agency_usdt_30d: number;
  total_agency_usdt_7d: number;     // == this player's getTopContributors row for {from:d7,to:today}
}

// Config-driven player P&L across ALL agency games (see AGENCY_GAMES). Reuses the exact same
// underlying functions as the per-game pages and Top Contributors, so totals are consistent
// by construction. Used by the CRM player page (/crm/[id]).
export function getPlayerPnLAllGames(playerId: number): PlayerPnLAllGames {
  const today = new Date().toISOString().slice(0, 10);
  const d7 = daysAgo(7);
  const d30 = daysAgo(30);
  const p30: Period = { from: d30, to: today };
  const p7: Period = { from: d7, to: today };

  const games: PlayerGamePnL[] = [];
  let total_all = 0, total_30 = 0, total_7 = 0;

  for (const cfg of AGENCY_GAMES) {
    const deal = getPlayerDealsForGame(playerId, cfg.key) ?? null;
    let row: PlayerGamePnL;

    if (cfg.kind === "wepoker") {
      const all = getWepokerPnL(playerId)[0];
      const r30 = getWepokerPnL(playerId, p30)[0];
      const r7 = getWepokerPnL(playerId, p7)[0];
      row = {
        game_key: cfg.key, label: cfg.label, kind: cfg.kind, basePath: cfg.basePath, archived: !!cfg.archived,
        has_deal: !!deal, deal, currency: "CNY",
        player_pnl_all: all?.player_pnl_cny ?? 0, player_pnl_30d: r30?.player_pnl_cny ?? 0, player_pnl_7d: r7?.player_pnl_cny ?? 0,
        agency_cut_usdt_all: all?.total_agency_usdt ?? 0, agency_cut_usdt_30d: r30?.total_agency_usdt ?? 0, agency_cut_usdt_7d: r7?.total_agency_usdt ?? 0,
        deposited: 0, withdrawn: 0,
        wp: all ? {
          agency_cut_cny: all.total_agency_cny, agency_cut_usdt: all.total_agency_usdt,
          agency_winnings_cny: all.agency_winnings_split_cny, agency_rakeback_cny: all.agency_rakeback_split_cny, agency_insurance_cny: all.agency_insurance_split_cny,
          winnings_cny: all.winnings_cny, rake_cny: all.rake_cny, insurance_cny: all.insurance_cny,
        } : null,
      };
    } else {
      const all = walletPlayerPnL(cfg.key, playerId);
      const r30 = walletPlayerPnL(cfg.key, playerId, p30);
      const r7 = walletPlayerPnL(cfg.key, playerId, p7);
      row = {
        game_key: cfg.key, label: cfg.label, kind: cfg.kind, basePath: cfg.basePath, archived: !!cfg.archived,
        has_deal: !!deal, deal, currency: "USDT",
        player_pnl_all: all?.net_usdt ?? 0, player_pnl_30d: r30?.net_usdt ?? 0, player_pnl_7d: r7?.net_usdt ?? 0,
        agency_cut_usdt_all: all?.agency_cut_usdt ?? 0, agency_cut_usdt_30d: r30?.agency_cut_usdt ?? 0, agency_cut_usdt_7d: r7?.agency_cut_usdt ?? 0,
        deposited: all?.deposited ?? 0, withdrawn: all?.withdrawn ?? 0,
        wp: null,
      };
    }

    total_all += row.agency_cut_usdt_all;
    total_30 += row.agency_cut_usdt_30d;
    total_7 += row.agency_cut_usdt_7d;

    // Include the game if the player has a deal OR any recorded activity in it.
    const hasActivity = row.player_pnl_all !== 0 || row.agency_cut_usdt_all !== 0 || row.deposited !== 0 || row.withdrawn !== 0;
    if (row.has_deal || hasActivity) games.push(row);
  }

  // Grindhouse agency share (per grinder) — included in the player's agency-cut total so the CRM
  // card / graph endpoint == Top Contributors row (which also adds it). 0 for non-grinders.
  const gAll = getGrinderProfitability(playerId).agency_share_usdt;
  const g30 = getGrinderProfitability(playerId, p30).agency_share_usdt;
  const g7 = getGrinderProfitability(playerId, p7).agency_share_usdt;
  total_all += gAll;
  total_30 += g30;
  total_7 += g7;

  return {
    games,
    grindhouse_usdt_all: gAll, grindhouse_usdt_30d: g30, grindhouse_usdt_7d: g7,
    total_agency_usdt_all: total_all, total_agency_usdt_30d: total_30, total_agency_usdt_7d: total_7,
  };
}

// Daily cumulative AGENCY CUT (operator's share) for one player, ALL agency games combined, in USDT.
// Mirrors getPnLOverTime's per-game math but scoped to a single player and summed into one series.
// CRITICAL: action_pct is INSIDE the SUM (per-tx weighting) — same correct math as the getPnLOverTime
// fix; do NOT pull it out (that reintroduced the GROUP BY bug). The last cumulative point over the
// full period equals getPlayerPnLAllGames.total_agency_usdt_* for the same period (action_pct is
// constant within a player+game), which == the player's getTopContributors row / net-worth share.
// Output shape matches getNetPnlSeries so the existing NetPnlChart consumes it unchanged.
export function getPlayerAgencyCutSeries(playerId: number, period?: Period): { day: string; cumulative_net: number }[] {
  const db = getDb();
  const { since, until } = periodToDateRange(period);
  const rate = getCnyRate();
  const dayMap = new Map<string, number>(); // day (YYYY-MM-DD) -> agency cut USDT that day

  // Wallet games (USDT): per-tx net × that player's action_pct, summed per day.
  for (const cfg of AGENCY_GAMES.filter((g) => g.kind === "wallet")) {
    const rows = db.prepare(`
      SELECT substr(wt.tx_datetime, 1, 10) AS day,
        COALESCE(SUM((CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END) * pgd.action_pct / 100.0), 0) AS agency
      FROM wallet_transactions wt
      JOIN player_game_deals pgd ON pgd.player_id = wt.player_id AND pgd.game_id = wt.game_id
      JOIN games g ON g.id = wt.game_id AND g.name = ?
      WHERE wt.player_id = ?
        AND (wt.source IS NULL OR wt.source != 'unknown')
        AND (pgd.start_date IS NULL OR wt.tx_datetime >= pgd.start_date)
        AND (pgd.end_date IS NULL OR wt.tx_datetime <= pgd.end_date)
        ${since ? "AND wt.tx_datetime >= ?" : ""}
        ${until ? "AND wt.tx_datetime <= ?" : ""}
      GROUP BY day
    `).all(...[cfg.key, playerId, since, until].filter((v) => v !== undefined)) as { day: string; agency: number }[];
    for (const r of rows) dayMap.set(r.day, (dayMap.get(r.day) ?? 0) + r.agency);
  }

  // Wepoker (CNY, 3-component) → converted to USDT per day (linear, so daily-then-convert == total).
  const wp = db.prepare(`
    SELECT COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) AS day,
      COALESCE(SUM(re.winnings_amount * COALESCE(pgd.action_pct, 0) / 100.0), 0) AS wl,
      COALESCE(SUM(re.amount * COALESCE(pgd.rakeback_pct, 0) / 100.0), 0) AS rb,
      COALESCE(SUM(re.insurance_amount * COALESCE(pgd.insurance_pct, 0) / 100.0), 0) AS ins
    FROM rakeback_entries re
    JOIN rakeback_reports rr ON rr.id = re.report_id
    LEFT JOIN player_game_deals pgd ON pgd.player_id = re.player_id AND pgd.game_id = rr.game_id
    WHERE re.player_id = ?
      AND (pgd.start_date IS NULL OR COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) >= pgd.start_date)
      ${period?.from ? "AND COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) >= ?" : ""}
      ${period?.to ? "AND COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) <= ?" : ""}
    GROUP BY day
  `).all(...[playerId, period?.from, period?.to].filter((v) => v !== undefined)) as { day: string; wl: number; rb: number; ins: number }[];
  for (const r of wp) {
    const usdt = convertCnyToUsdt(r.wl + r.rb + r.ins, rate);
    dayMap.set(r.day, (dayMap.get(r.day) ?? 0) + usdt);
  }

  // Grindhouse agency share per day (per grinder, no global fees). Sum == getGrinderProfitability
  // for the period → keeps the curve endpoint == getPlayerPnLAllGames total (poker + grind).
  for (const r of getGrinderNetOverTime(playerId, period)) {
    dayMap.set(r.date, (dayMap.get(r.date) ?? 0) + r.net);
  }

  let cum = 0;
  return [...dayMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, v]) => { cum += v; return { day, cumulative_net: cum }; });
}

// F) Top contributors by agency cut
// NOTE: scope must stay aligned with AGENCY_GAMES / getPlayerPnLAllGames — a player's row here
// == their getPlayerPnLAllGames total for the same period (5 poker games + per-grinder grind share).
export interface ContributorRow {
  player_id: number; player_name: string; agency_usdt: number;
  akpoker_usdt: number; kkpoker_usdt: number; a5poker_usdt: number; aks_usdt: number; nutspk_usdt: number; wepoker_usdt: number;
  grindhouse_usdt: number;
}
export function getTopContributors(period: Period, limit = 5): ContributorRow[] {
  const ak = getAkpokerPnL(undefined, period);
  const kk = getKkpokerPnL(undefined, period);
  const a5 = getA5pokerPnL(undefined, period);
  const aks = getAksPnL(undefined, period);
  const nutspk = getNutspkPnL(undefined, period);
  const wp = getWepokerPnL(undefined, period);

  const byPlayer = new Map<number, ContributorRow>();
  const get = (r: { player_id: number; player_name: string }) =>
    byPlayer.get(r.player_id) ?? { player_id: r.player_id, player_name: r.player_name, agency_usdt: 0, akpoker_usdt: 0, kkpoker_usdt: 0, a5poker_usdt: 0, aks_usdt: 0, nutspk_usdt: 0, wepoker_usdt: 0, grindhouse_usdt: 0 };
  for (const r of ak) {
    const e = get(r); e.akpoker_usdt += r.agency_cut_usdt; e.agency_usdt += r.agency_cut_usdt; byPlayer.set(r.player_id, e);
  }
  for (const r of kk) {
    const e = get(r); e.kkpoker_usdt += r.agency_cut_usdt; e.agency_usdt += r.agency_cut_usdt; byPlayer.set(r.player_id, e);
  }
  for (const r of a5) {
    const e = get(r); e.a5poker_usdt += r.agency_cut_usdt; e.agency_usdt += r.agency_cut_usdt; byPlayer.set(r.player_id, e);
  }
  for (const r of aks) {
    const e = get(r); e.aks_usdt += r.agency_cut_usdt; e.agency_usdt += r.agency_cut_usdt; byPlayer.set(r.player_id, e);
  }
  for (const r of nutspk) {
    const e = get(r); e.nutspk_usdt += r.agency_cut_usdt; e.agency_usdt += r.agency_cut_usdt; byPlayer.set(r.player_id, e);
  }
  for (const r of wp) {
    const e = get(r); e.wepoker_usdt += r.total_agency_usdt; e.agency_usdt += r.total_agency_usdt; byPlayer.set(r.player_id, e);
  }

  // Grindhouse per-grinder agency share (any status, to match getPlayerPnLAllGames on the CRM fiche).
  // getGrinderProfitability defaults to lifetime when period has no from/to — pass through the period.
  try {
    const grinders = getDb().prepare(`SELECT gg.player_id, p.name FROM grindhouse_grinders gg JOIN players p ON p.id = gg.player_id`).all() as { player_id: number; name: string }[];
    for (const g of grinders) {
      const share = getGrinderProfitability(g.player_id, period).agency_share_usdt;
      if (share === 0) continue;
      const e = get({ player_id: g.player_id, player_name: g.name });
      e.grindhouse_usdt += share; e.agency_usdt += share; byPlayer.set(g.player_id, e);
    }
  } catch { /* grindhouse tables absent on fresh DB before migration */ }

  return [...byPlayer.values()].sort((a, b) => b.agency_usdt - a.agency_usdt).slice(0, limit);
}

// G) P&L time series for charts
export interface PnLTimePoint {
  date: string; akpoker_usdt: number; kkpoker_usdt: number; a5poker_usdt: number; aks_usdt: number; nutspk_usdt: number; wepoker_usdt: number; grindhouse_usdt: number; total_usdt: number;
}
export function getPnLOverTime(period: Period): PnLTimePoint[] {
  const db = getDb();
  const { since, until } = periodToDateRange(period);

  const walletDailyByGame = (gameName: string) => db.prepare(`
    SELECT substr(wt.tx_datetime, 1, 10) AS day,
      COALESCE(SUM((CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END) * pgd.action_pct / 100.0), 0) AS agency
    FROM wallet_transactions wt
    JOIN player_game_deals pgd ON pgd.player_id = wt.player_id AND pgd.game_id = wt.game_id
    JOIN games g ON g.id = wt.game_id AND LOWER(g.name) = LOWER(?)
    WHERE (wt.source IS NULL OR wt.source != 'unknown')
      AND (pgd.start_date IS NULL OR wt.tx_datetime >= pgd.start_date)
      AND (pgd.end_date IS NULL OR wt.tx_datetime <= pgd.end_date)
      ${since ? "AND wt.tx_datetime >= ?" : ""}
      ${until ? "AND wt.tx_datetime <= ?" : ""}
    GROUP BY day ORDER BY day
  `).all(...[gameName, since, until].filter(Boolean)) as { day: string; agency: number }[];

  const akDaily = walletDailyByGame("TELE");
  const kkDaily = walletDailyByGame("KKPOKER");
  const a5Daily = walletDailyByGame("A5POKER");
  const aksDaily = walletDailyByGame("AKS");
  const nutspkDaily = walletDailyByGame("NUTSPK");

  const rate = getCnyRate();
  const wpDaily = db.prepare(`
    SELECT COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) AS day,
      COALESCE(SUM(re.winnings_amount * COALESCE(pgd.action_pct, 0) / 100.0), 0) AS wl_agency,
      COALESCE(SUM(re.amount * COALESCE(pgd.rakeback_pct, 0) / 100.0), 0) AS rb_agency,
      COALESCE(SUM(re.insurance_amount * COALESCE(pgd.insurance_pct, 0) / 100.0), 0) AS ins_agency
    FROM rakeback_entries re
    JOIN rakeback_reports rr ON rr.id = re.report_id
    LEFT JOIN player_game_deals pgd ON pgd.player_id = re.player_id AND pgd.game_id = rr.game_id
    WHERE re.player_id IS NOT NULL
      AND (pgd.start_date IS NULL OR COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) >= pgd.start_date)
      ${period?.from ? "AND COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) >= ?" : ""}
      ${period?.to ? "AND COALESCE(rr.report_date, substr(rr.created_at, 1, 10)) <= ?" : ""}
    GROUP BY day ORDER BY day
  `).all(...[period?.from, period?.to].filter(Boolean)) as any[];

  const dayMap = new Map<string, PnLTimePoint>();
  const getDay = (day: string) => dayMap.get(day) ?? { date: day, akpoker_usdt: 0, kkpoker_usdt: 0, a5poker_usdt: 0, aks_usdt: 0, nutspk_usdt: 0, wepoker_usdt: 0, grindhouse_usdt: 0, total_usdt: 0 };
  for (const r of akDaily) {
    const e = getDay(r.day); e.akpoker_usdt += r.agency; e.total_usdt += r.agency; dayMap.set(r.day, e);
  }
  for (const r of kkDaily) {
    const e = getDay(r.day); e.kkpoker_usdt += r.agency; e.total_usdt += r.agency; dayMap.set(r.day, e);
  }
  for (const r of a5Daily) {
    const e = getDay(r.day); e.a5poker_usdt += r.agency; e.total_usdt += r.agency; dayMap.set(r.day, e);
  }
  for (const r of aksDaily) {
    const e = getDay(r.day); e.aks_usdt += r.agency; e.total_usdt += r.agency; dayMap.set(r.day, e);
  }
  for (const r of nutspkDaily) {
    const e = getDay(r.day); e.nutspk_usdt += r.agency; e.total_usdt += r.agency; dayMap.set(r.day, e);
  }
  for (const r of wpDaily) {
    const wpUsdt = convertCnyToUsdt(r.wl_agency + r.rb_agency + r.ins_agency, rate);
    const e = getDay(r.day); e.wepoker_usdt += wpUsdt; e.total_usdt += wpUsdt; dayMap.set(r.day, e);
  }

  // Add agency extras to the time series
  for (const gk of ["akpoker", "kkpoker", "a5poker", "aks", "nutspk", "wepoker"] as const) {
    const extras = getAgencyExtras(gk, period);
    const isCny = gk === "wepoker";
    for (const ex of extras) {
      const day = ex.recorded_at.slice(0, 10);
      const raw = ex.type === "win" ? ex.amount : -ex.amount;
      const val = isCny ? convertCnyToUsdt(raw, rate) : raw;
      const e = getDay(day);
      if (gk === "akpoker") e.akpoker_usdt += val;
      else if (gk === "kkpoker") e.kkpoker_usdt += val;
      else if (gk === "a5poker") e.a5poker_usdt += val;
      else if (gk === "aks") e.aks_usdt += val;
      else if (gk === "nutspk") e.nutspk_usdt += val;
      else e.wepoker_usdt += val;
      e.total_usdt += val;
      dayMap.set(day, e);
    }
  }

  // Grindhouse agency net per day (sessions, fees — see getGrindhouseNetOverTime)
  for (const r of getGrindhouseNetOverTime(period)) {
    const e = getDay(r.date); e.grindhouse_usdt += r.net; e.total_usdt += r.net; dayMap.set(r.date, e);
  }

  return [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// H) War Room ops feed — READ-ONLY aggregation of recent agency events
export interface OpsFeedEvent {
  ts: string;                                              // "YYYY-MM-DD HH:MM:SS" UTC
  type: "session" | "settlement" | "gh_settle" | "expense" | "onboard";
  label: string;
  detail: string | null;
  amount: number | null;                                   // USDT, signed
}
export function getOpsFeed(limit = 20): OpsFeedEvent[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT s.created_at AS ts, 'session' AS type, p.name AS label,
             g.name AS detail, s.net_result_usdt AS amount,
             COALESCE(g.currency, 'USDT') AS currency
      FROM grindhouse_sessions s
      JOIN players p ON p.id = s.player_id
      JOIN games g ON g.id = s.game_id

      UNION ALL
      SELECT gs.paid_at, 'gh_settle', p.name,
             gs.period_start || ' → ' || gs.period_end, gs.grinder_share, 'USDT'
      FROM grindhouse_settlements gs
      JOIN players p ON p.id = gs.player_id
      WHERE gs.status = 'paid' AND gs.paid_at IS NOT NULL

      UNION ALL
      SELECT ws.received_at, 'settlement', p.name,
             'semaine ' || ws.week_start, ws.pnl_player, 'USDT'
      FROM weekly_settlements ws
      JOIN players p ON p.id = ws.player_id
      WHERE ws.payment_received = 1 AND ws.received_at IS NOT NULL

      UNION ALL
      SELECT e.created_at, 'expense', UPPER(e.type),
             e.description, -ABS(e.amount_usdt), 'USDT'
      FROM grindhouse_expenses e

      UNION ALL
      SELECT p.created_at, 'onboard', p.name, NULL, NULL, 'USDT'
      FROM players p
    )
    ORDER BY ts DESC
    LIMIT ?
  `).all(limit) as (OpsFeedEvent & { currency: string })[];
  // Feed amounts are displayed as USDT — convert non-USDT session amounts; if no rate is
  // configured, keep the raw amount but tag the currency in the detail (never mislabel).
  return rows.map(({ currency, ...r }) => {
    if (r.amount === null || currency === "USDT") return r;
    if (getExchangeRate(currency) > 0) return { ...r, amount: toUsdt(r.amount, currency) };
    return { ...r, detail: r.detail ? `${r.detail} · ${currency}` : currency };
  });
}

// I) War Room status line counts
export interface DashboardStatus {
  active_players: number;
  active_games: number;
  active_grinders: number;
}
export function getDashboardStatus(): DashboardStatus {
  const db = getDb();
  const active_players = (db.prepare(`SELECT COUNT(*) AS n FROM players WHERE status = 'active'`).get() as { n: number }).n;
  const active_games = (db.prepare(`SELECT COUNT(*) AS n FROM games WHERE status = 'active'`).get() as { n: number }).n;
  let active_grinders = 0;
  try {
    active_grinders = (db.prepare(`SELECT COUNT(*) AS n FROM grindhouse_grinders WHERE status = 'active'`).get() as { n: number }).n;
  } catch { /* table absent on fresh DB before migration */ }
  return { active_players, active_games, active_grinders };
}

// J) Grindhouse weekly grid — read-only aggregation per grinder × ISO week
export interface GrinderRow { player_id: number; name: string; }
export function getActiveGrinders(): GrinderRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT gg.player_id, p.name
    FROM grindhouse_grinders gg
    JOIN players p ON p.id = gg.player_id
    WHERE gg.status = 'active'
    ORDER BY p.name COLLATE NOCASE
  `).all() as GrinderRow[];
}

export interface GrindhouseWeekCell {
  player_id: number;
  week_start: string;          // Monday YYYY-MM-DD
  currency: string;            // game currency — one cell row per currency
  pnl: number;                 // raw amount in `currency`
  pnl_usdt: number;            // converted via toUsdt(); 0 when rate_missing
  rate_missing: boolean;       // non-USDT currency with no configured exchange rate
  hours: number;
  session_count: number;
  games_count: number;
}
export function getGrindhouseWeeklyCells(from: string, to: string): GrindhouseWeekCell[] {
  const db = getDb();
  // One row per player × week × currency, converted to USDT via toUsdt() (invariant #3).
  // Currencies without a configured rate get pnl_usdt=0 + rate_missing=true so the UI can
  // warn instead of silently dropping or raw-summing them.
  const rows = db.prepare(`
    SELECT s.player_id,
           date(s.session_date, '-' || ((CAST(strftime('%w', s.session_date) AS INTEGER) + 6) % 7) || ' days') AS week_start,
           COALESCE(g.currency, 'USDT') AS currency,
           SUM(s.net_result_usdt) AS pnl,
           COALESCE(SUM(s.duration_hours), 0) AS hours,
           COUNT(*) AS session_count,
           COUNT(DISTINCT s.game_id) AS games_count
    FROM grindhouse_sessions s
    JOIN games g ON g.id = s.game_id
    WHERE s.session_date >= ? AND s.session_date <= ?
    GROUP BY s.player_id, week_start, currency
  `).all(from, to) as Omit<GrindhouseWeekCell, "pnl_usdt" | "rate_missing">[];
  return rows.map(r => ({
    ...r,
    pnl_usdt: toUsdt(r.pnl, r.currency),
    rate_missing: r.currency !== "USDT" && getExchangeRate(r.currency) === 0,
  }));
}

// Per-session detail for the weekly modal (prefill, edit, delete)
export interface GrindhouseWeekSession {
  id: number;
  player_id: number;
  game_id: number;
  week_start: string;
  net_result_usdt: number;
  duration_hours: number;
  variant: string | null;
}
export function getGrindhouseWeeklySessions(from: string, to: string): GrindhouseWeekSession[] {
  const db = getDb();
  return db.prepare(`
    SELECT s.id, s.player_id, s.game_id,
           date(s.session_date, '-' || ((CAST(strftime('%w', s.session_date) AS INTEGER) + 6) % 7) || ' days') AS week_start,
           s.net_result_usdt, s.duration_hours, s.variant
    FROM grindhouse_sessions s
    WHERE s.session_date >= ? AND s.session_date <= ?
    ORDER BY s.id
  `).all(from, to) as GrindhouseWeekSession[];
}

// Distinct variants already logged — feeds the autocomplete datalist in the weekly modal
export function getGrindhouseVariants(): string[] {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT DISTINCT variant FROM grindhouse_sessions
      WHERE variant IS NOT NULL AND TRIM(variant) != ''
      ORDER BY variant COLLATE NOCASE
    `).all() as { variant: string }[];
    return rows.map(r => r.variant);
  } catch {
    return []; // variant column absent before add_session_variant_v1
  }
}

// Default game for the weekly quick-add: each grinder's most recent session's game
export function getGrinderDefaultGames(): Record<number, number> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT s1.player_id, s1.game_id
    FROM grindhouse_sessions s1
    WHERE s1.id = (
      SELECT s2.id FROM grindhouse_sessions s2
      WHERE s2.player_id = s1.player_id
      ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1
    )
  `).all() as { player_id: number; game_id: number }[];
  return Object.fromEntries(rows.map(r => [r.player_id, r.game_id]));
}


// ═══════════════════════════════════════════════════════════════════════════
// QQPK STAKING (Phase 4 + 4.5) — orchestration around the pure engine.
//
// INVARIANT #2: all money math for QQPK staking lives HERE (or in the pure engine
// lib/qqpk-staking-engine.ts). Server actions / pages stay thin. NOT wired into the
// dashboard / net worth yet (Phase 5).
//
// CYCLE MODEL (Phase 4.5 — per-player ROLLING cycle, NOT calendar month):
//   Each QQPK player has a cycle anchored on their onboarding date (start_date). A cycle
//   runs start_date+k months → start_date+(k+1) months (Europe/Paris, day clamped). Onboarded
//   the 12th → cycle 12 Jun → 11 Jul, settle on the 12th. The active cycle is the earliest
//   one not yet settled. The qqpk_staking_blocks.block_month column now holds the cycle-start
//   date 'YYYY-MM-DD' (a per-player cycle id), so UNIQUE(player_id, block_month) = one row/cycle.
//
// RESET SEC (Phase 4.5 — confirmed by Baki):
//   NO carry between cycles. Every cycle settles standalone with c_prec=0 / t_prec=0. A losing
//   cycle is covered 70% by the Cercle and then wiped — the Cercle absorbs its share, nothing
//   is carried into the next cycle. So reglement per cycle: loss → +0.70×|net| (Cercle pays),
//   gain → −0.30×net (player pays); 30k condition (mains<30000 & loss) → 0 (player bears 100%).
//
// Net (resultat_periode) is read with the canonical wallet math — getWalletSummaryByPlayer
// (withdrawals − deposits, source != 'unknown') — bounded to the cycle window.
// ═══════════════════════════════════════════════════════════════════════════

export interface QqpkCycle {
  player_start_date: string; // YYYY-MM-DD (Paris) onboarding anchor
  cycle_index: number;       // 0-based offset from the anchor
  cycle_start: string;       // YYYY-MM-DD (Paris) — the qqpk_staking_blocks.block_month key
  cycle_end_incl: string;    // YYYY-MM-DD (Paris) last day of the cycle (anniversary − 1 day)
  settle_date: string;       // YYYY-MM-DD (Paris) anniversary = échéance (settle on/after this)
  start_iso: string;         // UTC ISO inclusive start
  end_iso: string;           // UTC ISO inclusive end (anniversary 00:00:00 − 1s)
  due: boolean;              // now ≥ anniversary → cycle complete, settle due
  days_overdue: number;      // whole days past the anniversary (0 if not due)
}

export interface QqpkStakingRow {
  player_id: number;
  player_name: string;
  start_date: string;        // onboarding anchor
  cycle_start: string;
  cycle_end_incl: string;
  settle_date: string;
  due: boolean;
  days_overdue: number;
  resultat_periode: number;  // on-chain net for the cycle (withdrawals − deposits, USDT)
  mains: number;
  c: number;
  t: number;                 // settled position; for reset-sec this = T of the standalone cycle
  reglement: number;         // >0 Cercle pays player, <0 player pays Cercle
  condition_30k_applied: boolean;
  operator_pnl: number;      // −reglement (frozen sign convention)
  // PRÉVISIONNEL (engine projectStakingBlock — as-if-covered, 30k gate ignored).
  // On a settled cycle the projection is moot: fields carry the settled reality.
  reglement_projected: number;
  operator_pnl_projected: number; // −reglement_projected (Part Cercle prévisionnelle)
  // RB MANUEL (qqpk_cycle_rakeback) — owner-only revenue from the room, invisible player,
  // NEVER in the engine/settlement/lock. Optional so the settle/preview paths (which don't
  // carry it) stay byte-identical. Display-only additive line.
  rb_manual?: number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function parseYMD(d: string): { y: number; m: number; d: number } | null {
  const mm = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!mm) return null;
  return { y: +mm[1], m: +mm[2], d: +mm[3] };
}

// Normalize a stored date or UTC datetime to a Paris calendar date 'YYYY-MM-DD'.
function toParisCalDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;            // already a plain date
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T"); // SQLite 'YYYY-MM-DD HH:MM:SS' → ISO
  return toParisDate(iso);
}

// QQPK onboarding anchor for a player: earliest deal acceptance for QQPK (the true onboarding
// moment, once Phase 2 writes it) → else the QQPK deal start_date → else its created_at.
export function getQqpkPlayerStartDate(playerId: number): string | null {
  const db = getDb();
  const acc = db.prepare(
    `SELECT MIN(da.accepted_at) AS d
     FROM deal_acceptances da JOIN games g ON g.id = da.game_id AND g.name = 'QQPK'
     WHERE da.player_id = ?`
  ).get(playerId) as { d: string | null } | undefined;
  if (acc?.d) return toParisCalDate(acc.d);
  const deal = db.prepare(
    `SELECT pgd.start_date, pgd.created_at
     FROM player_game_deals pgd JOIN games g ON g.id = pgd.game_id AND g.name = 'QQPK'
     WHERE pgd.player_id = ?`
  ).get(playerId) as { start_date: string | null; created_at: string | null } | undefined;
  if (!deal) return null;
  const raw = deal.start_date ?? deal.created_at;
  return raw ? toParisCalDate(raw) : null;
}

function isQqpkCycleSettled(playerId: number, cycleKey: string): boolean {
  const row = getDb().prepare(
    `SELECT 1 FROM qqpk_staking_blocks WHERE player_id = ? AND block_month = ? AND status = 'settled'`
  ).get(playerId, cycleKey);
  return !!row;
}

function getQqpkStoredMains(playerId: number, cycleKey: string): number {
  const row = getDb().prepare(
    `SELECT mains FROM qqpk_staking_blocks WHERE player_id = ? AND block_month = ?`
  ).get(playerId, cycleKey) as { mains: number } | undefined;
  return row?.mains ?? 0;
}

function getQqpkBlockRow(playerId: number, cycleKey: string) {
  return getDb().prepare(
    `SELECT * FROM qqpk_staking_blocks WHERE player_id = ? AND block_month = ?`
  ).get(playerId, cycleKey) as any | undefined;
}

// The active (earliest unsettled) rolling cycle for a player, or null if no QQPK anchor.
export function getQqpkActiveCycle(playerId: number): QqpkCycle | null {
  const startStr = getQqpkPlayerStartDate(playerId);
  if (!startStr) return null;
  const s = parseYMD(startStr);
  if (!s) return null;

  const MAX = 600; // 50 years guard
  let k = 0;
  for (; k < MAX; k++) {
    const a = addMonthsParis(s.y, s.m, s.d, k);
    const key = `${a.year}-${pad2(a.month)}-${pad2(a.day)}`;
    if (!isQqpkCycleSettled(playerId, key)) break;
  }
  const a = addMonthsParis(s.y, s.m, s.d, k);
  const aNext = addMonthsParis(s.y, s.m, s.d, k + 1);
  const cycleStart = `${a.year}-${pad2(a.month)}-${pad2(a.day)}`;
  const settleDate = `${aNext.year}-${pad2(aNext.month)}-${pad2(aNext.day)}`;
  const startBound = parisLocalToUTC(a.year, a.month, a.day, 0, 0, 0, 0);
  const endExcl = parisLocalToUTC(aNext.year, aNext.month, aNext.day, 0, 0, 0, 0);
  const endIncl = new Date(endExcl.getTime() - 1000);
  const now = Date.now();
  const due = now >= endExcl.getTime();
  const days_overdue = due ? Math.floor((now - endExcl.getTime()) / 86400000) : 0;

  // SETTLE ANTICIPÉ / TX EN RETARD (GO Hugo 2026-07-22 — cas Antoine) : un cycle réglé
  // AVANT sa fin théorique fige son résultat à l'instant du settle ; les tx datées entre
  // ce settle et l'anniversaire suivant tombaient dans une zone morte (cycle précédent
  // immutable sans elles, cycle actif démarrant à l'anniversaire). Miroir de l'invariant
  // des settlements hebdo — une tx en retard appartient à la période ouverte suivante :
  // le cycle actif démarre au moment du dernier settle quand celui-ci précède
  // l'anniversaire. min() garantit zéro double comptage : un settle en retard a figé une
  // fenêtre bornée à l'anniversaire, donc on ne recule jamais au-delà de ce qui est déjà
  // compté. Le settle du cycle actif persistera cette borne dans block_start (fenêtre
  // élargie figée), donc la chaîne reste contiguë settle après settle.
  let startIso = toUTCISO(startBound);
  const prevSettle = getDb().prepare(
    `SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM qqpk_staking_blocks
     WHERE player_id = ? AND status = 'settled' AND block_month < ?`
  ).get(playerId, cycleStart) as { t: string | null } | undefined;
  if (prevSettle?.t) {
    const raw = prevSettle.t;
    const prevIso = raw.includes("T") ? raw : raw.replace(" ", "T") + (raw.endsWith("Z") ? "" : "Z");
    if (prevIso < startIso) startIso = prevIso;
  }

  return {
    player_start_date: startStr,
    cycle_index: k,
    cycle_start: cycleStart,
    cycle_end_incl: toParisDate(toUTCISO(endIncl)),
    settle_date: settleDate,
    start_iso: startIso,
    end_iso: toUTCISO(endIncl),
    due,
    days_overdue,
  };
}

// On-chain net for a player over a cycle window (canonical wallet math, bounded to the cycle).
function getQqpkCycleNet(playerId: number, startIso: string, endIso: string): number {
  const rows = getWalletSummaryByPlayer({ game_name: "QQPK", since_date: startIso, end_date: endIso }) as any[];
  const r = rows.find((x) => x.player_id === playerId);
  return r?.net ?? 0;
}

export interface QqpkCycleTx {
  id: number;
  tx_datetime: string | null;
  tx_date: string;
  type: "deposit" | "withdrawal";
  amount: number;
  source: string | null;
  tron_tx_hash: string | null;
}

// The transactions composing a cycle's résultat — DISPLAY-ONLY (never feeds the
// engine/settlement/lock). Filters mirror getWalletSummaryByPlayer's join for QQPK
// exactly (source != 'unknown', deal start/end bounds, tx_datetime window) so that
// Σ(withdrawals − deposits) of this list == the resultat_periode shown next to it
// for the ACTIVE cycle. Settled views re-query live over the stored block window:
// a tx imported after settle could appear in the list while the footer keeps the
// frozen engine snapshot (correct — the settled number is immutable).
export function getQqpkCycleTransactions(playerId: number, startIso: string, endIso: string): QqpkCycleTx[] {
  return getDb().prepare(`
    SELECT wt.id, wt.tx_datetime, wt.tx_date, wt.type, wt.amount, wt.source, wt.tron_tx_hash
    FROM wallet_transactions wt
    JOIN games g ON g.id = wt.game_id AND g.name = 'QQPK'
    JOIN player_game_deals pgd ON pgd.player_id = wt.player_id AND pgd.game_id = g.id
    WHERE wt.player_id = ?
      AND (wt.source IS NULL OR wt.source != 'unknown')
      AND (pgd.start_date IS NULL OR wt.tx_datetime >= pgd.start_date)
      AND (pgd.end_date IS NULL OR wt.tx_datetime <= pgd.end_date)
      AND wt.tx_datetime >= ? AND wt.tx_datetime <= ?
    ORDER BY wt.tx_datetime ASC, wt.id ASC
  `).all(playerId, startIso, endIso) as QqpkCycleTx[];
}

// Pure projection of the active cycle for one player: net + stored mains + RESET-SEC carry
// (always 0/0) → engine. Two views of the same inputs:
//   • RÉEL (computeStakingBlock, is_final_settlement=true) == what settling now produces
//     (30k gate applied) — this is what the Régler panel shows and what lock writes.
//   • PRÉVISIONNEL (projectStakingBlock) == as-if-covered 70/30, pertes <30k incluses —
//     this is what the board and the KPI show (decision Baki: expose real exposure).
function computeQqpkProjection(playerId: number, cycle: QqpkCycle): {
  resultat_periode: number; mains: number; c: number; t: number;
  reglement: number; condition_30k_applied: boolean; operator_pnl: number;
  reglement_projected: number; operator_pnl_projected: number;
} {
  const resultat_periode = getQqpkCycleNet(playerId, cycle.start_iso, cycle.end_iso);
  const mains = getQqpkStoredMains(playerId, cycle.cycle_start);
  // RESET SEC: no carry between cycles — every cycle starts at 0/0.
  const res = computeStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode, mains, is_final_settlement: true });
  const proj = projectStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode, mains });
  return {
    resultat_periode, mains, c: res.c, t: res.t, reglement: res.reglement,
    condition_30k_applied: res.condition_30k_applied,
    operator_pnl: operatorPnlFromReglement(res.reglement),
    reglement_projected: proj.reglement_projected,
    operator_pnl_projected: operatorPnlFromReglement(proj.reglement_projected),
  };
}

// ── QQPK manual rakeback (owner-only, hors deal) ─────────────────────────────
// Revenue the Cercle earns from the room on a player, entered by hand per rolling
// cycle. INVISIBLE to the player: never enters computeStakingBlock, settleQqpkCycle,
// the réglable amount, or any Telegram message. Keyed on (player_id, cycle_start)
// where cycle_start == qqpk_staking_blocks.block_month — new cycle → empty again,
// past cycles keep their entered value (no destructive reset).

// All entries as a map "player_id|cycle_start" → amount (one query for board + history).
function getQqpkCycleRakebackMap(): Map<string, number> {
  const rows = getDb().prepare(
    `SELECT player_id, cycle_start, amount FROM qqpk_cycle_rakeback`
  ).all() as { player_id: number; cycle_start: string; amount: number }[];
  return new Map(rows.map((r) => [`${r.player_id}|${r.cycle_start}`, r.amount]));
}

export function setQqpkCycleRakeback(playerId: number, amount: number): { ok: boolean; error?: string } {
  if (!Number.isFinite(amount) || amount < 0) return { ok: false, error: "RB manuel : nombre ≥ 0 requis." };
  const cycle = getQqpkActiveCycle(playerId);
  if (!cycle) return { ok: false, error: "Pas de cycle QQPK actif." };
  // Défense en profondeur (miroir setQqpkMains) : l'actif n'est jamais settled par
  // construction, mais on refuse explicitement au cas où un futur appelant contourne l'UI.
  const existing = getQqpkBlockRow(playerId, cycle.cycle_start);
  if (existing && existing.status === "settled") return { ok: false, error: "Cycle déjà réglé (immutable)." };
  getDb().prepare(
    `INSERT INTO qqpk_cycle_rakeback (player_id, cycle_start, amount, updated_at)
     VALUES (@player_id, @cycle_start, @amount, datetime('now'))
     ON CONFLICT(player_id, cycle_start) DO UPDATE SET amount = excluded.amount, updated_at = datetime('now')`
  ).run({ player_id: playerId, cycle_start: cycle.cycle_start, amount });
  logQqpkEntry(playerId, cycle.cycle_start, "rb", amount); // journal graph — display-only, hors argent
  return { ok: true };
}

// Append-only journal for the evolution graph — a dated trace of every save.
// DISPLAY-ONLY (invariant: never read by engine/settlement/lock). 'result' events are
// not logged: the résultat is derived from wallet_transactions (already dated).
// Never throws: the business write has already committed when this runs — a journal
// failure must not flip a successful save into a caller-visible error (audit note).
function logQqpkEntry(playerId: number, cycleStart: string, kind: "result" | "mains" | "rb", value: number): void {
  try {
    getDb().prepare(
      `INSERT INTO qqpk_entry_log (player_id, cycle_start, kind, value) VALUES (?, ?, ?, ?)`
    ).run(playerId, cycleStart, kind, value);
  } catch (err: any) {
    console.error(`[qqpk_entry_log] INSERT failed (${kind}, player ${playerId}):`, err.message);
  }
}

// ── QQPK evolution graph (display-only, NEVER read by settlement/lock) ───────
// Series builder for the /qqpk/pnl chart. Y = cumulative "Part Cercle prévisionnelle
// + RB manuel" (decision Baki: RB spikes are wanted — each dated saisie = a visible
// event). Sources of dated events:
//   • 'result' — wallet_transactions (tx_datetime), SAME filters as getWalletSummaryByPlayer
//     → full retroactive history, Σ deltas == getQqpkCycleNet by construction.
//   • 'rb' / 'mains' — qqpk_entry_log (journal fed by the write-paths + seed). No history
//     before the journal exists (no fake retroactive curve).
// Every cumul is computed HERE (server) via the engine — the chart component only
// picks precomputed fields (invariant #2: zero math in the client).

export interface QqpkGraphEvent {
  ts: number;            // epoch ms (X axis)
  at: string;            // raw datetime for the tooltip
  player_id: number;
  player_name: string;
  kind: "seed" | "result" | "rb" | "mains" | "settle";
  delta: number;         // change of (projected + RB) caused by this event
  note: string;          // tooltip context ("+500,00 on-chain", "RB = 120", "25 000 mains", …)
  cumul_player: number;  // running projected+RB of THIS player after the event (view scope)
  cumul_all: number;     // running Σ across all players after the event
}

export interface QqpkGraphData {
  cycleEvents: QqpkGraphEvent[];   // vue CYCLE (scope = the page's cycleView)
  globalEvents: QqpkGraphEvent[];  // vue GLOBALE (all cycles, continuous timeline)
  players: { player_id: number; player_name: string }[];
}

// SQLite datetimes come as 'YYYY-MM-DD HH:MM:SS' (log) or UTC ISO (tx) — both are UTC.
function qqpkEventTs(raw: string): number {
  let iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  if (!iso.endsWith("Z") && !iso.includes("+")) iso += "Z";
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

// Part Cercle prévisionnelle for a cumulative net — engine only (mains is irrelevant to
// the projected AMOUNT: the 30k gate is a settlement-time rule the projection ignores).
function qqpkProjPart(net: number): number {
  return operatorPnlFromReglement(projectStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode: net, mains: 0 }).reglement_projected);
}

// Dated on-chain events of a player within a cycle window — mirrors the join/filters of
// getWalletSummaryByPlayer (game scope via the deal, source guard, deal window) so the
// running Σ of deltas equals getQqpkCycleNet for the same window.
function getQqpkCycleTxEvents(playerId: number, startIso: string, endIso: string): { at: string; delta_net: number }[] {
  return getDb().prepare(
    `SELECT wt.tx_datetime AS at,
            CASE WHEN wt.type = 'withdrawal' THEN wt.amount ELSE -wt.amount END AS delta_net
     FROM wallet_transactions wt
     JOIN player_game_deals pgd ON pgd.player_id = wt.player_id AND pgd.game_id = wt.game_id
     JOIN games g ON g.id = pgd.game_id AND g.name = 'QQPK'
     WHERE wt.player_id = @pid
       AND (wt.source IS NULL OR wt.source != 'unknown')
       AND wt.tx_datetime >= @start AND wt.tx_datetime <= @end
       AND (pgd.start_date IS NULL OR wt.tx_datetime >= pgd.start_date)
       AND (pgd.end_date IS NULL OR wt.tx_datetime <= pgd.end_date)
     ORDER BY wt.tx_datetime, wt.id`
  ).all({ pid: playerId, start: startIso, end: endIso }) as { at: string; delta_net: number }[];
}

function getQqpkLogEvents(playerId: number, cycleStart: string): { at: string; kind: string; value: number }[] {
  return getDb().prepare(
    `SELECT created_at AS at, kind, value FROM qqpk_entry_log
     WHERE player_id = ? AND cycle_start = ? AND kind IN ('rb','mains')
     ORDER BY created_at, id`
  ).all(playerId, cycleStart) as { at: string; kind: string; value: number }[];
}

const fmtNote = (n: number) => (n >= 0 ? "+" : "−") + Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Live walk of one player's cycle: dated tx + journal events → per-event deltas of
// (projected + RB). For a SETTLED cycle a final 'settle' event snaps the curve to the
// settled reality (operator_pnl réel + RB) — the 30k-gate drop becomes visible, and the
// last point matches the table/KPI of past views. cumuls are filled later (finalize).
function buildQqpkCycleWalk(
  p: { player_id: number; player_name: string },
  cycleStart: string, startIso: string, endIso: string,
  settled: { reglement: number; settled_at: string } | null,
  rbOfCycle: number,
): Omit<QqpkGraphEvent, "cumul_player" | "cumul_all">[] {
  const base = { player_id: p.player_id, player_name: p.player_name };
  const raw: { ts: number; at: string; kind: "result" | "rb" | "mains"; v: number }[] = [
    ...getQqpkCycleTxEvents(p.player_id, startIso, endIso).map((t) => ({ ts: qqpkEventTs(t.at), at: t.at, kind: "result" as const, v: t.delta_net })),
    ...getQqpkLogEvents(p.player_id, cycleStart).map((l) => ({ ts: qqpkEventTs(l.at), at: l.at, kind: l.kind as "rb" | "mains", v: l.value })),
  ].sort((a, b) => a.ts - b.ts);

  const out: Omit<QqpkGraphEvent, "cumul_player" | "cumul_all">[] = [
    { ...base, ts: qqpkEventTs(startIso), at: startIso, kind: "seed", delta: 0, note: "Début de cycle" },
  ];
  let net = 0, rb = 0, prevTotal = 0;
  for (const e of raw) {
    if (e.kind === "result") net += e.v;
    else if (e.kind === "rb") rb = e.v;
    const total = qqpkProjPart(net) + rb;
    const note = e.kind === "result" ? `${fmtNote(e.v)} on-chain`
      : e.kind === "rb" ? `RB manuel = ${fmtNote(e.v)}`
      : `${e.v.toLocaleString("fr-FR")} mains saisies`;
    out.push({ ...base, ts: e.ts, at: e.at, kind: e.kind, delta: total - prevTotal, note });
    prevTotal = total;
  }
  if (settled) {
    // Final RB of the cycle from the canonical table (journal may predate old cycles).
    const finalVal = operatorPnlFromReglement(settled.reglement) + rbOfCycle;
    out.push({
      ...base, ts: qqpkEventTs(settled.settled_at), at: settled.settled_at, kind: "settle",
      delta: finalVal - prevTotal, note: "Règlement du cycle (réel, gate 30k appliquée)",
    });
  }
  return out;
}

// Fill running cumuls: per-player first (each player's own chronological deltas), then
// the merged all-players timeline. Pure Σ of already-computed deltas — no new math.
function finalizeQqpkEvents(events: Omit<QqpkGraphEvent, "cumul_player" | "cumul_all">[]): QqpkGraphEvent[] {
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.ts - b.e.ts || a.i - b.i).map((x) => x.e);
  const perPlayer = new Map<number, number>();
  let all = 0;
  return sorted.map((e) => {
    const cp = (perPlayer.get(e.player_id) ?? 0) + e.delta;
    perPlayer.set(e.player_id, cp);
    all += e.delta;
    return { ...e, cumul_player: cp, cumul_all: all };
  });
}

export function getQqpkGraphData(cycleView: number): QqpkGraphData {
  const db = getDb();
  const players = db.prepare(
    `SELECT p.id AS player_id, p.name AS player_name
     FROM players p
     JOIN player_game_deals pgd ON pgd.player_id = p.id
     JOIN games g ON g.id = pgd.game_id AND g.name = 'QQPK'
     ORDER BY p.name COLLATE NOCASE`
  ).all() as { player_id: number; player_name: string }[];

  const rbMap = getQqpkCycleRakebackMap();
  const blocks = db.prepare(
    `SELECT player_id, block_month, block_start, block_end, reglement, updated_at, created_at
     FROM qqpk_staking_blocks WHERE status = 'settled' ORDER BY player_id, block_month`
  ).all() as { player_id: number; block_month: string; block_start: string; block_end: string; reglement: number; updated_at: string | null; created_at: string }[];
  const settledByPlayer = new Map<number, typeof blocks>();
  for (const b of blocks) {
    const l = settledByPlayer.get(b.player_id) ?? [];
    l.push(b);
    settledByPlayer.set(b.player_id, l);
  }

  const cycleRaw: Omit<QqpkGraphEvent, "cumul_player" | "cumul_all">[] = [];
  const globalRaw: Omit<QqpkGraphEvent, "cumul_player" | "cumul_all">[] = [];

  for (const p of players) {
    const settledDesc = (settledByPlayer.get(p.player_id) ?? []).slice().sort((a, b) => b.block_month.localeCompare(a.block_month));

    // — vue CYCLE (same relative semantics as the table: 0 = actif, n = n-th settled) —
    if (cycleView === 0) {
      const cycle = getQqpkActiveCycle(p.player_id);
      if (cycle) cycleRaw.push(...buildQqpkCycleWalk(p, cycle.cycle_start, cycle.start_iso, cycle.end_iso, null, rbMap.get(`${p.player_id}|${cycle.cycle_start}`) ?? 0));
    } else {
      const b = settledDesc[cycleView - 1];
      if (b) cycleRaw.push(...buildQqpkCycleWalk(p, b.block_month, b.block_start, b.block_end, { reglement: b.reglement, settled_at: b.updated_at ?? b.created_at }, rbMap.get(`${p.player_id}|${b.block_month}`) ?? 0));
    }

    // — vue GLOBALE : cycles passés = valeur finale (réel réglé + RB), courant = courbe vive —
    for (const b of settledByPlayer.get(p.player_id) ?? []) {
      const rb = rbMap.get(`${p.player_id}|${b.block_month}`) ?? 0;
      const at = b.updated_at ?? b.created_at;
      globalRaw.push({
        player_id: p.player_id, player_name: p.player_name,
        ts: qqpkEventTs(at), at, kind: "settle",
        delta: operatorPnlFromReglement(b.reglement) + rb,
        note: `Cycle ${b.block_month} réglé (réel + RB du cycle)`,
      });
    }
    const active = getQqpkActiveCycle(p.player_id);
    if (active) globalRaw.push(...buildQqpkCycleWalk(p, active.cycle_start, active.start_iso, active.end_iso, null, rbMap.get(`${p.player_id}|${active.cycle_start}`) ?? 0));
  }

  return { cycleEvents: finalizeQqpkEvents(cycleRaw), globalEvents: finalizeQqpkEvents(globalRaw), players };
}

// Board view: one row per QQPK player = their active cycle + live "if settled now" projection.
export function getQqpkStakingOverview(): { rows: QqpkStakingRow[] } {
  const players = getDb().prepare(
    `SELECT p.id AS player_id, p.name AS player_name
     FROM players p
     JOIN player_game_deals pgd ON pgd.player_id = p.id
     JOIN games g ON g.id = pgd.game_id AND g.name = 'QQPK'
     ORDER BY p.name COLLATE NOCASE`
  ).all() as { player_id: number; player_name: string }[];

  const rbMap = getQqpkCycleRakebackMap();
  const rows: QqpkStakingRow[] = [];
  for (const p of players) {
    const cycle = getQqpkActiveCycle(p.player_id);
    if (!cycle) continue;
    const proj = computeQqpkProjection(p.player_id, cycle);
    rows.push({
      player_id: p.player_id, player_name: p.player_name,
      start_date: cycle.player_start_date, cycle_start: cycle.cycle_start,
      cycle_end_incl: cycle.cycle_end_incl, settle_date: cycle.settle_date,
      due: cycle.due, days_overdue: cycle.days_overdue, ...proj,
      rb_manual: rbMap.get(`${p.player_id}|${cycle.cycle_start}`) ?? 0,
    });
  }
  return { rows };
}

// History: all settled cycles, newest first. block_start/block_end = the settled
// cycle's UTC ISO bounds, exposed so the tx-detail view can query the same window.
export function getQqpkBlockHistory(): (QqpkStakingRow & { settled_at: string | null; block_start: string | null; block_end: string | null })[] {
  const rows = getDb().prepare(
    `SELECT b.*, p.name AS player_name
     FROM qqpk_staking_blocks b
     JOIN players p ON p.id = b.player_id
     WHERE b.status = 'settled'
     ORDER BY b.block_month DESC, p.name COLLATE NOCASE`
  ).all() as any[];
  const rbMap = getQqpkCycleRakebackMap();
  return rows.map((b) => ({
    player_id: b.player_id, player_name: b.player_name,
    start_date: "", cycle_start: b.block_month,
    cycle_end_incl: b.block_end ? toParisDate(b.block_end) : "",
    settle_date: "", due: false, days_overdue: 0,
    resultat_periode: b.resultat_periode, mains: b.mains,
    c: b.c, t: b.t, reglement: b.reglement,
    condition_30k_applied: !!b.condition_30k_applied,
    operator_pnl: operatorPnlFromReglement(b.reglement),
    // Settled cycle: no projection anymore — the settled reality IS the number.
    reglement_projected: b.reglement,
    operator_pnl_projected: operatorPnlFromReglement(b.reglement),
    // Past cycles keep the RB entered while they were active (no destructive reset).
    rb_manual: rbMap.get(`${b.player_id}|${b.block_month}`) ?? 0,
    settled_at: b.updated_at ?? b.created_at ?? null,
    block_start: b.block_start ?? null,
    block_end: b.block_end ?? null,
  }));
}

// Recap for the confirmation dialog — read-only, no write. Carries BOTH the real
// (réglable, 30k gate applied — what lock will write) and the projected fields so
// the panel can state the divergence when <30k ("non couvert à ce jour: 0 réglable").
export function previewQqpkSettlement(playerId: number): {
  ok: boolean; error?: string;
  player_id: number; cycle?: QqpkCycle;
  resultat_periode?: number; mains?: number; c?: number; t?: number;
  reglement?: number; condition_30k_applied?: boolean; operator_pnl?: number;
  reglement_projected?: number; operator_pnl_projected?: number;
} {
  const cycle = getQqpkActiveCycle(playerId);
  if (!cycle) return { ok: false, error: "Pas de cycle QQPK (deal/onboarding manquant).", player_id: playerId };
  const proj = computeQqpkProjection(playerId, cycle);
  return { ok: true, player_id: playerId, cycle, ...proj };
}

// Persist the manually-entered hands for the active cycle. Integer ≥ 0. Refuses if settled.
export function setQqpkMains(playerId: number, mains: number): { ok: boolean; error?: string } {
  if (!Number.isInteger(mains) || mains < 0) return { ok: false, error: "Mains: entier ≥ 0 requis." };
  const cycle = getQqpkActiveCycle(playerId);
  if (!cycle) return { ok: false, error: "Pas de cycle QQPK actif." };
  const existing = getQqpkBlockRow(playerId, cycle.cycle_start);
  if (existing && existing.status === "settled") return { ok: false, error: "Cycle déjà réglé (immutable)." };
  getDb().prepare(
    `INSERT INTO qqpk_staking_blocks (player_id, block_month, block_start, block_end, mains, status, updated_at)
     VALUES (@player_id, @cycle, @start, @end, @mains, 'open', datetime('now'))
     ON CONFLICT(player_id, block_month) DO UPDATE SET mains = excluded.mains, updated_at = datetime('now')`
  ).run({ player_id: playerId, cycle: cycle.cycle_start, start: cycle.start_iso, end: cycle.end_iso, mains });
  logQqpkEntry(playerId, cycle.cycle_start, "mains", mains); // journal graph — display-only, hors argent
  return { ok: true };
}

// THE settlement: settle the active cycle. Reads net + mains, RESET-SEC carry (0/0), runs the
// engine (is_final_settlement=true), persists as 'settled'. Refuses to overwrite a settled cycle
// (immutability, mirror invariant #11). No carry to the next cycle (reset sec).
export function settleQqpkCycle(playerId: number): { ok: boolean; error?: string; result?: QqpkStakingRow } {
  const cycle = getQqpkActiveCycle(playerId);
  if (!cycle) return { ok: false, error: "Pas de cycle QQPK actif." };
  const existing = getQqpkBlockRow(playerId, cycle.cycle_start);
  if (existing && existing.status === "settled") return { ok: false, error: "Cycle déjà réglé (immutable)." };

  const resultat_periode = getQqpkCycleNet(playerId, cycle.start_iso, cycle.end_iso);
  const mains = getQqpkStoredMains(playerId, cycle.cycle_start);
  const res = computeStakingBlock({ c_prec: 0, t_prec: 0, resultat_periode, mains, is_final_settlement: true });

  getDb().prepare(
    `INSERT INTO qqpk_staking_blocks
       (player_id, block_month, block_start, block_end, resultat_periode, mains,
        c_prec, c, t_prec, t, reglement, condition_30k_applied, status, updated_at)
     VALUES
       (@player_id, @cycle, @start, @end, @resultat_periode, @mains,
        0, @c, 0, @t, @reglement, @cond, 'settled', datetime('now'))
     ON CONFLICT(player_id, block_month) DO UPDATE SET
        block_start = excluded.block_start, block_end = excluded.block_end,
        resultat_periode = excluded.resultat_periode, mains = excluded.mains,
        c_prec = 0, c = excluded.c, t_prec = 0, t = excluded.t,
        reglement = excluded.reglement, condition_30k_applied = excluded.condition_30k_applied,
        status = 'settled', updated_at = datetime('now')`
  ).run({
    player_id: playerId, cycle: cycle.cycle_start, start: cycle.start_iso, end: cycle.end_iso,
    resultat_periode, mains, c: res.c, t: res.t, reglement: res.reglement,
    cond: res.condition_30k_applied ? 1 : 0, // better-sqlite3 does NOT coerce booleans
  });

  const playerName = (getDb().prepare(`SELECT name FROM players WHERE id = ?`).get(playerId) as { name: string } | undefined)?.name ?? `#${playerId}`;
  return {
    ok: true,
    result: {
      player_id: playerId, player_name: playerName,
      start_date: cycle.player_start_date, cycle_start: cycle.cycle_start,
      cycle_end_incl: cycle.cycle_end_incl, settle_date: cycle.settle_date,
      due: cycle.due, days_overdue: cycle.days_overdue,
      resultat_periode, mains, c: res.c, t: res.t, reglement: res.reglement,
      condition_30k_applied: res.condition_30k_applied,
      operator_pnl: operatorPnlFromReglement(res.reglement),
      // Just settled → the settled reality is the number (projection is moot).
      reglement_projected: res.reglement,
      operator_pnl_projected: operatorPnlFromReglement(res.reglement),
    },
  };
}
