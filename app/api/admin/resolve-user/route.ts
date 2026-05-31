import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  const provided = req.headers.get("x-admin-token");
  if (provided !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const username = req.nextUrl.searchParams.get("username");
  if (!username) return NextResponse.json({ error: "username param required" }, { status: 400 });

  try {
    const { TelegramClient } = await import("telegram");
    const { StringSession } = await import("telegram/sessions");

    const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "0");
    const apiHash = process.env.TELEGRAM_API_HASH ?? "";
    const session = process.env.TELEGRAM_SESSION ?? "";
    if (!apiId || !apiHash || !session) {
      return NextResponse.json({ error: "Userbot not configured" }, { status: 503 });
    }

    const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 3 });
    await client.connect();

    const entity = await client.getEntity(username.startsWith("@") ? username : `@${username}`) as any;
    const result = {
      id: Number(BigInt(entity.id)),
      username: entity.username ?? null,
      first_name: entity.firstName ?? null,
      last_name: entity.lastName ?? null,
      phone: entity.phone ?? null,
      bot: entity.bot ?? false,
      className: entity.className ?? null,
    };

    return NextResponse.json({ ok: true, user: result });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
