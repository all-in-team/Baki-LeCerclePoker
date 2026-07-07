import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { insertWalletTransactionByHash, getActiveWalletMeresForGame, getAllWalletMereAddressesAnyStatus, getAllGameWalletsByPlayer, getAllCashoutsByPlayer, getPlayersOnGame, isGameArchived } from "@/lib/queries";

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

function getGameId(gameName: string): number | null {
  const row = getDb().prepare(`SELECT id FROM games WHERE name = ?`).get(gameName) as { id: number } | undefined;
  return row?.id ?? null;
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

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const gameName: string = body.game_name ?? "TELE";

  if (isGameArchived(gameName)) {
    return NextResponse.json({ error: `Game ${gameName} archived, sync disabled` }, { status: 403 });
  }

  const gameId = getGameId(gameName);
  if (!gameId)
    return NextResponse.json({ ok: false, message: `Game ${gameName} not found.` });

  const players = getPlayersOnGame(gameName);
  if (players.length === 0)
    return NextResponse.json({ ok: true, imported: 0, message: "Aucun joueur avec un Wallet Game configuré." });

  const mereAddrs = getActiveWalletMeresForGame(gameId);
  if (mereAddrs.size === 0) {
    console.warn(`[SYNC] No active wallet_mère for game=${gameName}, withdrawals cannot be detected`);
  }
  // ANY status: a transfer from a retired mère is still operator money, never a
  // player deposit (history: retired KKPOKER mère funding a player's OKPOKER/AKS
  // game wallets got imported as 8 phantom deposits).
  const allMereAddrs = getAllWalletMereAddressesAnyStatus();

  // Build game-wallet map: player_id → [address, ...] (deduped by lowercase)
  const gameWalletEntries = getAllGameWalletsByPlayer(gameName);
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
  let skippedFromMere = 0;

  // ── Pass 1 : scan WALLET GAME — deposits; withdrawal ONLY if sender is a mère of THIS game;
  //    incoming from another game's mère is skipped (that game's Pass 2 owns it)
  for (const player of players) {
    const wallets = gameWalletsByPlayer.get(player.id) ?? [];
    let deposits = 0;
    let cashouts = 0;

    for (const walletAddr of wallets) {
      const gameAddr = walletAddr.toLowerCase();
      try {
        const txs = await fetchAllTronTxs(walletAddr);
        for (const tx of txs) {
          if ((tx.to ?? "").toLowerCase() !== gameAddr) continue;
          const fromLower = (tx.from ?? "").toLowerCase();
          const fromGameMere = mereAddrs.has(fromLower);
          // Strict per-game rule (Baki 2026-07-07): a cashout of game X comes ONLY
          // from a mère OF GAME X. An incoming from ANOTHER game's mère is that
          // other game's cashout (its own sync imports it via Pass 2) — importing
          // it here would stamp it with the wrong game_id. It is not a deposit
          // either (operator money, not player funding), so skip entirely.
          if (!fromGameMere && allMereAddrs.has(fromLower)) {
            skippedFromMere++;
            console.warn(`[SYNC ${gameName}] skip tx ${tx.transaction_id}: from mère ${fromLower.slice(0, 10)}… (another game or retired) → not a ${gameName} tx (player=${player.name})`);
            continue;
          }
          const changed = insertWalletTransactionByHash({
            player_id: player.id,
            game_id: gameId,
            type: fromGameMere ? "withdrawal" : "deposit",
            amount: toAmt(tx),
            currency: "USDT",
            tx_date: toDate(tx),
            tx_datetime: toDatetime(tx),
            tron_tx_hash: tx.transaction_id,
            counterparty_address: tx.from ?? null,
          });
          if (changed) {
            if (fromGameMere) cashouts++;
            else deposits++;
          }
        }
      } catch (e: any) {
        results.push({ player: player.name, deposits: 0, cashouts: 0, error: `${walletAddr.slice(0, 8)}… ${e.message}` });
      }
    }
    totalDeposits += deposits;
    totalCashouts += cashouts;
    results.push({ player: player.name, deposits, cashouts });
  }

  // ── Pass 2 : cashouts — scan each WALLET CASHOUT, keep only incoming from WALLET MERE
  // Build map: address (lowercase) → [player_ids] to handle shared wallets
  const cashoutOwners = new Map<string, { playerIds: number[]; original: string }>();
  const playerIdsOnTele = new Set(players.map(p => p.id));
  for (const c of getAllCashoutsByPlayer(gameName)) {
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
              game_id: gameId,
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
    // Txs seen on game wallets but coming from a mère that is not an active mère
    // of THIS game (another game's cashout, or a retired mère) — deliberately not
    // imported. Surfaced so a mis-registered cashout wallet doesn't fail silently.
    skipped_from_mere: skippedFromMere,
    wallet_meres_configured: mereAddrs.size,
    cashout_wallets_configured: cashoutOwners.size,
    results,
  });
}
