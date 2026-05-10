import { getDb } from "@/lib/db";
import { sendMsg, answerCbQuery, AGENT_CHAT_ID } from "./helpers";
import { getWeekBounds, toParisDate, toUTCISO } from "@/lib/date-utils";

// ── Types ────────────────────────────────────────────────

type CashoutPlayer = {
  id: number;
  name: string;
  telegram_handle: string | null;
  telegram_id: number | null;
  telegram_group_id: string;
  accounting_topic_id: number;
};

type SkipEntry = { player_id: number; name: string; reason: string };
type SendEntry = { player_id: number; name: string; topic_id: number; username: string | null };

export interface CashoutResult {
  sent: number;
  skipped: number;
  errors: string[];
  dry_run?: boolean;
  would_send_to?: SendEntry[];
  would_skip?: SkipEntry[];
  summary?: { would_send: number; would_skip: number };
}

// ── Helpers ──────────────────────────────────────────────

export function getCurrentWeekStart(): string {
  const { start } = getWeekBounds(0);
  return toParisDate(toUTCISO(start));
}

function getActivePlayersForCashout(): CashoutPlayer[] {
  return getDb().prepare(`
    SELECT id, name, telegram_handle, telegram_id, telegram_group_id, accounting_topic_id
    FROM players
    WHERE status IN ('active', 'signed')
      AND telegram_group_id IS NOT NULL
      AND accounting_topic_id IS NOT NULL
  `).all() as CashoutPlayer[];
}

function getPendingPlayers(weekStart: string): CashoutPlayer[] {
  return getDb().prepare(`
    SELECT p.id, p.name, p.telegram_handle, p.telegram_id, p.telegram_group_id, p.accounting_topic_id
    FROM players p
    JOIN weekly_cashout_state wcs ON wcs.player_id = p.id AND wcs.week_start = ?
    WHERE wcs.cashout_confirmed = 0
      AND wcs.not_played = 0
      AND p.telegram_group_id IS NOT NULL
      AND p.accounting_topic_id IS NOT NULL
  `).all(weekStart) as CashoutPlayer[];
}

function ensureCashoutState(playerId: number, weekStart: string) {
  getDb().prepare(`
    INSERT OR IGNORE INTO weekly_cashout_state (player_id, week_start, reminder_sent_at)
    VALUES (?, ?, datetime('now'))
  `).run(playerId, weekStart);
}

function markConfirmed(playerId: number, weekStart: string) {
  getDb().prepare(`
    UPDATE weekly_cashout_state
    SET cashout_confirmed = 1, confirmed_at = datetime('now')
    WHERE player_id = ? AND week_start = ?
  `).run(playerId, weekStart);
}

function isResolved(playerId: number, weekStart: string): boolean {
  const row = getDb().prepare(`
    SELECT cashout_confirmed, not_played FROM weekly_cashout_state
    WHERE player_id = ? AND week_start = ?
  `).get(playerId, weekStart) as { cashout_confirmed: number; not_played: number } | undefined;
  return !!(row?.cashout_confirmed || row?.not_played);
}

function getLastMessageAt(playerId: number, weekStart: string): string | null {
  const row = getDb().prepare(`
    SELECT last_message_at FROM weekly_cashout_state
    WHERE player_id = ? AND week_start = ?
  `).get(playerId, weekStart) as { last_message_at: string | null } | undefined;
  return row?.last_message_at ?? null;
}

function touchLastMessage(playerId: number, weekStart: string) {
  getDb().prepare(`
    UPDATE weekly_cashout_state
    SET last_message_at = datetime('now'), reminder_sent_at = COALESCE(reminder_sent_at, datetime('now'))
    WHERE player_id = ? AND week_start = ?
  `).run(playerId, weekStart);
}

function markNotPlayed(playerId: number, weekStart: string) {
  getDb().prepare(`
    UPDATE weekly_cashout_state
    SET not_played = 1, confirmed_at = datetime('now')
    WHERE player_id = ? AND week_start = ?
  `).run(playerId, weekStart);
}

