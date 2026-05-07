import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import * as fs from "fs";
import * as path from "path";

let _client: TelegramClient | null = null;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// GramJS returns BigInt wrapper objects ({ value: bigint }), not native bigint.
// typeof returns "object", not "bigint", so naive checks fail silently.
const toNum = (v: any): number => Number(BigInt(v));

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
      user_id: toNum(me.id),
      username: me.username ?? null,
      error: null,
    };
  } catch (e: any) {
    return { configured: true, connected: false, session_valid: false, user_id: null, username: null, error: e.message ?? String(e) };
  }
}

// ── Types ────────────────────────────────────────────────

export interface GroupResult {
  chatId: number;
  inviteLink: string;
  topicIds: Record<string, number>;
  status: "full_success" | "partial" | "failed";
  failedSteps: string[];
  errors: string[];
  botPromoted: boolean;
}

const TOPIC_DEFS = [
  { key: "accounting", title: "Accounting", iconColor: 0x6FB9F0, emojis: ["📊", "📈", "💹", "📉"] },
  { key: "deals", title: "Deals", iconColor: 0xFFD67E, emojis: ["🤝", "📋", "📝", "✍️"] },
  { key: "clubs", title: "Clubs", iconColor: 0x8EEE98, emojis: ["🏠", "🎰", "🃏", "♠️"] },
  { key: "depot", title: "Dépôt", iconColor: 0xFF93B2, emojis: ["💰", "💳", "🏦", "💵"] },
  { key: "liveplay", title: "Liveplay", iconColor: 0xFB6F5F, emojis: ["🔴", "🎥", "📺", "▶️"] },
  { key: "onboarding", title: "Onboarding", iconColor: 0xCB86DB, emojis: ["🚀", "✅", "📌", "⚡"] },
];

// ── Retry helper ─────────────────────────────────────────

function errMsg(e: any): string {
  if (e?.message) return String(e.message);
  if (e?.errorMessage) return String(e.errorMessage);
  try { return JSON.stringify(e, (_, v) => typeof v === "bigint" ? v.toString() : v); }
  catch { return "[unserializable error]"; }
}

function parseFloodWait(e: any): number | null {
  const msg = errMsg(e);
  const match = msg.match(/FLOOD_WAIT_(\d+)/i) ?? msg.match(/A wait of (\d+) seconds/i);
  return match ? parseInt(match[1]) : null;
}

async function retry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts: number,
  backoffMs: number[],
): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const flood = parseFloodWait(e);
      const waitMs = flood ? flood * 1000 : (backoffMs[i] ?? backoffMs[backoffMs.length - 1]);
      console.warn(`[USERBOT] ${label} attempt ${i + 1}/${maxAttempts} failed: ${errMsg(e)}, retrying in ${waitMs}ms`);
      if (i < maxAttempts - 1) await sleep(waitMs);
    }
  }
  throw lastErr;
}

// ── Icon fetching ────────────────────────────────────────

async function fetchTopicIcons(client: TelegramClient): Promise<Map<string, bigint>> {
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
          iconMap.set(attr.alt, BigInt(doc.id));
        }
      }
    }
    console.log("[USERBOT] topic icons available:", [...iconMap.keys()].join(" "));
  } catch (e) {
    console.warn("[USERBOT] could not fetch topic icons:", errMsg(e));
  }
  return iconMap;
}

function findIcon(iconMap: Map<string, bigint>, ...emojis: string[]): bigint | undefined {
  for (const e of emojis) { const id = iconMap.get(e); if (id) return id; }
  return undefined;
}

// ── Single topic creation with DOCUMENT_INVALID fallback ─

function extractTopicId(result: any): number {
  const updates = result.updates ?? [];
  for (const u of updates) {
    if (u.message?.action?.className === "MessageActionTopicCreate") {
      return toNum(u.message.id);
    }
  }
  throw new Error("no TopicCreate in response");
}

