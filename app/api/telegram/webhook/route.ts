import { NextRequest, NextResponse } from "next/server";
import { upsertPlayerFromTelegram, insertCrmNote } from "@/lib/queries";

// Only groups whose title contains one of these strings (case-insensitive) trigger auto-add.
// Add more keywords to TELEGRAM_GROUP_KEYWORDS env var (comma-separated) to extend the list.
const KEYWORDS = (process.env.TELEGRAM_GROUP_KEYWORDS ?? "le cercle")
  .split(",")
  .map(k => k.trim().toLowerCase())
  .filter(Boolean);

function groupMatches(title: string): boolean {
  const t = title.toLowerCase();
  return KEYWORDS.some(k => t.includes(k));
}

export async function POST(req: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const incoming = req.headers.get("x-telegram-bot-api-secret-token");
    if (incoming !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const update = await req.json();
  const msg = update.message;
  if (!msg?.new_chat_members) return NextResponse.json({ ok: true });

  const chatTitle: string = msg.chat?.title ?? "";
  if (!groupMatches(chatTitle)) return NextResponse.json({ ok: true });

  for (const member of msg.new_chat_members as any[]) {
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

  return NextResponse.json({ ok: true });
}
