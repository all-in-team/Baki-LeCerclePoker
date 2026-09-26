import { NextRequest, NextResponse } from "next/server";
import { resetPlayerChecked } from "@/lib/players-archive";
import { PlayerOpenError } from "@/lib/queries/player-open";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  const provided = req.headers.get("x-admin-token");
  if (provided !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { telegram_id, player_id } = body;
  if (!telegram_id && !player_id) {
    return NextResponse.json({ error: "Provide telegram_id or player_id" }, { status: 400 });
  }

  // Verrou « ouvert » : un joueur qui a quelque chose à régler n'est jamais effacé (409 + motifs).
  try {
    const r = resetPlayerChecked({ telegram_id, player_id });
    if (!r.found) return NextResponse.json({ error: "Player not found" }, { status: 404 });
    const { found: _found, ...rest } = r;
    return NextResponse.json({ ok: true, ...rest });
  } catch (e: any) {
    if (e instanceof PlayerOpenError) return NextResponse.json({ error: e.message, blocked: e.blocked }, { status: 409 });
    throw e;
  }
}