function getNotPlayedCount(weekStart: string): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n FROM weekly_cashout_state
    WHERE week_start = ? AND not_played = 1
  `).get(weekStart) as { n: number };
  return row.n;
}

function incrementEscalation(playerId: number, weekStart: string) {
  getDb().prepare(`
    UPDATE weekly_cashout_state
    SET escalation_count = escalation_count + 1, last_message_at = datetime('now')
    WHERE player_id = ? AND week_start = ?
  `).run(playerId, weekStart);
}

function isOpsAlerted(weekStart: string): boolean {
  const row = getDb().prepare(`
    SELECT MAX(ops_alerted) AS alerted FROM weekly_cashout_state WHERE week_start = ?
  `).get(weekStart) as { alerted: number } | undefined;
  return !!(row?.alerted);
}

function markOpsAlerted(weekStart: string) {
  getDb().prepare(`
    UPDATE weekly_cashout_state SET ops_alerted = 1
    WHERE week_start = ? AND cashout_confirmed = 0
  `).run(weekStart);
}

const DEDUP_ESCALATION_MINUTES = 25;

function minutesSinceLastMessage(playerId: number, weekStart: string): number | null {
  const lastAt = getLastMessageAt(playerId, weekStart);
  if (!lastAt) return null;
  const lastMs = new Date(lastAt + "Z").getTime();
  const nowMs = Date.now();
  return (nowMs - lastMs) / 60_000;
}

// ── Telegram API wrappers ────────────────────────────────

async function sendTgMsgWithButton(
  chatId: string, text: string, keyboard: any[][], threadId: number
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const body: Record<string, any> = {
    chat_id: chatId, text, parse_mode: "HTML",
    reply_markup: JSON.stringify({ inline_keyboard: keyboard }),
    message_thread_id: threadId,
  };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("[CASHOUT]", chatId, res.status, await res.text());
    return false;
  }
  return true;
}

async function editTgMessage(chatId: number | string, messageId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId, message_id: messageId, text, parse_mode: "HTML",
    }),
  });
}

// ── Message templates ────────────────────────────────────

const INITIAL_MESSAGE =
`\u{1F3AC} <b>Cashout de la semaine</b>

Avant <b>20h heure de Paris</b> :

1. <b>Full cashout</b> : tu vides complètement ta roll sur l'app
2. Tu envoies dans ce topic <b>un screen recording</b> qui montre :
   - Ta roll <b>vide</b> (preuve du cashout complet)
   - Tes <b>transferts USDT</b> (dépôts + retraits de la semaine)

Tu pourras recommencer à jouer <b>après 00h heure de Paris</b> (lundi).

Quand c'est fait, clique sur le bouton ci-dessous \u{1F447}`;

function playerTag(player: CashoutPlayer): string {
  if (player.telegram_handle) return `@${player.telegram_handle}`;
  if (player.telegram_id) return `<a href="tg://user?id=${player.telegram_id}">${player.name.split(" ")[0]}</a>`;
  return `<b>${player.name}</b>`;
}

function makeButtons(playerId: number, weekStart: string) {
  return [
    [{ text: "✅ C'est fait, j'ai tout envoyé", callback_data: `cashout_done:${playerId}:${weekStart}` }],
    [{ text: "⏸️ Je n'ai pas joué cette semaine", callback_data: `cashout_skipped:${playerId}:${weekStart}` }],
  ];
}

function toSendEntry(p: CashoutPlayer): SendEntry {
  return { player_id: p.id, name: p.name, topic_id: p.accounting_topic_id, username: p.telegram_handle };
}

// ── Public API ───────────────────────────────────────────

export async function sendInitialReminders(playerIds?: number[], dryRun = false): Promise<CashoutResult> {
  const weekStart = getCurrentWeekStart();
  let players = getActivePlayersForCashout();
  if (playerIds && playerIds.length > 0) {
    players = players.filter(p => playerIds.includes(p.id));
  }

  const wouldSend: SendEntry[] = [];
  const wouldSkip: SkipEntry[] = [];
  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const player of players) {
    if (isResolved(player.id, weekStart)) {
      wouldSkip.push({ player_id: player.id, name: player.name, reason: "already resolved (confirmed or not_played)" });
      skipped++;
      continue;
    }

    ensureCashoutState(player.id, weekStart);

    const lastAt = getLastMessageAt(player.id, weekStart);
    if (lastAt !== null) {
      wouldSkip.push({ player_id: player.id, name: player.name, reason: "already sent initial this week" });
      skipped++;
      continue;
    }

    if (dryRun) {
      wouldSend.push(toSendEntry(player));
      continue;
    }

    const ok = await sendTgMsgWithButton(
      player.telegram_group_id,
      `${playerTag(player)}\n\n${INITIAL_MESSAGE}`,
      makeButtons(player.id, weekStart),
      player.accounting_topic_id
    );

    if (ok) {
      touchLastMessage(player.id, weekStart);
      sent++;
    } else {
      errors.push(`${player.name}: send failed`);
    }
  }

  if (dryRun) {
    return {
      sent: 0, skipped, errors: [],
      dry_run: true,
      would_send_to: wouldSend,
      would_skip: wouldSkip,
      summary: { would_send: wouldSend.length, would_skip: wouldSkip.length },
    };
  }

  return { sent, skipped, errors };
}

