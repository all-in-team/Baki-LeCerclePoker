import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// ── Configurable thresholds (env override; safe defaults here, modifiable) ──
const DEPOSIT_THRESHOLD_USDT = Number(process.env.AGENT_NOTIF_DEPOSIT_THRESHOLD ?? 500);
const THROTTLE_PER_DAY = Number(process.env.AGENT_NOTIF_THROTTLE_PER_DAY ?? 3);
const LOOKBACK_DAYS = Number(process.env.AGENT_NOTIF_LOOKBACK_DAYS ?? 3);
const SEND_DELAY_MS = Number(process.env.AGENT_NOTIF_SEND_DELAY_MS ?? 1500);
const MAX_SENDS_PER_RUN = Number(process.env.AGENT_NOTIF_MAX_PER_RUN ?? 20); // anti-timeout (Railway 60s @ delay)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function depositMessage(filleulName: string, amount: number) {
  return `🔥 Ton filleul <b>${filleulName}</b> vient de déposer <b>${amount.toFixed(0)} USDT</b> · ça bosse pour toi 💪\n\nOuvre ton dashboard 👉 /myaffi`;
}

/**
 * Agent activity notifications — "big filleul action".
 * Dry-run by default (?apply=0): computes what WOULD be sent, records candidates (dry_run=1),
 * NEVER calls sendMessage. Real send only with ?apply=1 (sequential + delay, anti-FLOOD).
 * Dedup: UNIQUE(agent, action_ref) + only a dry_run=0 row counts as "really sent".
 * Throttle: max THROTTLE_PER_DAY real sends per agent per day.
 * ?agent=<id> restricts to one agent (Phase 2 single-agent test).
 */
