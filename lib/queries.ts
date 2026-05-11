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
}): { id: number; isNew: boolean } {
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM players WHERE telegram_id = ?`).get(data.telegram_id) as { id: number } | undefined;
  if (existing) return { id: existing.id, isNew: false };
  const r = db.prepare(`
    INSERT INTO players (name, telegram_handle, telegram_id, status, tier)
    VALUES (@name, @telegram_handle, @telegram_id, 'active', 'B')
  `).run({ name: data.name, telegram_handle: data.telegram_handle ?? null, telegram_id: data.telegram_id });
  return { id: Number(r.lastInsertRowid), isNew: true };
}

// ── Games ─────────────────────────────────────────────────
export function getGames() {
  return getDb().prepare(`SELECT * FROM games ORDER BY id`).all() as { id: number; name: string; default_action_pct: number | null }[];
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
export function getPlayerCashouts(playerId: number) {
  return getDb().prepare(`SELECT id, address, label FROM player_wallet_cashouts WHERE player_id = ? ORDER BY id`).all(playerId) as { id: number; address: string; label: string | null }[];
}

export function setPlayerCashouts(playerId: number, addresses: { address: string; label?: string | null }[]) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM player_wallet_cashouts WHERE player_id = ?`).run(playerId);
    const ins = db.prepare(`INSERT OR IGNORE INTO player_wallet_cashouts (player_id, address, label) VALUES (?, ?, ?)`);
    for (const c of addresses) {
      const a = c.address.trim();
      if (!a) continue;
      ins.run(playerId, a, c.label ?? null);
    }
    // Mirror the first address into the legacy column for Telegram-bot compatibility
    const first = addresses.find(c => c.address.trim());
    db.prepare(`UPDATE players SET tele_wallet_cashout = ? WHERE id = ?`).run(first ? first.address.trim() : null, playerId);
  });
  tx();
}

// ── Player Wallet Games (multi) ──────────────────────────
export function getPlayerGameWallets(playerId: number) {
  return getDb().prepare(`SELECT id, address, label FROM player_wallet_games WHERE player_id = ? ORDER BY id`).all(playerId) as { id: number; address: string; label: string | null }[];
}

export function setPlayerGameWallets(playerId: number, addresses: { address: string; label?: string | null }[]) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM player_wallet_games WHERE player_id = ?`).run(playerId);
    const ins = db.prepare(`INSERT OR IGNORE INTO player_wallet_games (player_id, address, label) VALUES (?, ?, ?)`);
    for (const c of addresses) {
      const a = c.address.trim();
      if (!a) continue;
      ins.run(playerId, a, c.label ?? null);
    }
    const first = addresses.find(c => c.address.trim());
    db.prepare(`UPDATE players SET tron_address = ? WHERE id = ?`).run(first ? first.address.trim() : null, playerId);
  });
  tx();
}

export function getAllTeleGameWalletsByPlayer() {
  return getDb().prepare(`
    SELECT player_id, address FROM player_wallet_games
    WHERE player_id IN (
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

export function getAllTeleCashoutsByPlayer() {
  // Returns one row per (player_id, address). Includes both new-table entries and the legacy single column.
  return getDb().prepare(`
    SELECT player_id, address FROM player_wallet_cashouts
    UNION
    SELECT id AS player_id, tele_wallet_cashout AS address FROM players
    WHERE tele_wallet_cashout IS NOT NULL AND tele_wallet_cashout != ''
  `).all() as { player_id: number; address: string }[];
}

export function upsertPlayerGameDeal(data: { player_id: number; game_id: number; action_pct: number; rakeback_pct: number; start_date?: string | null }) {
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct, start_date)
    VALUES (@player_id, @game_id, @action_pct, @rakeback_pct, @start_date)
    ON CONFLICT(player_id, game_id) DO UPDATE SET
      action_pct = excluded.action_pct,
      rakeback_pct = excluded.rakeback_pct,
      start_date = excluded.start_date
  `).run({ ...data, start_date: data.start_date ?? null });
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
  const endDateCond = filters?.end_date ? `AND wt.tx_datetime <= @end_date` : "";
  const dateJoin = filters?.since_date
    ? `LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id ${srcFilter} AND wt.tx_datetime >= @since_date ${endDateCond} ${startDateCond}`
    : `LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id ${srcFilter} ${endDateCond} ${startDateCond}`;
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
  const edCond = filters?.end_date ? `AND wt.tx_datetime <= @end_date` : "";
  const dateJoin = filters?.since_date
    ? `LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id ${srcF} AND wt.tx_datetime >= @since_date ${edCond} ${sdCond}`
    : `LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id ${srcF} ${edCond} ${sdCond}`;
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
  created_at: string;
}

export function getWalletMeres(): WalletMere[] {
  return getDb().prepare(`SELECT id, address, label, created_at FROM wallet_meres ORDER BY id`).all() as WalletMere[];
}

export function addWalletMere(address: string, label: string | null): WalletMere {
  const result = getDb().prepare(`INSERT INTO wallet_meres (address, label) VALUES (?, ?)`).run(address, label || null);
  return { id: Number(result.lastInsertRowid), address, label: label || null, created_at: new Date().toISOString() };
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

export function getLockedSummaryByPlayer(weekStart: string) {
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
    JOIN games g ON g.id = pgd.game_id AND g.name = 'TELE'
    WHERE ws.week_start = ?
    ORDER BY ws.pnl_operator DESC
  `).all(weekStart);
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
      return getLockedSummaryByPlayer(weekStart);
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

