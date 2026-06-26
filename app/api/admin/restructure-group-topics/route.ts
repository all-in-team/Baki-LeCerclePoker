import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { checkUserbotHealth, getGroupTopicsState, restructureGroupTopics } from "@/lib/telegram-userbot";

// Phase B/C: restructure EXISTING player groups' topics.
//   delete Deals + Clubs (irreversible) · close Alertes + Dépôt + Liveplay (read-only for members).
//   Accounting + Onboarding stay open. Bot is (re)promoted admin BEFORE closing.
// dry-run (default): per group, lists what WOULD be deleted / closed (read-only GetForumTopics).
// apply (+confirm): sequential, delay between groups, session-checked, STOPS at first failure, idempotent.
// Token-gated (x-admin-token === ADMIN_RECONCILE_TOKEN).

const DELETE_TITLES = ["Deals", "Clubs"];
const CLOSE_TITLES = ["Alertes", "Dépôt", "Liveplay"];
const truthy = (v: unknown) => v === 1 || v === "1" || v === true || v === "true";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  if (req.headers.get("x-admin-token") !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const qp = req.nextUrl.searchParams;
  const apply = truthy(body.apply) || truthy(qp.get("apply"));
  const confirm = body.confirm === true || truthy(qp.get("confirm"));
  const delayMs = Number(body.delay_ms) || 1500;

  // Targeted ids: body.player_ids[] | body.player_id | ?player_ids=53
  let ids: number[] = [];
  if (Array.isArray(body.player_ids)) ids.push(...body.player_ids.map(Number));
  if (body.player_id != null) ids.push(Number(body.player_id));
  const qIds = qp.get("player_ids") ?? qp.get("player_id");
  if (qIds) ids.push(...qIds.split(",").map(s => Number(s.trim())));
  ids = [...new Set(ids.filter(n => Number.isFinite(n)))];
  const targeted = ids.length > 0;

  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const players = db.prepare(`
    SELECT id, name, telegram_group_id
    FROM players
    WHERE telegram_group_id IS NOT NULL
      ${targeted ? `AND id IN (${placeholders})` : ""}
    ORDER BY id
  `).all(...(targeted ? ids : [])) as { id: number; name: string; telegram_group_id: string }[];
  const notFound = targeted ? ids.filter(id => !players.some(p => p.id === id)) : [];

  // Both dry-run and apply hit the userbot → session must be alive.
  const health = await checkUserbotHealth();
  if (!health.session_valid) {
    return NextResponse.json({ error: "Userbot session invalid — aborting", detail: health.error }, { status: 503 });
  }

  // ── DRY-RUN (read-only GetForumTopics per group) ──
  if (!apply) {
    const plan: any[] = [];
    for (const p of players) {
      const chatId = parseInt(p.telegram_group_id);
      const snap = await getGroupTopicsState(chatId);
      if (!snap.ok) { plan.push({ id: p.id, name: p.name, group: p.telegram_group_id, error: snap.error }); continue; }
      const present = new Map(snap.topics.map(t => [t.title.toLowerCase(), t]));
      const would_delete = DELETE_TITLES.filter(t => present.has(t.toLowerCase()));
      const would_close = CLOSE_TITLES.filter(t => { const x = present.get(t.toLowerCase()); return x && !x.closed; });
      const already = [
        ...DELETE_TITLES.filter(t => !present.has(t.toLowerCase())).map(t => `${t}:absent`),
        ...CLOSE_TITLES.filter(t => { const x = present.get(t.toLowerCase()); return x && x.closed; }).map(t => `${t}:closed`),
      ];
      plan.push({ id: p.id, name: p.name, group: p.telegram_group_id, would_delete, would_close, already });
      await new Promise(r => setTimeout(r, 400));
    }
    return NextResponse.json({
      dry_run: true, targeted, requested_ids: targeted ? ids : undefined, not_found: notFound.length ? notFound : undefined,
      groups: plan.length, plan,
      hint: 'Apply: {"apply":1,"confirm":true,"player_ids":[53]}',
    });
  }

  if (!confirm) return NextResponse.json({ error: "apply requires confirm:true" }, { status: 400 });

  // ── APPLY ── sequential, stop at first failure
  const results: any[] = [];
  let stoppedAt: number | null = null;
  for (const p of players) {
    const chatId = parseInt(p.telegram_group_id);
    if (isNaN(chatId)) { results.push({ id: p.id, name: p.name, ok: false, error: `invalid group ${p.telegram_group_id}` }); stoppedAt = p.id; break; }

    const r = await restructureGroupTopics(chatId);

    // NULL the now-deleted topic columns (idempotent cleanup) when the group was processed without errors.
    if (r.ok) {
      db.prepare(`UPDATE players SET deals_topic_id = NULL, clubs_topic_id = NULL WHERE id = ?`).run(p.id);
    }

    results.push({ id: p.id, name: p.name, ok: r.ok, botPromoted: r.botPromoted, deleted: r.deleted, closed: r.closed, skipped: r.skipped, errors: r.errors });
    if (!r.ok) { stoppedAt = p.id; break; }
    await new Promise(res => setTimeout(res, delayMs));
  }

  return NextResponse.json({
    applied: true, targeted, requested_ids: targeted ? ids : undefined, not_found: notFound.length ? notFound : undefined,
    total: players.length, processed: results.length, stopped_at: stoppedAt, results,
  });
}
