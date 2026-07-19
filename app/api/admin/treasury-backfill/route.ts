export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { backfillWalletHistory, snapshotTreasuryToday, TREASURY_WALLETS } from "@/lib/treasury";

// Backfill de l'historique de trésorerie (one-shot, un wallet par appel — les
// wallets gas fee peuvent avoir des milliers de tx) + snapshot manuel du jour.
//   POST { key, address }              → reconstruit les snapshots du wallet depuis le 10/01
//   POST { key, action: "snapshot" }   → fige le solde du jour pour les 5 wallets (test du cron)
//   POST { key, action: "list" }       → rappelle les adresses de la config

const KEY = "treasury-backfill-20260719";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.key !== KEY) return NextResponse.json({ error: "bad key" }, { status: 403 });

  if (body.action === "list") {
    return NextResponse.json({ ok: true, wallets: TREASURY_WALLETS });
  }
  if (body.action === "snapshot") {
    const r = await snapshotTreasuryToday();
    return NextResponse.json(r);
  }
  if (typeof body.address === "string" && body.address) {
    const r = await backfillWalletHistory(body.address);
    console.log(`[TREASURY-BACKFILL] ${body.address}: ok=${r.ok} days=${r.days_written} txs=${r.tx_count} err=${r.error ?? "-"}`);
    return NextResponse.json(r);
  }
  return NextResponse.json({ error: "address or action required" }, { status: 400 });
}
