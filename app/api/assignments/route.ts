import { NextRequest, NextResponse } from "next/server";
import { upsertAssignment, getAppById } from "@/lib/queries";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { player_id, app_id } = body;
  if (!player_id || !app_id) return NextResponse.json({ error: "player_id and app_id required" }, { status: 400 });

  const app = getAppById(Number(app_id)) as any;
  if (!app) return NextResponse.json({ error: "App not found" }, { status: 404 });

  upsertAssignment({
    player_id: Number(player_id),
    app_id: Number(app_id),
    deal_type: "rakeback",
    deal_value: app.deal_value ?? 0,
    status: "active",
  });
  return NextResponse.json({ ok: true }, { status: 201 });
}
