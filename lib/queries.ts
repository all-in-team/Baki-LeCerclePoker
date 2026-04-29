import { getDb } from "./db";

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

export function getAllTeleCashoutsByPlayer() {
  // Returns one row per (player_id, address). Includes both new-table entries and the legacy single column.
  return getDb().prepare(`
    SELECT player_id, address FROM player_wallet_cashouts
    UNION
    SELECT id AS player_id, tele_wallet_cashout AS address FROM players
    WHERE tele_wallet_cashout IS NOT NULL AND tele_wallet_cashout != ''
  `).all() as { player_id: number; address: string }[];
}

export function upsertPlayerGameDeal(data: { player_id: number; game_id: number; action_pct: number; rakeback_pct: number }) {
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct)
    VALUES (@player_id, @game_id, @action_pct, @rakeback_pct)
    ON CONFLICT(player_id, game_id) DO UPDATE SET
      action_pct = excluded.action_pct,
      rakeback_pct = excluded.rakeback_pct
  `).run(data);
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

// ── Reports ───────────────────────────────────────────────
export function getReports() {
  const db = getDb();
  return db.prepare(`
    SELECT r.*, pa.name AS app_name,
      COUNT(ae.id) AS entry_count,
      COALESCE(SUM(ae.my_net), 0) AS total_net
    FROM reports r
    JOIN poker_apps pa ON pa.id = r.app_id
    LEFT JOIN accounting_entries ae ON ae.report_id = r.id
    GROUP BY r.id
    ORDER BY r.period_end DESC
  `).all();
}

export function insertReport(data: { app_id: number; period_label: string; period_start: string; period_end: string; raw_content?: string }) {
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO reports (app_id, period_label, period_start, period_end, raw_content)
    VALUES (@app_id, @period_label, @period_start, @period_end, @raw_content)
  `).run({ raw_content: null, ...data });
  return r.lastInsertRowid;
}

// ── Accounting entries ────────────────────────────────────
export function getEntries(filters?: { period?: string; app_id?: number; player_id?: number }) {
  const db = getDb();
  let q = `
    SELECT ae.*,
      p.name AS player_name, pa.name AS app_name, pa.currency
    FROM accounting_entries ae
    JOIN poker_apps pa ON pa.id = ae.app_id
    LEFT JOIN players p ON p.id = ae.player_id
    WHERE 1=1
  `;
  const params: Record<string, unknown> = {};
  if (filters?.app_id) { q += ` AND ae.app_id = @app_id`; params.app_id = filters.app_id; }
  if (filters?.player_id) { q += ` AND ae.player_id = @player_id`; params.player_id = filters.player_id; }
  if (filters?.period) { q += ` AND ae.period_label = @period`; params.period = filters.period; }
  q += ` ORDER BY ae.period_end DESC, ae.created_at DESC`;
  return db.prepare(q).all(params);
}

