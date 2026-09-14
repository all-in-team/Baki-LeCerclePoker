// AK multi-Account — joueurs inscrits au modèle pool.
// GET  → inscrits (avec leur part d'action) + candidats (joueurs non inscrits).
// POST → inscrire { player_id, main_okpay_tg_id? } (idempotent, met à jour la main).
// Route fine (invariant #2) : validation, appel lib, réponse.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listPoolPlayers, enrollPoolPlayer } from "@/lib/pool/periods";
import { POOL_GAME_NAME } from "@/lib/pool/schema";

export async function GET() {
  try {
    const db = getDb();
    const enrolled = listPoolPlayers();
    const ids = new Set(enrolled.map(p => p.player_id));
    const candidates = (db.prepare(`
      SELECT p.id, p.name, d.action_pct
        FROM players p
        LEFT JOIN player_game_deals d ON d.player_id = p.id AND d.game_id = (SELECT id FROM games WHERE name = ?)
       ORDER BY p.name
    `).all(POOL_GAME_NAME) as { id: number; name: string; action_pct: number | null }[]).filter(p => !ids.has(p.id));
    return NextResponse.json({ ok: true, enrolled, candidates });
  } catch (e: any) {
    console.error("[AKMULTI_PLAYERS_GET]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => null);
    if (!b || !Number.isInteger(b.player_id)) return NextResponse.json({ error: "player_id attendu." }, { status: 400 });
    const main = typeof b.main_okpay_tg_id === "string" && b.main_okpay_tg_id.trim() !== "" ? b.main_okpay_tg_id.trim() : null;
    const r = enrollPoolPlayer(b.player_id, main);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true, id: r.id });
  } catch (e: any) {
    console.error("[AKMULTI_PLAYERS_POST]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
