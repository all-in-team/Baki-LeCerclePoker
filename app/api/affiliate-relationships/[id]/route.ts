import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const db = getDb();
  const gameRates = db.prepare(
    `SELECT arg.game_id, g.name AS game_name, arg.disclosed_action_pct, arg.disclosed_rakeback_pct, arg.disclosed_insurance_pct, arg.exclude_agency_extras, arg.excluded
     FROM affiliate_relationship_games arg
     JOIN games g ON g.id = arg.game_id
     WHERE arg.relationship_id = ?
     ORDER BY g.name`
  ).all(Number(id)) as any[];
  return NextResponse.json({ game_rates: gameRates });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json();
  const db = getDb();
  const relId = Number(id);

  const allowed = ["origin_game_id", "start_date", "status", "disclosed_action_pct", "disclosed_rakeback_pct", "disclosed_insurance_pct", "exclude_agency_extras", "notes"];
  const sets: string[] = [];
  const vals: Record<string, unknown> = { id: relId };

  for (const key of allowed) {
    if (body[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      vals[key] = body[key];
    }
  }

  if (sets.length > 0) {
    db.prepare(`UPDATE affiliate_relationships SET ${sets.join(", ")} WHERE id = @id`).run(vals);
  }

  if (Array.isArray(body.game_rates)) {
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM affiliate_relationship_games WHERE relationship_id = ?`).run(relId);
      const insert = db.prepare(
        `INSERT INTO affiliate_relationship_games (relationship_id, game_id, disclosed_action_pct, disclosed_rakeback_pct, disclosed_insurance_pct, exclude_agency_extras, excluded)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const gr of body.game_rates) {
        if (!gr.game_id) continue;
        insert.run(
          relId, gr.game_id,
          gr.disclosed_action_pct ?? null,
          gr.disclosed_rakeback_pct ?? null,
          gr.disclosed_insurance_pct ?? null,
          gr.exclude_agency_extras ?? 1,
          gr.excluded ?? 0,
        );
      }
    });
    tx();
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(_: NextRequest, { params }: Ctx) {
  const { id } = await params;
  getDb().prepare(`UPDATE affiliate_relationships SET status = 'terminated' WHERE id = ?`).run(Number(id));
  return NextResponse.json({ ok: true });
}
