import { NextRequest, NextResponse } from "next/server";
import { getPlayerCashouts, setPlayerCashouts } from "@/lib/queries";
import { getDb } from "@/lib/db";

const SHARED_WALLET_ALLOWED = new Set([1, 2]); // Hugo + Baki can share cashout wallets

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

  // Check for shared wallets (except Baki+Hugo)
  if (!SHARED_WALLET_ALLOWED.has(playerId)) {
    const db = getDb();
    for (const c of cleaned) {
      const existing = db.prepare(
        `SELECT pwc.player_id, p.name FROM player_wallet_cashouts pwc JOIN players p ON p.id = pwc.player_id WHERE pwc.address = ? AND pwc.player_id != ?`
      ).get(c.address, playerId) as { player_id: number; name: string } | undefined;
      if (existing) {
        return NextResponse.json(
          { error: `L'adresse ${c.address.slice(0, 8)}… est déjà utilisée par ${existing.name}. Un wallet cashout ne peut appartenir qu'à un seul joueur.` },
          { status: 409 }
        );
      }
    }
  }

  setPlayerCashouts(playerId, cleaned);
  return NextResponse.json({ ok: true, count: cleaned.length });
}
