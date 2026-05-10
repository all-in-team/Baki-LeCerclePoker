export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listGroups, syncGroupStructure } from "@/lib/telegram-userbot";

const TOPIC_COLUMN_MAP: Record<string, string> = {
  accounting: "accounting_topic_id",
  deals: "deals_topic_id",
  clubs: "clubs_topic_id",
  depot: "depot_topic_id",
  liveplay: "liveplay_topic_id",
  onboarding: "onboarding_topic_id",
  alertes: "alertes_topic_id",
};

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  const provided = req.headers.get("x-admin-token");
  if (provided !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const singleChatId = body.chat_id ? Number(body.chat_id) : null;

  const db = getDb();
  const updatedPlayers = new Set<number>();
  const results: any[] = [];

  let targetGroups: { chat_id: string; title: string; member_count: number }[];

  if (singleChatId) {
    targetGroups = [{ chat_id: String(singleChatId), title: "", member_count: 0 }];
  } else {
    const groupList = await listGroups();
    if (!groupList.ok) {
      return NextResponse.json({ error: "Failed to list groups", detail: groupList.error }, { status: 500 });
    }
    targetGroups = groupList.groups.sort((a, b) => b.member_count - a.member_count);
  }

  for (const group of targetGroups) {
    const chatId = parseInt(group.chat_id);
    if (isNaN(chatId)) continue;

    console.log(`[SYNC] processing group ${group.chat_id} "${group.title}"`);

    const sync = await syncGroupStructure(chatId);

    // ── Match player from group title ──
    let matchedPlayer: string | null = null;
    const titleMatch = sync.title.match(/^(.+?)\s*x\s*LeCercle/i);

    if (titleMatch) {
      const extractedName = titleMatch[1].trim();

      // Exact match first, then starts-with fallback
      let candidates = db.prepare(
        `SELECT id, name FROM players WHERE LOWER(name) = LOWER(?) AND status IN ('active', 'signed')`
      ).all(extractedName) as { id: number; name: string }[];

      if (candidates.length === 0) {
        candidates = db.prepare(
          `SELECT id, name FROM players WHERE LOWER(name) LIKE LOWER(?) AND status IN ('active', 'signed') ORDER BY name`
        ).all(`${extractedName}%`) as { id: number; name: string }[];
      }

      if (candidates.length === 1 && !updatedPlayers.has(candidates[0].id)) {
        const player = candidates[0];
        matchedPlayer = player.name;

        // Build COALESCE update — only fill NULL fields
        const sets: string[] = [`telegram_group_id = COALESCE(telegram_group_id, ?)`];
        const values: any[] = [String(chatId)];

        for (const [key, col] of Object.entries(TOPIC_COLUMN_MAP)) {
          if (sync.topic_ids[key] != null) {
            sets.push(`${col} = COALESCE(${col}, ?)`);
            values.push(sync.topic_ids[key]);
          }
        }

        values.push(player.id);
        db.prepare(`UPDATE players SET ${sets.join(", ")} WHERE id = ?`).run(...values);
        updatedPlayers.add(player.id);
        console.log(`[SYNC] matched "${sync.title}" → ${player.name} (id=${player.id})`);
      } else if (candidates.length === 0) {
        console.log(`[SYNC] orphan group: "${sync.title}" — no player match for "${extractedName}"`);
      } else if (candidates.length > 1) {
        matchedPlayer = `ambiguous (${candidates.map(c => c.name).join(", ")})`;
        console.log(`[SYNC] ambiguous match: "${sync.title}" — ${candidates.length} candidates`);
      } else if (updatedPlayers.has(candidates[0].id)) {
        matchedPlayer = `${candidates[0].name} (already updated from larger group)`;
      }
    }

    results.push({
      chat_id: chatId,
      title: sync.title,
      matched_player: matchedPlayer,
      bot_invited: sync.bot_invited,
      bot_promoted: sync.bot_promoted,
      topics_created: sync.topics_created,
      topics_skipped: sync.topics_skipped,
      errors: sync.errors,
    });

    await new Promise(r => setTimeout(r, 500));
  }

  return NextResponse.json({
    ok: true,
    groups_processed: results.length,
    players_updated: updatedPlayers.size,
    results,
  });
}
