import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { computeAgentCommission } from "@/lib/queries/affiliate";

// ── Configurable (env override; safe defaults, modifiable) ──
const TIER_SIZE_USDT = Number(process.env.AGENT_NOTIF_TIER_USDT ?? 500);     // notify every 500 USDT of gross agency profit
const THROTTLE_PER_DAY = Number(process.env.AGENT_NOTIF_THROTTLE_PER_DAY ?? 3);
const SEND_DELAY_MS = Number(process.env.AGENT_NOTIF_SEND_DELAY_MS ?? 1500);
const MAX_SENDS_PER_RUN = Number(process.env.AGENT_NOTIF_MAX_PER_RUN ?? 20);
const COMMISSION_RATE = 0.50;
const PORTAL_URL = "https://t.me/LeCercle_Lebot/portal"; // Direct Link → opens the Mini App in 1 tap

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const dashboardButton = { inline_keyboard: [[{ text: "🎰 Ouvre ton dashboard", url: PORTAL_URL }]] };

function tierMessage(cumul: number) {
  return `🔥 L'agence est à <b>+${cumul.toFixed(0)} USDT</b> sur tes filleuls → ta part : <b>${(cumul * COMMISSION_RATE).toFixed(0)} USDT</b> 💪`;
}

/**
 * Agent profit-tier notifications.
 * Trigger: an agent's GROSS agency cumul (computeAgentCommission.cumul_agence_eligible,
 * before ×50%, cross-makeup over all eligible filleuls/games) crosses a new 500-USDT tier.
 * Dedup PER TIER: action_ref = 'tier:<N>'. last_notified_tier = MAX recorded tier (dry_run=0)
 *   → notify only if current_tier > last. Anti-ping-pong: tiers already recorded never re-fire,
 *   and a drop-then-rise to the same tier is a no-op (current_tier <= last).
 * Dry-run by default (?apply=0): NEVER sends. ?apply=1 sends sequentially + delay (anti-FLOOD).
 * Throttle: max THROTTLE_PER_DAY real sends per agent per day. ?agent=<id> restricts to one agent.
 */
