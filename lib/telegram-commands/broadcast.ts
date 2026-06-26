import { getDb } from "@/lib/db";
import { sendMsg, sendMsgKeyboard, answerCbQuery, mentionOf, AGENT_CHAT_ID } from "./helpers";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const pendingBroadcasts = new Map<number, any>();
let isBroadcasting = false;

type Channel = "alertes" | "liveplay";

const CHANNEL_LABELS: Record<Channel, string> = {
  alertes: "📢 Alertes",
  liveplay: "🎰 Liveplay",
};

const TOPIC_COLUMN: Record<Channel, string> = {
  alertes: "alertes_topic_id",
  liveplay: "liveplay_topic_id",
};

function detectMessageType(msg: any): string {
  if (msg.photo) return "photo";
  if (msg.video) return "video";
  if (msg.document) return "document";
  if (msg.audio) return "audio";
  if (msg.voice) return "voice";
  if (msg.animation) return "animation";
  if (msg.video_note) return "video_note";
  if (msg.sticker) return "sticker";
  if (msg.text) return "text";
  return "unknown";
}

type Recipient = {
  id: number;
  name: string;
  telegram_handle: string | null;
  telegram_id: number | null;
  telegram_group_id: string;
  topic_id: number | null;
};

// NOTE: we DO NOT filter out players whose topic_id is NULL anymore. A missing topic
// must NOT silently drop the player from alerts — instead the send falls back to the
// group root (General). Only a group link is required.
function getRecipients(channel: Channel, gameId?: number): Recipient[] {
  const col = TOPIC_COLUMN[channel];
  const gameFilter = gameId
    ? `AND id IN (SELECT player_id FROM player_game_deals WHERE game_id = ${gameId})`
    : "";
  return getDb().prepare(`
    SELECT id, name, telegram_handle, telegram_id, telegram_group_id, ${col} AS topic_id
    FROM players
    WHERE status = 'active'
      AND telegram_group_id IS NOT NULL
      ${gameFilter}
  `).all() as Recipient[];
}

function getActiveGames(): { id: number; name: string }[] {
  return getDb().prepare(`SELECT id, name FROM games WHERE status = 'active' ORDER BY id`).all() as any[];
}

export async function handleBroadcast(msg: any, chatId: number) {
  if (String(chatId) !== AGENT_CHAT_ID) return;

  const original = msg.reply_to_message;
  if (!original) {
    await sendMsg(chatId, "Réponds à un message avec /broadcast pour le diffuser.");
    return;
  }

  const msgType = detectMessageType(original);
  if (msgType === "unknown") {
    await sendMsg(chatId, "Ce type de message ne peut pas être diffusé.");
    return;
  }

  if (isBroadcasting) {
    await sendMsg(chatId, "Un broadcast est déjà en cours. Attends qu'il finisse.");
    return;
  }

  pendingBroadcasts.set(original.message_id, original);

  await sendMsgKeyboard(chatId,
    `📢 <b>Où envoyer ?</b>`,
    [
      [{ text: "📢 Alertes", callback_data: `bc_ch:alertes:${original.message_id}` }],
      [{ text: "🎰 Liveplay", callback_data: `bc_ch:liveplay:${original.message_id}` }],
      [{ text: "❌ Annuler", callback_data: "bc_no" }],
    ]
  );
}

