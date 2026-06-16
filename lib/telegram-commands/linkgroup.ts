import { getDb } from "@/lib/db";
import { sendMsg, OWNER_IDS } from "./helpers";
import { syncGroupStructure } from "@/lib/telegram-userbot";

interface PlayerRow { id: number; name: string; telegram_handle: string | null; telegram_group_id: string | null }

// Same mapping the sync-group-structure admin route uses — backfilled via COALESCE
// so onboarding flows post in the Onboarding topic instead of General.
const TOPIC_COLUMN_MAP: Record<string, string> = {
  accounting: "accounting_topic_id",
  deals: "deals_topic_id",
  clubs: "clubs_topic_id",
  depot: "depot_topic_id",
  liveplay: "liveplay_topic_id",
  onboarding: "onboarding_topic_id",
  alertes: "alertes_topic_id",
};

function extractBaseName(title: string): string {
  return title
    .replace(/\s*x\s*LeCercle.*$/i, "")
    .replace(/\s*\(OLD ARCHIVE\)\s*/i, "")
    .replace(/\s*\(Agent\s*:.*?\)\s*/i, "")
    .trim();
}

async function linkPlayer(chatId: number, player: PlayerRow): Promise<string> {
  const db = getDb();
  const old = player.telegram_group_id;
  db.prepare(`UPDATE players SET telegram_group_id = ? WHERE id = ?`).run(String(chatId), player.id);
  let msg = `✅ Groupe lié à <b>${player.name}</b> (id=${player.id}).`;
  if (old && old !== String(chatId)) msg += `\n<i>(remplace l'ancien groupe ${old})</i>`;

  // Best-effort: detect/create the forum topics and backfill *_topic_id columns.
  // Without this, onboarding_topic_id stays NULL and onboarding flows (pitch, %
  // keyboard, wallet steps) fall back to the General topic.
  try {
    const sync = await syncGroupStructure(chatId);
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, col] of Object.entries(TOPIC_COLUMN_MAP)) {
      if (sync.topic_ids[key] != null) {
        sets.push(`${col} = COALESCE(${col}, ?)`);
        values.push(sync.topic_ids[key]);
      }
    }
    if (sets.length > 0) {
      values.push(player.id);
      db.prepare(`UPDATE players SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const onbId = sync.topic_ids.onboarding;
    if (onbId != null) {
      msg += `\n🧵 Topics synchronisés — Onboarding détecté (id=${onbId}).`;
    } else {
      msg += `\n⚠️ Aucun topic <b>Onboarding</b> détecté (groupe non-forum ?). Les flows posteront dans General.`;
    }
  } catch (e: any) {
    console.warn(`[LINKGROUP] topic backfill failed for chat ${chatId}: ${e?.message ?? e}`);
    msg += `\n⚠️ Sync des topics échouée (userbot indispo ?). onboarding_topic_id non renseigné — relance plus tard.`;
  }

  msg += `\nTu peux maintenant taper /startaffi.`;
  return msg;
}

export async function handleLinkGroup(chatId: number, fromId: number, chatType: string, args: string, chatTitle: string) {
  if (!OWNER_IDS.has(fromId)) {
    await sendMsg(chatId, `❌ Réservé aux admins.`);
    return;
  }

  if (chatType !== "group" && chatType !== "supergroup") {
    await sendMsg(chatId, `❌ À utiliser dans le groupe à lier.`);
    return;
  }

  const db = getDb();
  const trimmed = args.trim();

  // CAS 1 — No args: auto-detect from group title
  if (!trimmed) {
    const baseName = extractBaseName(chatTitle);
    if (!baseName) {
      await sendMsg(chatId, `❌ Impossible d'extraire le nom du player depuis le titre "${chatTitle}".\nUtilise <code>/linkgroup @handle</code> ou <code>/linkgroup id:&lt;numéro&gt;</code>.`);
      return;
    }

    const players = db.prepare(
      `SELECT id, name, telegram_handle, telegram_group_id FROM players WHERE LOWER(name) LIKE LOWER('%' || ? || '%')`
    ).all(baseName) as PlayerRow[];

    if (players.length === 0) {
      await sendMsg(chatId, `❌ Aucun player trouvé pour "<i>${baseName}</i>".\nUtilise <code>/linkgroup @handle</code> ou <code>/linkgroup id:&lt;numéro&gt;</code>.`);
      return;
    }
    if (players.length === 1) {
      await sendMsg(chatId, await linkPlayer(chatId, players[0]));
      return;
    }
    const list = players.map(p => `• id=${p.id} — ${p.name}${p.telegram_handle ? ` (@${p.telegram_handle})` : ""}`).join("\n");
    await sendMsg(chatId, `⚠️ Plusieurs players pour "<i>${baseName}</i>" :\n${list}\n\nChoisis avec <code>/linkgroup id:&lt;numéro&gt;</code>`);
    return;
  }

  // CAS 2 — id:<number>
  if (trimmed.startsWith("id:")) {
    const force = trimmed.endsWith(" force");
    const idStr = force ? trimmed.slice(3, -6).trim() : trimmed.slice(3).trim();
    const pid = parseInt(idStr);
    if (isNaN(pid)) {
      await sendMsg(chatId, `❌ Format : <code>/linkgroup id:&lt;numéro&gt;</code> (un nombre).\nOu tape juste <code>/linkgroup</code> pour auto-détecter.`);
      return;
    }
    const player = db.prepare(`SELECT id, name, telegram_handle, telegram_group_id FROM players WHERE id = ?`).get(pid) as PlayerRow | undefined;
    if (!player) { await sendMsg(chatId, `❌ Player id=${pid} introuvable.`); return; }
    if (player.telegram_group_id && player.telegram_group_id !== String(chatId) && !force) {
      await sendMsg(chatId, `⚠️ <b>${player.name}</b> a déjà un groupe (<code>${player.telegram_group_id}</code>).\nPour écraser : <code>/linkgroup id:${pid} force</code>`);
      return;
    }
    await sendMsg(chatId, await linkPlayer(chatId, player));
    return;
  }

  // CAS 3 — @handle or handle
  const handle = trimmed.replace(/^@/, "").toLowerCase();
  const players = db.prepare(
    `SELECT id, name, telegram_handle, telegram_group_id FROM players WHERE LOWER(telegram_handle) = ? OR LOWER(REPLACE(telegram_handle, '@', '')) = ?`
  ).all(handle, handle) as PlayerRow[];

  if (players.length === 0) {
    await sendMsg(chatId, `❌ Aucun player pour "@${handle}".\nTape juste <code>/linkgroup</code> pour auto-détecter depuis le titre du groupe.`);
    return;
  }
  if (players.length > 1) {
    const list = players.map(p => `• id=${p.id} — ${p.name} (@${p.telegram_handle ?? "?"})`).join("\n");
    await sendMsg(chatId, `⚠️ Plusieurs players :\n${list}\n\nChoisis avec <code>/linkgroup id:&lt;numéro&gt;</code>`);
    return;
  }
  await sendMsg(chatId, await linkPlayer(chatId, players[0]));
}