async function createSingleTopic(
  client: TelegramClient,
  channelPeer: Api.InputChannel,
  def: typeof TOPIC_DEFS[number],
  iconMap: Map<string, bigint>,
): Promise<{ topicId: number; usedFallback: boolean }> {
  const iconEmojiId = findIcon(iconMap, ...def.emojis);

  // Attempt with icon
  if (iconEmojiId) {
    try {
      const result = await retry(async () => {
        const raw = await client.invoke(
          new Api.channels.CreateForumTopic({
            channel: channelPeer,
            title: def.title,
            iconColor: def.iconColor,
            iconEmojiId,
            randomId: BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) as any,
          } as any)
        );
        return extractTopicId(raw);
      }, `topic:${def.title}`, 2, [1000, 2000]);
      return { topicId: result, usedFallback: false };
    } catch (e: any) {
      const msg = errMsg(e);
      if (msg.includes("DOCUMENT_INVALID")) {
        console.warn(`[USERBOT] topic "${def.title}": icon ${iconEmojiId} rejected (DOCUMENT_INVALID), retrying without icon`);
      } else {
        throw e;
      }
    }
  }

  // Fallback: no icon (colored circle from iconColor)
  const result = await retry(async () => {
    const raw = await client.invoke(
      new Api.channels.CreateForumTopic({
        channel: channelPeer,
        title: def.title,
        iconColor: def.iconColor,
        randomId: BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) as any,
      } as any)
    );
    return extractTopicId(raw);
  }, `topic:${def.title}:no-icon`, 2, [1000, 2000]);
  return { topicId: result, usedFallback: true };
}

// ── Create topics on an existing supergroup ──────────────

async function createTopicsOnChannel(
  client: TelegramClient,
  channelPeer: Api.InputChannel,
  failedSteps: string[],
  errors: string[],
): Promise<Record<string, number>> {
  const topicIds: Record<string, number> = {};
  const iconMap = await fetchTopicIcons(client);

  for (const def of TOPIC_DEFS) {
    try {
      const { topicId, usedFallback } = await createSingleTopic(client, channelPeer, def, iconMap);
      topicIds[def.key] = topicId;
      if (usedFallback) console.log(`[USERBOT] topic "${def.title}" created with fallback icon`);
    } catch (e: any) {
      const msg = errMsg(e);
      console.error(`[USERBOT] topic "${def.title}" failed after retries: ${msg}`);
      failedSteps.push(`topic:${def.title}`);
      errors.push(`${def.title}: ${msg}`);
    }
    await sleep(300);
  }

  console.log("[USERBOT] topics created:", topicIds);
  return topicIds;
}

// ── createPlayerGroup ────────────────────────────────────

