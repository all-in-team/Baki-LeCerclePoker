import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import * as fs from "fs";
import * as path from "path";

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

export async function checkUserbotHealth(): Promise<{
  configured: boolean;
  connected: boolean;
  session_valid: boolean;
  user_id: number | null;
  username: string | null;
  error: string | null;
}> {
  if (!getApiCredentials()) {
    return { configured: false, connected: false, session_valid: false, user_id: null, username: null, error: "Missing TELEGRAM_API_ID, TELEGRAM_API_HASH, or TELEGRAM_SESSION" };
  }
  try {
    const client = await getClient();
    if (!client) {
      return { configured: true, connected: false, session_valid: false, user_id: null, username: null, error: "Connection failed" };
    }
    const me = await client.getMe() as any;
    return {
      configured: true,
      connected: true,
      session_valid: true,
      user_id: typeof me.id === "bigint" ? Number(me.id) : me.id,
      username: me.username ?? null,
      error: null,
    };
  } catch (e: any) {
    return { configured: true, connected: false, session_valid: false, user_id: null, username: null, error: e.message ?? String(e) };
  }
}

export interface GroupResult {
  chatId: number;
  inviteLink: string;
  topicIds: Record<string, number>;
}

export async function createPlayerGroup(
  playerTgId: number,
  playerName: string,
  botToken: string,
  playerUsername?: string
): Promise<GroupResult | null> {
  const client = await getClient();
  if (!client) return null;

  try {
    const usersToAdd: Api.TypeInputUser[] = [];

    // Three-tier player entity resolution:
    // 1. @username (global search — most reliable)
    // 2. Numeric ID (users.GetUsers with accessHash=0 — works if userbot has seen the user)
    // 3. Raw InputPeerUser (accessHash=0 — last resort, works if Telegram server knows both parties)
    let playerEntity: Api.TypeInputUser | null = null;
    if (playerUsername) {
      try {
        playerEntity = await client.getInputEntity(playerUsername) as unknown as Api.TypeInputUser;
        console.log(`[USERBOT] resolved player via @${playerUsername}`);
      } catch {
        console.warn(`[USERBOT] could not resolve @${playerUsername}, trying by ID`);
      }
    }
    if (!playerEntity) {
      try {
        playerEntity = await client.getInputEntity(playerTgId) as unknown as Api.TypeInputUser;
        console.log(`[USERBOT] resolved player via numeric ID ${playerTgId}`);
      } catch {
        console.warn(`[USERBOT] could not resolve numeric ID ${playerTgId}, using raw InputPeerUser`);
      }
    }
    if (!playerEntity) {
      playerEntity = new Api.InputPeerUser({
        userId: BigInt(playerTgId) as any,
        accessHash: BigInt(0) as any,
      }) as unknown as Api.TypeInputUser;
      console.log(`[USERBOT] using raw InputPeerUser for ${playerTgId} (accessHash=0)`);
    }
    usersToAdd.push(playerEntity);

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
        title: `${playerName} x LeCercle`,
      })
    );

    const raw = result as any;
    const chats = raw.chats ?? raw.updates?.chats ?? [];
    let chat = chats[0];
    if (!chat && raw.updates) {
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

      const resolved = await client.getInputEntity(
        new Api.PeerChannel({ channelId: BigInt(channelId) as any })
      );
      channelPeer = resolved as unknown as Api.InputChannel;
      console.log("[USERBOT] migrated to supergroup, channelId:", channelId);
    } catch (e) {
      console.error("[USERBOT] migration to supergroup failed:", e);
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
      return { chatId: -rawChatId, inviteLink: "", topicIds: {} };
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

    // Set group photo
    try {
      const logoPath = path.join(process.cwd(), "public", "lecercle-logo.jpg");
      const logoBuffer = fs.readFileSync(logoPath);
      const { CustomFile } = await import("telegram/client/uploads");
      const file = await client.uploadFile({
        file: new CustomFile("lecercle-logo.jpg", logoBuffer.length, "", logoBuffer),
        workers: 1,
      });
      await client.invoke(
        new Api.channels.EditPhoto({
          channel: channelPeer,
          photo: new Api.InputChatUploadedPhoto({ file }),
        })
      );
      console.log("[USERBOT] group photo set");
    } catch (e) {
      console.warn("[USERBOT] could not set group photo:", e);
    }

    // Enable forum mode + create topics
    const topicIds: Record<string, number> = {};
    try {
      await client.invoke(
        new Api.channels.ToggleForum({
          channel: channelPeer,
          enabled: true,
        })
      );

      // Fetch default forum topic icon stickers
      const iconMap = new Map<string, bigint>();
      try {
        const stickerSet = await client.invoke(
          new Api.messages.GetStickerSet({
            stickerset: new Api.InputStickerSetEmojiDefaultTopicIcons(),
            hash: 0,
          })
        );
        const docs = (stickerSet as any).documents ?? [];
        for (const doc of docs) {
          for (const attr of doc.attributes ?? []) {
            if (attr.className === "DocumentAttributeCustomEmoji" && attr.alt) {
              iconMap.set(attr.alt, typeof doc.id === "bigint" ? doc.id : BigInt(doc.id));
            }
          }
        }
        console.log("[USERBOT] topic icons available:", [...iconMap.keys()].join(" "));
      } catch (e) {
        console.warn("[USERBOT] could not fetch topic icons:", e);
      }

      const findIcon = (...emojis: string[]): bigint | undefined => {
        for (const e of emojis) { const id = iconMap.get(e); if (id) return id; }
        return undefined;
      };

      const topicDefs = [
        { key: "accounting", title: "Accounting", iconColor: 0x6FB9F0, emojis: ["📊", "📈", "💹", "📉"] },
        { key: "deals", title: "Deals", iconColor: 0xFFD67E, emojis: ["🤝", "📋", "📝", "✍️"] },
        { key: "clubs", title: "Clubs", iconColor: 0x8EEE98, emojis: ["🏠", "🎰", "🃏", "♠️"] },
        { key: "depot", title: "Dépôt", iconColor: 0xFF93B2, emojis: ["💰", "💳", "🏦", "💵"] },
        { key: "liveplay", title: "Liveplay", iconColor: 0xFB6F5F, emojis: ["🔴", "🎥", "📺", "▶️"] },
        { key: "onboarding", title: "Onboarding", iconColor: 0xCB86DB, emojis: ["🚀", "✅", "📌", "⚡"] },
      ];

      for (const def of topicDefs) {
        try {
          const iconEmojiId = findIcon(...def.emojis);
          const topicResult = await client.invoke(
            new Api.channels.CreateForumTopic({
              channel: channelPeer,
              title: def.title,
              iconColor: def.iconColor,
              ...(iconEmojiId ? { iconEmojiId } : {}),
              randomId: BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) as any,
            } as any)
          );
          const topicRaw = topicResult as any;
          const updates = topicRaw.updates ?? [];
          for (const u of updates) {
            if (u.message?.action?.className === "MessageActionTopicCreate") {
              topicIds[def.key] = typeof u.message.id === "bigint" ? Number(u.message.id) : u.message.id;
              break;
            }
          }
        } catch (e) {
          console.warn(`[USERBOT] could not create topic "${def.title}":`, e);
        }
      }
      console.log("[USERBOT] topics created:", topicIds);
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

    return { chatId: supergroupChatId, inviteLink, topicIds };
  } catch (e) {
    console.error("[USERBOT] createPlayerGroup failed:", e);
    return null;
  }
}
