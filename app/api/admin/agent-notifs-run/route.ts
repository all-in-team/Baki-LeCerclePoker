import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { computeAgentCommission } from "@/lib/queries/affiliate";

// ── Configurable (env override; safe defaults, modifiable) ──
const TIER_SIZE_USDT = Number(process.env.AGENT_NOTIF_TIER_USDT ?? 500);     // profit-tier step
const THROTTLE_PER_DAY = Number(process.env.AGENT_NOTIF_THROTTLE_PER_DAY ?? 3);
const SEND_DELAY_MS = Number(process.env.AGENT_NOTIF_SEND_DELAY_MS ?? 1500);
const MAX_SENDS_PER_RUN = Number(process.env.AGENT_NOTIF_MAX_PER_RUN ?? 20);
const NOTONB_MIN_AGE_DAYS = Number(process.env.AGENT_NOTIF_NOTONB_AGE_DAYS ?? 2); // grace period before "not onboarded" fires
const COMMISSION_RATE = 0.50;
const PORTAL_URL = "https://t.me/LeCercle_Lebot/portal"; // Direct Link → opens the Mini App in 1 tap

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const dashboardButton = { inline_keyboard: [[{ text: "🎰 Ouvre ton dashboard", url: PORTAL_URL }]] };
const round2 = (n: number) => Math.round(n * 100) / 100;

function tierMessage(cumul: number) {
  return `🔥 L'agence est à <b>+${cumul.toFixed(0)} USDT</b> sur tes filleuls → ta part : <b>${(cumul * COMMISSION_RATE).toFixed(0)} USDT</b> 💪`;
}
function notOnboardedMessage(name: string) {
  return `👋 Ton filleul <b>${name}</b> n'est pas encore setup. Vois avec lui pour qu'on l'avance 👇`;
}

