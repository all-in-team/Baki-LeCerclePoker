import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(req: NextRequest) {
  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");
  const type = req.nextUrl.searchParams.get("type");
  const playerId = req.nextUrl.searchParams.get("player_id");
  const db = getDb();

  const conditions = ["1=1"];
  const params: Record<string, unknown> = {};
  if (from) { conditions.push("ge.date >= @from"); params.from = from; }
  if (to) { conditions.push("ge.date <= @to"); params.to = to; }
  if (type) { conditions.push("ge.type = @type"); params.type = type; }
  if (playerId) { conditions.push("ge.player_id = @player_id"); params.player_id = Number(playerId); }

  return NextResponse.json(db.prepare(`
    SELECT ge.*, p.name AS player_name
    FROM grindhouse_expenses ge LEFT JOIN players p ON p.id = ge.player_id
    WHERE ${conditions.join(" AND ")} ORDER BY ge.date DESC, ge.created_at DESC
  `).all(params));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { date, amount_usdt, type, player_id, description } = body;
  if (!amount_usdt || !type) return NextResponse.json({ error: "amount_usdt + type requis" }, { status: 400 });

  const db = getDb();
  const r = db.prepare(`INSERT INTO grindhouse_expenses (date, amount_usdt, type, player_id, description) VALUES (?, ?, ?, ?, ?)`)
    .run(date ?? new Date().toISOString().slice(0, 10), amount_usdt, type, player_id ?? null, description ?? null);

  const row = db.prepare(`SELECT ge.*, p.name AS player_name FROM grindhouse_expenses ge LEFT JOIN players p ON p.id = ge.player_id WHERE ge.id = ?`).get(Number(r.lastInsertRowid));
  return NextResponse.json(row, { status: 201 });
}
