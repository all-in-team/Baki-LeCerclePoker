import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN env var is not set on the server" }, { status: 503 });
  }
  const provided = req.headers.get("x-admin-token");
  if (provided !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  if (body.confirm !== "DELETE_PHANTOM_ROWS") {
    return NextResponse.json(
      { error: 'Missing or incorrect confirmation. Send { "confirm": "DELETE_PHANTOM_ROWS" } in the body.' },
      { status: 400 }
    );
  }

  const db = getDb();

  const phantomIds = db.prepare(
    `SELECT id FROM wallet_transactions WHERE source = 'unknown'`
  ).all() as { id: number }[];

  const ids = phantomIds.map(r => r.id);
  const count = ids.length;

  if (count === 0) {
    return NextResponse.json({ deleted: 0, remaining_phantom: 0, message: "No phantom rows to delete." });
  }

  console.log(`[${new Date().toISOString()}] DELETE phantom wallet_transactions: count=${count}, ids=[${ids.join(",")}]`);

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM wallet_transactions WHERE source = 'unknown'`).run();
  });
  tx();

  const remaining = (db.prepare(
    `SELECT COUNT(*) AS c FROM wallet_transactions WHERE source = 'unknown'`
  ).get() as { c: number }).c;

  return NextResponse.json({ deleted: count, remaining_phantom: remaining });
}
