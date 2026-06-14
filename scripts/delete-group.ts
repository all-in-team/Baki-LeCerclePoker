/**
 * One-off: delete a supergroup by chat_id via the userbot (creator).
 * Usage: DELETE_CHAT_ID=-1004400047972 railway run npx -y tsx scripts/delete-group.ts
 */
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";

async function main() {
  const chatId = parseInt(process.env.DELETE_CHAT_ID ?? "0");
  if (!chatId) { console.error("Missing DELETE_CHAT_ID"); process.exit(1); }

  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "0");
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  const session = process.env.TELEGRAM_SESSION ?? "";
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 3 });
  await client.connect();

  const channelId = -(chatId + 1000000000000); // inverse of -(1e12 + channelId)
  const peer = await client.getInputEntity(new Api.PeerChannel({ channelId: BigInt(channelId) as any }));
  await client.invoke(new Api.channels.DeleteChannel({ channel: peer as any }));

  console.log("DELETED chat_id=" + chatId);
  await client.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(2); });