export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  if (req.headers.get("x-admin-token") !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apply = req.nextUrl.searchParams.get("apply") === "1";
  const onlyAgent = req.nextUrl.searchParams.get("agent");
  const db = getDb();

  // Significant action = filleul USDT deposit >= threshold, recent, source-guarded (invariant #10).
  // USDT-only → the threshold compares a single USDT amount, no cross-currency aggregation (invariant #3).
  const candidates = db.prepare(`
    SELECT wt.id AS tx_id, wt.amount, wt.currency, COALESCE(wt.tx_datetime, wt.tx_date) AS ts,
           ar.affiliate_player_id AS agent_id, ap.name AS agent_name, ap.telegram_id AS agent_tg,
           fp.id AS filleul_id, fp.name AS filleul_name
    FROM wallet_transactions wt
    JOIN affiliate_relationships ar ON ar.referred_player_id = wt.player_id AND ar.status = 'active'
    JOIN players ap ON ap.id = ar.affiliate_player_id
    JOIN players fp ON fp.id = wt.player_id
    WHERE wt.type = 'deposit' AND wt.currency = 'USDT' AND wt.amount >= ?
      AND (wt.source IS NULL OR wt.source != 'unknown')
      AND COALESCE(wt.tx_datetime, wt.tx_date) >= datetime('now', ?)
    ORDER BY ts DESC
  `).all(DEPOSIT_THRESHOLD_USDT, `-${LOOKBACK_DAYS} days`) as any[];

  const alreadySent = db.prepare(`SELECT 1 FROM agent_activity_notifs WHERE agent_player_id = ? AND action_ref = ? AND dry_run = 0`);
  const sentTodayQ = db.prepare(`SELECT COUNT(*) AS n FROM agent_activity_notifs WHERE agent_player_id = ? AND dry_run = 0 AND date(notified_at) = date('now')`);
  const recordDry = db.prepare(`INSERT OR IGNORE INTO agent_activity_notifs (agent_player_id, filleul_player_id, action_type, action_ref, amount_usdt, dry_run) VALUES (?, ?, 'deposit', ?, ?, 1)`);
  const upsertSent = db.prepare(`INSERT INTO agent_activity_notifs (agent_player_id, filleul_player_id, action_type, action_ref, amount_usdt, dry_run, notified_at) VALUES (?, ?, 'deposit', ?, ?, 0, datetime('now')) ON CONFLICT(agent_player_id, action_ref) DO UPDATE SET dry_run = 0, notified_at = datetime('now')`);

  const wouldSend: any[] = [];
  const skipped: any[] = [];
  const runCount = new Map<number, number>(); // throttle accounting within this run
  const seen = new Set<string>();             // intra-run dedup guard on (agent, action_ref)

  for (const c of candidates) {
    if (onlyAgent && String(c.agent_id) !== onlyAgent) continue;
    const action_ref = `deposit:${c.tx_id}`;
    const seenKey = `${c.agent_id}|${action_ref}`;
    if (seen.has(seenKey)) continue; // never two wouldSend entries for the same action
    seen.add(seenKey);

    if (alreadySent.get(c.agent_id, action_ref)) { skipped.push({ agent: c.agent_name, filleul: c.filleul_name, reason: "already_sent" }); continue; }
    if (!c.agent_tg) { skipped.push({ agent: c.agent_name, filleul: c.filleul_name, reason: "no_telegram_id" }); continue; }
    const todayN = (sentTodayQ.get(c.agent_id) as { n: number }).n + (runCount.get(c.agent_id) ?? 0);
    if (todayN >= THROTTLE_PER_DAY) { skipped.push({ agent: c.agent_name, filleul: c.filleul_name, reason: "throttled_daily_max" }); continue; }

    wouldSend.push({
      agent_id: c.agent_id, agent: c.agent_name, agent_tg: c.agent_tg, filleul_id: c.filleul_id, filleul: c.filleul_name,
      action: "deposit", amount_usdt: c.amount, action_ref, message_preview: depositMessage(c.filleul_name, c.amount),
    });
    runCount.set(c.agent_id, (runCount.get(c.agent_id) ?? 0) + 1);
  }

  const thresholds = { deposit_threshold_usdt: DEPOSIT_THRESHOLD_USDT, throttle_per_day: THROTTLE_PER_DAY, lookback_days: LOOKBACK_DAYS, send_delay_ms: SEND_DELAY_MS };

  if (!apply) {
    // DRY-RUN — record candidates (dry_run=1), NO sendMessage
    for (const w of wouldSend) recordDry.run(w.agent_id, w.filleul_id, w.action_ref, w.amount_usdt);
    return NextResponse.json({
      mode: "dry_run", apply: false, thresholds, scanned_candidates: candidates.length,
      would_send: wouldSend.length,
      breakdown: wouldSend.map(w => ({ agent: w.agent, filleul: w.filleul, action: w.action, amount_usdt: w.amount_usdt, message_preview: w.message_preview })),
      skipped,
    });
  }

  // APPLY=1 — real send, SEQUENTIAL with delay (anti-FLOOD / anti session-revocation)
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return NextResponse.json({ error: "No bot token" }, { status: 503 });
  const sent: any[] = [];
  const failed: any[] = [];
  const toSend = wouldSend.slice(0, MAX_SENDS_PER_RUN);
  const deferred = wouldSend.length - toSend.length; // capped this run, will go next run
  for (const w of toSend) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: w.agent_tg, text: w.message_preview, parse_mode: "HTML" }),
      });
      if (res.ok) { upsertSent.run(w.agent_id, w.filleul_id, w.action_ref, w.amount_usdt); sent.push({ agent: w.agent, filleul: w.filleul, amount_usdt: w.amount_usdt }); }
      else { failed.push({ agent: w.agent, status: res.status, error: (await res.text().catch(() => "")).slice(0, 200) }); }
    } catch (e: any) { failed.push({ agent: w.agent, error: e.message }); }
    await sleep(SEND_DELAY_MS);
  }
  return NextResponse.json({ mode: "apply", apply: true, thresholds, sent: sent.length, deferred_capped: deferred, sent_detail: sent, failed, skipped });
}
