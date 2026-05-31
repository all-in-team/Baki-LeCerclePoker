import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.key !== "cleanup-partial-shells-20260517") {
    return NextResponse.json({ error: "bad key" }, { status: 403 });
  }

  const db = getDb();
  const targets = [46, 47, 48, 49];
  const tgIds = [8736080064, 8064954082, 7559000418, 1298290355];
  const log: string[] = [];

  const tx = db.transaction(() => {
    for (const pid of targets) {
      const p = db.prepare(`SELECT telegram_chat_id FROM players WHERE id = ?`).get(pid) as any;
      if (p?.telegram_chat_id) {
        const r = db.prepare(`DELETE FROM telegram_sessions WHERE chat_id = ?`).run(p.telegram_chat_id);
        log.push(`sessions pid=${pid}: ${r.changes}`);
      }
      db.prepare(`DELETE FROM player_wallet_games WHERE player_id = ?`).run(pid);
      db.prepare(`DELETE FROM player_wallet_cashouts WHERE player_id = ?`).run(pid);
      db.prepare(`DELETE FROM player_game_deals WHERE player_id = ?`).run(pid);
      const r = db.prepare(`DELETE FROM players WHERE id = ?`).run(pid);
      log.push(`player ${pid}: ${r.changes}`);
    }
    for (const tid of tgIds) {
      const r = db.prepare(`DELETE FROM onboarding_leads WHERE telegram_id = ?`).run(tid);
      log.push(`lead tg=${tid}: ${r.changes}`);
    }
  });
  tx();

  const verify = targets.map(pid => {
    const row = db.prepare(`SELECT id FROM players WHERE id = ?`).get(pid);
    return { pid, exists: !!row };
  });

  return NextResponse.json({ ok: true, log, verify });
}