export function insertEntry(data: {
  report_id?: number;
  player_id?: number;
  app_id: number;
  period_label: string;
  period_start: string;
  period_end: string;
  gross_amount: number;
  player_cut: number;
  my_net: number;
  notes?: string;
}) {
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO accounting_entries
      (report_id, player_id, app_id, period_label, period_start, period_end, gross_amount, player_cut, my_net, notes)
    VALUES
      (@report_id, @player_id, @app_id, @period_label, @period_start, @period_end, @gross_amount, @player_cut, @my_net, @notes)
  `).run({ report_id: null, player_id: null, notes: null, ...data });
  return r.lastInsertRowid;
}

export function deleteEntry(id: number) {
  getDb().prepare(`DELETE FROM accounting_entries WHERE id = ?`).run(id);
}

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

// ── Dashboard aggregates ──────────────────────────────────
export function getNetByApp(period?: string) {
  const db = getDb();
  let q = `
    SELECT pa.id, pa.name, pa.currency,
      COALESCE(SUM(ae.gross_amount),0) AS gross,
      COALESCE(SUM(ae.player_cut),0) AS player_cuts,
      COALESCE(SUM(ae.my_net),0) AS net
    FROM poker_apps pa
    LEFT JOIN accounting_entries ae ON ae.app_id = pa.id ${period ? "AND ae.period_label = @period" : ""}
    GROUP BY pa.id ORDER BY net DESC
  `;
  return db.prepare(q).all(period ? { period } : {});
}

export function getNetByPlayer(period?: string) {
  const db = getDb();
  let q = `
    SELECT p.id, p.name, p.status,
      COALESCE(SUM(ae.gross_amount),0) AS gross,
      COALESCE(SUM(ae.player_cut),0) AS player_cuts,
      COALESCE(SUM(ae.my_net),0) AS net
    FROM players p
    LEFT JOIN accounting_entries ae ON ae.player_id = p.id ${period ? "AND ae.period_label = @period" : ""}
    GROUP BY p.id ORDER BY net DESC
  `;
  return db.prepare(q).all(period ? { period } : {});
}

export function getNetByWeek() {
  const db = getDb();
  return db.prepare(`
    SELECT strftime('%Y-W%W', period_end) AS week,
      SUM(gross_amount) AS gross, SUM(player_cut) AS player_cuts, SUM(my_net) AS net
    FROM accounting_entries
    GROUP BY week ORDER BY week DESC LIMIT 12
  `).all();
}

export function getNetByMonth() {
  const db = getDb();
  return db.prepare(`
    SELECT strftime('%Y-%m', period_end) AS month,
      SUM(gross_amount) AS gross, SUM(player_cut) AS player_cuts, SUM(my_net) AS net
    FROM accounting_entries
    GROUP BY month ORDER BY month DESC LIMIT 12
  `).all();
}

export function getSignals() {
  const db = getDb();

  const pendingReports = db.prepare(`
    SELECT pa.name, MAX(r.period_end) AS last_report
    FROM poker_apps pa
    LEFT JOIN reports r ON r.app_id = pa.id
    GROUP BY pa.id
    HAVING last_report IS NULL OR last_report < date('now','-25 days')
  `).all();

  const inactivePlayers = db.prepare(`
    SELECT p.name, MAX(ae.period_end) AS last_activity
    FROM players p
    LEFT JOIN accounting_entries ae ON ae.player_id = p.id
    WHERE p.status = 'active'
    GROUP BY p.id
    HAVING last_activity IS NULL OR last_activity < date('now','-45 days')
  `).all();

  const unsettledLedger = db.prepare(`
    SELECT SUM(CASE WHEN direction='in' THEN amount ELSE -amount END) AS balance
    FROM telegram_transactions
    WHERE tx_date >= date('now','-30 days')
  `).get() as { balance: number } | undefined;

  const topPlayers = db.prepare(`
    SELECT p.name, SUM(ae.my_net) AS net
    FROM accounting_entries ae
    JOIN players p ON p.id = ae.player_id
    WHERE ae.period_end >= date('now','-30 days')
    GROUP BY p.id ORDER BY net DESC LIMIT 3
  `).all();

  return { pendingReports, inactivePlayers, unsettledLedger, topPlayers };
}

export function getPeriods() {
  const db = getDb();
  return db.prepare(`SELECT DISTINCT period_label FROM accounting_entries ORDER BY period_end DESC`).all() as { period_label: string }[];
}

// ── Wallet Transactions ───────────────────────────────────
export function getWalletTransactions(filters?: { player_id?: number; game_id?: number; game_name?: string; limit?: number; since_date?: string }) {
  const db = getDb();
  let q = `
    SELECT wt.*, p.name AS player_name,
      COALESCE(g.name, pa.name, 'Unknown') AS game_name
    FROM wallet_transactions wt
    JOIN players p ON p.id = wt.player_id
    LEFT JOIN games g ON g.id = wt.game_id
    LEFT JOIN poker_apps pa ON pa.id = wt.app_id
    WHERE 1=1
  `;
  const params: Record<string, unknown> = {};
  if (filters?.player_id) { q += ` AND wt.player_id = @player_id`; params.player_id = filters.player_id; }
  if (filters?.game_id)   { q += ` AND wt.game_id = @game_id`;    params.game_id = filters.game_id; }
  if (filters?.game_name) { q += ` AND COALESCE(g.name, pa.name) = @game_name`; params.game_name = filters.game_name; }
  if (filters?.since_date) { q += ` AND wt.tx_date >= @since_date`; params.since_date = filters.since_date; }
  q += ` ORDER BY wt.tx_date DESC, wt.created_at DESC`;
  if (filters?.limit)     { q += ` LIMIT @limit`;                  params.limit = filters.limit; }
  return db.prepare(q).all(params);
}

export function getWalletSummaryByPlayer(filters?: { game_name?: string; since_date?: string }) {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters?.game_name) { conditions.push(`g.name = @game_name`); params.game_name = filters.game_name; }
  const dateJoin = filters?.since_date
    ? `LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id AND wt.tx_date >= @since_date`
    : `LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id`;
  if (filters?.since_date) params.since_date = filters.since_date;
  const q = `
    SELECT
      pgd.id AS deal_id,
      p.id AS player_id, p.name AS player_name,
      g.id AS game_id, g.name AS game_name,
      pgd.action_pct, pgd.rakeback_pct,
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

export function getWalletKPIs(filters?: { game_name?: string; since_date?: string }) {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters?.game_name) { conditions.push(`g.name = @game_name`); params.game_name = filters.game_name; }
  const dateJoin = filters?.since_date
    ? `LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id AND wt.tx_date >= @since_date`
    : `LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id`;
  if (filters?.since_date) params.since_date = filters.since_date;
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
  `).get(playerId) as { deposited: number; withdrawn: number; net: number; my_pnl: number } | undefined;
}

export function insertWalletTransaction(data: {
  player_id: number; game_id: number; type: "deposit" | "withdrawal";
  amount: number; currency?: string; note?: string; tx_date: string;
}) {
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO wallet_transactions (player_id, game_id, type, amount, currency, note, tx_date)
    VALUES (@player_id, @game_id, @type, @amount, @currency, @note, @tx_date)
  `).run({ currency: "USDT", note: null, ...data });
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
      p.id, p.name, p.telegram_handle, p.telegram_phone, p.status, p.tier, p.action_pct, p.notes,
      (SELECT content FROM crm_notes WHERE player_id = p.id ORDER BY created_at DESC LIMIT 1) AS last_note,
      (SELECT created_at FROM crm_notes WHERE player_id = p.id ORDER BY created_at DESC LIMIT 1) AS last_activity,
      (SELECT COUNT(*) FROM crm_notes WHERE player_id = p.id) AS note_count,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) AS wallet_net,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END) * p.action_pct / 100, 0) AS my_pnl,
      (SELECT COUNT(*) FROM tg_messages WHERE player_id = p.id) AS msg_count,
      (SELECT msg_date FROM tg_messages WHERE player_id = p.id ORDER BY msg_date DESC LIMIT 1) AS last_msg_date,
      COALESCE((SELECT SUM(CASE WHEN direction='in' THEN amount ELSE -amount END) FROM telegram_transactions WHERE player_id = p.id), 0) AS balance_du
    FROM players p
    LEFT JOIN wallet_transactions wt ON wt.player_id = p.id
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
export function getTelePlayers() {
  return getDb().prepare(`
    SELECT
      p.id, p.name, p.tron_address AS wallet_game, p.tele_wallet_cashout AS wallet_cashout,
      pgd.action_pct, pgd.rakeback_pct,
      COALESCE(SUM(CASE WHEN wt.type='deposit'    THEN wt.amount ELSE 0 END), 0) AS total_deposited,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE 0 END), 0) AS total_withdrawn,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) AS net,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) * pgd.action_pct / 100 AS my_pnl,
      COUNT(wt.id) AS tx_count,
      MAX(wt.tx_date) AS last_tx
    FROM players p
    JOIN player_game_deals pgd ON pgd.player_id = p.id
    JOIN games g ON g.id = pgd.game_id AND g.name = 'TELE'
    LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = g.id
    GROUP BY p.id
    ORDER BY p.name
  `).all() as {
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
    WHERE wt.game_id IS NOT NULL
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
  amount: number; currency: string; tx_date: string; tron_tx_hash: string;
  counterparty_address?: string | null;
}) {
  const db = getDb();
  const params = { note: "auto-sync", counterparty_address: null, ...data };
  // First: try insert. INSERT OR IGNORE returns 0 changes on conflict (existing hash).
  const ins = db.prepare(`
    INSERT OR IGNORE INTO wallet_transactions (player_id, game_id, type, amount, currency, tx_date, tron_tx_hash, counterparty_address, note)
    VALUES (@player_id, @game_id, @type, @amount, @currency, @tx_date, @tron_tx_hash, @counterparty_address, @note)
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
