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
      rb_pct: number | null;
      ins_pct: number | null;
      action_pct: number | null;
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

      // Save/update the deal % for this player × game — auto-fills on next import
      const hasDeal = row.rb_pct !== null || row.ins_pct !== null || row.action_pct !== null;
      if (hasDeal) {
        try {
          db.prepare(`
            INSERT INTO player_game_deals (player_id, game_id, rakeback_pct, insurance_pct, action_pct)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(player_id, game_id) DO UPDATE SET
              rakeback_pct  = COALESCE(excluded.rakeback_pct,  rakeback_pct),
              insurance_pct = COALESCE(excluded.insurance_pct, insurance_pct),
              action_pct    = COALESCE(excluded.action_pct,    action_pct)
          `).run(row.player_id, game_id, row.rb_pct ?? null, row.ins_pct ?? null, row.action_pct ?? null);
        } catch {}
      }
    }
  }

  return NextResponse.json({ ok: true, report_id });
}
