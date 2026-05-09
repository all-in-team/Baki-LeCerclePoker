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
  topic_id: number;
};

function getRecipients(channel: Channel): Recipient[] {
  const col = TOPIC_COLUMN[channel];
  return getDb().prepare(`
    SELECT id, name, telegram_handle, telegram_id, telegram_group_id, ${col} AS topic_id
    FROM players
    WHERE status = 'active'
      AND telegram_group_id IS NOT NULL
      AND ${col} IS NOT NULL
  `).all() as Recipient[];
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

  // Step 1 callback: channel selection → show preview
  const chMatch = data.match(/^bc_ch:(alertes|liveplay):(\d+)$/);
  if (chMatch) {
    const channel = chMatch[1] as Channel;
    const originalMsgId = parseInt(chMatch[2]);
    const original = pendingBroadcasts.get(originalMsgId);
    if (!original) {
      await editMessage(chatId, msgId, "❌ Message source expiré. Relance /broadcast.");
      return;
    }

    const recipients = getRecipients(channel);
    if (recipients.length === 0) {
      await editMessage(chatId, msgId,
        `❌ Aucun joueur avec un topic ${CHANNEL_LABELS[channel]} configuré.\n` +
        `Lance le backfill : <code>POST /api/admin/backfill-${channel === "alertes" ? "alertes" : "liveplay"}-topic</code>`
      );
      return;
    }

    const msgType = detectMessageType(original);
    await editMessageKeyboard(chatId, msgId,
      `📢 <b>Broadcast preview</b>\n\n` +
      `Type : <b>${msgType}</b>\n` +
      `Channel : <b>${CHANNEL_LABELS[channel]}</b>\n` +
      `Destinataires : <b>${recipients.length} joueurs actifs</b>`,
      [[
        { text: "✅ Confirmer", callback_data: `bc_go:${channel}:${originalMsgId}` },
        { text: "❌ Annuler", callback_data: "bc_no" },
      ]]
    );
    return;
  }

  // Step 2 callback: confirm → fan out
  const goMatch = data.match(/^bc_go:(alertes|liveplay):(\d+)$/);
  if (!goMatch) return;

  const channel = goMatch[1] as Channel;
  const originalMsgId = parseInt(goMatch[2]);

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
    await editMessage(chatId, msgId, `📤 Diffusion en cours vers ${CHANNEL_LABELS[channel]}...`);

    const recipients = getRecipients(channel);
    const msgType = detectMessageType(original);
    const token = process.env.TELEGRAM_BOT_TOKEN;

    let sent = 0;
    const errors: string[] = [];

    for (const player of recipients) {
      try {
        const mention = mentionOf(player);
        const topicId = player.topic_id;
        const groupId = player.telegram_group_id;

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
              message_thread_id: topicId,
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

    let report = `✅ Diffusé à ${sent}/${recipients.length} joueurs (${CHANNEL_LABELS[channel]})`;
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
