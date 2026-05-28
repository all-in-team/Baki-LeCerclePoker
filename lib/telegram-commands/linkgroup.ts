import { getDb } from "@/lib/db";
import { sendMsg, OWNER_IDS } from "./helpers";

export async function handleLinkGroup(chatId: number, fromId: number, chatType: string, args: string) {
  if (!OWNER_IDS.has(fromId)) {
    await sendMsg(chatId, `❌ Réservé aux admins.`);
    return;
  }

  if (chatType !== "group" && chatType !== "supergroup") {
    await sendMsg(chatId, `❌ À utiliser dans le groupe à lier.`);
    return;
  }

  const trimmed = args.trim();
  if (!trimmed) {
    await sendMsg(chatId, `Usage : <code>/linkgroup @handle</code> ou <code>/linkgroup id:&lt;numero&gt;</code>`);
    return;
  }

  const db = getDb();
  const force = trimmed.endsWith(" force");
  const arg = force ? trimmed.slice(0, -6).trim() : trimmed;

  let players: { id: number; name: string; telegram_handle: string | null; telegram_group_id: string | null }[] = [];

  if (arg.startsWith("id:")) {
    const pid = parseInt(arg.slice(3));
    if (isNaN(pid)) { await sendMsg(chatId, `❌ ID invalide.`); return; }
    const p = db.prepare(`SELECT id, name, telegram_handle, telegram_group_id FROM players WHERE id = ?`).get(pid);
    if (p) players = [p as any];
  } else {
    const handle = arg.replace(/^@/, "").toLowerCase();
    players = db.prepare(
      `SELECT id, name, telegram_handle, telegram_group_id FROM players WHERE LOWER(telegram_handle) = ? OR LOWER(REPLACE(telegram_handle, '@', '')) = ?`
    ).all(handle, handle) as any[];
  }

  if (players.length === 0) {
    await sendMsg(chatId, `❌ Aucun player trouvé pour "<i>${arg}</i>".\nUtilise <code>/linkgroup id:&lt;numero&gt;</code> pour cibler par ID.`);
    return;
  }

  if (players.length > 1) {
    const list = players.map(p => `• id=${p.id} — ${p.name} (@${p.telegram_handle ?? "?"})`).join("\n");
    await sendMsg(chatId, `⚠️ Plusieurs players matchent :\n${list}\n\nUtilise <code>/linkgroup id:&lt;numero&gt;</code> pour choisir.`);
    return;
  }

  const player = players[0];

  if (player.telegram_group_id && player.telegram_group_id !== String(chatId) && !force) {
    await sendMsg(chatId,
      `⚠️ <b>${player.name}</b> a déjà un groupe lié (<code>${player.telegram_group_id}</code>).\n` +
      `Pour écraser, retape : <code>/linkgroup id:${player.id} force</code>`
    );
    return;
  }

  db.prepare(`UPDATE players SET telegram_group_id = ? WHERE id = ?`).run(String(chatId), player.id);

  await sendMsg(chatId,
    `✅ Groupe lié à <b>${player.name}</b> (id=${player.id}).\n` +
    `Tu peux maintenant taper /startaffi.`
  );
}
