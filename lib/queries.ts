import { getDb } from "./db";
import { toParisDate } from "./date-utils";

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
  getDb().prepare(`DELETE FROM players WHERE id = ?`).run(id);
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

export function getWalletSummaryByPlayer(filters?: { game_name?: string; since_date?: string; end_date?: string }) {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters?.game_name) { conditions.push(`g.name = @game_name`); params.game_name = filters.game_name; }
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

export function getWalletKPIs(filters?: { game_name?: string; since_date?: string; end_date?: string }) {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters?.game_name) { conditions.push(`g.name = @game_name`); params.game_name = filters.game_name; }
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

export function getLockedSummaryByPlayer(weekStart: string, gameName?: string) {
  const gn = gameName ?? "TELE";
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
    JOIN games g ON g.id = pgd.game_id AND g.name = ?
    WHERE ws.week_start = ?
    ORDER BY ws.pnl_operator DESC
  `).all(gn, weekStart);
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

export function getLockAwareSummaryByPlayer(filters?: { game_name?: string; since_date?: string; end_date?: string }) {
  if (filters?.since_date && filters?.end_date) {
    const weekStart = getWeekStartFromDates(filters.since_date, filters.end_date);
    if (weekStart && isWeekLocked(weekStart)) {
      return getLockedSummaryByPlayer(weekStart, filters?.game_name);
    }
  }
  return getWalletSummaryByPlayer(filters);
}

export function getLockAwareKPIs(filters?: { game_name?: string; since_date?: string; end_date?: string }) {
  if (filters?.since_date && filters?.end_date) {
    const weekStart = getWeekStartFromDates(filters.since_date, filters.end_date);
    if (weekStart && isWeekLocked(weekStart)) {
      return getLockedKPIs(weekStart);
    }
  }
  return getWalletKPIs(filters);
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
// USDT-ONLY: sessions of non-USDT games (games.currency != 'USDT') are EXCLUDED — there is
// no FX rate for them (Phase 2), and raw cross-currency sums violate invariant #3.
export function getGrindhouseAgencyNet(period?: Period): number {
  const db = getDb();
  try {
    const sessParams: string[] = [];
    let sessSql = `
      SELECT COALESCE(SUM(s.net_result_usdt), 0) AS v
      FROM grindhouse_sessions s
      JOIN grindhouse_grinders gg ON gg.player_id = s.player_id AND gg.status = 'active'
      JOIN games gm ON gm.id = s.game_id AND COALESCE(gm.currency, 'USDT') = 'USDT'
      WHERE 1=1`;
    if (period?.from) { sessSql += ` AND s.session_date >= ?`; sessParams.push(period.from); }
    if (period?.to) { sessSql += ` AND s.session_date <= ?`; sessParams.push(period.to); }
    const sessionsPnl = (db.prepare(sessSql).get(...sessParams) as { v: number }).v;

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
      SELECT s.session_date AS day, COALESCE(SUM(s.net_result_usdt), 0) AS v
      FROM grindhouse_sessions s
      JOIN grindhouse_grinders gg ON gg.player_id = s.player_id AND gg.status = 'active'
      JOIN games gm ON gm.id = s.game_id AND COALESCE(gm.currency, 'USDT') = 'USDT'
      WHERE 1=1${range("s.session_date", sessParams)}
      GROUP BY day
    `).all(...sessParams) as { day: string; v: number }[];
    for (const r of sessions) add(r.day, r.v * 0.5);

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
  wepoker_cny: number;
  wepoker_extras_cny: number;
  wepoker_usdt: number;
}
export function getAgencyTotalPnL(period?: Period): AgencyTotalPnL {
  const ak = getAkpokerPnL(undefined, period);
  const kk = getKkpokerPnL(undefined, period);
  const a5 = getA5pokerPnL(undefined, period);
  const wp = getWepokerPnL(undefined, period);
  const akTotal = ak.reduce((s, r) => s + r.agency_cut_usdt, 0);
  const kkTotal = kk.reduce((s, r) => s + r.agency_cut_usdt, 0);
  const a5Total = a5.reduce((s, r) => s + r.agency_cut_usdt, 0);
  const wpTotalCny = wp.reduce((s, r) => s + r.total_agency_cny, 0);
  const wpTotalUsdt = wp.reduce((s, r) => s + r.total_agency_usdt, 0);
  const akExtras = getAgencyExtrasNet("akpoker", period);
  const kkExtras = getAgencyExtrasNet("kkpoker", period);
  const a5Extras = getAgencyExtrasNet("a5poker", period);
  const wpExtrasCny = getAgencyExtrasNet("wepoker", period);
  const rate = getCnyRate();
  const wpExtrasUsdt = convertCnyToUsdt(wpExtrasCny, rate);
  const grindhouse = getGrindhouseAgencyNet(period);
  const gamesUsdt = akTotal + kkTotal + a5Total + wpTotalUsdt;
  const extrasUsdt = akExtras + kkExtras + a5Extras + wpExtrasUsdt;
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

// F) Top contributors by agency cut
export interface ContributorRow {
  player_id: number; player_name: string; agency_usdt: number;
  akpoker_usdt: number; kkpoker_usdt: number; a5poker_usdt: number; wepoker_usdt: number;
}
export function getTopContributors(period: Period, limit = 5): ContributorRow[] {
  const ak = getAkpokerPnL(undefined, period);
  const kk = getKkpokerPnL(undefined, period);
  const a5 = getA5pokerPnL(undefined, period);
  const wp = getWepokerPnL(undefined, period);

  const byPlayer = new Map<number, ContributorRow>();
  const get = (r: { player_id: number; player_name: string }) =>
    byPlayer.get(r.player_id) ?? { player_id: r.player_id, player_name: r.player_name, agency_usdt: 0, akpoker_usdt: 0, kkpoker_usdt: 0, a5poker_usdt: 0, wepoker_usdt: 0 };
  for (const r of ak) {
    const e = get(r); e.akpoker_usdt += r.agency_cut_usdt; e.agency_usdt += r.agency_cut_usdt; byPlayer.set(r.player_id, e);
  }
  for (const r of kk) {
    const e = get(r); e.kkpoker_usdt += r.agency_cut_usdt; e.agency_usdt += r.agency_cut_usdt; byPlayer.set(r.player_id, e);
  }
  for (const r of a5) {
    const e = get(r); e.a5poker_usdt += r.agency_cut_usdt; e.agency_usdt += r.agency_cut_usdt; byPlayer.set(r.player_id, e);
  }
  for (const r of wp) {
    const e = get(r); e.wepoker_usdt += r.total_agency_usdt; e.agency_usdt += r.total_agency_usdt; byPlayer.set(r.player_id, e);
  }

  return [...byPlayer.values()].sort((a, b) => b.agency_usdt - a.agency_usdt).slice(0, limit);
}

// G) P&L time series for charts
export interface PnLTimePoint {
  date: string; akpoker_usdt: number; kkpoker_usdt: number; a5poker_usdt: number; wepoker_usdt: number; grindhouse_usdt: number; total_usdt: number;
}
export function getPnLOverTime(period: Period): PnLTimePoint[] {
  const db = getDb();
  const { since, until } = periodToDateRange(period);

  const walletDailyByGame = (gameName: string) => db.prepare(`
    SELECT substr(wt.tx_datetime, 1, 10) AS day,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END) * pgd.action_pct / 100.0, 0) AS agency
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
  const getDay = (day: string) => dayMap.get(day) ?? { date: day, akpoker_usdt: 0, kkpoker_usdt: 0, a5poker_usdt: 0, wepoker_usdt: 0, grindhouse_usdt: 0, total_usdt: 0 };
  for (const r of akDaily) {
    const e = getDay(r.day); e.akpoker_usdt += r.agency; e.total_usdt += r.agency; dayMap.set(r.day, e);
  }
  for (const r of kkDaily) {
    const e = getDay(r.day); e.kkpoker_usdt += r.agency; e.total_usdt += r.agency; dayMap.set(r.day, e);
  }
  for (const r of a5Daily) {
    const e = getDay(r.day); e.a5poker_usdt += r.agency; e.total_usdt += r.agency; dayMap.set(r.day, e);
  }
  for (const r of wpDaily) {
    const wpUsdt = convertCnyToUsdt(r.wl_agency + r.rb_agency + r.ins_agency, rate);
    const e = getDay(r.day); e.wepoker_usdt += wpUsdt; e.total_usdt += wpUsdt; dayMap.set(r.day, e);
  }

  // Add agency extras to the time series
  for (const gk of ["akpoker", "kkpoker", "a5poker", "wepoker"] as const) {
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
  return db.prepare(`
    SELECT * FROM (
      SELECT s.created_at AS ts, 'session' AS type, p.name AS label,
             g.name AS detail, s.net_result_usdt AS amount
      FROM grindhouse_sessions s
      JOIN players p ON p.id = s.player_id
      JOIN games g ON g.id = s.game_id

      UNION ALL
      SELECT gs.paid_at, 'gh_settle', p.name,
             gs.period_start || ' → ' || gs.period_end, gs.grinder_share
      FROM grindhouse_settlements gs
      JOIN players p ON p.id = gs.player_id
      WHERE gs.status = 'paid' AND gs.paid_at IS NOT NULL

      UNION ALL
      SELECT ws.received_at, 'settlement', p.name,
             'semaine ' || ws.week_start, ws.pnl_player
      FROM weekly_settlements ws
      JOIN players p ON p.id = ws.player_id
      WHERE ws.payment_received = 1 AND ws.received_at IS NOT NULL

      UNION ALL
      SELECT e.created_at, 'expense', UPPER(e.type),
             e.description, -ABS(e.amount_usdt)
      FROM grindhouse_expenses e

      UNION ALL
      SELECT p.created_at, 'onboard', p.name, NULL, NULL
      FROM players p
    )
    ORDER BY ts DESC
    LIMIT ?
  `).all(limit) as OpsFeedEvent[];
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
  pnl: number;
  hours: number;
  session_count: number;
  games_count: number;
}
export function getGrindhouseWeeklyCells(from: string, to: string): GrindhouseWeekCell[] {
  const db = getDb();
  // One row per player × week × currency — amounts of different currencies are NEVER
  // summed together (invariant #3, no FX conversion in grindhouse).
  return db.prepare(`
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
  `).all(from, to) as GrindhouseWeekCell[];
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
