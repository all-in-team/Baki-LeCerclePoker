import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listGroups, ensureTopic } from "@/lib/telegram-userbot";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  const provided = req.headers.get("x-admin-token");
  if (provided !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const singleChatId = body.chat_id ? Number(body.chat_id) : null;

  const db = getDb();
  const summary = { processed: 0, matched: 0, created: 0, skipped: 0, errors: [] as string[] };

  // Step 1: If players are missing telegram_group_id, try to match them to groups
  const playersWithoutGroup = db.prepare(`
    SELECT id, name FROM players
    WHERE status = 'active' AND telegram_group_id IS NULL
  `).all() as { id: number; name: string }[];

  if (playersWithoutGroup.length > 0) {
    const groupList = await listGroups();
    if (groupList.ok) {
      for (const player of playersWithoutGroup) {
        const firstName = player.name.split(" ")[0];
        const matched = groupList.groups.find(g =>
          g.title.toLowerCase().startsWith(firstName.toLowerCase()) &&
          g.title.toLowerCase().includes("x lecercle")
        );
        if (matched) {
          db.prepare(`UPDATE players SET telegram_group_id = ? WHERE id = ?`)
            .run(matched.chat_id, player.id);
          summary.matched++;
        }
      }
    }
  }

  // Step 2: For each target player, ensure Alertes topic exists
  let players: { id: number; name: string; telegram_group_id: string; alertes_topic_id: number | null }[];

  if (singleChatId) {
    players = db.prepare(`
      SELECT id, name, telegram_group_id, alertes_topic_id FROM players
      WHERE telegram_group_id = ? AND status = 'active'
    `).all(String(singleChatId)) as typeof players;
  } else {
    players = db.prepare(`
      SELECT id, name, telegram_group_id, alertes_topic_id FROM players
      WHERE status = 'active' AND telegram_group_id IS NOT NULL
    `).all() as typeof players;
  }

  for (const player of players) {
    summary.processed++;

    if (player.alertes_topic_id) {
      summary.skipped++;
      continue;
    }

    const chatId = parseInt(player.telegram_group_id);
    if (isNaN(chatId)) {
      summary.errors.push(`${player.name}: invalid telegram_group_id "${player.telegram_group_id}"`);
      continue;
    }

    const result = await ensureTopic(chatId, "alertes");
    if (result.ok && result.topicId) {
      db.prepare(`UPDATE players SET alertes_topic_id = ? WHERE id = ?`)
        .run(result.topicId, player.id);
      if (result.created) summary.created++;
      else summary.skipped++;
    } else {
      summary.errors.push(`${player.name}: ${result.error ?? "unknown error"}`);
    }

    // Small delay between groups to avoid Telegram rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  return NextResponse.json(summary);
}
