import { NextRequest, NextResponse } from "next/server";
import { runChat } from "@/lib/agent-chat";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const MORNING_PROMPT = `[SYSTEM TRIGGER — c'est l'heure du check-in matinal]

Bonjour. C'est l'agent infrastructure qui te réveille pour ton briefing.

Ta mission ce matin : produire UN message court (5-10 lignes max) destiné à l'opérateur dans le groupe Telegram. Pas plus, pas moins.

Étapes :
1. Regarde l'état du système (déjà injecté plus haut : P&L, dépôts, retraits, dernière sync, inbox).
2. Appelle get_inbox_messages() pour voir ce qui traîne dans l'inbox depuis hier.
3. Appelle list_doer_sessions(limit=3) pour voir les PRs récentes ouvertes par le doer.
4. Appelle get_pnl(period="yesterday") pour comparer.

Puis choisis UNE seule chose à mettre en avant :
- Soit une question pointue ("hier P&L à -2k, tu veux qu'on creuse ?")
- Soit un nudge ("la PR #3 du doer attend ton review depuis 2 jours")
- Soit une action ("le inbox a 3 messages dont 'fix /finance', je dispatch ?")
- Soit un bilan ("3 PRs mergées hier, tout est clean, bonne journée")

Style : direct, court, en français, ton de coworker. Pas d'emojis sauf 1 si vraiment utile. Format Telegram HTML (<b>, <i>, <code>). Ne salue pas, va direct au point.

Si rien ne mérite d'être remonté, dis-le platement : "RAS aujourd'hui, le système tourne." (1 ligne).`;

function authorize(req: NextRequest): boolean {
  const expected = process.env.AGENT_REPORT_SECRET;
  if (!expected) return false;
  const got = req.headers.get("x-agent-report-secret");
  return got === expected;
}

export async function POST(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const chatId = process.env.AGENT_TELEGRAM_CHAT_ID ?? "-4846690641";

  try {
    // runChat handles: snapshot injection, tool use, history, posting reply
    const reply = await runChat({ chatId, userText: MORNING_PROMPT });

    // Send the reply directly via Telegram (runChat saves to history but doesn't send)
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (token) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `<b>☀️ Check-in matinal</b>\n\n${reply}`,
          parse_mode: "HTML",
        }),
      });
    }

    return NextResponse.json({ ok: true, posted: true });
  } catch (e: any) {
    console.error("[morning-checkin]", e);
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function GET() {
  // Health check + show last few morning messages from the conversation table
  const recent = getDb().prepare(
    `SELECT created_at, role, substr(content, 1, 80) AS preview
     FROM agent_conversations
     ORDER BY id DESC LIMIT 6`
  ).all();
  return NextResponse.json({
    status: "morning-checkin endpoint live",
    next_run: "Daily 09:00 Asia/Shanghai (01:00 UTC) — schedule via Anthropic RemoteTrigger",
    recent_conversation: recent,
  });
}
