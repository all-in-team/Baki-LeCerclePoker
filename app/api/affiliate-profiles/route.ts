import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Promote an existing player to affiliate agent — CRM equivalent of the
// /startaffi bot command (startaffi.ts:51). Same defaults: joined_at = now,
// status = 'active'. Commission stays the hardcoded 50% (affiliate.ts:81).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const player_id = Number(body.player_id);
  if (!player_id) return NextResponse.json({ error: "player_id requis" }, { status: 400 });

  const db = getDb();
  const player = db.prepare(`SELECT id, name FROM players WHERE id = ?`).get(player_id) as { id: number; name: string } | undefined;
  if (!player) {
    return NextResponse.json({ error: "Joueur introuvable, crée-le d'abord dans CRM Joueurs" }, { status: 404 });
  }

  const existing = db.prepare(`SELECT 1 FROM affiliate_profiles WHERE affiliate_player_id = ?`).get(player_id);
  // Mirror startaffi.ts:51 — INSERT OR IGNORE = ON CONFLICT DO NOTHING; defaults fill joined_at + status='active'
  const r = db.prepare(`INSERT OR IGNORE INTO affiliate_profiles (affiliate_player_id) VALUES (?)`).run(player_id);

  return NextResponse.json(
    { ok: true, created: r.changes > 0, already_existed: !!existing, player: { id: player.id, name: player.name } },
    { status: r.changes > 0 ? 201 : 200 },
  );
}
