import { NextRequest, NextResponse } from "next/server";
import { getPlayerCashouts, setPlayerCashouts } from "@/lib/queries";
import { getDb } from "@/lib/db";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(getPlayerCashouts(Number(id)));
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const playerId = Number(id);
  const body = await req.json();
  if (!Array.isArray(body.addresses)) {
    return NextResponse.json({ error: "addresses array required" }, { status: 400 });
  }
  const cleaned = body.addresses
    .filter((a: any) => typeof a === "object" && typeof a.address === "string")
    .map((a: any) => ({ address: a.address.trim(), label: a.label?.trim() || null }))
    .filter((a: any) => a.address.length > 0);

  const db = getDb();

  // A shared cashout address is ALLOWED (business rule: same address = same entity/team → alias).
  // We no longer block it — we surface who it is shared with (informational) so the owner sees
  // the alias forming. The money side (a shared-address cashout must be counted ONCE, under one
  // player) is enforced deterministically in the wallet sync (app/api/wallets/sync Pass 2), not here.
  const sharedWith: { address: string; names: string[] }[] = [];
  for (const c of cleaned) {
    const others = db.prepare(
      `SELECT DISTINCT p.name FROM player_wallet_cashouts pwc JOIN players p ON p.id = pwc.player_id WHERE pwc.address = ? AND pwc.player_id != ?`
    ).all(c.address, playerId) as { name: string }[];
    if (others.length > 0) sharedWith.push({ address: c.address, names: others.map((o) => o.name) });
  }

  const gameId = typeof body.game_id === "number" ? body.game_id : undefined;
  setPlayerCashouts(playerId, cleaned, gameId);

  // Shared cashout → (re)build aliases immediately so the grouping shows without a full sync.
  if (sharedWith.length > 0) {
    try {
      const { detectAliases } = await import("@/lib/aliases");
      detectAliases();
    } catch (e: any) {
      console.warn("[CASHOUTS] detectAliases failed (non-blocking):", e?.message ?? e);
    }
  }

  return NextResponse.json({ ok: true, count: cleaned.length, shared_with: sharedWith });
}