/**
 * Agent notifications — two types:
 *  (A) profit_tier   : gross agency cumul (computeAgentCommission.cumul_agence_eligible, before ×50%,
 *                      cross-makeup) crosses a new TIER_SIZE_USDT tier. Dedup per tier (anti-ping-pong).
 *  (B) not_onboarded : an active filleul is ULTRA-STRICTLY un-set-up (no group, no deal, no wallet)
 *                      AND the relationship is older than NOTONB_MIN_AGE_DAYS. Dedup once per filleul.
 * Dry-run by default (?apply=0): NEVER sends. ?apply=1 sends sequentially + delay + inline button.
 * Throttle: max THROTTLE_PER_DAY real sends per agent per day (shared across both types).
 * ?agent=<id> restricts to one agent. ?tier=<n> overrides the tier step (calibration).
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

  const lastTierQ = db.prepare(`SELECT COALESCE(MAX(CAST(substr(action_ref, 6) AS REAL)), 0) AS last FROM agent_activity_notifs WHERE agent_player_id = ? AND action_type = 'profit_tier' AND dry_run = 0`);
  const alreadySent = db.prepare(`SELECT 1 FROM agent_activity_notifs WHERE agent_player_id = ? AND action_ref = ? AND dry_run = 0`);
  const sentTodayQ = db.prepare(`SELECT COUNT(*) AS n FROM agent_activity_notifs WHERE agent_player_id = ? AND dry_run = 0 AND date(notified_at) = date('now')`);
  const recordDry = db.prepare(`INSERT OR IGNORE INTO agent_activity_notifs (agent_player_id, filleul_player_id, action_type, action_ref, amount_usdt, dry_run) VALUES (?, ?, ?, ?, ?, 1)`);
  const upsertSent = db.prepare(`INSERT INTO agent_activity_notifs (agent_player_id, filleul_player_id, action_type, action_ref, amount_usdt, dry_run, notified_at) VALUES (?, ?, ?, ?, ?, 0, datetime('now')) ON CONFLICT(agent_player_id, action_ref) DO UPDATE SET dry_run = 0, notified_at = datetime('now')`);

  const wouldSend: any[] = [];
  const skipped: any[] = [];
  const runCount = new Map<number, number>();

  // shared gate: telegram + throttle. Returns true if the candidate may queue.
  function gate(agentId: number, agentTg: number | null, label: any): boolean {
    if (!agentTg) { skipped.push({ ...label, reason: "no_telegram_id" }); return false; }
    const todayN = (sentTodayQ.get(agentId) as { n: number }).n + (runCount.get(agentId) ?? 0);
    if (todayN >= THROTTLE_PER_DAY) { skipped.push({ ...label, reason: "throttled_daily_max" }); return false; }
    runCount.set(agentId, (runCount.get(agentId) ?? 0) + 1);
    return true;
  }

  // ── PASS A: profit_tier ──
  const agents = db.prepare(`
    SELECT DISTINCT ar.affiliate_player_id AS agent_id, ap.name AS agent_name, ap.telegram_id AS agent_tg
    FROM affiliate_relationships ar JOIN players ap ON ap.id = ar.affiliate_player_id
    WHERE ar.status = 'active'
  `).all() as { agent_id: number; agent_name: string; agent_tg: number | null }[];

  for (const a of agents) {
    if (onlyAgent && String(a.agent_id) !== onlyAgent) continue;
    const ac = computeAgentCommission(a.agent_id); // SAME source as CRM + portal
    const cumul = ac.cumul_agence_eligible;
    const currentTier = cumul >= tierSize ? Math.floor(cumul / tierSize) * tierSize : 0;
    if (currentTier <= 0) { skipped.push({ type: "profit_tier", agent: a.agent_name, cumul: round2(cumul), reason: "below_first_tier" }); continue; }
    const action_ref = `tier:${currentTier}`;
    const last = (lastTierQ.get(a.agent_id) as { last: number }).last;
    if (currentTier <= last) { skipped.push({ type: "profit_tier", agent: a.agent_name, tier: currentTier, last_notified_tier: last, reason: "already_notified_tier" }); continue; }
    if (alreadySent.get(a.agent_id, action_ref)) { skipped.push({ type: "profit_tier", agent: a.agent_name, tier: currentTier, reason: "already_sent" }); continue; }
    if (!gate(a.agent_id, a.agent_tg, { type: "profit_tier", agent: a.agent_name, tier: currentTier })) continue;
    wouldSend.push({
      agent_id: a.agent_id, agent: a.agent_name, agent_tg: a.agent_tg, filleul_id: a.agent_id, action_type: "profit_tier",
      action_ref, amount: round2(cumul), tier: currentTier, cumul_agence: round2(cumul), your_share: round2(cumul * COMMISSION_RATE),
      message_preview: tierMessage(cumul),
    });
  }

  // ── PASS B: not_onboarded (ULTRA-STRICT: no group AND no deal AND no wallet, rel older than grace) ──
  const notOnb = db.prepare(`
    SELECT ar.affiliate_player_id AS agent_id, ap.name AS agent_name, ap.telegram_id AS agent_tg,
           fp.id AS filleul_id, fp.name AS filleul_name, ar.created_at AS rel_created
    FROM affiliate_relationships ar
    JOIN players ap ON ap.id = ar.affiliate_player_id
    JOIN players fp ON fp.id = ar.referred_player_id
    WHERE ar.status = 'active'
      AND fp.telegram_group_id IS NULL
      AND fp.tron_address IS NULL AND fp.tele_wallet_cashout IS NULL
      AND (SELECT COUNT(*) FROM player_game_deals d WHERE d.player_id = fp.id) = 0
      AND (SELECT COUNT(*) FROM player_wallet_games w WHERE w.player_id = fp.id) = 0
      AND (SELECT COUNT(*) FROM player_wallet_cashouts c WHERE c.player_id = fp.id) = 0
      AND ar.created_at <= datetime('now', ?)
  `).all(`-${NOTONB_MIN_AGE_DAYS} days`) as { agent_id: number; agent_name: string; agent_tg: number | null; filleul_id: number; filleul_name: string; rel_created: string }[];

  for (const n of notOnb) {
    if (onlyAgent && String(n.agent_id) !== onlyAgent) continue;
    const action_ref = `notonb:${n.filleul_id}`;
    if (alreadySent.get(n.agent_id, action_ref)) { skipped.push({ type: "not_onboarded", agent: n.agent_name, filleul: n.filleul_name, reason: "already_sent" }); continue; }
    if (!gate(n.agent_id, n.agent_tg, { type: "not_onboarded", agent: n.agent_name, filleul: n.filleul_name })) continue;
    wouldSend.push({
      agent_id: n.agent_id, agent: n.agent_name, agent_tg: n.agent_tg, filleul_id: n.filleul_id, action_type: "not_onboarded",
      action_ref, amount: null, filleul: n.filleul_name, rel_created: n.rel_created,
      message_preview: notOnboardedMessage(n.filleul_name),
    });
  }

  const config = { tier_size_usdt: tierSize, throttle_per_day: THROTTLE_PER_DAY, send_delay_ms: SEND_DELAY_MS, notonb_min_age_days: NOTONB_MIN_AGE_DAYS, commission_rate: COMMISSION_RATE };

  if (!apply) {
    for (const w of wouldSend) recordDry.run(w.agent_id, w.filleul_id, w.action_type, w.action_ref, w.amount);
    return NextResponse.json({
      mode: "dry_run", apply: false, config, scanned_agents: agents.length,
      would_send: wouldSend.length,
      breakdown: wouldSend.map(w => w.action_type === "profit_tier"
        ? { type: "profit_tier", agent: w.agent, tier: w.tier, cumul_agence: w.cumul_agence, your_share: w.your_share, message_preview: w.message_preview, button: PORTAL_URL }
        : { type: "not_onboarded", agent: w.agent, filleul: w.filleul, rel_created: w.rel_created, message_preview: w.message_preview, button: PORTAL_URL }),
      skipped,
    });
  }

  // APPLY=1 — real send, SEQUENTIAL + delay, inline dashboard button
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
      if (res.ok) { upsertSent.run(w.agent_id, w.filleul_id, w.action_type, w.action_ref, w.amount); sent.push({ type: w.action_type, agent: w.agent, ...(w.tier ? { tier: w.tier } : { filleul: w.filleul }) }); }
      else { failed.push({ agent: w.agent, status: res.status, error: (await res.text().catch(() => "")).slice(0, 200) }); }
    } catch (e: any) { failed.push({ agent: w.agent, error: e.message }); }
    await sleep(SEND_DELAY_MS);
  }
  return NextResponse.json({ mode: "apply", apply: true, config, sent: sent.length, deferred_capped: wouldSend.length - toSend.length, sent_detail: sent, failed, skipped });
}