// D) Total agency P&L across all games
export interface AgencyTotalPnL {
  total_usdt: number;
  akpoker_usdt: number;
  wepoker_cny: number;
  wepoker_usdt: number;
}
export function getAgencyTotalPnL(period?: Period): AgencyTotalPnL {
  const ak = getAkpokerPnL(undefined, period);
  const wp = getWepokerPnL(undefined, period);
  const akTotal = ak.reduce((s, r) => s + r.agency_cut_usdt, 0);
  const wpTotalCny = wp.reduce((s, r) => s + r.total_agency_cny, 0);
  const wpTotalUsdt = wp.reduce((s, r) => s + r.total_agency_usdt, 0);
  return {
    total_usdt: akTotal + wpTotalUsdt,
    akpoker_usdt: akTotal,
    wepoker_cny: wpTotalCny,
    wepoker_usdt: wpTotalUsdt,
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
    const akPlayers = db.prepare(`
      SELECT DISTINCT wt.player_id FROM wallet_transactions wt
      JOIN games g ON g.id = wt.game_id AND LOWER(g.name) = 'tele'
      WHERE wt.tx_datetime >= ? AND wt.tx_datetime <= ?
        AND (wt.source IS NULL OR wt.source != 'unknown')
    `).all(since, until) as { player_id: number }[];
    akPlayers.forEach(r => combined.add(r.player_id));
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
  akpoker_usdt: number; wepoker_usdt: number;
}
export function getTopContributors(period: Period, limit = 5): ContributorRow[] {
  const ak = getAkpokerPnL(undefined, period);
  const wp = getWepokerPnL(undefined, period);

  const byPlayer = new Map<number, ContributorRow>();
  for (const r of ak) {
    const existing = byPlayer.get(r.player_id) ?? { player_id: r.player_id, player_name: r.player_name, agency_usdt: 0, akpoker_usdt: 0, wepoker_usdt: 0 };
    existing.akpoker_usdt += r.agency_cut_usdt;
    existing.agency_usdt += r.agency_cut_usdt;
    byPlayer.set(r.player_id, existing);
  }
  for (const r of wp) {
    const existing = byPlayer.get(r.player_id) ?? { player_id: r.player_id, player_name: r.player_name, agency_usdt: 0, akpoker_usdt: 0, wepoker_usdt: 0 };
    existing.wepoker_usdt += r.total_agency_usdt;
    existing.agency_usdt += r.total_agency_usdt;
    byPlayer.set(r.player_id, existing);
  }

  return [...byPlayer.values()].sort((a, b) => b.agency_usdt - a.agency_usdt).slice(0, limit);
}

// G) P&L time series for charts
export interface PnLTimePoint {
  date: string; akpoker_usdt: number; wepoker_usdt: number; total_usdt: number;
}
export function getPnLOverTime(period: Period): PnLTimePoint[] {
  const db = getDb();
  const { since, until } = periodToDateRange(period);

  const akDaily = db.prepare(`
    SELECT substr(wt.tx_datetime, 1, 10) AS day,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END) * pgd.action_pct / 100.0, 0) AS agency
    FROM wallet_transactions wt
    JOIN player_game_deals pgd ON pgd.player_id = wt.player_id AND pgd.game_id = wt.game_id
    JOIN games g ON g.id = wt.game_id AND LOWER(g.name) = 'tele'
    WHERE (wt.source IS NULL OR wt.source != 'unknown')
      AND (pgd.start_date IS NULL OR wt.tx_datetime >= pgd.start_date)
      ${since ? "AND wt.tx_datetime >= ?" : ""}
      ${until ? "AND wt.tx_datetime <= ?" : ""}
    GROUP BY day ORDER BY day
  `).all(...[since, until].filter(Boolean)) as { day: string; agency: number }[];

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
  for (const r of akDaily) {
    dayMap.set(r.day, { date: r.day, akpoker_usdt: r.agency, wepoker_usdt: 0, total_usdt: r.agency });
  }
  for (const r of wpDaily) {
    const wpUsdt = convertCnyToUsdt(r.wl_agency + r.rb_agency + r.ins_agency, rate);
    const existing = dayMap.get(r.day) ?? { date: r.day, akpoker_usdt: 0, wepoker_usdt: 0, total_usdt: 0 };
    existing.wepoker_usdt += wpUsdt;
    existing.total_usdt += wpUsdt;
    dayMap.set(r.day, existing);
  }

  return [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
}
