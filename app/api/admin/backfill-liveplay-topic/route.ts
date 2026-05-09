import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { ensureTopic } from "@/lib/telegram-userbot";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  const provided = req.headers.get("x-admin-token");
  if (provided !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const singleChatId = body.chat_id ? Number(body.chat_id) : null;

  const db = getDb();
  const summary = { processed: 0, created: 0, skipped: 0, errors: [] as string[] };

  let players: { id: number; name: string; telegram_group_id: string; liveplay_topic_id: number | null }[];

  if (singleChatId) {
    players = db.prepare(`
      SELECT id, name, telegram_group_id, liveplay_topic_id FROM players
      WHERE telegram_group_id = ? AND status = 'active'
    `).all(String(singleChatId)) as typeof players;
  } else {
    players = db.prepare(`
      SELECT id, name, telegram_group_id, liveplay_topic_id FROM players
      WHERE status = 'active' AND telegram_group_id IS NOT NULL
    `).all() as typeof players;
  }

  for (const player of players) {
    summary.processed++;

    if (player.liveplay_topic_id) {
      summary.skipped++;
      continue;
    }

    const chatId = parseInt(player.telegram_group_id);
    if (isNaN(chatId)) {
      summary.errors.push(`${player.name}: invalid telegram_group_id "${player.telegram_group_id}"`);
      continue;
    }

    const result = await ensureTopic(chatId, "liveplay");
    if (result.ok && result.topicId) {
      db.prepare(`UPDATE players SET liveplay_topic_id = ? WHERE id = ?`)
        .run(result.topicId, player.id);
      if (result.created) summary.created++;
      else summary.skipped++;
    } else {
      summary.errors.push(`${player.name}: ${result.error ?? "unknown error"}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return NextResponse.json(summary);
}
