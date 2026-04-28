export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getPlayersOverLossThreshold, getSetting } from "@/lib/queries";

async function sendMsg(chatId: string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  return res.ok;
}

export async function GET(req: NextRequest) {
  const notify = req.nextUrl.searchParams.get("notify") === "true";
  const threshold = getSetting("alert_loss_threshold_usdt") ?? "-2000";
  const alerts = getPlayersOverLossThreshold();

  if (alerts.length > 0 && notify) {
    const chatId = process.env.TELEGRAM_OWNER_CHAT_ID ?? process.env.AGENT_TELEGRAM_CHAT_ID;
    if (chatId) {
      const lines = alerts.map(a =>
        `🔴 <b>${a.player_name}</b> : <b>${a.total_usdt.toFixed(2)} USDT</b>`
      );
      await sendMsg(chatId,
        `🚨 <b>Alerte P&L</b> — ${alerts.length} joueur(s) sous ${threshold} USDT\n\n${lines.join("\n")}`
      );
    }
  }

  return NextResponse.json({ threshold: parseFloat(threshold), alerts, count: alerts.length });
}
