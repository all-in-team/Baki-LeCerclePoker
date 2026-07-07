import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

const GAME_CURRENCY: Record<string, string> = { akpoker: "USDT", wepoker: "CNY", kkpoker: "USDT", a5poker: "USDT", aks: "USDT", nutspk: "USDT", okpoker: "USDT", jvip: "USDT" };

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const gameKey = sp.get("game_key");
  if (!gameKey || !GAME_CURRENCY[gameKey]) {
    return NextResponse.json({ error: "game_key must be 'akpoker' or 'wepoker'" }, { status: 400 });
  }

  const from = sp.get("from");
  const to = sp.get("to");

  let sql = `SELECT * FROM agency_extras WHERE game_key = ? AND deleted_at IS NULL`;
  const params: any[] = [gameKey];

  if (from) { sql += ` AND recorded_at >= ?`; params.push(from); }
  if (to) { sql += ` AND recorded_at <= ?`; params.push(to); }
  sql += ` ORDER BY recorded_at DESC`;

  const rows = getDb().prepare(sql).all(...params);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { game_key, type, amount, description, notes, recorded_by } = body;

  if (!game_key || !GAME_CURRENCY[game_key]) {
    return NextResponse.json({ error: "game_key must be 'akpoker' or 'wepoker'" }, { status: 400 });
  }
  if (!type || !["win", "fee"].includes(type)) {
    return NextResponse.json({ error: "type must be 'win' or 'fee'" }, { status: 400 });
  }
  if (typeof amount !== "number" || amount <= 0) {
    return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
  }

  const currency = GAME_CURRENCY[game_key];
  const result = getDb().prepare(`
    INSERT INTO agency_extras (game_key, type, amount, currency, description, recorded_by, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(game_key, type, amount, currency, description ?? null, recorded_by ?? null, notes ?? null);

  const row = getDb().prepare(`SELECT * FROM agency_extras WHERE id = ?`).get(result.lastInsertRowid);
  return NextResponse.json(row, { status: 201 });
}
