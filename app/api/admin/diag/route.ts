export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token || req.headers.get("x-admin-token") !== token)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();
  const schema = db.prepare(`PRAGMA table_info(weekly_settlements)`).all();
  const fixApplied = db.prepare(`SELECT name FROM _applied_fixes WHERE name = 'weekly_settlement_payment_v1'`).get();
  const sampleRow = db.prepare(`SELECT * FROM weekly_settlements LIMIT 1`).get();
  return NextResponse.json({ schema, fixApplied: !!fixApplied, sampleColumns: sampleRow ? Object.keys(sampleRow) : [] });
}
