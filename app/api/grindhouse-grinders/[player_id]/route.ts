import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ player_id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { player_id } = await params;
  const body = await req.json();
  const db = getDb();

  const allowed = ["status", "deal_percentage", "notes"];
  const sets: string[] = [];
  const vals: Record<string, unknown> = { player_id: Number(player_id) };

  for (const key of allowed) {
    if (body[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      vals[key] = body[key];
    }
  }

  if (sets.length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  db.prepare(`UPDATE grindhouse_grinders SET ${sets.join(", ")} WHERE player_id = @player_id`).run(vals);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_: NextRequest, { params }: Ctx) {
  const { player_id } = await params;
  getDb().prepare(`UPDATE grindhouse_grinders SET status = 'inactive' WHERE player_id = ?`).run(Number(player_id));
  return NextResponse.json({ ok: true });
}
