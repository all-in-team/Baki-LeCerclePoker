import { NextResponse } from "next/server";
import { TREASURY_WALLETS, fetchUsdtBalance } from "@/lib/treasury";

// Trésorerie live — soldes USDT on-chain des wallets opérationnels du Cercle.
// DISPLAY-ONLY : aucune écriture DB, aucun lien avec wallet_transactions ni le
// money engine. La config des wallets + le fetch de solde vivent dans
// lib/treasury.ts (partagés avec les snapshots quotidiens du graph d'évolution).

const CACHE_TTL_MS = 60_000; // TronGrid free tier ≈ 1 req/s → on ne refait pas les 5 appels plus d'1×/min
const SPACING_MS = 1200;

export interface TreasuryWallet {
  label: string;
  address: string;
  usdt: number | null; // null = fetch failed for this wallet (error set)
  error?: string;
}
interface TreasurySnapshot {
  ok: boolean;
  updated_at: string;
  total_usdt: number;
  complete: boolean; // false si au moins un wallet n'a pas répondu (total partiel)
  wallets: TreasuryWallet[];
}

let cache: { at: number; data: TreasurySnapshot } | null = null;
let inflight: Promise<TreasurySnapshot> | null = null;

async function buildSnapshot(): Promise<TreasurySnapshot> {
  const wallets: TreasuryWallet[] = [];
  for (let i = 0; i < TREASURY_WALLETS.length; i++) {
    const w = TREASURY_WALLETS[i];
    if (i > 0) await new Promise((r) => setTimeout(r, SPACING_MS));
    try {
      wallets.push({ ...w, usdt: await fetchUsdtBalance(w.address) });
    } catch (e: any) {
      wallets.push({ ...w, usdt: null, error: e?.message ?? "fetch failed" });
    }
  }
  const complete = wallets.every((w) => w.usdt !== null);
  return {
    ok: true,
    updated_at: new Date().toISOString(),
    total_usdt: wallets.reduce((s, w) => s + (w.usdt ?? 0), 0),
    complete,
    wallets,
  };
}

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json(cache.data);
  }
  // Une seule construction à la fois : les requêtes concurrentes partagent la promesse
  // (sinon N onglets = N × 5 appels TronGrid et le rate-limit saute).
  if (!inflight) {
    inflight = buildSnapshot()
      .then((data) => {
        cache = { at: Date.now(), data };
        return data;
      })
      .finally(() => { inflight = null; });
  }
  return NextResponse.json(await inflight);
}
