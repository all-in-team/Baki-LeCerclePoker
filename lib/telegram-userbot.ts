import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";

let _client: TelegramClient | null = null;

function getApiCredentials() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "0");
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  const session = process.env.TELEGRAM_SESSION ?? "";
  if (!apiId || !apiHash || !session) return null;
  return { apiId, apiHash, session };
}

async function getClient(): Promise<TelegramClient | null> {
  const creds = getApiCredentials();
  if (!creds) return null;

  if (_client?.connected) return _client;

  _client = new TelegramClient(
    new StringSession(creds.session),
    creds.apiId,
    creds.apiHash,
    { connectionRetries: 3 }
  );

  try {
    await _client.connect();
    return _client;
  } catch (e) {
    console.error("[USERBOT] connection failed:", e);
    _client = null;
    return null;
  }
}

export function isUserbotConfigured(): boolean {
  return getApiCredentials() !== null;
}

export async function createPlayerGroup(
  playerTgId: number,
  playerName: string,
  botToken: string
): Promise<{ chatId: number; inviteLink: string } | null> {
  const client = await getClient();
  if (!client) return null;

  try {
    const usersToAdd: (string | number)[] = [playerTgId];
    // Add @baki77777 and @hugoroine
    for (const handle of ["baki77777", "hugoroine"]) {
      try {
        await client.getEntity(handle);
        usersToAdd.push(handle);
      } catch {
        console.warn(`[USERBOT] could not resolve @${handle}, skipping`);
      }
    }

    const result = await client.invoke(
      new Api.messages.CreateChat({
        users: usersToAdd,
        title: `TELE AK POKER — ${playerName}`,
      })
    );

    // Extract chat ID from the result
    const updates = result as any;
    const chat = updates.chats?.[0];
    if (!chat) throw new Error("no chat in response");

    const chatId = -chat.id; // Telegram groups have negative IDs for bots

    // Add the bot to the group
    const botId = parseInt(botToken.split(":")[0]);
    try {
      await client.invoke(
        new Api.messages.AddChatUser({
          chatId: chat.id,
          userId: botId,
          fwdLimit: 0,
        })
      );
    } catch (e) {
      console.warn("[USERBOT] could not add bot to group:", e);
    }

    // Generate invite link
    let inviteLink = "";
    try {
      const exported = await client.invoke(
        new Api.messages.ExportChatInvite({
          peer: chat.id,
        })
      );
      inviteLink = (exported as any).link ?? "";
    } catch {
      console.warn("[USERBOT] could not export invite link");
    }

    return { chatId, inviteLink };
  } catch (e) {
    console.error("[USERBOT] createPlayerGroup failed:", e);
    return null;
  }
}
