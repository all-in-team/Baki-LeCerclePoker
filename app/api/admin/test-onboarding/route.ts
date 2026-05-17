import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.key !== "test-onboard-20260517") {
    return NextResponse.json({ error: "bad key" }, { status: 403 });
  }

  const db = getDb();
  const log: string[] = [];

  try {
    // Step 1: Check games table
    const kkGame = db.prepare(`SELECT id FROM games WHERE name = 'KKPOKER'`).get() as any;
    log.push(`kkpoker game: ${JSON.stringify(kkGame)}`);

    // Step 2: onboarding_leads upsert
    db.prepare(`INSERT INTO onboarding_leads (telegram_id, telegram_username, first_name, stage) VALUES (?, ?, ?, 'joined') ON CONFLICT(telegram_id) DO UPDATE SET stage='joined', last_seen=datetime('now')`).run(999999999, "faketest", "FakeTest");
    log.push("onboarding_leads: ok");

    // Step 3: player insert
    const result = db.prepare(`INSERT INTO players (name, telegram_id, telegram_handle, telegram_chat_id, status) VALUES (?, ?, ?, ?, 'active')`).run("FakeTest Bot", 999999999, "faketest", "999999999");
    const playerId = Number(result.lastInsertRowid);
    log.push(`player insert: id=${playerId}`);

    // Step 4: player_game_deals insert
    if (kkGame) {
      db.prepare(`INSERT OR IGNORE INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct) VALUES (?, ?, 40, 0)`).run(playerId, kkGame.id);
      log.push("deal insert: ok");
    }

    // Step 5: telegram_sessions
    db.prepare(`INSERT OR REPLACE INTO telegram_sessions (chat_id, step, player_id, expected_tg_id, created_at) VALUES (?, ?, ?, ?, datetime('now'))`).run("999999999", "kkpoker_pitch_sent", playerId, 999999999);
    log.push("session insert: ok");

    // Cleanup
    db.prepare(`DELETE FROM telegram_sessions WHERE chat_id = '999999999'`).run();
    db.prepare(`DELETE FROM player_game_deals WHERE player_id = ?`).run(playerId);
    db.prepare(`DELETE FROM onboarding_leads WHERE telegram_id = 999999999`).run();
    db.prepare(`DELETE FROM players WHERE id = ?`).run(playerId);
    log.push("cleanup: ok");

    return NextResponse.json({ ok: true, log });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message, code: e.code, log }, { status: 500 });
  }
}