export async function handleBroadcastCallback(callbackId: string, data: string, cbMsg: any) {
  await answerCbQuery(callbackId);

  const chatId = cbMsg?.chat?.id;
  if (!chatId || String(chatId) !== AGENT_CHAT_ID) return;
  const msgId = cbMsg.message_id;

  if (data === "bc_no") {
    await editMessage(chatId, msgId, "❌ Broadcast annulé.");
    return;
  }

  // Step 1: channel selected → show game filter buttons
  const chMatch = data.match(/^bc_ch:(alertes|liveplay):(\d+)$/);
  if (chMatch) {
    const channel = chMatch[1] as Channel;
    const originalMsgId = parseInt(chMatch[2]);
    const original = pendingBroadcasts.get(originalMsgId);
    if (!original) {
      await editMessage(chatId, msgId, "❌ Message source expiré. Relance /broadcast.");
      return;
    }

    const games = getActiveGames();
    const buttons: any[][] = [
      [{ text: "📢 TOUS", callback_data: `bc_game:all:${channel}:${originalMsgId}` }],
    ];
    for (const g of games) {
      buttons.push([{ text: `🃏 ${g.name}`, callback_data: `bc_game:${g.id}:${channel}:${originalMsgId}` }]);
    }
    buttons.push([{ text: "❌ Annuler", callback_data: "bc_no" }]);

    await editMessageKeyboard(chatId, msgId,
      `📢 <b>Quels joueurs cibler ?</b>\n\nChannel : <b>${CHANNEL_LABELS[channel]}</b>`,
      buttons
    );
    return;
  }

  // Step 2: game filter selected → show preview
  const gameMatch = data.match(/^bc_game:(all|\d+):(alertes|liveplay):(\d+)$/);
  if (gameMatch) {
    const gameFilter = gameMatch[1];
    const channel = gameMatch[2] as Channel;
    const originalMsgId = parseInt(gameMatch[3]);
    const original = pendingBroadcasts.get(originalMsgId);
    if (!original) {
      await editMessage(chatId, msgId, "❌ Message source expiré. Relance /broadcast.");
      return;
    }

    const gameId = gameFilter === "all" ? undefined : parseInt(gameFilter);
    const recipients = getRecipients(channel, gameId);

    if (recipients.length === 0) {
      const label = gameFilter === "all" ? "TOUS" : getActiveGames().find(g => g.id === gameId)?.name ?? gameFilter;
      await editMessage(chatId, msgId,
        `❌ Aucun joueur actif avec un groupe pour <b>${label}</b>.`
      );
      return;
    }

    const gameLabel = gameFilter === "all" ? "TOUS" : getActiveGames().find(g => g.id === gameId)?.name ?? gameFilter;
    const msgType = detectMessageType(original);
    const names = recipients.slice(0, 5).map(r => r.name).join(", ") + (recipients.length > 5 ? ` +${recipients.length - 5}` : "");
    const fallbackCount = recipients.filter(r => !r.topic_id).length;

    await editMessageKeyboard(chatId, msgId,
      `📢 <b>Broadcast preview</b>\n\n` +
      `Type : <b>${msgType}</b>\n` +
      `Channel : <b>${CHANNEL_LABELS[channel]}</b>\n` +
      `Cible : <b>${gameLabel}</b>\n` +
      `Destinataires : <b>${recipients.length} joueurs</b>\n` +
      (fallbackCount > 0 ? `⚠️ ${fallbackCount} sans topic ${CHANNEL_LABELS[channel]} → envoi en General\n` : "") +
      `<i>${names}</i>`,
      [[
        { text: "✅ Confirmer", callback_data: `bc_go:${gameFilter}:${channel}:${originalMsgId}` },
        { text: "❌ Annuler", callback_data: "bc_no" },
      ]]
    );
    return;
  }

  // Step 3: confirm → fan out
  const goMatch = data.match(/^bc_go:(all|\d+):(alertes|liveplay):(\d+)$/);
  if (!goMatch) return;

  const gameFilter = goMatch[1];
  const channel = goMatch[2] as Channel;
  const originalMsgId = parseInt(goMatch[3]);

  const original = pendingBroadcasts.get(originalMsgId);
  if (!original) {
    await editMessage(chatId, msgId, "❌ Message source expiré. Relance /broadcast.");
    return;
  }
  pendingBroadcasts.delete(originalMsgId);

  if (isBroadcasting) {
    await editMessage(chatId, msgId, "❌ Un broadcast est déjà en cours.");
    return;
  }
  isBroadcasting = true;

  try {
    const gameId = gameFilter === "all" ? undefined : parseInt(gameFilter);
    const gameLabel = gameFilter === "all" ? "TOUS" : getActiveGames().find(g => g.id === gameId)?.name ?? gameFilter;
    await editMessage(chatId, msgId, `📤 Diffusion en cours vers ${CHANNEL_LABELS[channel]} (${gameLabel})...`);

    const recipients = getRecipients(channel, gameId);
    const msgType = detectMessageType(original);
    const token = process.env.TELEGRAM_BOT_TOKEN;

    let sent = 0;
    let fallback = 0;
    const errors: string[] = [];

    for (const player of recipients) {
      try {
        const mention = mentionOf(player);
        // topic_id NULL → post to the group root (General) instead of dropping the player.
        const topicId = player.topic_id ?? undefined;
        const groupId = player.telegram_group_id;
        if (!topicId) {
          fallback++;
          console.warn(`[BROADCAST] ${player.name} (#${player.id}) has no ${channel} topic → fallback General (group ${groupId})`);
        }

        if (msgType === "text") {
          await sendMsg(groupId, `${mention} 👇\n\n${escapeHtml(original.text)}`, topicId);
        } else {
          const originalCaption = original.caption ?? "";
          const caption = originalCaption
            ? `${mention} 👇\n\n${escapeHtml(originalCaption)}`
            : `${mention} 👇`;

          const res = await fetch(`https://api.telegram.org/bot${token}/copyMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: groupId,
              from_chat_id: chatId,
              message_id: originalMsgId,
              ...(topicId ? { message_thread_id: topicId } : {}),
              caption,
              parse_mode: "HTML",
            }),
          });

          if (!res.ok) {
            const err = await res.text();
            throw new Error(err);
          }
        }

        sent++;
      } catch (e: any) {
        const reason = e.message?.slice(0, 100) ?? String(e);
        errors.push(`${player.name} : ${reason}`);
      }

      await sleep(200);
    }

    let report = `✅ Diffusé à ${sent}/${recipients.length} joueurs (${CHANNEL_LABELS[channel]} · ${gameLabel})`;
    if (fallback > 0) report += `\nℹ️ ${fallback} en General (topic manquant — lance /fixgroup dans leur groupe)`;
    if (errors.length > 0) {
      report += `\n\n❌ Échec (${errors.length}) :\n` + errors.map(e => `• ${e}`).join("\n");
    }
    await editMessage(chatId, msgId, report);
  } finally {
    isBroadcasting = false;
  }
}

async function editMessage(chatId: number | string, messageId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
    }),
  });
}

async function editMessageKeyboard(chatId: number | string, messageId: number, text: string, keyboard: any[][]) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: JSON.stringify({ inline_keyboard: keyboard }),
    }),
  });
}