export async function createPlayerGroup(
  _playerTgId: number,
  playerName: string,
  _botToken?: string,
  _playerUsername?: string
): Promise<GroupResult | null> {
  const client = await getClient();
  if (!client) return null;

  const failedSteps: string[] = [];
  const errors: string[] = [];

  try {
    // Only add admins to the group — player joins via invite link
    const usersToAdd: Api.TypeInputUser[] = [];
    for (const handle of ["baki77777", "hugoroine"]) {
      try {
        const entity = await client.getInputEntity(handle);
        usersToAdd.push(entity as unknown as Api.TypeInputUser);
      } catch {
        console.warn(`[USERBOT] could not resolve @${handle}, skipping`);
      }
    }

    // ── Step 1: Create chat ──
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

    const rawChatId = toNum(chat.id);

    // ── Step 2: Migrate to supergroup ──
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
      channelId = toNum(channel.id);

      const resolved = await client.getInputEntity(
        new Api.PeerChannel({ channelId: BigInt(channelId) as any })
      );
      channelPeer = resolved as unknown as Api.InputChannel;
      console.log("[USERBOT] migrated to supergroup, channelId:", channelId);
    } catch (e: any) {
      const msg = errMsg(e);
      console.error("[USERBOT] migration to supergroup failed:", msg);
      failedSteps.push("migrate_supergroup");
      errors.push(`MigrateChat: ${msg}`);
      try {
        const botEntity = await client.getInputEntity("LeCercle_Lebot");
        await client.invoke(
          new Api.messages.AddChatUser({
            chatId: BigInt(rawChatId) as any,
            userId: botEntity as unknown as Api.TypeInputUser,
            fwdLimit: 0,
          })
        );
      } catch (e2: any) {
        console.error("[USERBOT] fallback bot-add to regular chat failed:", errMsg(e2));
      }
      return { chatId: -rawChatId, inviteLink: "", topicIds: {}, status: "failed", failedSteps, errors, botPromoted: false };
    }

    const supergroupChatId = -(1000000000000 + channelId);

    // Wait for admin rights to propagate after migration
    await sleep(1500);

    // ── Step 3: Add bot to supergroup + promote to admin ──
    let botPromoted = false;
    try {
      const botEntity = await client.getInputEntity("LeCercle_Lebot");
      await client.invoke(
        new Api.channels.InviteToChannel({
          channel: channelPeer,
          users: [botEntity as unknown as Api.TypeInputUser],
        })
      );
      console.log("[USERBOT] bot invited to supergroup");

      await sleep(800);

      // Promote bot to admin so it receives new_chat_members events
      await retry(async () => {
        await client.invoke(
          new Api.channels.EditAdmin({
            channel: channelPeer,
            userId: botEntity as unknown as Api.TypeInputUser,
            adminRights: new Api.ChatAdminRights({
              postMessages: true,
              editMessages: true,
              deleteMessages: true,
              banUsers: true,
              inviteUsers: true,
              changeInfo: true,
              manageTopics: true,
            }),
            rank: "",
          })
        );
      }, "EditAdmin", 2, [1000]);
      botPromoted = true;
      console.log(`[USERBOT] bot promoted to admin in channel ${channelId}`);

      await sleep(800);
    } catch (e: any) {
      const msg = errMsg(e);
      console.error("[USERBOT] bot invite/promote failed:", msg);
      failedSteps.push("bot_admin");
      errors.push(`BotAdmin: ${msg}`);
    }

    // ── Step 4: Set group photo ──
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
    } catch (e: any) {
      const msg = errMsg(e);
      console.warn("[USERBOT] could not set group photo:", msg);
      failedSteps.push("photo");
      errors.push(`EditPhoto: ${msg}`);
    }

    // ── Step 5: Enable forum mode (with retry) ──
    let forumEnabled = false;
    try {
      await retry(async () => {
        await client.invoke(
          new Api.channels.ToggleForum({
            channel: channelPeer,
            enabled: true,
          })
        );
      }, "ToggleForum", 3, [1000, 2000, 4000]);
      forumEnabled = true;
      console.log("[USERBOT] forum mode enabled");
    } catch (e: any) {
      const msg = errMsg(e);
      console.error("[USERBOT] could not enable forum mode after retries:", msg);
      failedSteps.push("forum_toggle");
      errors.push(`ToggleForum: ${msg}`);
    }

    // ── Step 6: Create topics (with per-topic retry) ──
    let topicIds: Record<string, number> = {};
    if (forumEnabled) {
      await sleep(800);
      topicIds = await createTopicsOnChannel(client, channelPeer, failedSteps, errors);
    }

    // ── Step 7: Generate invite link ──
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
    } catch (e: any) {
      const msg = errMsg(e);
      console.warn("[USERBOT] could not export invite link:", msg);
      failedSteps.push("invite_link");
      errors.push(`ExportChatInvite: ${msg}`);
    }

    const status = failedSteps.length === 0 ? "full_success" : "partial";
    return { chatId: supergroupChatId, inviteLink, topicIds, status, failedSteps, errors, botPromoted };
  } catch (e: any) {
    console.error("[USERBOT] createPlayerGroup failed:", errMsg(e));
    return null;
  }
}

// ── recreateTopics (recovery) ────────────────────────────

export async function recreateTopics(chatId: number): Promise<{
  ok: boolean;
  created: string[];
  skipped: string[];
  errors: string[];
}> {
  const client = await getClient();
  if (!client) return { ok: false, created: [], skipped: [], errors: ["Userbot not connected"] };

  try {
    // Derive channelId from the Bot API chat_id format: -(1000000000000 + channelId)
    const channelId = -(chatId + 1000000000000);
    const channelPeer = await client.getInputEntity(
      new Api.PeerChannel({ channelId: BigInt(channelId) as any })
    ) as unknown as Api.InputChannel;

    // Check existing topics
    const existingTopics = await client.invoke(
      new Api.channels.GetForumTopics({
        channel: channelPeer,
        offsetDate: 0,
        offsetId: 0,
        offsetTopic: 0,
        limit: 100,
      })
    );
    const existingTitles = new Set(
      ((existingTopics as any).topics ?? []).map((t: any) => t.title?.toLowerCase())
    );

    // Enable forum mode if not already
    if (existingTitles.size === 0) {
      try {
        await retry(async () => {
          await client.invoke(
            new Api.channels.ToggleForum({ channel: channelPeer, enabled: true })
          );
        }, "ToggleForum", 3, [1000, 2000, 4000]);
        await sleep(800);
      } catch (e: any) {
        return { ok: false, created: [], skipped: [], errors: [`ToggleForum: ${errMsg(e)}`] };
      }
    }

    const created: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    const iconMap = await fetchTopicIcons(client);

    for (const def of TOPIC_DEFS) {
      if (existingTitles.has(def.title.toLowerCase())) {
        skipped.push(def.title);
        continue;
      }

      try {
        const { usedFallback } = await createSingleTopic(client, channelPeer, def, iconMap);
        created.push(usedFallback ? `${def.title} (fallback icon)` : def.title);
      } catch (e: any) {
        errors.push(`${def.title}: ${errMsg(e)}`);
      }
      await sleep(300);
    }

    return { ok: errors.length === 0, created, skipped, errors };
  } catch (e: any) {
    return { ok: false, created: [], skipped: [], errors: [errMsg(e)] };
  }
}

