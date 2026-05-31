import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json();
  const db = getDb();

  const allowed = ["origin_game_id", "start_date", "status", "disclosed_action_pct", "disclosed_rakeback_pct", "disclosed_insurance_pct", "exclude_agency_extras", "notes"];
  const sets: string[] = [];
  const vals: Record<string, unknown> = { id: Number(id) };

  for (const key of allowed) {
    if (body[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      vals[key] = body[key];
    }
  }

  if (sets.length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  db.prepare(`UPDATE affiliate_relationships SET ${sets.join(", ")} WHERE id = @id`).run(vals);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_: NextRequest, { params }: Ctx) {
  const { id } = await params;
  getDb().prepare(`UPDATE affiliate_relationships SET status = 'terminated' WHERE id = ?`).run(Number(id));
  return NextResponse.json({ ok: true });
}
