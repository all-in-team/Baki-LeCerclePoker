export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";

const LECERCLE_TOPIC_NAMES = new Set(
  ["accounting", "deals", "clubs", "dépôt", "liveplay", "onboarding", "alertes"]
);

const TOPIC_DELETE_GROUPS = [
  -1002367502109, // Road To - 1 000$/h
  -1003969189995, // Short deck telegram
];

const ALL_LEAVE_GROUPS = [
  -1001799258800, -1001910875787, -1001921426535, -1001957728743,
  -1002067199100, -1002373504174, -1002387173024, -1002441461111,
  -1002475739552, -1002494086185, -1003629977322, -1003794808536,
  -1001667479412, -1002367502109, -1003969189995,
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  if (req.headers.get("x-admin-token") !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return NextResponse.json({ error: "No bot token" }, { status: 503 });

  const results: any[] = [];

  // ── Step B: Delete LeCercle topics in promoted groups via userbot ──
  const { TelegramClient, Api } = await import("telegram");
  const { StringSession } = await import("telegram/sessions");

  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "0");
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  const session = process.env.TELEGRAM_SESSION ?? "";

  let client: InstanceType<typeof TelegramClient> | null = null;
  if (apiId && apiHash && session) {
    client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 3 });
    await client.connect();
  }

  for (const chatId of TOPIC_DELETE_GROUPS) {
    const groupResult: any = { chat_id: chatId, phase: "topic_cleanup", topics_found: [], topics_deleted: [], errors: [] };

    if (!client) {
      groupResult.errors.push("Userbot not available");
      results.push(groupResult);
      continue;
    }

    try {
      const channelId = -(chatId + 1000000000000);
      const channelPeer = await client.getInputEntity(
        new Api.PeerChannel({ channelId: BigInt(channelId) as any })
      ) as any;

      const topicsResult = await client.invoke(
        new Api.channels.GetForumTopics({
          channel: channelPeer,
          offsetDate: 0, offsetId: 0, offsetTopic: 0, limit: 100,
        })
      );

      const topics = ((topicsResult as any).topics ?? []) as any[];

      for (const t of topics) {
        const title = t.title ?? "";
        const topicId = Number(BigInt(t.id));
        groupResult.topics_found.push({ id: topicId, title });

        if (LECERCLE_TOPIC_NAMES.has(title.toLowerCase())) {
          try {
            await client.invoke(
              new Api.channels.DeleteTopicHistory({
                channel: channelPeer,
                topMsgId: topicId,
              })
            );
            groupResult.topics_deleted.push(title);
            console.log(`[CLEANUP] deleted topic "${title}" (id=${topicId}) from ${chatId}`);
          } catch (e: any) {
            groupResult.errors.push(`delete ${title}: ${e.message ?? String(e)}`);
          }
          await sleep(300);
        }
      }
    } catch (e: any) {
      groupResult.errors.push(`GetForumTopics: ${e.message ?? String(e)}`);
    }

    results.push(groupResult);
    await sleep(500);
  }

  // ── Step A: Bot leaves all 15 external groups ──
  for (const chatId of ALL_LEAVE_GROUPS) {
    const leaveResult: any = { chat_id: chatId, phase: "bot_leave", ok: false, error: null };

    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/leaveChat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId }),
      });
      const data = await res.json();
      leaveResult.ok = data.ok ?? false;
      if (!data.ok) leaveResult.error = data.description ?? "unknown";
      console.log(`[CLEANUP] bot leaveChat ${chatId}: ${data.ok ? "OK" : data.description}`);
    } catch (e: any) {
      leaveResult.error = e.message ?? String(e);
    }

    results.push(leaveResult);
    await sleep(200);
  }

  return NextResponse.json({ ok: true, results });
}
