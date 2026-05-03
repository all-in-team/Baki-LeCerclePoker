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

    // Migrate to supergroup
    let channelId: number;
    let channelPeer: Api.InputChannel;
    try {
      const migrateResult = await client.invoke(
        new Api.messages.MigrateChat({
          chatId: BigInt(rawChatId) as any,
        })
      );
      const migrateRaw = migrateResult as any;
      const allChats = migrateRaw.chats ?? migrateRaw.updates?.chats ?? [];
      const channel = allChats.find((c: any) => c.className === "Channel");
      if (!channel) throw new Error("no channel after migration");
      channelId = typeof channel.id === "bigint" ? Number(channel.id) : channel.id;

      // Resolve entity from gramjs cache (populated by invoke processing)
      const resolved = await client.getInputEntity(
        new Api.PeerChannel({ channelId: BigInt(channelId) as any })
      );
      channelPeer = resolved as unknown as Api.InputChannel;
      console.log("[USERBOT] migrated to supergroup, channelId:", channelId);
    } catch (e) {
      console.error("[USERBOT] migration to supergroup failed:", e);
      // Fall back to basic group
      try {
        const botEntity = await client.getInputEntity("LeCercle_Lebot");
        await client.invoke(
          new Api.messages.AddChatUser({
            chatId: BigInt(rawChatId) as any,
            userId: botEntity as unknown as Api.TypeInputUser,
            fwdLimit: 0,
          })
        );
      } catch {}
      return { chatId: -rawChatId, inviteLink: "" };
    }

    const supergroupChatId = -(1000000000000 + channelId);

    // Add bot to supergroup
    try {
      const botEntity = await client.getInputEntity("LeCercle_Lebot");
      await client.invoke(
        new Api.channels.InviteToChannel({
          channel: channelPeer,
          users: [botEntity as unknown as Api.TypeInputUser],
        })
      );
    } catch (e) {
      console.warn("[USERBOT] could not add bot to supergroup:", e);
    }

    // Enable forum mode + create topics
    try {
      await client.invoke(
        new Api.channels.ToggleForum({
          channel: channelPeer,
          enabled: true,
        })
      );

      const topics = [
        { title: "Accounting", iconColor: 0x6FB9F0 },
        { title: "Deals", iconColor: 0xFFD67E },
        { title: "Clubs", iconColor: 0x8EEE98 },
      ];

      for (const topic of topics) {
        try {
          await client.invoke(
            new Api.channels.CreateForumTopic({
              channel: channelPeer,
              title: topic.title,
              iconColor: topic.iconColor,
              randomId: BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) as any,
            })
          );
        } catch (e) {
          console.warn(`[USERBOT] could not create topic "${topic.title}":`, e);
        }
      }
    } catch (e) {
      console.warn("[USERBOT] could not enable forum mode:", e);
    }

    // Generate invite link
    let inviteLink = "";
    try {
      const peerChannel = new Api.InputPeerChannel({
        channelId: channelPeer.channelId,
        accessHash: channelPeer.accessHash,
      });
      const exported = await client.invoke(
        new Api.messages.ExportChatInvite({ peer: peerChannel })
      );
      inviteLink = (exported as any).link ?? "";
    } catch (e) {
      console.warn("[USERBOT] could not export invite link:", e);
    }

    return { chatId: supergroupChatId, inviteLink };
  } catch (e) {
    console.error("[USERBOT] createPlayerGroup failed:", e);
    return null;
  }
}
