import { getDb } from "@/lib/db";
import { sendMsg, answerCbQuery, AGENT_CHAT_ID } from "./helpers";
import { getWeekBounds, toParisDate, toUTCISO } from "@/lib/date-utils";

// ── Helpers ──────────────────────────────────────────────

export function getCurrentWeekStart(): string {
  const { start } = getWeekBounds(0);
  return toParisDate(toUTCISO(start));
}

type CashoutPlayer = {
  id: number;
  name: string;
  telegram_handle: string | null;
  telegram_id: number | null;
  telegram_group_id: string;
  accounting_topic_id: number;
};

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

function isConfirmed(playerId: number, weekStart: string): boolean {
  const row = getDb().prepare(`
    SELECT cashout_confirmed FROM weekly_cashout_state
    WHERE player_id = ? AND week_start = ?
  `).get(playerId, weekStart) as { cashout_confirmed: number } | undefined;
  return !!row?.cashout_confirmed;
}

function incrementEscalation(playerId: number, weekStart: string) {
  getDb().prepare(`
    UPDATE weekly_cashout_state
    SET escalation_count = escalation_count + 1
    WHERE player_id = ? AND week_start = ?
  `).run(playerId, weekStart);
}

function markOpsAlerted(weekStart: string) {
  getDb().prepare(`
    UPDATE weekly_cashout_state SET ops_alerted = 1
    WHERE week_start = ? AND cashout_confirmed = 0
  `).run(weekStart);
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

function makeButton(playerId: number, weekStart: string) {
  return [[{
    text: "✅ C'est fait, j'ai tout envoyé",
    callback_data: `cashout_done:${playerId}:${weekStart}`,
  }]];
}

// ── Public API ───────────────────────────────────────────

export async function sendInitialReminders(playerIds?: number[]): Promise<{ sent: number; skipped: number; errors: string[] }> {
  const weekStart = getCurrentWeekStart();
  let players = getActivePlayersForCashout();
  if (playerIds && playerIds.length > 0) {
    players = players.filter(p => playerIds.includes(p.id));
  }

  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const player of players) {
    if (isConfirmed(player.id, weekStart)) {
      skipped++;
      continue;
    }

    ensureCashoutState(player.id, weekStart);

    const ok = await sendTgMsgWithButton(
      player.telegram_group_id,
      INITIAL_MESSAGE,
      makeButton(player.id, weekStart),
      player.accounting_topic_id
    );

    if (ok) sent++;
    else errors.push(`${player.name}: send failed`);
  }

  return { sent, skipped, errors };
}

export async function sendEscalationReminders(playerIds?: number[]): Promise<{ sent: number; skipped: number; errors: string[] }> {
  const weekStart = getCurrentWeekStart();
  let pending = getPendingPlayers(weekStart);
  if (playerIds && playerIds.length > 0) {
    pending = pending.filter(p => playerIds.includes(p.id));
  }

  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const player of pending) {
    if (isConfirmed(player.id, weekStart)) {
      skipped++;
      continue;
    }

    incrementEscalation(player.id, weekStart);

    const ok = await sendTgMsgWithButton(
      player.telegram_group_id,
      "⏰ Reminder : on attend ton cashout + screen recording. Ping-moi quand c'est fait.",
      makeButton(player.id, weekStart),
      player.accounting_topic_id
    );

    if (ok) sent++;
    else errors.push(`${player.name}: send failed`);
  }

  return { sent, skipped, errors };
}

export async function sendFinalAlert(): Promise<{ pending_count: number; alerted: boolean }> {
  const weekStart = getCurrentWeekStart();
  const pending = getPendingPlayers(weekStart);

  if (pending.length === 0) {
    return { pending_count: 0, alerted: false };
  }

  const lines = pending.map(p => {
    const internalId = String(p.telegram_group_id).replace(/^-100/, "");
    const link = `https://t.me/c/${internalId}/${p.accounting_topic_id}`;
    return `• ${p.name} (<a href="${link}">groupe</a>)`;
  });

  await sendMsg(
    AGENT_CHAT_ID,
    `⚠️ <b>Joueurs en retard cashout (${pending.length})</b>\n\n${lines.join("\n")}\n\nAction manuelle requise.`
  );

  markOpsAlerted(weekStart);
  return { pending_count: pending.length, alerted: true };
}

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

  if (isConfirmed(playerId, weekStart)) {
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
