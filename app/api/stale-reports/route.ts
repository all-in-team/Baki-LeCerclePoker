export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getStaleReports } from "@/lib/queries";

export async function GET(req: NextRequest) {
  const days = Number(req.nextUrl.searchParams.get("days") ?? "7");
  const stale = getStaleReports(days);

  if (stale.length > 0 && req.nextUrl.searchParams.get("notify") === "true") {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_OWNER_CHAT_ID ?? process.env.AGENT_TELEGRAM_CHAT_ID;
    if (token && chatId) {
      const lines = stale.map(g => {
        const ago = g.days_since_report != null ? `${g.days_since_report}j` : "jamais";
        return `• <b>${g.game_name}</b> — dernier rapport : ${ago} (${g.active_player_count} joueurs actifs)`;
      });
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `📋 <b>Rapports manquants</b>\n\n${lines.join("\n")}\n\n<i>Upload un rapport sur /reports pour corriger.</i>`,
          parse_mode: "HTML",
        }),
      });
    }
  }

  return NextResponse.json({ stale, count: stale.length });
}
