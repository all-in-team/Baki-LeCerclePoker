import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const entries = db.prepare(`
    SELECT re.id, re.external_id, re.amount, re.currency, re.player_id,
      p.name AS player_name
    FROM rakeback_entries re
    LEFT JOIN players p ON p.id = re.player_id
    WHERE re.report_id = ?
    ORDER BY re.amount DESC
  `).all(Number(id));
  return NextResponse.json(entries);
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  getDb().prepare(`DELETE FROM rakeback_reports WHERE id = ?`).run(Number(id));
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { entry_id, player_id } = await req.json();
  const db = getDb();
  const report = db.prepare(`SELECT game_id FROM rakeback_reports WHERE id = ?`).get(Number(id)) as any;
  db.prepare(`UPDATE rakeback_entries SET player_id = ? WHERE id = ?`).run(player_id, entry_id);
  if (player_id && report) {
    const e = db.prepare(`SELECT external_id FROM rakeback_entries WHERE id = ?`).get(entry_id) as any;
    try {
      db.prepare(`INSERT OR IGNORE INTO player_game_ids (player_id, game_id, external_id) VALUES (?, ?, ?)`)
        .run(player_id, report.game_id, e.external_id);
    } catch {}
  }
  return NextResponse.json({ ok: true });
}
