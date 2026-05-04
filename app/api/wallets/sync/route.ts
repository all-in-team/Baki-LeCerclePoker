import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { insertWalletTransactionByHash, getWalletMeres, getAllTeleCashoutsByPlayer, getAllTeleGameWalletsByPlayer } from "@/lib/queries";

const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// ─── ARCHITECTURE TELE ────────────────────────────────────────────────────────
//
//  WALLET GAME    (per joueur) ← reçoit les dépôts
//  WALLET CASHOUT (per joueur) ← adresse fixe où le joueur reçoit ses cashouts
//  WALLET MERE    (global)     → envoie tous les cashouts vers WALLET CASHOUT
//
//  Pass 1 : scan WALLET GAME     → dépôts (tout entrant)
//  Pass 2 : scan each WALLET CASHOUT → only keep incoming from WALLET MERE
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
    SELECT DISTINCT p.id, p.name
    FROM players p
    JOIN player_game_deals pgd ON pgd.player_id = p.id
    JOIN games g ON g.id = pgd.game_id AND g.name = 'TELE'
  `).all() as { id: number; name: string }[];
}

function toAmt(tx: any): number {
  return Number(tx.value) / Math.pow(10, tx.token_info?.decimals ?? 6);
}
function toDate(tx: any): string {
  return new Date(tx.block_timestamp).toISOString().slice(0, 10);
}
function toDatetime(tx: any): string {
  return new Date(tx.block_timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function POST() {
  const teleGameId = getTeleGameId();
  if (!teleGameId)
    return NextResponse.json({ ok: false, message: "TELE game not found." });

  const players = getPlayersOnTele();
  if (players.length === 0)
    return NextResponse.json({ ok: true, imported: 0, message: "Aucun joueur avec un Wallet Game configuré." });

  const walletMeres = getWalletMeres();
  const mereAddrs = new Set(walletMeres.map(wm => wm.address.toLowerCase()));

  // Build game-wallet map: player_id → [address, ...] (deduped by lowercase)
  const gameWalletEntries = getAllTeleGameWalletsByPlayer();
  const gameWalletsByPlayer = new Map<number, string[]>();
  const seenAddresses = new Map<number, Set<string>>();
  for (const e of gameWalletEntries) {
    const list = gameWalletsByPlayer.get(e.player_id) ?? [];
    const seen = seenAddresses.get(e.player_id) ?? new Set();
    const lower = e.address.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      list.push(e.address);
    }
    gameWalletsByPlayer.set(e.player_id, list);
    seenAddresses.set(e.player_id, seen);
  }

  type Result = { player: string; deposits: number; cashouts: number; error?: string };
  const results: Result[] = [];
  let totalDeposits = 0;
  let totalCashouts = 0;

  // ── Pass 1 : dépôts via WALLET GAME (all wallets per player) ─────────────
  for (const player of players) {
    const wallets = gameWalletsByPlayer.get(player.id) ?? [];
    let deposits = 0;

    for (const walletAddr of wallets) {
      const gameAddr = walletAddr.toLowerCase();
      try {
        const txs = await fetchAllTronTxs(walletAddr);
        for (const tx of txs) {
          if ((tx.to ?? "").toLowerCase() !== gameAddr) continue;
          const changed = insertWalletTransactionByHash({
            player_id: player.id,
            game_id: teleGameId,
            type: "deposit",
            amount: toAmt(tx),
            currency: "USDT",
            tx_date: toDate(tx),
            tx_datetime: toDatetime(tx),
            tron_tx_hash: tx.transaction_id,
            counterparty_address: tx.from ?? null,
          });
          if (changed) deposits++;
        }
      } catch (e: any) {
        results.push({ player: player.name, deposits: 0, cashouts: 0, error: `${walletAddr.slice(0, 8)}… ${e.message}` });
      }
    }
    totalDeposits += deposits;
    results.push({ player: player.name, deposits, cashouts: 0 });
  }

  // ── Pass 2 : cashouts — scan each WALLET CASHOUT, keep only incoming from WALLET MERE
  // Build map: address (lowercase) → [player_ids] to handle shared wallets
  const cashoutOwners = new Map<string, { playerIds: number[]; original: string }>();
  const playerIdsOnTele = new Set(players.map(p => p.id));
  for (const c of getAllTeleCashoutsByPlayer()) {
    if (!playerIdsOnTele.has(c.player_id)) continue;
    const lower = c.address.toLowerCase();
    const existing = cashoutOwners.get(lower);
    if (existing) {
      if (!existing.playerIds.includes(c.player_id)) existing.playerIds.push(c.player_id);
    } else {
      cashoutOwners.set(lower, { playerIds: [c.player_id], original: c.address });
    }
  }

  if (mereAddrs.size > 0 && cashoutOwners.size > 0) {
    for (const [addrLower, { playerIds, original }] of cashoutOwners) {
      try {
        const txs = await fetchAllTronTxs(original);
        for (const tx of txs) {
          if ((tx.to ?? "").toLowerCase() !== addrLower) continue;
          // Invariant #1: withdrawal ONLY if sender is a known wallet mère
          if (!mereAddrs.has((tx.from ?? "").toLowerCase())) continue;

          for (const pid of playerIds) {
            const changed = insertWalletTransactionByHash({
              player_id: pid,
              game_id: teleGameId,
              type: "withdrawal",
              amount: toAmt(tx),
              currency: "USDT",
              tx_date: toDate(tx),
              tx_datetime: toDatetime(tx),
              tron_tx_hash: tx.transaction_id,
              counterparty_address: tx.from ?? null,
            });
            if (changed) {
              totalCashouts++;
              const player = players.find(p => p.id === pid);
              const r = results.find(r => player && r.player === player.name);
              if (r) r.cashouts++;
            }
          }
        }
      } catch (e: any) {
        const names = playerIds.map(id => players.find(p => p.id === id)?.name ?? "?").join("/");
        results.push({ player: names, deposits: 0, cashouts: 0, error: e.message });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    imported: totalDeposits + totalCashouts,
    deposits: totalDeposits,
    cashouts: totalCashouts,
    wallet_meres_configured: mereAddrs.size,
    cashout_wallets_configured: cashoutOwners.size,
    results,
  });
}
