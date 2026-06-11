import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json();
  const db = getDb();

  const allowed = ["player_id", "game_id", "session_date", "duration_hours", "net_result_usdt", "notes", "variant"];
  const sets: string[] = [];
  const vals: Record<string, unknown> = { id: Number(id) };

  for (const key of allowed) {
    if (body[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      // blank variant means "cleared" — store NULL, keeps DISTINCT autocomplete clean
      vals[key] = key === "variant"
        ? (typeof body[key] === "string" && body[key].trim() !== "" ? body[key].trim() : null)
        : body[key];
    }
  }

  if (sets.length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  db.prepare(`UPDATE grindhouse_sessions SET ${sets.join(", ")} WHERE id = @id`).run(vals);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_: NextRequest, { params }: Ctx) {
  const { id } = await params;
  getDb().prepare(`DELETE FROM grindhouse_sessions WHERE id = ?`).run(Number(id));
  return NextResponse.json({ ok: true });
}
