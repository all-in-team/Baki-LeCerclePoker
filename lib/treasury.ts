/**
 * Trésorerie — config des wallets opérationnels + soldes live + snapshots quotidiens.
 *
 * DISPLAY-ONLY : rien ici ne touche wallet_transactions ni le money engine. Les
 * snapshots (`treasury_snapshots`) alimentent le graph "Trésorerie · évolution" du
 * dashboard ; le backfill reconstruit l'historique depuis le 10/01 à partir des
 * transferts USDT on-chain (solde à rebours depuis le solde actuel), puis le cron
 * quotidien (23h50 Paris) fige le solde du jour — plus aucune reconstruction ensuite.
 */

import { getDb } from "./db";

export const TREASURY_WALLETS: { label: string; address: string }[] = [
  { label: "Hugo short", address: "TUMXxSL6ZPrHFtYYepYYY5BjwqT3TQDkGd" },
  { label: "Hugo short gasfee", address: "TJwq47V9oRMnngv49V66A1QhhT9LfADc4o" },
  { label: "Général", address: "TBtcUxCFDUEXKS1ypPQ18U6CQmfFcK2itf" },
  { label: "Général gas fee", address: "TNBf7UHvahKbodkH8PEtwFoQk6xMLSAvNd" },
  { label: "Baki gas fee", address: "TTDEX1XimZsBTP6fYbaJVipCXWp3xvNZjN" },
];

export const TREASURY_START_DATE = "2026-01-10"; // même départ que le graph Profit cumulé

const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const MAX_BACKFILL_PAGES = 30; // 30 × 200 = 6 000 tx par wallet — au-delà on signale, pas de troncature silencieuse

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tronHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = process.env.TRONGRID_API_KEY;
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  return headers;
}

export async function fetchUsdtBalance(address: string): Promise<number> {
  const res = await fetch(`https://api.trongrid.io/v1/accounts/${address}`, { headers: tronHeaders(), next: { revalidate: 0 } });
  if (!res.ok) throw new Error(`TronGrid ${res.status}`);
  const json = await res.json();
  const account = json.data?.[0];
  if (!account) return 0; // compte jamais activé on-chain → solde 0
  for (const entry of account.trc20 ?? []) {
    const bal = entry[USDT_CONTRACT];
    if (bal !== undefined) return Number(bal) / 1e6;
  }
  return 0;
}

// Date Paris (YYYY-MM-DD) d'un timestamp epoch ms.
function parisDate(ms: number): string {
  return new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
}

function todayParis(): string {
  return parisDate(Date.now());
}

