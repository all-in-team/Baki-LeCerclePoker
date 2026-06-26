import { getDb } from "@/lib/db";
import { sendMsg, OWNER_IDS } from "./helpers";
import { repairGroupTopics } from "@/lib/group-repair";

interface PlayerRow { id: number; name: string }

function extractBaseName(title: string): string {
  return title
    .replace(/\s*x\s*LeCercle.*$/i, "")
    .replace(/\s*\(OLD ARCHIVE\)\s*/i, "")
    .replace(/\s*\(Agent\s*:.*?\)\s*/i, "")
    .trim();
}

/**
 * /fixgroup — robust one-command repair of the CURRENT group.
 * Verifies userbot session, find-or-creates all 7 topics, (re)invites/promotes the bot,
 * writes every topic id authoritatively, and ONLY confirms "✅" if everything truly succeeded.
 */
export async function handleFixGroup(chatId: number, fromId: number | undefined, chatType: string, chatTitle: string) {
  if (!fromId || !OWNER_IDS.has(fromId)) { await sendMsg(chatId, `❌ Réservé aux admins.`); return; }
  if (chatType !== "group" && chatType !== "supergroup") { await sendMsg(chatId, `❌ À utiliser DANS le groupe à réparer.`); return; }

  const db = getDb();
  // Find the linked player; if the group isn't linked yet, try a title match and link it.
  let player = db.prepare(`SELECT id, name FROM players WHERE telegram_group_id = ?`).get(String(chatId)) as PlayerRow | undefined;
  if (!player) {
    const base = extractBaseName(chatTitle);
    const matches = base
      ? (db.prepare(`SELECT id, name FROM players WHERE LOWER(name) LIKE LOWER('%' || ? || '%')`).all(base) as PlayerRow[])
      : [];
    if (matches.length === 1) {
      player = matches[0];
      db.prepare(`UPDATE players SET telegram_group_id = ? WHERE id = ?`).run(String(chatId), player.id);
    } else if (matches.length > 1) {
      await sendMsg(chatId, `⚠️ Plusieurs joueurs possibles pour "<i>${base}</i>". Lance d'abord <code>/linkgroup id:&lt;numéro&gt;</code>, puis <code>/fixgroup</code>.`);
      return;
    } else {
      await sendMsg(chatId, `❌ Ce groupe n'est lié à aucun joueur. Lance <code>/linkgroup</code> d'abord.`);
      return;
    }
  }

  await sendMsg(chatId, `🔧 Réparation du groupe en cours… (vérif userbot + topics)`);

  const r = await repairGroupTopics(chatId, player.id);

  // ── Report ONLY after the repair ran + was verified (no false success) ──
  if (!r.sessionOk) {
    await sendMsg(chatId,
      `❌ <b>Userbot déconnecté</b> — réparation impossible.\n` +
      `Aucun topic synchronisé. Réessaie quand le userbot est reconnecté.\n` +
      (r.errors.length ? `<i>${r.errors.slice(0, 2).join(" | ")}</i>` : "")
    );
    return;
  }

  if (r.ok) {
    await sendMsg(chatId,
      `✅ <b>Groupe réparé</b> — <b>${player.name}</b>\n` +
      `🧵 7/7 topics OK${r.topicsCreated.length ? ` (créés : ${r.topicsCreated.join(", ")})` : " (tous déjà présents)"}\n` +
      `🤖 Bot : ${r.botPromoted ? "admin ✅" : "⚠️ non promu"}\n` +
      `Les alertes partiront maintenant dans le bon topic.`
    );
  } else {
    await sendMsg(chatId,
      `⚠️ <b>Réparation PARTIELLE</b> — <b>${player.name}</b>\n` +
      `❌ Topics manquants : <b>${r.topicsMissing.join(", ") || "—"}</b>\n` +
      `🤖 Bot : ${r.botPromoted ? "admin ✅" : "⚠️ non promu"}\n` +
      (r.errors.length ? `<i>${r.errors.slice(0, 3).join(" | ")}</i>\n` : "") +
      `Relance <code>/fixgroup</code> (idempotent) une fois le souci réglé.`
    );
  }
}
