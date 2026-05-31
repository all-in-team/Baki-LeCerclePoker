import { NextResponse } from "next/server";
import { validatePlayer } from "@/lib/settlement-engine";

export async function POST(req: Request) {
  const body = await req.json();
  const { player_id, week_start, action, payload } = body;

  if (!player_id || !week_start || !action) {
    return NextResponse.json({ error: "Missing player_id, week_start, or action" }, { status: 400 });
  }

  const result = validatePlayer(player_id, week_start, action, payload);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}
