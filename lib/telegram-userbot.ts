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

/**
 * Accès au client GramJS partagé, pour les modules qui ont besoin de LIRE.
 *
 * Ajouté pour l'ingestion des notifications du club dzpk (`lib/funnels/dzpk/
 * ingest.ts`), qui doit interroger l'historique d'un peer. Volontairement un
 * simple ré-export du singleton plutôt qu'un second client : deux `TelegramClient`
 * sur le même compte, ce sont deux connexions MTProto concurrentes et un
 * FLOOD_WAIT partagé qu'aucun des deux ne voit venir.
 *
 * Aucun comportement existant n'est modifié — c'est un ajout pur.
 */
export async function getUserbotClient(): Promise<TelegramClient | null> {
  return getClient();
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

// `closed: true` → topic created read-only for members (only admins/bot post). The bot is
// promoted admin BEFORE topics are created, so closing does not block its alerts.
// Deals & Clubs intentionally removed (Phase A restructure). DB columns kept (append-only).
const TOPIC_DEFS = [
  { key: "accounting", title: "Accounting", iconColor: 0x6FB9F0, emojis: ["📊", "📈", "💹", "📉"], closed: false },
  { key: "depot", title: "Dépôt", iconColor: 0xFF93B2, emojis: ["💰", "💳", "🏦", "💵"], closed: true },
  { key: "liveplay", title: "Liveplay", iconColor: 0xFB6F5F, emojis: ["🔴", "🎥", "📺", "▶️"], closed: true },
  { key: "onboarding", title: "Onboarding", iconColor: 0xCB86DB, emojis: ["🚀", "✅", "📌", "⚡"], closed: false },
  { key: "alertes", title: "Alertes", iconColor: 0xFFD67E, emojis: ["📢", "🔔", "⚡", "📣"], closed: true },
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
  botPromoted: boolean,
): Promise<Record<string, number>> {
  const topicIds: Record<string, number> = {};
  const iconMap = await fetchTopicIcons(client);

  for (const def of TOPIC_DEFS) {
    try {
      const { topicId, usedFallback } = await createSingleTopic(client, channelPeer, def, iconMap);
      topicIds[def.key] = topicId;
      if (usedFallback) console.log(`[USERBOT] topic "${def.title}" created with fallback icon`);

      // Close (read-only for members) the topics flagged `closed`. Only if the bot is admin —
      // otherwise closing would block the bot's own alerts. Bot-less groups stay open (a later
      // promote-bot + Phase C handle them).
      if (def.closed) {
        if (botPromoted) {
          try {
            await retry(async () => {
              await client.invoke(
                new Api.channels.EditForumTopic({ channel: channelPeer, topicId, closed: true } as any)
              );
            }, `close:${def.title}`, 2, [1000]);
            console.log(`[USERBOT] topic "${def.title}" set read-only (closed)`);
          } catch (e: any) {
            console.warn(`[USERBOT] could not close "${def.title}": ${errMsg(e)}`);
            errors.push(`close ${def.title}: ${errMsg(e)}`);
          }
        } else {
          console.warn(`[USERBOT] bot not admin → leaving "${def.title}" OPEN (would block bot alerts if closed)`);
        }
      }
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
  _playerUsername?: string,
  titleSuffix?: string,
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
        title: titleSuffix ? `${playerName} x LeCercle (Agent : ${titleSuffix})` : `${playerName} x LeCercle`,
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
    let channelId!: number;
    let channelPeer!: Api.InputChannel;
    const tryMigrate = async () => {
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
    };
    try {
      try {
        await tryMigrate();
      } catch (e: any) {
        // SELF-HEAL borné (GO Hugo 2026-07-24) : plafond Telegram des 500 channels
        // atteint → UNE purge de shells morts (mêmes garde-fous que le cron du lundi)
        // puis UN retry de la migration. Jamais de boucle : si la purge ne libère
        // rien ou que le retry échoue, on retombe sur le fallback existant (chat
        // simple + notif admin côté appelant). Import dynamique → pas de cycle.
        if (!/CHANNELS_TOO_MUCH/i.test(errMsg(e))) throw e;
        console.warn("[USERBOT] CHANNELS_TOO_MUCH — tentative de self-heal (purge shells + retry unique)");
        const { purgeDeadShells, reportShellPurge } = await import("./shell-purge");
        const purge = await purgeDeadShells(20);
        await reportShellPurge(purge);
        if (purge.purged.length === 0) throw e;
        await tryMigrate();
      }
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
      topicIds = await createTopicsOnChannel(client, channelPeer, failedSteps, errors, botPromoted);
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

// ── resolveUsername ─────────────────────────────────────

export async function resolveUsername(username: string): Promise<number | null> {
  const client = await getClient();
  if (!client) return null;

  const handle = username.replace(/^@/, "");
  try {
    const result = await client.invoke(
      new Api.contacts.ResolveUsername({ username: handle })
    );
    const users = (result as any).users ?? [];
    if (users.length === 0) return null;
    return toNum(users[0].id);
  } catch (e: any) {
    console.warn(`[USERBOT] resolveUsername(@${handle}) failed: ${errMsg(e)}`);
    return null;
  }
}

// ── getChatMembers ─────────────────────────────────────

export async function getChatMembers(chatId: string): Promise<Array<{
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  bot?: boolean;
}>> {
  const client = await getClient();
  if (!client) return [];

  try {
    const numericId = parseInt(chatId.replace(/^-100/, ""), 10);
    const channelPeer = await client.getInputEntity(
      new Api.PeerChannel({ channelId: BigInt(numericId) as any })
    ) as unknown as Api.InputChannel;

    const result = await client.invoke(
      new Api.channels.GetParticipants({
        channel: channelPeer,
        filter: new Api.ChannelParticipantsRecent(),
        offset: 0,
        limit: 200,
        hash: BigInt(0) as any,
      })
    );

    const users = (result as any).users ?? [];
    return users.map((u: any) => ({
      id: toNum(u.id),
      first_name: u.firstName ?? undefined,
      last_name: u.lastName ?? undefined,
      username: u.username ?? undefined,
      bot: !!u.bot,
    }));
  } catch (e: any) {
    console.warn(`[USERBOT] getChatMembers(${chatId}) failed: ${errMsg(e)}`);
    return [];
  }
}

// ── renamePlayerGroup ──────────────────────────────────
// Renames an existing supergroup via channels.EditTitle. Robust: returns a status object,
// never throws. FLOOD_WAIT is reported (flood_wait seconds) and NOT auto-retried — the caller
// decides (anti-burst: never hammer Telegram). CHAT_NOT_MODIFIED (same title) is treated as ok.
export async function renamePlayerGroup(
  chatId: string,
  newTitle: string,
): Promise<{ ok: boolean; error: string | null; flood_wait: number | null; not_modified: boolean }> {
  const client = await getClient();
  if (!client) return { ok: false, error: "userbot session unavailable", flood_wait: null, not_modified: false };

  try {
    const numericId = parseInt(String(chatId).replace(/^-100/, ""), 10);
    if (!Number.isFinite(numericId)) return { ok: false, error: `bad chat_id: ${chatId}`, flood_wait: null, not_modified: false };
    const channelPeer = await client.getInputEntity(
      new Api.PeerChannel({ channelId: BigInt(numericId) as any })
    ) as unknown as Api.InputChannel;

    await client.invoke(new Api.channels.EditTitle({ channel: channelPeer, title: newTitle }));
    return { ok: true, error: null, flood_wait: null, not_modified: false };
  } catch (e: any) {
    const msg = errMsg(e);
    if (/CHAT_NOT_MODIFIED/i.test(msg)) return { ok: true, error: null, flood_wait: null, not_modified: true };
    const flood = parseFloodWait(e);
    console.warn(`[USERBOT] renamePlayerGroup(${chatId}) failed: ${msg}`);
    return { ok: false, error: msg, flood_wait: flood, not_modified: false };
  }
}

// ── getMe (expose bot user id) ─────────────────────────

// Identity of the userbot account itself — the inspect flow must not count it as
// a "human member" of the groups it created.
export async function getUserbotMe(): Promise<{ id: number; username: string | null; first_name: string | null; premium: boolean } | null> {
  const client = await getClient();
  if (!client) return null;
  try {
    const me: any = await client.getMe();
    // `premium` répond à "pourquoi CHANNELS_TOO_MUCH à ~495 ?" : limite Telegram
    // 500 channels sans Premium, 1000 avec — si false, le Premium n'est pas sur CE compte.
    return { id: toNum(me.id), username: me.username ?? null, first_name: me.firstName ?? null, premium: !!me.premium };
  } catch {
    return null;
  }
}

export async function getUserbotId(): Promise<number | null> {
  const client = await getClient();
  if (!client) return null;
  try {
    const me = await client.getMe() as any;
    return toNum(me.id);
  } catch {
    return null;
  }
}

// ── inviteUserToGroup ───────────────────────────────────

export async function inviteUserToGroup(
  groupChatId: number,
  username: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = await getClient();
    if (!client) return { ok: false, error: "userbot_not_configured" };

    const handle = username.replace(/^@/, "");
    const userEntity = await client.getInputEntity(handle);

    const channelId = -(groupChatId + 1000000000000);
    const channelPeer = await client.getInputEntity(
      new Api.PeerChannel({ channelId: BigInt(channelId) as any })
    ) as unknown as Api.InputChannel;

    await client.invoke(
      new Api.channels.InviteToChannel({
        channel: channelPeer,
        users: [userEntity as unknown as Api.TypeInputUser],
      })
    );

    console.log(`[USERBOT] invited @${handle} to group ${groupChatId}`);
    return { ok: true };
  } catch (e: any) {
    const msg = errMsg(e);
    console.warn(`[USERBOT] inviteUserToGroup failed for @${username}: ${msg}`);
    return { ok: false, error: msg };
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

// ── Channel capacity management (admin utility) ─────────────────────────────
// Telegram caps an account at ~500 channels/supergroups: past it, MigrateChat
// fails with CHANNELS_TOO_MUCH and EVERY new onboarding group creation breaks
// (history: YuS 2026-07-19). These two helpers power /api/admin/userbot-leave-groups:
// full inventory of the userbot's channels, then targeted LeaveChannel on ids the
// owner validated. The route enforces the keep-guard; this layer just executes.

export async function listUserbotChannels(): Promise<{
  ok: boolean;
  total_channels: number;
  channels: { chat_id: string; title: string; member_count: number; megagroup: boolean; last_message_at: string | null }[];
  error: string | null;
}> {
  const client = await getClient();
  if (!client) return { ok: false, total_channels: 0, channels: [], error: "Userbot not connected" };
  try {
    // iterDialogs walks ALL dialogs (getDialogs({limit}) truncates — the account
    // is near the ~500-channel cap, so a 200 cut would hide most of the problem).
    // Each dialog carries its top message → last_message_at (critère d'inactivité
    // du gros tri : "dernier message il y a +N jours", demande Hugo 2026-07-24).
    const channels: { chat_id: string; title: string; member_count: number; megagroup: boolean; last_message_at: string | null }[] = [];
    for await (const d of client.iterDialogs({})) {
      const entity = d.entity as any;
      if (!entity || entity.className !== "Channel") continue;
      const topDate = (d as any).message?.date;
      channels.push({
        chat_id: `-100${toNum(entity.id)}`,
        title: entity.title ?? "(untitled)",
        member_count: entity.participantsCount ?? 0,
        megagroup: !!(entity.megagroup || entity.gigagroup),
        last_message_at: typeof topDate === "number" && topDate > 0
          ? new Date(topDate * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
          : null,
      });
    }
    return { ok: true, total_channels: channels.length, channels, error: null };
  } catch (e: any) {
    return { ok: false, total_channels: 0, channels: [], error: errMsg(e) };
  }
}

export async function leaveUserbotChannels(chatIds: string[]): Promise<{
  ok: boolean;
  left: string[];
  failed: { chat_id: string; error: string }[];
  error: string | null;
}> {
  const client = await getClient();
  if (!client) return { ok: false, left: [], failed: [], error: "Userbot not connected" };
  const left: string[] = [];
  const failed: { chat_id: string; error: string }[] = [];
  for (const chatId of chatIds) {
    try {
      const entity = await client.getEntity(Number(chatId));
      await client.invoke(new Api.channels.LeaveChannel({ channel: entity as any }));
      left.push(chatId);
    } catch (e: any) {
      failed.push({ chat_id: chatId, error: errMsg(e) });
    }
    await sleep(1100); // flood-wait margin — leaving is rate-limited like any write
  }
  return { ok: failed.length === 0, left, failed, error: null };
}

// Kick a member out of a channel/supergroup the userbot administrates (used by the
// weekly shell purge — the userbot created the shells, so it holds the rights).
// Telegram semantics: EditBanned(viewMessages) = ban+remove; fine for dead groups
// that everyone is abandoning.
export async function kickFromChannel(chatId: string, userId: number): Promise<{ ok: boolean; error: string | null }> {
  const client = await getClient();
  if (!client) return { ok: false, error: "Userbot not connected" };
  try {
    const channel = await client.getEntity(Number(chatId));
    const participant = await client.getInputEntity(userId);
    await client.invoke(new Api.channels.EditBanned({
      channel: channel as any,
      participant,
      bannedRights: new Api.ChatBannedRights({ untilDate: 0, viewMessages: true }),
    }));
    return { ok: true, error: null };
  } catch (e: any) {
    return { ok: false, error: errMsg(e) };
  }
}

// ── Room membership verification (WN join-gate) ──────────────────────────────
// Le bot ne peut pas être invité dans le groupe de la room (droits côté room) —
// la vérification passe par le COMPTE userbot, qui doit simplement être membre.

// Résout un lien d'invitation t.me/+HASH → chat id. Ne marche que si le userbot
// est DÉJÀ membre (ChatInviteAlready) — sinon Telegram ne révèle pas l'id.
export async function resolveInviteHash(hash: string): Promise<{ chatId: string | null; error: string | null }> {
  const client = await getClient();
  if (!client) return { chatId: null, error: "Userbot not connected" };
  try {
    const res: any = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
    if (res.className === "ChatInviteAlready" && res.chat) {
      return { chatId: `-100${toNum(res.chat.id)}`, error: null };
    }
    return { chatId: null, error: "userbot pas membre du groupe (clique le lien d'invitation avec le compte Baki)" };
  } catch (e: any) {
    return { chatId: null, error: errMsg(e) };
  }
}

// Le user est-il membre du channel/supergroupe ? checked=false = vérification
// impossible (session down, userbot pas membre…) — l'appelant décide (fail-open).
export async function isUserInChannel(chatId: string, userId: number): Promise<{ member: boolean; checked: boolean; error: string | null }> {
  const client = await getClient();
  if (!client) return { member: false, checked: false, error: "Userbot not connected" };
  try {
    const channel = await client.getEntity(Number(chatId));
    const participant = await client.getInputEntity(userId);
    await client.invoke(new Api.channels.GetParticipant({ channel: channel as any, participant }));
    return { member: true, checked: true, error: null };
  } catch (e: any) {
    const msg = errMsg(e);
    if (msg.includes("USER_NOT_PARTICIPANT") || msg.includes("PARTICIPANT_ID_INVALID")) {
      return { member: false, checked: true, error: null };
    }
    return { member: false, checked: false, error: msg };
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

// ── inviteAndPromoteBot ─────────────────────────────────

export async function inviteAndPromoteBot(chatId: number): Promise<{
  ok: boolean;
  invited: boolean;
  promoted: boolean;
  error: string | null;
}> {
  const client = await getClient();
  if (!client) return { ok: false, invited: false, promoted: false, error: "Userbot not connected" };

  try {
    const channelId = -(chatId + 1000000000000);
    const channelPeer = await client.getInputEntity(
      new Api.PeerChannel({ channelId: BigInt(channelId) as any })
    ) as unknown as Api.InputChannel;

    const botEntity = await client.getInputEntity("LeCercle_Lebot");

    let invited = false;
    try {
      await client.invoke(
        new Api.channels.InviteToChannel({
          channel: channelPeer,
          users: [botEntity as unknown as Api.TypeInputUser],
        })
      );
      invited = true;
      console.log(`[USERBOT] bot invited to ${chatId}`);
    } catch (e: any) {
      const msg = errMsg(e);
      if (msg.includes("USER_ALREADY_PARTICIPANT")) {
        invited = true;
        console.log(`[USERBOT] bot already in ${chatId}`);
      } else {
        return { ok: false, invited: false, promoted: false, error: `Invite: ${msg}` };
      }
    }

    await sleep(800);

    let promoted = false;
    try {
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
      promoted = true;
      console.log(`[USERBOT] bot promoted in ${chatId}`);
    } catch (e: any) {
      const msg = errMsg(e);
      if (msg.includes("USER_NOT_MUTUAL_CONTACT") || msg.includes("ADMIN_RANK_EMOJI_NOT_ALLOWED")) {
        promoted = true;
      } else {
        return { ok: false, invited, promoted: false, error: `Promote: ${msg}` };
      }
    }

    await sleep(800);
    return { ok: true, invited, promoted, error: null };
  } catch (e: any) {
    return { ok: false, invited: false, promoted: false, error: errMsg(e) };
  }
}

// ── ensureTopic (generic) ────────────────────────────────

export type TopicKey = "alertes" | "liveplay" | "accounting";

export async function ensureTopic(chatId: number, key: TopicKey): Promise<{
  ok: boolean;
  topicId: number | null;
  created: boolean;
  error: string | null;
}> {
  const def = TOPIC_DEFS.find(d => d.key === key);
  if (!def) return { ok: false, topicId: null, created: false, error: `Unknown topic key: ${key}` };

  const client = await getClient();
  if (!client) return { ok: false, topicId: null, created: false, error: "Userbot not connected" };

  try {
    const channelId = -(chatId + 1000000000000);
    const channelPeer = await client.getInputEntity(
      new Api.PeerChannel({ channelId: BigInt(channelId) as any })
    ) as unknown as Api.InputChannel;

    const existing = await client.invoke(
      new Api.channels.GetForumTopics({
        channel: channelPeer,
        offsetDate: 0,
        offsetId: 0,
        offsetTopic: 0,
        limit: 100,
      })
    );

    const topics = ((existing as any).topics ?? []) as any[];
    const found = topics.find((t: any) =>
      t.title?.toLowerCase() === def.title.toLowerCase()
    );

    if (found) {
      const topicId = toNum(found.id);
      return { ok: true, topicId, created: false, error: null };
    }

    const iconMap = await fetchTopicIcons(client);
    const { topicId } = await createSingleTopic(client, channelPeer, def, iconMap);
    return { ok: true, topicId, created: true, error: null };
  } catch (e: any) {
    return { ok: false, topicId: null, created: false, error: errMsg(e) };
  }
}

export async function ensureAlertesTopic(chatId: number) {
  return ensureTopic(chatId, "alertes");
}

// ── syncGroupStructure (full group upgrade) ─────────────

export interface SyncGroupResult {
  chat_id: number;
  title: string;
  member_count: number;
  bot_invited: boolean;
  bot_promoted: boolean;
  topics_created: string[];
  topics_skipped: string[];
  topic_ids: Record<string, number>;
  errors: string[];
}

export async function syncGroupStructure(chatId: number): Promise<SyncGroupResult> {
  const result: SyncGroupResult = {
    chat_id: chatId,
    title: "",
    member_count: 0,
    bot_invited: false,
    bot_promoted: false,
    topics_created: [],
    topics_skipped: [],
    topic_ids: {},
    errors: [],
  };

  const client = await getClient();
  if (!client) {
    result.errors.push("Userbot not connected");
    return result;
  }

  try {
    const channelId = -(chatId + 1000000000000);
    const channelPeer = await client.getInputEntity(
      new Api.PeerChannel({ channelId: BigInt(channelId) as any })
    ) as unknown as Api.InputChannel;

    // Resolve title + member count
    try {
      const entity = await client.getEntity(
        new Api.PeerChannel({ channelId: BigInt(channelId) as any })
      );
      result.title = (entity as any).title ?? "(untitled)";
      result.member_count = (entity as any).participantsCount ?? 0;
    } catch {
      result.title = "(could not resolve)";
    }

    // ── Step 1-2: Bot invite ──
    const botEntity = await client.getInputEntity("LeCercle_Lebot");

    try {
      await client.invoke(
        new Api.channels.InviteToChannel({
          channel: channelPeer,
          users: [botEntity as unknown as Api.TypeInputUser],
        })
      );
      result.bot_invited = true;
      console.log(`[SYNC] bot invited to ${chatId}`);
    } catch (e: any) {
      const msg = errMsg(e);
      if (!msg.includes("USER_ALREADY_PARTICIPANT")) {
        result.errors.push(`Invite: ${msg}`);
      }
    }

    await sleep(800);

    // ── Step 3: Bot promote ──
    try {
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
      result.bot_promoted = true;
      console.log(`[SYNC] bot promoted in ${chatId}`);
    } catch (e: any) {
      result.errors.push(`Promote: ${errMsg(e)}`);
    }

    await sleep(800);

    // ── Step 4: List existing topics (enable forum mode if needed) ──
    let existingTopics: any[] = [];
    try {
      const topicsResult = await client.invoke(
        new Api.channels.GetForumTopics({
          channel: channelPeer,
          offsetDate: 0,
          offsetId: 0,
          offsetTopic: 0,
          limit: 100,
        })
      );
      existingTopics = ((topicsResult as any).topics ?? []) as any[];
    } catch {
      // Forum mode likely not enabled — try to enable and retry
      try {
        await retry(async () => {
          await client.invoke(
            new Api.channels.ToggleForum({ channel: channelPeer, enabled: true })
          );
        }, "ToggleForum", 3, [1000, 2000, 4000]);
        await sleep(800);
        const topicsResult = await client.invoke(
          new Api.channels.GetForumTopics({
            channel: channelPeer,
            offsetDate: 0,
            offsetId: 0,
            offsetTopic: 0,
            limit: 100,
          })
        );
        existingTopics = ((topicsResult as any).topics ?? []) as any[];
      } catch (e2: any) {
        result.errors.push(`Forum/Topics: ${errMsg(e2)}`);
        return result;
      }
    }

    // ── Step 5-6: Create missing topics ──
    const existingMap = new Map<string, number>();
    for (const t of existingTopics) {
      if (t.title) existingMap.set(t.title.toLowerCase(), toNum(t.id));
    }

    const iconMap = await fetchTopicIcons(client);

    for (const def of TOPIC_DEFS) {
      const existingId = existingMap.get(def.title.toLowerCase());
      if (existingId) {
        result.topic_ids[def.key] = existingId;
        result.topics_skipped.push(def.title);
        continue;
      }

      try {
        const { topicId } = await createSingleTopic(client, channelPeer, def, iconMap);
        result.topic_ids[def.key] = topicId;
        result.topics_created.push(def.title);
      } catch (e: any) {
        result.errors.push(`topic:${def.title}: ${errMsg(e)}`);
      }
      await sleep(300);
    }

    return result;
  } catch (e: any) {
    result.errors.push(errMsg(e));
    return result;
  }
}

// ── Topic restructure (Phase B/C: delete Deals/Clubs, close Alertes/Dépôt/Liveplay) ──

const RESTRUCTURE_DELETE = ["Deals", "Clubs"];          // hard delete (irreversible)
const RESTRUCTURE_CLOSE = ["Alertes", "Dépôt", "Liveplay"]; // read-only for members

// Read-only snapshot of a group's forum topics (for the dry-run + idempotency checks).
export async function getGroupTopicsState(chatId: number): Promise<{
  ok: boolean; topics: { title: string; id: number; closed: boolean }[]; error: string | null;
}> {
  const client = await getClient();
  if (!client) return { ok: false, topics: [], error: "Userbot not connected" };
  try {
    const channelId = -(chatId + 1000000000000);
    const channelPeer = await client.getInputEntity(
      new Api.PeerChannel({ channelId: BigInt(channelId) as any })
    ) as unknown as Api.InputChannel;
    const r = await client.invoke(new Api.channels.GetForumTopics({
      channel: channelPeer, offsetDate: 0, offsetId: 0, offsetTopic: 0, limit: 100,
    }));
    const topics = (((r as any).topics ?? []) as any[])
      .filter(t => t.title)
      .map(t => ({ title: t.title as string, id: toNum(t.id), closed: !!t.closed }));
    return { ok: true, topics, error: null };
  } catch (e: any) {
    return { ok: false, topics: [], error: errMsg(e) };
  }
}

export interface RestructureResult {
  chat_id: number;
  ok: boolean;
  botInvited: boolean;
  botPromoted: boolean;
  deleted: string[];   // titles actually deleted
  closed: string[];    // titles actually closed
  skipped: string[];   // already absent / already closed
  errors: string[];
}

// Restructure ONE existing group: ensure bot admin → delete Deals/Clubs → close Alertes/Dépôt/Liveplay.
// Idempotent (absent → skip, already-closed → skip). Bot admin is ensured BEFORE closing so the
// closed topics don't cut the bot's own alerts; if the bot can't be promoted, we abort without closing.
export async function restructureGroupTopics(chatId: number): Promise<RestructureResult> {
  const res: RestructureResult = { chat_id: chatId, ok: false, botInvited: false, botPromoted: false, deleted: [], closed: [], skipped: [], errors: [] };
  const client = await getClient();
  if (!client) { res.errors.push("Userbot not connected"); return res; }

  // 0) Ensure bot admin BEFORE closing (closed topics block non-admins; the bot must stay able to post).
  const bot = await inviteAndPromoteBot(chatId);
  res.botInvited = bot.invited;
  res.botPromoted = bot.promoted;
  if (!bot.promoted) {
    res.errors.push(`bot not admin (${bot.error ?? "promote failed"}) — aborting before close to not cut alerts`);
    return res;
  }
  await sleep(500);

  try {
    const channelId = -(chatId + 1000000000000);
    const channelPeer = await client.getInputEntity(
      new Api.PeerChannel({ channelId: BigInt(channelId) as any })
    ) as unknown as Api.InputChannel;

    const snap = await getGroupTopicsState(chatId);
    if (!snap.ok) { res.errors.push(`list topics: ${snap.error}`); return res; }
    const byTitle = new Map<string, { id: number; closed: boolean }>();
    for (const t of snap.topics) byTitle.set(t.title.toLowerCase(), { id: t.id, closed: t.closed });

    // Delete Deals/Clubs (drain history until the topic is gone).
    for (const title of RESTRUCTURE_DELETE) {
      const t = byTitle.get(title.toLowerCase());
      if (!t) { res.skipped.push(`${title} (absent)`); continue; }
      try {
        for (let i = 0; i < 20; i++) {
          const aff = await client.invoke(new Api.channels.DeleteTopicHistory({ channel: channelPeer, topMsgId: t.id } as any)) as any;
          if (!aff || (aff.offset ?? 0) === 0) break;
          await sleep(300);
        }
        res.deleted.push(title);
        console.log(`[RESTRUCTURE] deleted "${title}" (${t.id}) in ${chatId}`);
      } catch (e: any) {
        res.errors.push(`delete ${title}: ${errMsg(e)}`);
      }
      await sleep(400);
    }

    // Close Alertes/Dépôt/Liveplay (skip if already closed).
    for (const title of RESTRUCTURE_CLOSE) {
      const t = byTitle.get(title.toLowerCase());
      if (!t) { res.skipped.push(`${title} (absent)`); continue; }
      if (t.closed) { res.skipped.push(`${title} (déjà fermé)`); continue; }
      try {
        await retry(async () => {
          await client.invoke(new Api.channels.EditForumTopic({ channel: channelPeer, topicId: t.id, closed: true } as any));
        }, `close:${title}`, 2, [1000]);
        res.closed.push(title);
        console.log(`[RESTRUCTURE] closed "${title}" (${t.id}) in ${chatId}`);
      } catch (e: any) {
        res.errors.push(`close ${title}: ${errMsg(e)}`);
      }
      await sleep(400);
    }

    res.ok = res.errors.length === 0;
    return res;
  } catch (e: any) {
    res.errors.push(errMsg(e));
    return res;
  }
}

// ── Audit de groupe (lecture seule) ──────────────────────
// Ajouté pour l'arbitrage des doublons (Hugo 2026-08-04) : décider quel groupe garder
// exige de savoir lequel VIT — qui y parle, quand — et qui en est owner. Aucune de ces
// deux informations n'était lisible depuis le repo.

export type GroupAudit = {
  chat_id: string;
  title: string | null;
  ok: boolean;
  error: string | null;
  /** Messages lus dans la fenêtre demandée (plafonnée), pas le total historique. */
  messages_read: number;
  last_message_at: string | null;
  last_message_from: string | null;
  last_message_preview: string | null;
  /** Qui a parlé, décompte par personne, sur la fenêtre lue. */
  speakers: { id: number; label: string; is_bot: boolean; count: number }[];
  participants_count: number | null;
  creator: { id: number; label: string } | null;
  admins: { id: number; label: string }[];
  userbot_id: number | null;
  userbot_is_creator: boolean;
  userbot_is_admin: boolean;
};

function labelOfUser(u: any): string {
  if (!u) return "?";
  if (u.username) return `@${u.username}`;
  const n = [u.firstName, u.lastName].filter(Boolean).join(" ");
  return n || String(toNum(u.id));
}

/**
 * Lit l'historique + les droits d'un groupe. NE MODIFIE RIEN.
 * `limit` plafonne la lecture d'historique (Telegram pagine ; on ne remonte pas tout).
 */
export async function auditGroup(chatId: string | number, limit = 50): Promise<GroupAudit> {
  const cid = String(chatId);
  const res: GroupAudit = {
    chat_id: cid, title: null, ok: false, error: null,
    messages_read: 0, last_message_at: null, last_message_from: null, last_message_preview: null,
    speakers: [], participants_count: null, creator: null, admins: [],
    userbot_id: null, userbot_is_creator: false, userbot_is_admin: false,
  };

  const client = await getClient();
  if (!client) { res.error = "userbot non connecté"; return res; }

  try {
    const me: any = await client.getMe();
    res.userbot_id = toNum(me.id);

    const numericId = parseInt(cid.replace(/^-100/, ""), 10);
    const channelPeer = await client.getInputEntity(
      new Api.PeerChannel({ channelId: BigInt(numericId) as any })
    ) as unknown as Api.InputChannel;

    // Titre + nombre de participants.
    try {
      const full: any = await client.invoke(new Api.channels.GetFullChannel({ channel: channelPeer }));
      res.title = full?.chats?.[0]?.title ?? null;
      res.participants_count = full?.fullChat?.participantsCount ?? null;
    } catch (e: any) {
      res.error = `GetFullChannel: ${errMsg(e)}`;
    }

    // Historique — qui parle, et quand pour la dernière fois.
    try {
      const hist: any = await client.invoke(new Api.messages.GetHistory({
        peer: channelPeer, offsetId: 0, offsetDate: 0, addOffset: 0,
        limit, maxId: 0, minId: 0, hash: BigInt(0) as any,
      }));
      const msgs: any[] = (hist.messages ?? []).filter((m: any) => m.className !== "MessageEmpty");
      const users: any[] = hist.users ?? [];
      const userById = new Map<number, any>(users.map((u) => [toNum(u.id), u]));

      res.messages_read = msgs.length;

      const counts = new Map<number, number>();
      for (const m of msgs) {
        const fromId = m.fromId?.userId ?? m.fromId?.channelId;
        if (fromId == null) continue;
        const id = toNum(fromId);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      res.speakers = [...counts.entries()]
        .map(([id, count]) => {
          const u = userById.get(id);
          return { id, label: labelOfUser(u) , is_bot: !!u?.bot, count };
        })
        .sort((a, b) => b.count - a.count);

      // `messages` arrive du plus récent au plus ancien.
      const last = msgs[0];
      if (last) {
        res.last_message_at = last.date ? new Date(last.date * 1000).toISOString() : null;
        const fromId = last.fromId?.userId ?? last.fromId?.channelId;
        res.last_message_from = fromId != null ? labelOfUser(userById.get(toNum(fromId))) : null;
        const text = String(last.message ?? "").replace(/\s+/g, " ").trim();
        res.last_message_preview = text ? text.slice(0, 120) : (last.action ? `[${last.action.className}]` : "[média]");
      }
    } catch (e: any) {
      res.error = [res.error, `GetHistory: ${errMsg(e)}`].filter(Boolean).join(" | ");
    }

    // Owner + admins. `ChannelParticipantCreator` = le seul à pouvoir supprimer le groupe.
    try {
      const parts: any = await client.invoke(new Api.channels.GetParticipants({
        channel: channelPeer, filter: new Api.ChannelParticipantsAdmins(),
        offset: 0, limit: 100, hash: BigInt(0) as any,
      }));
      const users: any[] = parts.users ?? [];
      const userById = new Map<number, any>(users.map((u) => [toNum(u.id), u]));
      for (const p of (parts.participants ?? [])) {
        const id = toNum(p.userId);
        const entry = { id, label: labelOfUser(userById.get(id)) };
        if (p.className === "ChannelParticipantCreator") {
          res.creator = entry;
          if (id === res.userbot_id) res.userbot_is_creator = true;
        } else {
          res.admins.push(entry);
        }
        if (id === res.userbot_id) res.userbot_is_admin = true;
      }
    } catch (e: any) {
      res.error = [res.error, `GetParticipants(admins): ${errMsg(e)}`].filter(Boolean).join(" | ");
    }

    res.ok = res.error === null;
    return res;
  } catch (e: any) {
    res.error = errMsg(e);
    return res;
  }
}

/**
 * Supprime DÉFINITIVEMENT un supergroupe, pour tout le monde. Irréversible.
 *
 * Refuse si le userbot n'en est pas le créateur : `channels.DeleteChannel` exige le droit
 * owner, et un refus explicite vaut mieux qu'une erreur Telegram opaque. L'appelant doit
 * avoir vérifié en amont que le groupe n'est plus référencé — cette fonction ne juge pas
 * de ça, elle exécute.
 */
export async function deleteChannelAsOwner(chatId: string | number): Promise<{
  ok: boolean; deleted: boolean; error: string | null; title: string | null;
}> {
  const cid = String(chatId);
  const audit = await auditGroup(cid, 1);
  if (!audit.userbot_id) return { ok: false, deleted: false, error: "userbot non connecté", title: null };
  if (!audit.userbot_is_creator) {
    return {
      ok: false, deleted: false, title: audit.title,
      error: `le userbot n'est pas créateur de ce groupe (owner : ${audit.creator?.label ?? "inconnu"}) — suppression impossible`,
    };
  }

  const client = await getClient();
  if (!client) return { ok: false, deleted: false, error: "userbot non connecté", title: audit.title };

  try {
    const numericId = parseInt(cid.replace(/^-100/, ""), 10);
    const channelPeer = await client.getInputEntity(
      new Api.PeerChannel({ channelId: BigInt(numericId) as any })
    ) as unknown as Api.InputChannel;

    await client.invoke(new Api.channels.DeleteChannel({ channel: channelPeer }));
    console.log(`[USERBOT] channel ${cid} deleted (owner)`);
    return { ok: true, deleted: true, error: null, title: audit.title };
  } catch (e: any) {
    return { ok: false, deleted: false, error: errMsg(e), title: audit.title };
  }
}
