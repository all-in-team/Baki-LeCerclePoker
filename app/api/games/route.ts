import { NextRequest, NextResponse } from "next/server";
import { getGames } from "@/lib/queries";
import { getDb } from "@/lib/db";

export async function GET() {
  return NextResponse.json(getGames());
}

export async function PATCH(req: NextRequest) {
  const { id, default_action_pct } = await req.json();
  if (!id || default_action_pct === undefined) return NextResponse.json({ error: "id + default_action_pct requis" }, { status: 400 });
  getDb().prepare(`UPDATE games SET default_action_pct = ? WHERE id = ?`).run(default_action_pct, id);
  return NextResponse.json({ ok: true });
}
