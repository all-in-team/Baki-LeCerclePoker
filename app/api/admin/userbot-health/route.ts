import { NextRequest, NextResponse } from "next/server";
import { checkUserbotHealth } from "@/lib/telegram-userbot";

export async function GET(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  const provided = req.headers.get("x-admin-token");
  if (provided !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const health = await checkUserbotHealth();
  return NextResponse.json(health);
}
