import { NextResponse } from "next/server";

// Trésorerie live — soldes USDT on-chain des wallets opérationnels du Cercle.
// DISPLAY-ONLY : aucune écriture DB, aucun lien avec wallet_transactions ni le
// money engine. La liste des wallets est une config produit (Hugo 2026-07-17) —
// les wallets "gas fee" paient les frais en USDT (pas de TRX à suivre).
const TREASURY_WALLETS: { label: string; address: string }[] = [
  { label: "Hugo short", address: "TUMXxSL6ZPrHFtYYepYYY5BjwqT3TQDkGd" },
  { label: "Hugo short gasfee", address: "TJwq47V9oRMnngv49V66A1QhhT9LfADc4o" },
  { label: "Général", address: "TBtcUxCFDUEXKS1ypPQ18U6CQmfFcK2itf" },
  { label: "Général gas fee", address: "TNBf7UHvahKbodkH8PEtwFoQk6xMLSAvNd" },
  { label: "Baki gas fee", address: "TTDEX1XimZsBTP6fYbaJVipCXWp3xvNZjN" },
];

const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
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

async function fetchUsdtBalance(address: string): Promise<number> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = process.env.TRONGRID_API_KEY;
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  const res = await fetch(`https://api.trongrid.io/v1/accounts/${address}`, { headers, next: { revalidate: 0 } });
  if (!res.ok) throw new Error(`TronGrid ${res.status}`);
  const json = await res.json();
  const account = json.data?.[0];
  // Compte jamais activé on-chain → data vide → solde 0 (pas une erreur).
  if (!account) return 0;
  for (const entry of account.trc20 ?? []) {
    const bal = entry[USDT_CONTRACT];
    if (bal !== undefined) return Number(bal) / 1e6;
  }
  return 0;
}

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
