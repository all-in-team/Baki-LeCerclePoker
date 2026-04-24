import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const { game_id, period_label, rows } = await req.json() as {
    game_id: number;
    period_label: string;
    rows: { external_id: string; amount: number; currency: string; player_id: number | null }[];
  };

  if (!game_id || !period_label || !rows?.length) {
    return NextResponse.json({ error: "game_id, period_label, rows requis" }, { status: 400 });
  }

  const db = getDb();
  const rpt = db.prepare(`INSERT INTO rakeback_reports (game_id, period_label) VALUES (?, ?)`).run(game_id, period_label);
  const report_id = Number(rpt.lastInsertRowid);

  for (const row of rows) {
    db.prepare(`
      INSERT INTO rakeback_entries (report_id, player_id, external_id, amount, currency)
      VALUES (?, ?, ?, ?, ?)
    `).run(report_id, row.player_id ?? null, row.external_id, row.amount, row.currency || "USDT");

    if (row.player_id) {
      try {
        db.prepare(`INSERT OR IGNORE INTO player_game_ids (player_id, game_id, external_id) VALUES (?, ?, ?)`)
          .run(row.player_id, game_id, row.external_id);
      } catch {}
    }
  }

  return NextResponse.json({ ok: true, report_id });
}
