import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

function computeSettlement(db: any, playerId: number, from: string, to: string) {
  const sessionsPnl = (db.prepare(`
    SELECT COALESCE(SUM(net_result_usdt), 0) AS total
    FROM grindhouse_sessions WHERE player_id = ? AND session_date >= ? AND session_date <= ?
  `).get(playerId, from, to) as { total: number }).total;

  const grindFees = (db.prepare(`
    SELECT COALESCE(SUM(amount_usdt), 0) AS total
    FROM grindhouse_expenses WHERE player_id = ? AND type = 'grind' AND date >= ? AND date <= ?
  `).get(playerId, from, to) as { total: number }).total;

  const sessionsCount = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM grindhouse_sessions WHERE player_id = ? AND session_date >= ? AND session_date <= ?
  `).get(playerId, from, to) as { cnt: number }).cnt;

  const totalHours = (db.prepare(`
    SELECT COALESCE(SUM(duration_hours), 0) AS total
    FROM grindhouse_sessions WHERE player_id = ? AND session_date >= ? AND session_date <= ?
  `).get(playerId, from, to) as { total: number }).total;

  const poolNet = sessionsPnl - grindFees;
  const grinderShare = poolNet * 0.5;

  return { sessions_pnl: sessionsPnl, attributed_grind_fees: grindFees, pool_net: poolNet, grinder_share: grinderShare, sessions_count: sessionsCount, total_hours: totalHours };
}

export async function GET(req: NextRequest) {
  const db = getDb();
  const preview = req.nextUrl.searchParams.get("preview") === "1";
  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");
  const playerId = req.nextUrl.searchParams.get("player_id");

  if (preview && from && to) {
    if (playerId) {
      const player = db.prepare(`SELECT id, name FROM players WHERE id = ?`).get(Number(playerId)) as any;
      if (!player) return NextResponse.json({ error: "Player not found" }, { status: 404 });
      return NextResponse.json({ player_id: player.id, player_name: player.name, period_start: from, period_end: to, ...computeSettlement(db, player.id, from, to) });
    }
    const grinders = db.prepare(`SELECT gg.player_id, p.name FROM grindhouse_grinders gg JOIN players p ON p.id = gg.player_id WHERE gg.status = 'active'`).all() as any[];
    return NextResponse.json(grinders.map(g => ({ player_id: g.player_id, player_name: g.name, period_start: from, period_end: to, ...computeSettlement(db, g.player_id, from, to) })));
  }

  const conditions = ["1=1"];
  const params: Record<string, unknown> = {};
  if (from) { conditions.push("gs.period_start >= @from"); params.from = from; }
  if (to) { conditions.push("gs.period_end <= @to"); params.to = to; }
  if (playerId) { conditions.push("gs.player_id = @player_id"); params.player_id = Number(playerId); }

  return NextResponse.json(db.prepare(`
    SELECT gs.*, p.name AS player_name FROM grindhouse_settlements gs JOIN players p ON p.id = gs.player_id
    WHERE ${conditions.join(" AND ")} ORDER BY gs.created_at DESC
  `).all(params));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { player_id, period_start, period_end } = body;
  if (!player_id || !period_start || !period_end) return NextResponse.json({ error: "player_id, period_start, period_end requis" }, { status: 400 });

  const db = getDb();
  const calc = computeSettlement(db, player_id, period_start, period_end);

  const r = db.prepare(`
    INSERT INTO grindhouse_settlements (player_id, period_start, period_end, sessions_pnl, attributed_grind_fees, pool_net, grinder_share, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(player_id, period_start, period_end, calc.sessions_pnl, calc.attributed_grind_fees, calc.pool_net, calc.grinder_share);

  return NextResponse.json({ ok: true, id: Number(r.lastInsertRowid), ...calc }, { status: 201 });
}
