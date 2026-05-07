import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  const provided = req.headers.get("x-admin-token");
  if (provided !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { telegram_id, player_id } = body;
  if (!telegram_id && !player_id) {
    return NextResponse.json({ error: "Provide telegram_id or player_id" }, { status: 400 });
  }

  const db = getDb();

  const player = telegram_id
    ? db.prepare(`SELECT id, name, telegram_chat_id FROM players WHERE telegram_id = ?`).get(telegram_id) as any
    : db.prepare(`SELECT id, name, telegram_chat_id FROM players WHERE id = ?`).get(player_id) as any;

  if (!player) {
    return NextResponse.json({ error: "Player not found" }, { status: 404 });
  }

  let deletedSession = false;
  if (player.telegram_chat_id) {
    const r = db.prepare(`DELETE FROM telegram_sessions WHERE chat_id = ?`).run(player.telegram_chat_id);
    deletedSession = r.changes > 0;
  }

  db.prepare(`DELETE FROM crm_notes WHERE player_id = ?`).run(player.id);
  db.prepare(`DELETE FROM players WHERE id = ?`).run(player.id);

  return NextResponse.json({
    ok: true,
    deleted_player_id: player.id,
    deleted_player_name: player.name,
    deleted_session: deletedSession,
  });
}
