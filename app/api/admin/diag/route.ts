export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token || req.headers.get("x-admin-token") !== token)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();
  const r: Record<string, any> = {};
  r.ae_count = (db.prepare(`SELECT COUNT(*) AS n FROM accounting_entries`).get() as any).n;
  r.ae_range = db.prepare(`SELECT MIN(period_start) AS min_d, MAX(period_end) AS max_d FROM accounting_entries`).get();
  r.ae_sample = db.prepare(`SELECT * FROM accounting_entries ORDER BY id DESC LIMIT 3`).all();
  r.rr_count = (db.prepare(`SELECT COUNT(*) AS n FROM rakeback_reports`).get() as any).n;
  r.rr_range = db.prepare(`SELECT MIN(COALESCE(report_date, substr(created_at,1,10))) AS min_d, MAX(COALESCE(report_date, substr(created_at,1,10))) AS max_d FROM rakeback_reports`).get();
  r.re_count = (db.prepare(`SELECT COUNT(*) AS n FROM rakeback_entries`).get() as any).n;
  r.re_sample = db.prepare(`SELECT re.*, rr.game_id, g.name AS game_name FROM rakeback_entries re JOIN rakeback_reports rr ON rr.id = re.report_id JOIN games g ON g.id = rr.game_id ORDER BY re.id DESC LIMIT 5`).all();
  r.reports_count = (db.prepare(`SELECT COUNT(*) AS n FROM reports`).get() as any).n;
  r.wt_count = (db.prepare(`SELECT COUNT(*) AS n FROM wallet_transactions`).get() as any).n;
  r.wt_range = db.prepare(`SELECT MIN(tx_datetime) AS min_d, MAX(tx_datetime) AS max_d FROM wallet_transactions`).get();
  r.re_currencies = db.prepare(`SELECT currency, COUNT(*) AS n FROM rakeback_entries GROUP BY currency`).all();
  r.re_games = db.prepare(`SELECT g.name, COUNT(*) AS n FROM rakeback_entries re JOIN rakeback_reports rr ON rr.id=re.report_id JOIN games g ON g.id=rr.game_id GROUP BY g.id`).all();
  return NextResponse.json(r);
}
