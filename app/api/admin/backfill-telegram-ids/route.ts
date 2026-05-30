import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { resolveUsername, getChatMembers, getUserbotId } from "@/lib/telegram-userbot";

const OWNER_IDS = [1298290355, 1486389037];

interface BackfillResult {
  player_id: number;
  full_name: string;
  method: "handle" | "group_exclusion" | null;
  status: "backfilled" | "would_backfill" | "skipped";
  new_telegram_id?: number;
  reason?: string;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.key !== "db-diag-20260518") {
    return NextResponse.json({ error: "bad key" }, { status: 403 });
  }

  const apply = req.nextUrl.searchParams.get("apply") === "1";
  const db = getDb();

  const broken = db.prepare(`
    SELECT p.id, p.name, p.telegram_handle, p.telegram_group_id
    FROM players p
    JOIN affiliate_profiles ap ON ap.affiliate_player_id = p.id AND ap.status = 'active'
    WHERE p.telegram_id IS NULL
  `).all() as Array<{
    id: number;
    name: string;
    telegram_handle: string | null;
    telegram_group_id: string | null;
  }>;

  if (broken.length === 0) {
    return NextResponse.json({
      dry_run: !apply,
      summary: { total_broken: 0, would_backfill: 0, would_skip: 0 },
      results: [],
    });
  }

  const botUserId = await getUserbotId();
  const excludeIds = new Set([...OWNER_IDS, ...(botUserId ? [botUserId] : [])]);

  const results: BackfillResult[] = [];

  for (const player of broken) {
    const handle = player.telegram_handle;

    // Strategy 1: resolve via handle
    if (handle) {
      const resolved = await resolveUsername(handle);
      if (resolved) {
        if (apply) {
          db.prepare(`UPDATE players SET telegram_id = ? WHERE id = ? AND telegram_id IS NULL`).run(resolved, player.id);
        }
        results.push({
          player_id: player.id,
          full_name: player.name,
          method: "handle",
          status: apply ? "backfilled" : "would_backfill",
          new_telegram_id: resolved,
        });
        continue;
      }
    }

    // Strategy 2: group member exclusion
    if (player.telegram_group_id) {
      const members = await getChatMembers(player.telegram_group_id);
      const candidates = members.filter(m => !excludeIds.has(m.id) && !m.username?.toLowerCase().endsWith("bot"));
      if (candidates.length === 1) {
        const candidate = candidates[0];
        if (apply) {
          db.prepare(`UPDATE players SET telegram_id = ? WHERE id = ? AND telegram_id IS NULL`).run(candidate.id, player.id);
        }
        results.push({
          player_id: player.id,
          full_name: player.name,
          method: "group_exclusion",
          status: apply ? "backfilled" : "would_backfill",
          new_telegram_id: candidate.id,
        });
        continue;
      }

      results.push({
        player_id: player.id,
        full_name: player.name,
        method: null,
        status: "skipped",
        reason: candidates.length === 0
          ? "no candidates in group (empty or all excluded)"
          : `ambiguous (${candidates.length} candidates)`,
      });
      continue;
    }

    results.push({
      player_id: player.id,
      full_name: player.name,
      method: null,
      status: "skipped",
      reason: "no handle and no group_id",
    });
  }

  const wouldBackfill = results.filter(r => r.status === "backfilled" || r.status === "would_backfill").length;
  const wouldSkip = results.filter(r => r.status === "skipped").length;

  return NextResponse.json({
    dry_run: !apply,
    summary: { total_broken: broken.length, would_backfill: wouldBackfill, would_skip: wouldSkip },
    results,
  });
}
