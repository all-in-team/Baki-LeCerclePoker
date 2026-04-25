import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const { game_id, period_label, club_id, club_name, rows } = await req.json() as {
    game_id: number;
    period_label: string;
    club_id: string | null;
    club_name: string | null;
    rows: {
      external_id: string;
      rakeback_amount: number;
      insurance_amount: number;
      winnings_amount: number;
      currency: string;
      player_id: number | null;
      action_pct: number | null; // per player — stored in player_game_deals
    }[];
  };

  if (!game_id || !period_label || !rows?.length) {
    return NextResponse.json({ error: "game_id, period_label, rows requis" }, { status: 400 });
  }

  const db = getDb();
  const rpt = db.prepare(`INSERT INTO rakeback_reports (game_id, period_label, club_id, club_name) VALUES (?, ?, ?, ?)`).run(game_id, period_label, club_id ?? null, club_name ?? null);
  const report_id = Number(rpt.lastInsertRowid);

  for (const row of rows) {
    db.prepare(`
      INSERT INTO rakeback_entries (report_id, player_id, external_id, amount, insurance_amount, winnings_amount, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(report_id, row.player_id ?? null, row.external_id,
      row.rakeback_amount ?? 0, row.insurance_amount ?? 0, row.winnings_amount ?? 0,
      row.currency || "USDT");

    if (row.player_id) {
      // Remember the external ID mapping
      try {
        db.prepare(`INSERT OR IGNORE INTO player_game_ids (player_id, game_id, external_id) VALUES (?, ?, ?)`)
          .run(row.player_id, game_id, row.external_id);
      } catch {}

      // Save action % per player per game — auto-fills on next import
      if (row.action_pct !== null) {
        try {
          db.prepare(`
            INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct)
            VALUES (?, ?, ?, 0)
            ON CONFLICT(player_id, game_id) DO UPDATE SET action_pct = excluded.action_pct
          `).run(row.player_id, game_id, row.action_pct);
        } catch {}
      }
    }
  }

  return NextResponse.json({ ok: true, report_id });
}
