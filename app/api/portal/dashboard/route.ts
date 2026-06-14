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

  const botUsername = process.env.TELEGRAM_BOT_USERNAME || "LeCercle_Lebot";

  return {
    mode: "agent" as const,
    affiliate: { name: player.name, handle: player.telegram_handle, joined_at: player.created_at?.slice(0, 10) ?? null },
    summary: { lifetime_usdt: ac.earned, paid_usdt: ac.paid, pending_usdt: ac.due_now, cumul_agence: ac.cumul_agence_eligible },
    share_link: `https://t.me/${botUsername}?start=ref_${player.id}`,
    filleuls,
    payments,
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
        summary: { lifetime: ac.earned, paid: ac.paid, pending: ac.due_now },
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
