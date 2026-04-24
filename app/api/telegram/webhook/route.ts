import { NextRequest, NextResponse } from "next/server";
import { upsertPlayerFromTelegram, insertCrmNote } from "@/lib/queries";

async function handleNewMembers(members: any[], chatTitle: string) {
  for (const member of members) {
    if (member.is_bot) continue;
    const name = [member.first_name, member.last_name].filter(Boolean).join(" ") || `TG#${member.id}`;
    const { id: playerId, isNew } = upsertPlayerFromTelegram({
      telegram_id: member.id,
      name,
      telegram_handle: member.username ?? null,
    });
    insertCrmNote({
      player_id: playerId,
      content: `${isNew ? "Créé automatiquement — a" : "A"} rejoint "${chatTitle}"`,
      type: "note",
    });
  }
}

export async function POST(req: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const incoming = req.headers.get("x-telegram-bot-api-secret-token");
    if (incoming !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const update = await req.json();

  // Classic group: message.new_chat_members
  const msg = update.message;
  if (msg?.new_chat_members) {
    await handleNewMembers(msg.new_chat_members, msg.chat?.title ?? "");
    return NextResponse.json({ ok: true });
  }

  // Newer API: chat_member update
  const cm = update.chat_member;
  if (cm?.new_chat_member?.status === "member" && !cm.new_chat_member.user?.is_bot) {
    await handleNewMembers([cm.new_chat_member.user], cm.chat?.title ?? "");
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
