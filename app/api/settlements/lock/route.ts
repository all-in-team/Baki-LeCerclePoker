import { NextResponse } from "next/server";
import { lockWeek } from "@/lib/settlement-engine";

export async function POST(req: Request) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  const provided = req.headers.get("x-admin-token");
  if (provided !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { week_start } = body;
  if (!week_start) return NextResponse.json({ error: "Missing week_start" }, { status: 400 });

  const result = lockWeek(week_start);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}
