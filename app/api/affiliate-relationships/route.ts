import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { computeAffiliateCommission } from "@/lib/queries/affiliate";

export async function GET(req: NextRequest) {
  const db = getDb();
  const status = req.nextUrl.searchParams.get("status");
  let where = "";
  const params: any[] = [];
  if (status) { where = "WHERE ar.status = ?"; params.push(status); }

  const rows = db.prepare(`
    SELECT ar.*,
      a.name AS affiliate_name, a.telegram_handle AS affiliate_handle,
      r.name AS referred_name, r.telegram_handle AS referred_handle,
      g.name AS origin_game_name
    FROM affiliate_relationships ar
    JOIN players a ON a.id = ar.affiliate_player_id
    JOIN players r ON r.id = ar.referred_player_id
    LEFT JOIN games g ON g.id = ar.origin_game_id
    ${where}
    ORDER BY ar.created_at DESC
  `).all(...params) as any[];

  const paymentsStmt = db.prepare(`
    SELECT ap.paid_at, ap.amount_usdt, ap.game_id, g.name AS game_name, ap.tx_hash, ap.week_start_date, ap.week_end_date, ap.notes
    FROM affiliate_payments ap
    LEFT JOIN games g ON g.id = ap.game_id
    WHERE ap.relationship_id = ?
    ORDER BY ap.paid_at DESC
  `);

  return NextResponse.json(rows.map(r => {
    const commission = computeAffiliateCommission(r.id);
    const payments = paymentsStmt.all(r.id);
    return {
      id: r.id,
      affiliate: { id: r.affiliate_player_id, name: r.affiliate_name, telegram_handle: r.affiliate_handle },
      referred: { id: r.referred_player_id, name: r.referred_name, telegram_handle: r.referred_handle },
      origin_game: { id: r.origin_game_id, name: r.origin_game_name },
      start_date: r.start_date,
      status: r.status,
      disclosed_action_pct: r.disclosed_action_pct,
      disclosed_rakeback_pct: r.disclosed_rakeback_pct,
      disclosed_insurance_pct: r.disclosed_insurance_pct,
      exclude_agency_extras: r.exclude_agency_extras,
      notes: r.notes,
      created_at: r.created_at,
      games: commission?.breakdown ?? [],
      total_due_now: commission?.total_due_now ?? 0,
      total_paid_lifetime: commission?.total_paid_lifetime ?? 0,
      last_paid_at: commission?.last_paid_at ?? null,
      payments,
    };
  }));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { affiliate_player_id, referred_player_id, origin_game_id } = body;

  if (!affiliate_player_id || !referred_player_id)
    return NextResponse.json({ error: "affiliate_player_id, referred_player_id requis" }, { status: 400 });

  if (affiliate_player_id === referred_player_id)
    return NextResponse.json({ error: "Un joueur ne peut pas être son propre affiliate" }, { status: 400 });

  const db = getDb();

  if (origin_game_id) {
    const game = db.prepare(`SELECT id FROM games WHERE id = ? AND status = 'active'`).get(origin_game_id);
    if (!game) return NextResponse.json({ error: "Game introuvable ou archivée" }, { status: 400 });
  }

  try {
    const r = db.prepare(`
      INSERT INTO affiliate_relationships (affiliate_player_id, referred_player_id, origin_game_id, start_date, disclosed_action_pct, disclosed_rakeback_pct, disclosed_insurance_pct, exclude_agency_extras, notes)
      VALUES (@affiliate_player_id, @referred_player_id, @origin_game_id, @start_date, @disclosed_action_pct, @disclosed_rakeback_pct, @disclosed_insurance_pct, @exclude_agency_extras, @notes)
    `).run({
      affiliate_player_id,
      referred_player_id,
      origin_game_id: origin_game_id ?? null,
      start_date: body.start_date || new Date().toISOString().slice(0, 10),
      disclosed_action_pct: body.disclosed_action_pct ?? null,
      disclosed_rakeback_pct: body.disclosed_rakeback_pct ?? null,
      disclosed_insurance_pct: body.disclosed_insurance_pct ?? null,
      exclude_agency_extras: body.exclude_agency_extras ?? 1,
      notes: body.notes ?? null,
    });
    return NextResponse.json({ ok: true, id: Number(r.lastInsertRowid) }, { status: 201 });
  } catch (e: any) {
    if (e.message?.includes("UNIQUE constraint failed"))
      return NextResponse.json({ error: "Ce joueur a déjà un affiliate assigné" }, { status: 409 });
    throw e;
  }
}
