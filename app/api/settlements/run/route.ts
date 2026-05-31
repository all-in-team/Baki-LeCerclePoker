import { NextResponse } from "next/server";
import { computeWeek } from "@/lib/settlement-engine";

export async function POST(req: Request) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });

  const provided = req.headers.get("x-admin-token");
  if (provided !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let weekOffset = -1;
  try {
    const body = await req.json().catch(() => ({}));
    if (body.week_offset !== undefined) weekOffset = Number(body.week_offset);
  } catch {}

  const result = computeWeek(weekOffset);
  return NextResponse.json({ ok: true, ...result });
}
