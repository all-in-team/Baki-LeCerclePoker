import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const { game_id, period_label, club_id, club_name, rb_pct, ins_pct, rows } = await req.json() as {
    game_id: number;
    period_label: string;
    club_id: string | null;
    club_name: string | null;
    rb_pct: number | null;
    ins_pct: number | null;
    rows: {
      external_id: string;
      rakeback_amount: number;
      insurance_amount: number;
      winnings_amount: number;
      currency: string;
      player_id: number | null;
      action_pct: number | null;
      rakeback_pct: number | null;
    }[];
  };

  if (!game_id || !period_label || !rows?.length) {
    return NextResponse.json({ error: "game_id, period_label, rows requis" }, { status: 400 });
  }

  const db = getDb();
  // Persist club deal so next import auto-fills
  if (club_id) {
    try {
      db.prepare(`
        INSERT INTO clubs (game_id, external_club_id, club_name, rb_pct, ins_pct)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(game_id, external_club_id) DO UPDATE SET
          club_name = COALESCE(excluded.club_name, club_name),
          rb_pct    = COALESCE(excluded.rb_pct,    rb_pct),
          ins_pct   = COALESCE(excluded.ins_pct,   ins_pct)
      `).run(game_id, club_id, club_name ?? null, rb_pct ?? null, ins_pct ?? null);
    } catch {}
  }

  const rpt = db.prepare(`INSERT INTO rakeback_reports (game_id, period_label, club_id, club_name, rakeback_pct, insurance_pct) VALUES (?, ?, ?, ?, ?, ?)`).run(game_id, period_label, club_id ?? null, club_name ?? null, rb_pct ?? null, ins_pct ?? null);
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

      // Save action_pct + rakeback_pct per player per game — auto-fills on next import
      if (row.action_pct !== null || row.rakeback_pct !== null) {
        try {
          db.prepare(`
            INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(player_id, game_id) DO UPDATE SET
              action_pct   = CASE WHEN excluded.action_pct   IS NOT NULL THEN excluded.action_pct   ELSE action_pct   END,
              rakeback_pct = CASE WHEN excluded.rakeback_pct IS NOT NULL THEN excluded.rakeback_pct ELSE rakeback_pct END
          `).run(row.player_id, game_id, row.action_pct ?? null, row.rakeback_pct ?? null);
        } catch {}
      }
    } else {
      // Mark unidentified IDs as ignored — won't appear on future imports for this game
      try {
        db.prepare(`INSERT OR IGNORE INTO game_ignored_ids (game_id, external_id) VALUES (?, ?)`)
          .run(game_id, row.external_id);
      } catch {}
    }
  }

  return NextResponse.json({ ok: true, report_id });
}
