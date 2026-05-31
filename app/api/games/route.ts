import { NextRequest, NextResponse } from "next/server";
import { getGames } from "@/lib/queries";
import { getDb } from "@/lib/db";

export async function GET() {
  return NextResponse.json(getGames());
}

export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { id } = body;
  if (!id) return NextResponse.json({ error: "id requis" }, { status: 400 });

  const db = getDb();

  if (body.status === "archived") {
    const result = db.transaction(() => {
      db.prepare(`UPDATE games SET status = 'archived' WHERE id = ?`).run(id);
      const deals = db.prepare(`UPDATE player_game_deals SET end_date = date('now') WHERE game_id = ? AND end_date IS NULL`).run(id);
      const meres = db.prepare(`UPDATE wallet_meres SET status = 'retired', retired_at = datetime('now') WHERE game_id = ? AND status = 'active'`).run(id);
      return { deals_archived: deals.changes, meres_retired: meres.changes };
    })();
    return NextResponse.json({ ok: true, ...result });
  }

  if (body.status === "active") {
    db.prepare(`UPDATE games SET status = 'active' WHERE id = ?`).run(id);
    return NextResponse.json({ ok: true });
  }

  if (body.default_action_pct !== undefined) {
    db.prepare(`UPDATE games SET default_action_pct = ? WHERE id = ?`).run(body.default_action_pct, id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
}
