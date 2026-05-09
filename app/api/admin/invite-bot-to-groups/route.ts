import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { inviteAndPromoteBot } from "@/lib/telegram-userbot";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  const provided = req.headers.get("x-admin-token");
  if (provided !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const singlePlayerId = body.player_id ? Number(body.player_id) : null;

  const db = getDb();

  let players: { id: number; name: string; telegram_group_id: string }[];

  if (singlePlayerId) {
    players = db.prepare(`
      SELECT id, name, telegram_group_id FROM players
      WHERE id = ? AND telegram_group_id IS NOT NULL AND status = 'active'
    `).all(singlePlayerId) as typeof players;
  } else {
    players = db.prepare(`
      SELECT id, name, telegram_group_id FROM players
      WHERE telegram_group_id IS NOT NULL
        AND (telegram_chat_id IS NULL OR telegram_chat_id != telegram_group_id)
        AND status = 'active'
    `).all() as typeof players;
  }

  const errors: { player_id: number; name: string; reason: string }[] = [];
  let success = 0;

  for (const player of players) {
    const chatId = parseInt(player.telegram_group_id);
    if (isNaN(chatId)) {
      errors.push({ player_id: player.id, name: player.name, reason: `invalid telegram_group_id "${player.telegram_group_id}"` });
      continue;
    }

    const result = await inviteAndPromoteBot(chatId);

    if (result.ok) {
      db.prepare(`UPDATE players SET telegram_chat_id = telegram_group_id WHERE id = ?`)
        .run(player.id);
      success++;
    } else {
      errors.push({ player_id: player.id, name: player.name, reason: result.error ?? "unknown" });
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    processed: players.length,
    success,
    errors,
  });
}
