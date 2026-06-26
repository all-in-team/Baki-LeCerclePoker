import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { checkUserbotHealth } from "@/lib/telegram-userbot";
import { repairGroupTopics } from "@/lib/group-repair";

// Mass / targeted repair of player groups' forum topics.
//  - dry-run (default): lists active players whose group is set but some topic id is NULL.
//  - apply + confirm: repairs sequentially with a delay, session-checked, STOPS at first failure.
// apply / confirm / player_ids are accepted in the BODY *or* as query params (robust to either).
// Token-gated (x-admin-token === ADMIN_RECONCILE_TOKEN), like the other admin repair routes.

const TOPIC_COLS = [
  "alertes_topic_id", "onboarding_topic_id", "liveplay_topic_id",
  "accounting_topic_id", "deals_topic_id", "clubs_topic_id", "depot_topic_id",
];

const truthy = (v: unknown) => v === 1 || v === "1" || v === true || v === "true";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  if (req.headers.get("x-admin-token") !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const qp = req.nextUrl.searchParams;

  // apply / confirm — accepted from body OR query param
  const apply = truthy(body.apply) || truthy(qp.get("apply"));
  const confirm = body.confirm === true || truthy(qp.get("confirm"));
  const delayMs = Number(body.delay_ms) || 1500;

  // Targeted ids: body.player_ids [array] | body.player_id [single] | ?player_ids=45,130
  let ids: number[] = [];
  if (Array.isArray(body.player_ids)) ids.push(...body.player_ids.map(Number));
  if (body.player_id != null) ids.push(Number(body.player_id));
  const qIds = qp.get("player_ids") ?? qp.get("player_id");
  if (qIds) ids.push(...qIds.split(",").map(s => Number(s.trim())));
  ids = [...new Set(ids.filter(n => Number.isFinite(n)))];
  const targeted = ids.length > 0;

  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, name, telegram_group_id, ${TOPIC_COLS.join(", ")}
    FROM players
    WHERE status = 'active' AND telegram_group_id IS NOT NULL
      ${targeted ? `AND id IN (${placeholders})` : ""}
    ORDER BY id
  `).all(...(targeted ? ids : [])) as any[];

  const mapped = rows.map(p => ({ id: p.id, name: p.name, group: p.telegram_group_id, missing: TOPIC_COLS.filter(c => p[c] == null) }));
  // Targeted run → repair ALL requested players (also fixes stale ids / bot rights even if no NULL).
  // Mass run → only players that actually have a missing topic.
  const affected = targeted ? mapped : mapped.filter(p => p.missing.length > 0);
  const notFound = targeted ? ids.filter(id => !rows.some(r => r.id === id)) : [];

  // ── DRY-RUN (no userbot calls, pure DB) ──
  if (!apply) {
    return NextResponse.json({
      dry_run: true,
      targeted,
      requested_ids: targeted ? ids : undefined,
      not_found: notFound.length ? notFound : undefined,
      active_with_group: rows.length,
      needs_fix: affected.length,
      players: affected,
      hint: 'Repair: body {"apply":1,"confirm":true,"player_ids":[45,130]}  (or ?apply=1&confirm=true&player_ids=45,130)',
    });
  }

  if (!confirm) {
    return NextResponse.json({ error: "apply requires confirm:true (body) or ?confirm=true (query)" }, { status: 400 });
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
    targeted,
    requested_ids: targeted ? ids : undefined,
    not_found: notFound.length ? notFound : undefined,
    total_targeted: affected.length,
    processed: results.length,
    stopped_at: stoppedAt,
    results,
  });
}