export async function sendEscalationReminders(playerIds?: number[], dryRun = false): Promise<CashoutResult> {
  const weekStart = getCurrentWeekStart();
  let pending = getPendingPlayers(weekStart);
  if (playerIds && playerIds.length > 0) {
    pending = pending.filter(p => playerIds.includes(p.id));
  }

  const wouldSend: SendEntry[] = [];
  const wouldSkip: SkipEntry[] = [];
  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const player of pending) {
    if (isResolved(player.id, weekStart)) {
      wouldSkip.push({ player_id: player.id, name: player.name, reason: "already resolved" });
      skipped++;
      continue;
    }

    const minSince = minutesSinceLastMessage(player.id, weekStart);
    if (minSince !== null && minSince < DEDUP_ESCALATION_MINUTES) {
      wouldSkip.push({ player_id: player.id, name: player.name, reason: `dedup: last message ${Math.round(minSince)}min ago (threshold ${DEDUP_ESCALATION_MINUTES}min)` });
      skipped++;
      continue;
    }

    if (dryRun) {
      wouldSend.push(toSendEntry(player));
      continue;
    }

    incrementEscalation(player.id, weekStart);

    const ok = await sendTgMsgWithButton(
      player.telegram_group_id,
      `${playerTag(player)}\n\n⏰ Reminder : on attend ton cashout + screen recording. Ping-moi quand c'est fait.`,
      makeButtons(player.id, weekStart),
      player.accounting_topic_id
    );

    if (ok) sent++;
    else errors.push(`${player.name}: send failed`);
  }

  if (dryRun) {
    return {
      sent: 0, skipped, errors: [],
      dry_run: true,
      would_send_to: wouldSend,
      would_skip: wouldSkip,
      summary: { would_send: wouldSend.length, would_skip: wouldSkip.length },
    };
  }

  return { sent, skipped, errors };
}

export async function sendFinalAlert(dryRun = false): Promise<{ pending_count: number; not_played_count: number; alerted: boolean; dry_run?: boolean }> {
  const weekStart = getCurrentWeekStart();
  const pending = getPendingPlayers(weekStart);
  const notPlayedCount = getNotPlayedCount(weekStart);

  if (pending.length === 0) {
    return { pending_count: 0, not_played_count: notPlayedCount, alerted: false };
  }

  if (isOpsAlerted(weekStart)) {
    return { pending_count: pending.length, not_played_count: notPlayedCount, alerted: false };
  }

  if (dryRun) {
    return { pending_count: pending.length, not_played_count: notPlayedCount, alerted: false, dry_run: true };
  }

  const lines = pending.map(p => {
    const internalId = String(p.telegram_group_id).replace(/^-100/, "");
    const link = `https://t.me/c/${internalId}/${p.accounting_topic_id}`;
    return `• ${p.name} (<a href="${link}">groupe</a>)`;
  });

  let msg = `⚠️ <b>Joueurs en retard cashout (${pending.length})</b>\n\n${lines.join("\n")}\n\nAction manuelle requise.`;
  if (notPlayedCount > 0) {
    msg += `\n\n⏸️ Joueurs qui n'ont pas joué cette semaine : ${notPlayedCount}`;
  }

  await sendMsg(AGENT_CHAT_ID, msg);
  markOpsAlerted(weekStart);
  return { pending_count: pending.length, not_played_count: notPlayedCount, alerted: true };
}

// ── Callback handlers ────────────────────────────────────

export async function handleCashoutDoneCallback(
  callbackId: string,
  data: string,
  chatId: number | string,
  messageId: number,
  threadId?: number
) {
  const match = data.match(/^cashout_done:(\d+):(.+)$/);
  if (!match) {
    await answerCbQuery(callbackId, "Données invalides");
    return;
  }

  const playerId = parseInt(match[1]);
  const weekStart = match[2];

  if (isResolved(playerId, weekStart)) {
    await answerCbQuery(callbackId, "Déjà confirmé ✅");
    return;
  }

  ensureCashoutState(playerId, weekStart);
  markConfirmed(playerId, weekStart);
  await answerCbQuery(callbackId, "✅ Confirmé !");

  await editTgMessage(chatId, messageId,
    "\u{1F3AC} <b>Cashout de la semaine</b>\n\n✅ <b>Confirmé</b>"
  );

  await sendMsg(
    chatId,
    "✅ Reçu, ton settlement sera calculé demain. Bonne soirée \u{1F0CF}",
    threadId
  );
}

export async function handleCashoutSkippedCallback(
  callbackId: string,
  data: string,
  chatId: number | string,
  messageId: number,
  threadId?: number
) {
  const match = data.match(/^cashout_skipped:(\d+):(.+)$/);
  if (!match) {
    await answerCbQuery(callbackId, "Données invalides");
    return;
  }

  const playerId = parseInt(match[1]);
  const weekStart = match[2];

  if (isResolved(playerId, weekStart)) {
    await answerCbQuery(callbackId, "Déjà pris en compte ✅");
    return;
  }

  ensureCashoutState(playerId, weekStart);
  markNotPlayed(playerId, weekStart);
  await answerCbQuery(callbackId, "⏸️ Noté !");

  await editTgMessage(chatId, messageId,
    "\u{1F3AC} <b>Cashout de la semaine</b>\n\n⏸️ <b>Pas joué cette semaine</b>"
  );

  await sendMsg(
    chatId,
    "Reçu, on te ping à nouveau dimanche prochain. Bon week-end \u{1F0CF}",
    threadId
  );
}
