import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { checkUserbotHealth } from "@/lib/telegram-userbot";
import { repairGroupTopics } from "@/lib/group-repair";

// Mass repair of player groups' forum topics.
//  - dry-run (default / apply != 1): lists active players whose group is set but some topic id is NULL.
//  - apply=1 (+ confirm:true): repairs sequentially with a delay, session-checked, STOPS at first failure.
// Token-gated (x-admin-token === ADMIN_RECONCILE_TOKEN), like the other admin repair routes.

const TOPIC_COLS = [
  "alertes_topic_id", "onboarding_topic_id", "liveplay_topic_id",
  "accounting_topic_id", "deals_topic_id", "clubs_topic_id", "depot_topic_id",
];

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  if (req.headers.get("x-admin-token") !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const apply = body.apply === 1 || body.apply === "1" || body.apply === true;
  const singlePid = body.player_id ? Number(body.player_id) : null;
  const delayMs = Number(body.delay_ms) || 1500;

  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, telegram_group_id, ${TOPIC_COLS.join(", ")}
    FROM players
    WHERE status = 'active' AND telegram_group_id IS NOT NULL
      ${singlePid ? "AND id = @pid" : ""}
    ORDER BY id
  `).all(singlePid ? { pid: singlePid } : {}) as any[];

  const affected = rows
    .map(p => ({ id: p.id, name: p.name, group: p.telegram_group_id, missing: TOPIC_COLS.filter(c => p[c] == null) }))
    .filter(p => p.missing.length > 0);

  // ── DRY-RUN (no userbot calls, pure DB) ──
  if (!apply) {
    return NextResponse.json({
      dry_run: true,
      active_with_group: rows.length,
      needs_fix: affected.length,
      players: affected,
      hint: "Re-run with {\"apply\":1,\"confirm\":true} to repair (sequential, stops at first failure).",
    });
  }

  if (body.confirm !== true) {
    return NextResponse.json({ error: "apply=1 requires confirm:true in the body" }, { status: 400 });
  }

  // ── APPLY ── session check ONCE before touching the userbot
  const health = await checkUserbotHealth();
  if (!health.session_valid) {
    return NextResponse.json({ error: "Userbot session invalid — aborting before any change", detail: health.error }, { status: 503 });
  }

  const results: any[] = [];
  let stoppedAt: number | null = null;
  for (const p of affected) {
    const chatId = parseInt(p.group);
    if (isNaN(chatId)) { results.push({ id: p.id, name: p.name, ok: false, error: `invalid group ${p.group}` }); stoppedAt = p.id; break; }

    const r = await repairGroupTopics(chatId, p.id);
    results.push({ id: p.id, name: p.name, ok: r.ok, sessionOk: r.sessionOk, botPromoted: r.botPromoted, topicsCreated: r.topicsCreated, stillMissing: r.topicsMissing, errors: r.errors });

    if (!r.ok) { stoppedAt = p.id; break; }            // stop at first failure
    await new Promise(res => setTimeout(res, delayMs)); // anti-burst between groups
  }

  return NextResponse.json({
    applied: true,
    total_needing_fix: affected.length,
    processed: results.length,
    stopped_at: stoppedAt,
    results,
  });
}
