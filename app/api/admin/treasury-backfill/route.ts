export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { adminTokenGuard } from "@/lib/admin-token";
import { backfillWalletHistory, snapshotTreasuryToday, TREASURY_WALLETS } from "@/lib/treasury";

// Backfill de l'historique de trésorerie (one-shot, un wallet par appel — les
// wallets gas fee peuvent avoir des milliers de tx) + snapshot manuel du jour.
//   POST (x-admin-token) { address }              → reconstruit les snapshots du wallet depuis le 10/01
//   POST (x-admin-token) { action: "snapshot" }   → fige le solde du jour pour les 5 wallets (test du cron)
//   POST (x-admin-token) { action: "list" }       → rappelle les adresses de la config


export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const denied = adminTokenGuard(req);
  if (denied) return denied;

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
