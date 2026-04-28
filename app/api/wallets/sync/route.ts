import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { insertWalletTransactionByHash, getSetting, getAllTeleCashoutsByPlayer } from "@/lib/queries";

const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// ─── ARCHITECTURE TELE ────────────────────────────────────────────────────────
//
//  WALLET GAME    (per joueur) ← reçoit les dépôts
//  WALLET CASHOUT (per joueur) ← adresse fixe où le joueur reçoit ses cashouts
//  WALLET MERE    (global)     → envoie tous les cashouts vers WALLET CASHOUT
//
//  Pass 1 : scan WALLET GAME  → dépôts (tout entrant)
//  Pass 2 : scan WALLET MERE  → cashouts filtrés sur WALLET CASHOUT connus
//
// ─────────────────────────────────────────────────────────────────────────────

// TronGrid free tier limits to 1 RPS. Going over suspends the IP for ~5s, and rapid
// retries can extend the suspension. Solution: enforce a global minimum spacing
// between *any* TronGrid call (regardless of which player), and on 429 wait long
// enough that the suspension fully clears before retrying.
const MIN_SPACING_MS = 1500; // 0.66 RPS — comfortable margin under the 1 RPS limit
const RETRY_AFTER_429_MS = 12000; // 5s suspension + 7s margin to avoid extending it
let lastTronGridCallAt = 0;

async function throttle() {
  const now = Date.now();
  const wait = lastTronGridCallAt + MIN_SPACING_MS - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastTronGridCallAt = Date.now();
}

async function fetchTronGrid(url: string, headers: Record<string, string>): Promise<any> {
  const maxRetries = 5;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await throttle();
    const res = await fetch(url, { headers, next: { revalidate: 0 } });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < maxRetries) {
      await new Promise(r => setTimeout(r, RETRY_AFTER_429_MS));
      lastTronGridCallAt = Date.now(); // reset so we wait the full spacing again
      continue;
    }
    throw new Error(`TronGrid ${res.status}: ${await res.text()}`);
  }
  throw new Error("TronGrid: max retries exceeded");
}

async function fetchAllTronTxs(address: string): Promise<any[]> {
  const apiKey = process.env.TRONGRID_API_KEY;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

  const all: any[] = [];
  let fingerprint: string | undefined;
  let page = 0;

  do {
    const params = new URLSearchParams({
      limit: "200",
      contract_address: USDT_CONTRACT,
      only_confirmed: "true",
    });
    if (fingerprint) params.set("fingerprint", fingerprint);

    const url = `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?${params}`;
    const json = await fetchTronGrid(url, headers);

    all.push(...(json.data ?? []));
    fingerprint = json.meta?.fingerprint ?? undefined;
    page++;
    if (page >= 10) break;
  } while (fingerprint);

  return all;
}

function getTeleGameId(): number | null {
  const row = getDb().prepare(`SELECT id FROM games WHERE name = 'TELE'`).get() as { id: number } | undefined;
  return row?.id ?? null;
}

function getPlayersOnTele() {
  return getDb().prepare(`
    SELECT p.id, p.name, p.tron_address AS wallet_game, p.tele_wallet_cashout AS wallet_cashout
    FROM players p
    JOIN player_game_deals pgd ON pgd.player_id = p.id
    JOIN games g ON g.id = pgd.game_id AND g.name = 'TELE'
    WHERE p.tron_address IS NOT NULL AND p.tron_address != ''
  `).all() as { id: number; name: string; wallet_game: string; wallet_cashout: string | null }[];
}

function toAmt(tx: any): number {
  return Number(tx.value) / Math.pow(10, tx.token_info?.decimals ?? 6);
}
function toDate(tx: any): string {
  return new Date(tx.block_timestamp).toISOString().slice(0, 10);
}

export async function POST() {
  const teleGameId = getTeleGameId();
  if (!teleGameId)
    return NextResponse.json({ ok: false, message: "TELE game not found." });

  const players = getPlayersOnTele();
  if (players.length === 0)
    return NextResponse.json({ ok: true, imported: 0, message: "Aucun joueur avec un Wallet Game configuré." });

  const walletMere = getSetting("tele_wallet_mere");

  type Result = { player: string; deposits: number; cashouts: number; error?: string };
  const results: Result[] = [];
  let totalDeposits = 0;
  let totalCashouts = 0;

  // ── Pass 1 : dépôts via WALLET GAME ──────────────────────────────────────
  for (const player of players) {
    const gameAddr = player.wallet_game.toLowerCase();
    let deposits = 0;

    try {
      const txs = await fetchAllTronTxs(player.wallet_game);
      for (const tx of txs) {
        if ((tx.to ?? "").toLowerCase() !== gameAddr) continue; // entrants seulement
        const changed = insertWalletTransactionByHash({
          player_id: player.id,
          game_id: teleGameId,
          type: "deposit",
          amount: toAmt(tx),
          currency: "USDT",
          tx_date: toDate(tx),
          tron_tx_hash: tx.transaction_id,
        });
        if (changed) deposits++;
      }
      totalDeposits += deposits;
      results.push({ player: player.name, deposits, cashouts: 0 });
    } catch (e: any) {
      results.push({ player: player.name, deposits: 0, cashouts: 0, error: e.message });
    }
  }

  // ── Pass 2 : cashouts via WALLET MERE → WALLET CASHOUT ───────────────────
  // Build the cashout map from BOTH the new multi-cashout table AND the legacy single column.
  const cashoutMap = new Map<string, number>(); // wallet_cashout (lowercase) → player_id
  const playerIdsOnTele = new Set(players.map(p => p.id));
  for (const c of getAllTeleCashoutsByPlayer()) {
    if (!playerIdsOnTele.has(c.player_id)) continue;
    cashoutMap.set(c.address.toLowerCase(), c.player_id);
  }

  if (walletMere && cashoutMap.size > 0) {
    try {
      const mereTxs = await fetchAllTronTxs(walletMere);
      const mereAddr = walletMere.toLowerCase();

      for (const tx of mereTxs) {
        if ((tx.from ?? "").toLowerCase() !== mereAddr) continue; // sortants seulement
        const playerId = cashoutMap.get((tx.to ?? "").toLowerCase());
        if (!playerId) continue;

        const changed = insertWalletTransactionByHash({
          player_id: playerId,
          game_id: teleGameId,
          type: "withdrawal",
          amount: toAmt(tx),
          currency: "USDT",
          tx_date: toDate(tx),
          tron_tx_hash: tx.transaction_id,
        });
        if (changed) {
          totalCashouts++;
          const r = results.find(r => {
            const p = players.find(p => p.id === playerId);
            return p && r.player === p.name;
          });
          if (r) r.cashouts++;
        }
      }
    } catch (e: any) {
      results.push({ player: "WALLET MERE", deposits: 0, cashouts: 0, error: e.message });
    }
  }

  return NextResponse.json({
    ok: true,
    imported: totalDeposits + totalCashouts,
    deposits: totalDeposits,
    cashouts: totalCashouts,
    wallet_mere_configured: !!walletMere,
    cashout_wallets_configured: cashoutMap.size,
    results,
  });
}
