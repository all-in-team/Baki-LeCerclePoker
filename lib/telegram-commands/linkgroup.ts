import { getDb } from "@/lib/db";
import { sendMsg, OWNER_IDS } from "./helpers";
import { repairGroupTopics } from "@/lib/group-repair";

interface PlayerRow { id: number; name: string; telegram_handle: string | null; telegram_group_id: string | null }

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
  const oldNote = old && old !== String(chatId) ? `\n<i>(remplace l'ancien groupe ${old})</i>` : "";

  // Repair topics (session-checked, find-or-create, authoritative write). The headline
  // reflects the REAL outcome — no "✅" unless topics actually synced (fixes the false-success bug).
  const r = await repairGroupTopics(chatId, player.id);

  if (!r.sessionOk) {
    return `⚠️ Groupe lié à <b>${player.name}</b> (id=${player.id}).${oldNote}\n` +
      `❌ Topics NON synchronisés — <b>userbot déconnecté</b>. Relance <code>/fixgroup</code> ici quand il est revenu.`;
  }
  if (r.ok) {
    return `✅ Groupe lié + réparé — <b>${player.name}</b> (id=${player.id}).${oldNote}\n` +
      `🧵 7/7 topics OK · Bot ${r.botPromoted ? "admin ✅" : "⚠️ non promu"}.\n` +
      `Tu peux taper /startaffi.`;
  }
  return `⚠️ Groupe lié à <b>${player.name}</b> (id=${player.id}).${oldNote}\n` +
    `🧵 Topics partiels — manquants : <b>${r.topicsMissing.join(", ") || "—"}</b> · Bot ${r.botPromoted ? "admin ✅" : "⚠️ non promu"}.\n` +
    (r.errors.length ? `<i>${r.errors.slice(0, 2).join(" | ")}</i>\n` : "") +
    `Relance <code>/fixgroup</code> (idempotent).`;
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
