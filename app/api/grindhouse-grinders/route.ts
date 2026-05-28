import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(req: NextRequest) {
  const includeInactive = req.nextUrl.searchParams.get("include_inactive") === "1";
  const db = getDb();
  const where = includeInactive ? "" : "WHERE gg.status = 'active'";
  const rows = db.prepare(`
    SELECT gg.*, p.name, p.telegram_handle
    FROM grindhouse_grinders gg
    JOIN players p ON p.id = gg.player_id
    ${where}
    ORDER BY p.name
  `).all();
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { player_id, deal_percentage } = body;
  if (!player_id) return NextResponse.json({ error: "player_id requis" }, { status: 400 });

  const db = getDb();
  const existing = db.prepare(`SELECT player_id, status FROM grindhouse_grinders WHERE player_id = ?`).get(player_id) as any;

  if (existing && existing.status === "active") {
    return NextResponse.json({ error: "Déjà grinder actif" }, { status: 409 });
  }

  if (existing) {
    db.prepare(`UPDATE grindhouse_grinders SET status = 'active', joined_at = date('now') WHERE player_id = ?`).run(player_id);
  } else {
    db.prepare(`INSERT INTO grindhouse_grinders (player_id, deal_percentage) VALUES (?, ?)`).run(player_id, deal_percentage ?? 50);
  }

  const row = db.prepare(`
    SELECT gg.*, p.name, p.telegram_handle
    FROM grindhouse_grinders gg JOIN players p ON p.id = gg.player_id
    WHERE gg.player_id = ?
  `).get(player_id);

  return NextResponse.json(row, { status: 201 });
}