function prevDay(date: string): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── Backfill (one-shot, un wallet par appel) ─────────────────────────────────
// Reconstruit les soldes de fin de journée (Paris) depuis TREASURY_START_DATE :
// solde fin de J-1 = solde fin de J − Δ(J), en partant du solde actuel. Écrit
// INSERT OR REPLACE dans treasury_snapshots. Les jours antérieurs à la 1ère tx
// donnent naturellement le solde d'alors (≈0 pour un wallet né après le 10/01).
export async function backfillWalletHistory(address: string): Promise<{
  ok: boolean; days_written: number; tx_count: number; error: string | null;
}> {
  const wallet = TREASURY_WALLETS.find((w) => w.address === address);
  if (!wallet) return { ok: false, days_written: 0, tx_count: 0, error: "adresse hors liste trésorerie" };

  const minTs = new Date(TREASURY_START_DATE + "T00:00:00+01:00").getTime();

  // 1) Solde actuel
  let currentBalance: number;
  try {
    currentBalance = await fetchUsdtBalance(address);
  } catch (e: any) {
    return { ok: false, days_written: 0, tx_count: 0, error: `balance: ${e?.message ?? e}` };
  }

  // 2) Tous les transferts USDT depuis le 10/01 (paginé, borné)
  const deltasByDay = new Map<string, number>();
  let fingerprint: string | undefined;
  let page = 0;
  let txCount = 0;
  const addrLower = address.toLowerCase();
  try {
    do {
      await sleep(1300);
      const params = new URLSearchParams({
        limit: "200",
        contract_address: USDT_CONTRACT,
        only_confirmed: "true",
        min_timestamp: String(minTs),
      });
      if (fingerprint) params.set("fingerprint", fingerprint);
      const res = await fetch(`https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?${params}`, { headers: tronHeaders(), next: { revalidate: 0 } });
      if (!res.ok) throw new Error(`TronGrid ${res.status}`);
      const json = await res.json();
      for (const tx of json.data ?? []) {
        if (tx.block_timestamp < minTs) continue;
        const amt = Number(tx.value) / Math.pow(10, tx.token_info?.decimals ?? 6);
        const day = parisDate(tx.block_timestamp);
        const isIn = (tx.to ?? "").toLowerCase() === addrLower;
        const isOut = (tx.from ?? "").toLowerCase() === addrLower;
        if (!isIn && !isOut) continue;
        deltasByDay.set(day, (deltasByDay.get(day) ?? 0) + (isIn ? amt : -amt));
        txCount++;
      }
      fingerprint = json.meta?.fingerprint ?? undefined;
      page++;
    } while (fingerprint && page < MAX_BACKFILL_PAGES);
    if (fingerprint) {
      return { ok: false, days_written: 0, tx_count: txCount, error: `plus de ${MAX_BACKFILL_PAGES * 200} tx depuis le 10/01 — backfill refusé (pas de troncature silencieuse)` };
    }
  } catch (e: any) {
    return { ok: false, days_written: 0, tx_count: txCount, error: `history: ${e?.message ?? e}` };
  }

  // 3) Marche à rebours + écriture
  const db = getDb();
  const ins = db.prepare(`INSERT OR REPLACE INTO treasury_snapshots (date, address, usdt) VALUES (?, ?, ?)`);
  let day = todayParis();
  let balance = currentBalance;
  let days = 0;
  const writeAll = db.transaction(() => {
    while (day >= TREASURY_START_DATE) {
      ins.run(day, address, Math.round(balance * 1e6) / 1e6);
      days++;
      balance -= deltasByDay.get(day) ?? 0; // solde fin de J-1
      day = prevDay(day);
    }
  });
  writeAll();
  return { ok: true, days_written: days, tx_count: txCount, error: null };
}

// ── Snapshot quotidien (cron 23h50 Paris) ────────────────────────────────────
export async function snapshotTreasuryToday(): Promise<{ ok: boolean; written: number; errors: string[] }> {
  const db = getDb();
  const ins = db.prepare(`INSERT OR REPLACE INTO treasury_snapshots (date, address, usdt) VALUES (?, ?, ?)`);
  const date = todayParis();
  let written = 0;
  const errors: string[] = [];
  for (let i = 0; i < TREASURY_WALLETS.length; i++) {
    if (i > 0) await sleep(1300);
    const w = TREASURY_WALLETS[i];
    try {
      const bal = await fetchUsdtBalance(w.address);
      ins.run(date, w.address, bal);
      written++;
    } catch (e: any) {
      errors.push(`${w.label}: ${e?.message ?? e}`);
    }
  }
  return { ok: errors.length === 0, written, errors };
}

// ── Série pour le graph (lecture SQL pure) ───────────────────────────────────
export interface TreasurySeriesPoint {
  date: string;          // YYYY-MM-DD
  total: number;
  byWallet: Record<string, number>; // label → usdt
}

export function getTreasurySeries(): TreasurySeriesPoint[] {
  const rows = getDb().prepare(
    `SELECT date, address, usdt FROM treasury_snapshots WHERE date >= ? ORDER BY date ASC`
  ).all(TREASURY_START_DATE) as { date: string; address: string; usdt: number }[];
  const labelByAddr = new Map(TREASURY_WALLETS.map((w) => [w.address, w.label]));
  const byDate = new Map<string, TreasurySeriesPoint>();
  for (const r of rows) {
    const label = labelByAddr.get(r.address);
    if (!label) continue; // snapshot d'un wallet retiré de la config → ignoré du graph
    let p = byDate.get(r.date);
    if (!p) byDate.set(r.date, (p = { date: r.date, total: 0, byWallet: {} }));
    p.byWallet[label] = r.usdt;
    p.total += r.usdt;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