export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  if (req.headers.get("x-admin-token") !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apply = req.nextUrl.searchParams.get("apply") === "1";
  const onlyAgent = req.nextUrl.searchParams.get("agent");
  const qTier = Number(req.nextUrl.searchParams.get("tier"));
  const tierSize = Number.isFinite(qTier) && qTier > 0 ? qTier : TIER_SIZE_USDT;
  const db = getDb();

  const agents = db.prepare(`
    SELECT DISTINCT ar.affiliate_player_id AS agent_id, ap.name AS agent_name, ap.telegram_id AS agent_tg
    FROM affiliate_relationships ar JOIN players ap ON ap.id = ar.affiliate_player_id
    WHERE ar.status = 'active'
  `).all() as { agent_id: number; agent_name: string; agent_tg: number | null }[];

  const lastTierQ = db.prepare(`SELECT COALESCE(MAX(CAST(substr(action_ref, 6) AS REAL)), 0) AS last FROM agent_activity_notifs WHERE agent_player_id = ? AND action_type = 'profit_tier' AND dry_run = 0`);
  const alreadySent = db.prepare(`SELECT 1 FROM agent_activity_notifs WHERE agent_player_id = ? AND action_ref = ? AND dry_run = 0`);
  const sentTodayQ = db.prepare(`SELECT COUNT(*) AS n FROM agent_activity_notifs WHERE agent_player_id = ? AND dry_run = 0 AND date(notified_at) = date('now')`);
  // profit_tier is agent-level (no single filleul) → filleul_player_id = agent_player_id (FK-safe placeholder)
  const recordDry = db.prepare(`INSERT OR IGNORE INTO agent_activity_notifs (agent_player_id, filleul_player_id, action_type, action_ref, amount_usdt, dry_run) VALUES (?, ?, 'profit_tier', ?, ?, 1)`);
  const upsertSent = db.prepare(`INSERT INTO agent_activity_notifs (agent_player_id, filleul_player_id, action_type, action_ref, amount_usdt, dry_run, notified_at) VALUES (?, ?, 'profit_tier', ?, ?, 0, datetime('now')) ON CONFLICT(agent_player_id, action_ref) DO UPDATE SET dry_run = 0, notified_at = datetime('now')`);

  const wouldSend: any[] = [];
  const skipped: any[] = [];
  const runCount = new Map<number, number>();

  for (const a of agents) {
    if (onlyAgent && String(a.agent_id) !== onlyAgent) continue;

    // Cumul agence brute — SAME source as /crm/affiliates & /portal (guaranteed consistency)
    const ac = computeAgentCommission(a.agent_id);
    const cumul = ac.cumul_agence_eligible;
    const currentTier = cumul >= tierSize ? Math.floor(cumul / tierSize) * tierSize : 0;

    if (currentTier <= 0) { skipped.push({ agent: a.agent_name, cumul: round2(cumul), reason: "below_first_tier" }); continue; }

    const action_ref = `tier:${currentTier}`;
    const last = (lastTierQ.get(a.agent_id) as { last: number }).last;
    if (currentTier <= last) { skipped.push({ agent: a.agent_name, cumul: round2(cumul), tier: currentTier, last_notified_tier: last, reason: "already_notified_tier" }); continue; }
    if (alreadySent.get(a.agent_id, action_ref)) { skipped.push({ agent: a.agent_name, tier: currentTier, reason: "already_sent" }); continue; }
    if (!a.agent_tg) { skipped.push({ agent: a.agent_name, tier: currentTier, reason: "no_telegram_id" }); continue; }
    const todayN = (sentTodayQ.get(a.agent_id) as { n: number }).n + (runCount.get(a.agent_id) ?? 0);
    if (todayN >= THROTTLE_PER_DAY) { skipped.push({ agent: a.agent_name, tier: currentTier, reason: "throttled_daily_max" }); continue; }

    wouldSend.push({
      agent_id: a.agent_id, agent: a.agent_name, agent_tg: a.agent_tg, action: "profit_tier",
      cumul_agence: round2(cumul), your_share: round2(cumul * COMMISSION_RATE), tier: currentTier, action_ref,
      message_preview: tierMessage(cumul), button: "🎰 Ouvre ton dashboard → " + PORTAL_URL,
    });
    runCount.set(a.agent_id, (runCount.get(a.agent_id) ?? 0) + 1);
  }

  const config = { tier_size_usdt: tierSize, throttle_per_day: THROTTLE_PER_DAY, send_delay_ms: SEND_DELAY_MS, commission_rate: COMMISSION_RATE };

  if (!apply) {
    for (const w of wouldSend) recordDry.run(w.agent_id, w.agent_id, w.action_ref, w.cumul_agence);
    return NextResponse.json({
      mode: "dry_run", apply: false, config, scanned_agents: agents.length,
      would_send: wouldSend.length,
      breakdown: wouldSend.map(w => ({ agent: w.agent, tier: w.tier, cumul_agence: w.cumul_agence, your_share: w.your_share, message_preview: w.message_preview, button: w.button })),
      skipped,
    });
  }

  // APPLY=1 — real send, SEQUENTIAL + delay, with inline dashboard button
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return NextResponse.json({ error: "No bot token" }, { status: 503 });
  const sent: any[] = [];
  const failed: any[] = [];
  const toSend = wouldSend.slice(0, MAX_SENDS_PER_RUN);
  for (const w of toSend) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: w.agent_tg, text: w.message_preview, parse_mode: "HTML", reply_markup: dashboardButton }),
      });
      if (res.ok) { upsertSent.run(w.agent_id, w.agent_id, w.action_ref, w.cumul_agence); sent.push({ agent: w.agent, tier: w.tier, cumul_agence: w.cumul_agence }); }
      else { failed.push({ agent: w.agent, status: res.status, error: (await res.text().catch(() => "")).slice(0, 200) }); }
    } catch (e: any) { failed.push({ agent: w.agent, error: e.message }); }
    await sleep(SEND_DELAY_MS);
  }
  return NextResponse.json({ mode: "apply", apply: true, config, sent: sent.length, deferred_capped: wouldSend.length - toSend.length, sent_detail: sent, failed, skipped });
}

function round2(n: number) { return Math.round(n * 100) / 100; }
