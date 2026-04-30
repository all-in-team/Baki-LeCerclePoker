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
  botToken: string,
  playerUsername?: string
): Promise<{ chatId: number; inviteLink: string } | null> {
  const client = await getClient();
  if (!client) return null;

  try {
    // Resolve the player — prefer username (works even if userbot never saw them)
    const usersToAdd: Api.TypeInputUser[] = [];
    const playerHandle = playerUsername ?? String(playerTgId);
    try {
      const playerEntity = await client.getInputEntity(playerHandle);
      usersToAdd.push(playerEntity as unknown as Api.TypeInputUser);
    } catch {
      console.error(`[USERBOT] could not resolve player ${playerHandle}`);
      return null;
    }

    for (const handle of ["baki77777", "hugoroine"]) {
      try {
        const entity = await client.getInputEntity(handle);
        usersToAdd.push(entity as unknown as Api.TypeInputUser);
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

    // Extract chat ID — response can be Updates, InvitedUsers wrapper, etc.
    const raw = result as any;
    const chats = raw.chats ?? raw.updates?.chats ?? [];
    let chat = chats[0];
    if (!chat && raw.updates) {
      // InvitedUsers response: { updates: Updates { chats: [...] } }
      const innerChats = raw.updates.chats ?? [];
      chat = innerChats[0];
    }
    if (!chat) {
      console.error("[USERBOT] unexpected CreateChat response:", JSON.stringify(raw).slice(0, 500));
      throw new Error("no chat in response");
    }

    const rawChatId = typeof chat.id === "bigint" ? Number(chat.id) : chat.id;
    const chatId = -rawChatId;

    // Add the bot to the group
    const botId = parseInt(botToken.split(":")[0]);
    try {
      await client.invoke(
        new Api.messages.AddChatUser({
          chatId: BigInt(rawChatId) as any,
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
          peer: rawChatId,
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
