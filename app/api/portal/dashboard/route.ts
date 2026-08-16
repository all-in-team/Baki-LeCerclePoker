import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { getDb } from "@/lib/db";
import { computeAffiliateCommission, computeAgentCommission } from "@/lib/queries/affiliate";

const OWNER_TG_IDS = new Set(
  (process.env.TELEGRAM_OWNER_IDS ?? "1298290355,1486389037")
    .split(",").map(id => parseInt(id.trim(), 10)).filter(n => !isNaN(n))
);

function verifyTelegramWebAppData(initData: string, botToken: string): { valid: boolean; user?: any } {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { valid: false };

  params.delete("hash");
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return { valid: false };
  if (!timingSafeEqual(a, b)) return { valid: false };

  const userStr = params.get("user");
  const user = userStr ? JSON.parse(userStr) : null;
  return { valid: true, user };
}

function buildAgentDashboard(agentPlayerId: number, db: any) {
  const player = db.prepare(
    `SELECT id, name, telegram_handle, created_at FROM players WHERE id = ?`
  ).get(agentPlayerId) as { id: number; name: string; telegram_handle: string | null; created_at: string | null } | undefined;
  if (!player) return null;

  const rels = db.prepare(
    `SELECT id FROM affiliate_relationships WHERE affiliate_player_id = ? AND status = 'active'`
  ).all(player.id) as { id: number }[];

  // Agent-level commission (cross-makeup) — single source of truth, shared with /crm/affiliates
  const ac = computeAgentCommission(player.id);
  const filleuls: any[] = [];

  for (const r of rels) {
    const commission = computeAffiliateCommission(r.id);
    if (!commission) continue;
    // per-filleul ELIGIBLE agency P&L (signed) — what this filleul contributes to the agent cumul
    const partEligible = commission.breakdown
      .filter(b => b.rate_label === "éligible")
      .reduce((s, b) => s + b.agency_pnl_lifetime, 0);
    filleuls.push({
      name: commission.referred.name,
      handle: commission.referred.telegram_handle,
      window_status: commission.window_status,
      games: commission.breakdown.map(b => ({
        game_name: b.game_name, rate_label: b.rate_label,
        rate_pct: Math.round(b.rate * 100), agency_pnl: b.agency_pnl_lifetime, currency: b.currency,
      })),
      part_agence_eligible: partEligible, // signed (can be negative)
    });
  }

  const payments = db.prepare(`
    SELECT ap.paid_at, g.name AS game_name, ap.amount_usdt, ap.tx_hash, ap.notes
    FROM affiliate_payments ap
    JOIN affiliate_relationships ar ON ar.id = ap.relationship_id
    LEFT JOIN games g ON g.id = ap.game_id
    WHERE ar.affiliate_player_id = ?
    ORDER BY ap.paid_at DESC LIMIT 20
  `).all(player.id) as any[];

  // ── Gamification data (DISPLAY-ONLY: counts + recent tx lines, no money aggregation,
  //    no cross-currency sum — each line keeps its native amount+currency) ──
  const refRows = db.prepare(
    `SELECT referred_player_id FROM affiliate_relationships WHERE affiliate_player_id = ? AND status = 'active'`
  ).all(player.id) as { referred_player_id: number }[];
  const refIds = refRows.map(r => r.referred_player_id);

  let activity: { ts: string; type: string; amount: number; currency: string; player_name: string }[] = [];
  let momentum = { filleuls_total: refIds.length, filleuls_active_30d: 0, actions_30d: 0, actions_prev_30d: 0 };

  if (refIds.length > 0) {
    const ph = refIds.map(() => "?").join(",");
    const ts = `COALESCE(wt.tx_datetime, wt.tx_date)`;
    const guard = `(wt.source IS NULL OR wt.source != 'unknown') AND (wt.status IS NULL OR wt.status = 'active')`;

    activity = db.prepare(`
      SELECT ${ts} AS ts, wt.type, wt.amount, wt.currency, p.name AS player_name
      FROM wallet_transactions wt JOIN players p ON p.id = wt.player_id
      WHERE wt.player_id IN (${ph}) AND ${guard} AND ${ts} >= datetime('now','-14 days')
      ORDER BY ts DESC LIMIT 12
    `).all(...refIds) as typeof activity;

    const a30 = db.prepare(`
      SELECT COUNT(DISTINCT wt.player_id) AS act, COUNT(*) AS cnt
      FROM wallet_transactions wt
      WHERE wt.player_id IN (${ph}) AND ${guard} AND ${ts} >= datetime('now','-30 days')
    `).get(...refIds) as { act: number; cnt: number };

    const aPrev = db.prepare(`
      SELECT COUNT(*) AS cnt FROM wallet_transactions wt
      WHERE wt.player_id IN (${ph}) AND ${guard}
        AND ${ts} >= datetime('now','-60 days') AND ${ts} < datetime('now','-30 days')
    `).get(...refIds) as { cnt: number };

    momentum = { filleuls_total: refIds.length, filleuls_active_30d: a30.act, actions_30d: a30.cnt, actions_prev_30d: aPrev.cnt };
  }

  const botUsername = process.env.TELEGRAM_BOT_USERNAME || "LeCercle_Lebot";

  return {
    mode: "agent" as const,
    affiliate: { name: player.name, handle: player.telegram_handle, joined_at: player.created_at?.slice(0, 10) ?? null },
    summary: { lifetime_usdt: ac.earned, paid_usdt: ac.paid, pending_usdt: ac.due_now, cumul_agence: ac.cumul_agence_eligible },
    share_link: `https://t.me/${botUsername}?start=ref_${player.id}`,
    filleuls,
    payments,
    activity,
    momentum,
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const initData = body.initData as string;
  const agentId = body.agent_id as number | undefined;
  if (!initData) return NextResponse.json({ error: "initData required" }, { status: 400 });

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return NextResponse.json({ error: "Server config error" }, { status: 500 });

  const { valid, user } = verifyTelegramWebAppData(initData, botToken);
  if (!valid || !user?.id) return NextResponse.json({ error: "Invalid initData" }, { status: 401 });

  const db = getDb();
  const telegramId = user.id;
  const isOwner = OWNER_TG_IDS.has(telegramId);

  // Owner mode: drill into specific agent
  if (isOwner && agentId) {
    const dashboard = buildAgentDashboard(agentId, db);
    if (!dashboard) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    return NextResponse.json(dashboard);
  }

  // Owner mode: overview of all agents
  if (isOwner && !agentId) {
    const agents = db.prepare(`
      SELECT ap.affiliate_player_id, p.name, p.telegram_handle, ap.joined_at
      FROM affiliate_profiles ap
      JOIN players p ON p.id = ap.affiliate_player_id
      WHERE ap.status = 'active'
      ORDER BY p.name
    `).all() as { affiliate_player_id: number; name: string; telegram_handle: string | null; joined_at: string }[];

    let totalDueAll = 0;
    let totalPaidAll = 0;
    const agentSummaries = agents.map(a => {
      // Agent-level commission (cross-makeup) — same function as /crm/affiliates → guaranteed consistency
      const ac = computeAgentCommission(a.affiliate_player_id);
      totalDueAll += ac.due_now;
      totalPaidAll += ac.paid;

      return {
        player_id: a.affiliate_player_id,
        name: a.name,
        handle: a.telegram_handle,
        joined_at: a.joined_at?.slice(0, 10) ?? null,
        filleuls_count: ac.filleuls.length,
        // `cumul` = solde agence signé, AFFICHAGE OWNER UNIQUEMENT (peut être négatif).
        // Ne jamais confondre avec la commission payable : celle-ci reste `pending`/`lifetime`,
        // toujours issues de max(0, cumul) × 50% dans computeAgentCommission. Aucun calcul modifié ici.
        summary: { lifetime: ac.earned, paid: ac.paid, pending: ac.due_now, cumul: ac.cumul_agence_eligible },
      };
    });

    return NextResponse.json({
      mode: "owner",
      total_due_all_agents: totalDueAll,
      total_paid_all_agents: totalPaidAll,
      agents: agentSummaries,
    });
  }

  // Agent mode: own dashboard
  let player = db.prepare(
    `SELECT id FROM players WHERE telegram_id = ?`
  ).get(telegramId) as { id: number } | undefined;

  if (!player && user.username) {
    const username = user.username as string;
    const candidates = db.prepare(
      `SELECT id FROM players WHERE telegram_id IS NULL AND (
        LOWER(telegram_handle) = LOWER(?) OR LOWER(telegram_handle) = LOWER(?)
      )`
    ).all(username, `@${username}`) as { id: number }[];

    if (candidates.length === 1) {
      db.prepare(`UPDATE players SET telegram_id = ? WHERE id = ? AND telegram_id IS NULL`)
        .run(String(telegramId), candidates[0].id);
      player = candidates[0];
      console.log(`[portal] Backfilled telegram_id=${telegramId} for player ${candidates[0].id} via username @${username}`);
    }
  }

  if (!player) return NextResponse.json({ error: "Player not found" }, { status: 403 });

  const profile = db.prepare(`SELECT 1 FROM affiliate_profiles WHERE affiliate_player_id = ?`).get(player.id);
  const hasRels = db.prepare(`SELECT 1 FROM affiliate_relationships WHERE affiliate_player_id = ? AND status = 'active'`).get(player.id);
  if (!profile && !hasRels) return NextResponse.json({ error: "Not an agent" }, { status: 403 });

  const dashboard = buildAgentDashboard(player.id, db);
  if (!dashboard) return NextResponse.json({ error: "Error building dashboard" }, { status: 500 });
  return NextResponse.json(dashboard);
}
