import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json();
  const db = getDb();

  const allowed = [
    "exact_action_pct", "exact_rakeback_pct", "exact_insurance_pct",
    "perceived_action_pct", "perceived_rakeback_pct", "perceived_insurance_pct",
  ];
  const sets: string[] = [];
  const vals: Record<string, unknown> = { id: Number(id) };

  for (const key of allowed) {
    if (body[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      vals[key] = body[key];
    }
  }

  if (sets.length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  db.prepare(`UPDATE games SET ${sets.join(", ")} WHERE id = @id`).run(vals);
  return NextResponse.json({ ok: true });
}
