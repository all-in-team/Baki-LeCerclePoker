import { NextRequest, NextResponse } from "next/server";
import { recreateTopics } from "@/lib/telegram-userbot";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  const provided = req.headers.get("x-admin-token");
  if (provided !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const chatId = body.chat_id;
  if (!chatId || typeof chatId !== "number") {
    return NextResponse.json({ error: "Missing or invalid chat_id (number)" }, { status: 400 });
  }

  const result = await recreateTopics(chatId);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
