import { getDb } from "@/lib/db";
import { sendMsg, sendMsgKeyboard, answerCbQuery, mentionOf, AGENT_CHAT_ID } from "./helpers";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// In-memory store for pending broadcast content (single-server, fine for Railway)
const pendingBroadcasts = new Map<number, any>();
let isBroadcasting = false;

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
  alertes_topic_id: number;
};

function getRecipients(): Recipient[] {
  return getDb().prepare(`
    SELECT id, name, telegram_handle, telegram_id, telegram_group_id, alertes_topic_id
    FROM players
    WHERE status = 'active'
      AND telegram_group_id IS NOT NULL
      AND alertes_topic_id IS NOT NULL
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

  const recipients = getRecipients();
  if (recipients.length === 0) {
    await sendMsg(chatId,
      "Aucun joueur actif avec un topic Alertes configuré.\n" +
      "Lance le backfill : <code>POST /api/admin/backfill-alertes-topic</code>"
    );
    return;
  }

  pendingBroadcasts.set(original.message_id, original);

  await sendMsgKeyboard(chatId,
    `📢 <b>Broadcast preview</b>\n\n` +
    `Type : <b>${msgType}</b>\n` +
    `Destinataires : <b>${recipients.length} joueurs actifs</b>`,
    [[
      { text: "✅ Confirmer", callback_data: `bc_yes:${original.message_id}` },
      { text: "❌ Annuler", callback_data: "bc_no" },
    ]]
  );
}

export async function handleBroadcastCallback(callbackId: string, data: string, cbMsg: any) {
  await answerCbQuery(callbackId);

  const chatId = cbMsg?.chat?.id;
  if (!chatId || String(chatId) !== AGENT_CHAT_ID) return;
  const confirmationMsgId = cbMsg.message_id;

  if (data === "bc_no") {
    await editMessage(chatId, confirmationMsgId, "❌ Broadcast annulé.");
    return;
  }

  const match = data.match(/^bc_yes:(\d+)$/);
  if (!match) return;
  const originalMsgId = parseInt(match[1]);

  const original = pendingBroadcasts.get(originalMsgId);
  if (!original) {
    await editMessage(chatId, confirmationMsgId, "❌ Message source expiré. Relance /broadcast.");
    return;
  }
  pendingBroadcasts.delete(originalMsgId);

  if (isBroadcasting) {
    await editMessage(chatId, confirmationMsgId, "❌ Un broadcast est déjà en cours.");
    return;
  }
  isBroadcasting = true;

  try {
    await editMessage(chatId, confirmationMsgId, "📤 Diffusion en cours...");

    const recipients = getRecipients();
    const msgType = detectMessageType(original);
    const token = process.env.TELEGRAM_BOT_TOKEN;

    let sent = 0;
    const errors: string[] = [];

    for (const player of recipients) {
      try {
        const mention = mentionOf(player);
        const topicId = player.alertes_topic_id;
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

    let report = `✅ Diffusé à ${sent}/${recipients.length} joueurs`;
    if (errors.length > 0) {
      report += `\n\n❌ Échec (${errors.length}) :\n` + errors.map(e => `• ${e}`).join("\n");
    }
    await editMessage(chatId, confirmationMsgId, report);
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
