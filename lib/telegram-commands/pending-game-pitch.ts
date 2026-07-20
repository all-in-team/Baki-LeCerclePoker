import { getDb } from "@/lib/db";

// Persistent pitch-intent ledger for the self-service deep-link games (OKPOKER / JVIP /
// TTPOKER). The in-memory pendingGroupData Map (onboarding.ts) does NOT survive a process
// restart, and a player can take hours to join the group after clicking the link — so the
// intent to auto-post the game pitch is persisted in `pending_game_pitches` and consumed
// atomically when the player actually joins (handleNewMembers). This is what makes the
// self-service flow incassable: a delayed join or a redeploy still fires the pitch.
//
// kk/a5 keep their existing Map-based askActionPct flow — NOT touched here.
export const AUTO_PITCH_GAMES = new Set(["OKPOKER", "JVIP", "TTPOKER", "WN"]);

// Default action % for the auto-pitch (owner adjusts after via /crm or a re-run). Never
// asked to the player. Falls back to 30 if the game row has no default.
export function defaultActionPct(gameName: string): number {
  const row = getDb().prepare(`SELECT default_action_pct FROM games WHERE name = ?`).get(gameName) as { default_action_pct: number | null } | undefined;
  return row?.default_action_pct ?? 30;
}

// Arm (or re-arm) a pending pitch at group-creation time. Idempotent per (telegram_id,
// game): re-clicking before the player has joined just refreshes group_id + created_at.
// Does NOT clear a prior consumed_at — a pitch already sent stays sent (dedup lives in the
// claim + hasPitchBeenSent guards, not here).
export function armPendingGamePitch(telegramId: number, gameName: string, groupId: string | null) {
  getDb().prepare(`
    INSERT INTO pending_game_pitches (player_telegram_id, game_name, group_id, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(player_telegram_id, game_name) DO UPDATE SET
      group_id = excluded.group_id,
      created_at = datetime('now')
  `).run(telegramId, gameName, groupId);
}

// Atomically claim an unconsumed pending pitch on player join. Returns the row IFF this call
// won the claim — guards against Telegram delivering BOTH new_chat_members and chat_member
// for the same join (webhook:303 + :308), which would otherwise post the pitch twice.
export function claimPendingGamePitch(telegramId: number): { game_name: string; group_id: string | null } | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, game_name, group_id FROM pending_game_pitches
    WHERE player_telegram_id = ? AND consumed_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(telegramId) as { id: number; game_name: string; group_id: string | null } | undefined;
  if (!row) return null;
  const claim = db.prepare(
    `UPDATE pending_game_pitches SET consumed_at = datetime('now') WHERE id = ? AND consumed_at IS NULL`
  ).run(row.id);
  if (claim.changes !== 1) return null; // lost the race to a duplicate join event
  return { game_name: row.game_name, group_id: row.group_id };
}

// Has the pitch for this (player, game) already been posted? Used by the re-click reprise
// path to decide "re-fire into the existing group" vs "just point them to it".
export function hasPitchBeenSent(telegramId: number, gameName: string): boolean {
  return !!getDb().prepare(
    `SELECT 1 FROM pending_game_pitches WHERE player_telegram_id = ? AND game_name = ? AND consumed_at IS NOT NULL`
  ).get(telegramId, gameName);
}

// Mark a pitch consumed after firing it directly (reprise path, where there is no join
// event to claim). Upserts so a first-time reprise (no prior row) is recorded too.
export function markPitchConsumed(telegramId: number, gameName: string, groupId: string | null) {
  getDb().prepare(`
    INSERT INTO pending_game_pitches (player_telegram_id, game_name, group_id, created_at, consumed_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(player_telegram_id, game_name) DO UPDATE SET
      group_id = excluded.group_id,
      consumed_at = datetime('now')
  `).run(telegramId, gameName, groupId);
}

// Fire the game-specific pitch with the DEFAULT action % (no owner prompt). Same pitch the
// group /start<game> flow posts: deal shown, J'accepte, then wallet collection — all in the
// group's Onboarding topic (tid). Unknown game = no-op (defensive).
export async function dispatchGamePitch(
  gameName: string,
  chatId: number,
  playerId: number,
  player: { name: string; telegram_id: number | null; telegram_handle: string | null },
  tid?: number,
) {
  const pct = defaultActionPct(gameName);
  switch (gameName) {
    case "OKPOKER": {
      const { sendOkpokerPitch } = await import("@/lib/games/okpoker/onboarding");
      await sendOkpokerPitch(chatId, playerId, player, pct, tid);
      return;
    }
    case "JVIP": {
      const { sendJvipPitch } = await import("@/lib/games/jvip/onboarding");
      await sendJvipPitch(chatId, playerId, player, pct, tid);
      return;
    }
    case "TTPOKER": {
      const { sendTtpokerPitch } = await import("@/lib/games/ttpoker/onboarding");
      await sendTtpokerPitch(chatId, playerId, player, pct, tid);
      return;
    }
    case "WN": {
      const { sendWnPitch } = await import("@/lib/games/wn/onboarding");
      await sendWnPitch(chatId, playerId, player, pct, tid);
      return;
    }
  }
}