// ── listGroups (admin utility) ───────────────────────────

export async function listGroups(): Promise<{
  ok: boolean;
  groups: { chat_id: string; title: string; member_count: number }[];
  error: string | null;
}> {
  const client = await getClient();
  if (!client) return { ok: false, groups: [], error: "Userbot not connected" };

  try {
    const dialogs = await client.getDialogs({ limit: 200 });
    const groups: { chat_id: string; title: string; member_count: number }[] = [];

    for (const d of dialogs) {
      const entity = d.entity as any;
      if (!entity) continue;
      const isChannel = entity.className === "Channel";
      const isMegagroup = isChannel && (entity.megagroup || entity.gigagroup);
      if (!isChannel && !isMegagroup) continue;

      const channelId = toNum(entity.id);
      const chatId = `-100${channelId}`;
      groups.push({
        chat_id: chatId,
        title: entity.title ?? "(untitled)",
        member_count: entity.participantsCount ?? 0,
      });
    }

    groups.sort((a, b) => a.title.localeCompare(b.title));
    return { ok: true, groups, error: null };
  } catch (e: any) {
    return { ok: false, groups: [], error: errMsg(e) };
  }
}

// ── getInviteLink (admin utility) ────────────────────────

export async function getInviteLink(chatId: number): Promise<{ ok: boolean; link: string; error: string | null }> {
  const client = await getClient();
  if (!client) return { ok: false, link: "", error: "Userbot not connected" };

  try {
    const channelId = -(chatId + 1000000000000);
    const channelPeer = await client.getInputEntity(
      new Api.PeerChannel({ channelId: BigInt(channelId) as any })
    ) as unknown as Api.InputChannel;

    const peerChannel = new Api.InputPeerChannel({
      channelId: channelPeer.channelId,
      accessHash: channelPeer.accessHash,
    });
    const exported = await client.invoke(
      new Api.messages.ExportChatInvite({ peer: peerChannel })
    );
    const link = (exported as any).link ?? "";
    return { ok: !!link, link, error: link ? null : "Empty link returned" };
  } catch (e: any) {
    return { ok: false, link: "", error: errMsg(e) };
  }
}

// ── promoteBot (recovery) ────────────────────────────────

export async function promoteBot(chatId: number): Promise<{ ok: boolean; error: string | null }> {
  const client = await getClient();
  if (!client) return { ok: false, error: "Userbot not connected" };

  try {
    const channelId = -(chatId + 1000000000000);
    const channelPeer = await client.getInputEntity(
      new Api.PeerChannel({ channelId: BigInt(channelId) as any })
    ) as unknown as Api.InputChannel;

    const botEntity = await client.getInputEntity("LeCercle_Lebot");

    await retry(async () => {
      await client.invoke(
        new Api.channels.EditAdmin({
          channel: channelPeer,
          userId: botEntity as unknown as Api.TypeInputUser,
          adminRights: new Api.ChatAdminRights({
            postMessages: true,
            editMessages: true,
            deleteMessages: true,
            banUsers: true,
            inviteUsers: true,
            changeInfo: true,
            manageTopics: true,
          }),
          rank: "",
        })
      );
    }, "EditAdmin", 2, [1000]);

    console.log(`[USERBOT] bot promoted to admin in ${chatId}`);
    return { ok: true, error: null };
  } catch (e: any) {
    return { ok: false, error: errMsg(e) };
  }
}
