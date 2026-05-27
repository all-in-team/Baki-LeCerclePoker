import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { getDb } from "@/lib/db";
import { computeAffiliateCommission } from "@/lib/queries/affiliate";

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

export async function POST(req: NextRequest) {
  const body = await req.json();
  const initData = body.initData as string;
  if (!initData) return NextResponse.json({ error: "initData required" }, { status: 400 });

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return NextResponse.json({ error: "Server config error" }, { status: 500 });

  const { valid, user } = verifyTelegramWebAppData(initData, botToken);
  if (!valid || !user?.id) return NextResponse.json({ error: "Invalid initData" }, { status: 401 });

  const db = getDb();
  const telegramId = user.id;

  const player = db.prepare(
    `SELECT id, name, telegram_handle, created_at FROM players WHERE telegram_id = ?`
  ).get(telegramId) as { id: number; name: string; telegram_handle: string | null; created_at: string | null } | undefined;

  if (!player) return NextResponse.json({ error: "Player not found" }, { status: 403 });

  const rels = db.prepare(
    `SELECT id FROM affiliate_relationships WHERE affiliate_player_id = ? AND status = 'active'`
  ).all(player.id) as { id: number }[];

  if (rels.length === 0) return NextResponse.json({ error: "Not an affiliate" }, { status: 403 });

  let totalEarned = 0;
  let totalPaid = 0;
  const filleuls: any[] = [];

  for (const r of rels) {
    const commission = computeAffiliateCommission(r.id);
    if (!commission) continue;
    totalEarned += commission.total_earned_lifetime;
    totalPaid += commission.total_paid_lifetime;
    filleuls.push({
      name: commission.referred.name,
      handle: commission.referred.telegram_handle,
      games: commission.breakdown.map(b => ({
        game_name: b.game_name,
        rate_label: b.rate_label,
        rate_pct: Math.round(b.rate * 100),
        earned: b.earned_lifetime,
        due_now: b.due_now,
      })),
      total_earned: commission.total_earned_lifetime,
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

  return NextResponse.json({
    affiliate: {
      name: player.name,
      handle: player.telegram_handle,
      joined_at: player.created_at?.slice(0, 10) ?? null,
    },
    summary: {
      lifetime_usdt: totalEarned,
      paid_usdt: totalPaid,
      pending_usdt: Math.max(0, totalEarned - totalPaid),
    },
    filleuls,
    payments,
  });
}
