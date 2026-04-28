export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getPlayerBalance } from "@/lib/queries";

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

function s(n: number) {
  return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(2);
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret") ?? req.headers.get("x-agent-report-secret");
  const expected = process.env.AGENT_REPORT_SECRET;
  if (expected && secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const playersWithChat = db.prepare(
    `SELECT id, name, telegram_chat_id FROM players WHERE telegram_chat_id IS NOT NULL AND status = 'active'`
  ).all() as { id: number; name: string; telegram_chat_id: string }[];

  const allBalances = getPlayerBalance();
  const balanceMap = new Map(allBalances.map(b => [b.player_id, b]));

  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const player of playersWithChat) {
    const bal = balanceMap.get(player.id);
    if (!bal || Math.abs(bal.total_usdt) < 0.01) {
      skipped++;
      continue;
    }

    const lines = bal.games
      .filter(g => Math.abs(g.net_usdt) >= 0.01)
      .map(g => {
        const emoji = g.net_usdt > 0.01 ? "🟢" : g.net_usdt < -0.01 ? "🔴" : "⚪";
        return `${emoji} <b>${g.game_name}</b> : <b>${s(g.net_usdt)} USDT</b>`;
      });

    if (lines.length === 0) { skipped++; continue; }

    const totalLine = lines.length > 1 ? `\n\n<b>Total : ${s(bal.total_usdt)} USDT</b>` : "";
    const text = `📊 <b>Récap hebdo — ${player.name}</b>\n\n${lines.join("\n")}${totalLine}`;

    const ok = await sendMsg(player.telegram_chat_id, text);
    if (ok) sent++;
    else errors.push(player.name);
  }

  // Notify operator of summary
  const operatorChatId = process.env.TELEGRAM_OWNER_CHAT_ID ?? process.env.AGENT_TELEGRAM_CHAT_ID;
  if (operatorChatId) {
    const errLine = errors.length > 0 ? `\n❌ Erreurs : ${errors.join(", ")}` : "";
    await sendMsg(operatorChatId,
      `📬 <b>Récap hebdo envoyé</b>\n✅ ${sent} joueur(s) · ⏭ ${skipped} sans solde${errLine}`
    );
  }

  return NextResponse.json({ ok: true, sent, skipped, errors });
}

export async function GET() {
  const db = getDb();
  const count = (db.prepare(
    `SELECT COUNT(*) AS n FROM players WHERE telegram_chat_id IS NOT NULL AND status = 'active'`
  ).get() as { n: number }).n;
  return NextResponse.json({
    status: "weekly-summary endpoint live",
    eligible_players: count,
    trigger: "Railway Cron Job — POST with x-cron-secret header",
    schedule: "Every Sunday 20:00 Europe/Paris",
  });
}
