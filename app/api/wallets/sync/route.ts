import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { insertWalletTransactionByHash, getActiveWalletMeresForGame, getAllWalletMereAddressesAnyStatus, getAllGameWalletsByPlayer, getAllCashoutsByPlayer, getOwnCashoutAddrsByPlayer, getPlayersOnGame, getPlayerIdsWithDealOnGame, isGameArchived } from "@/lib/queries";
import { isKnownTokenContract, tokenContractLabel, PLAUSIBILITY_THRESHOLD_USDT } from "@/lib/wallet-address";

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
  let droppedNonTransfer = 0;

  do {
    const params = new URLSearchParams({
      limit: "200",
      contract_address: USDT_CONTRACT,
      only_confirmed: "true",
    });
    if (fingerprint) params.set("fingerprint", fingerprint);

    const url = `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?${params}`;
    const json = await fetchTronGrid(url, headers);

    // ⚠️ MONEY-CRITICAL — ne garder QUE les Transfer.
    //
    // Cet endpoint TronGrid ne renvoie pas que des transferts : il mélange les
    // événements `Approval` du même contrat. Un `approve` illimité porte une
    // valeur de 2^256−1, que `toAmt()` divise par 10^6 et transforme en un dépôt
    // de 1,157920892373162e+71 USDT. C'est exactement l'origine des montants
    // astronomiques du 16/08/2026 : sur les 2 000 événements lus, 21 étaient des
    // Approval, dont 3 au montant max-uint — à eux seuls −3,47e+71 sur le solde.
    //
    // Ce filtre est indépendant de la garde d'adresse : une approbation signée
    // depuis la VRAIE wallet d'un joueur produirait le même dégât.
    for (const ev of json.data ?? []) {
      if (ev?.type && ev.type !== "Transfer") { droppedNonTransfer++; continue; }
      all.push(ev);
    }
    fingerprint = json.meta?.fingerprint ?? undefined;
    page++;
    if (page >= 10) break;
  } while (fingerprint);

  if (droppedNonTransfer > 0) {
    console.warn(`[SYNC] ${address.slice(0, 10)}… : ${droppedNonTransfer} événement(s) non-Transfer ignoré(s) (Approval, etc.)`);
  }

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
  // …EXCEPT when the sending address is the player's OWN registered cashout wallet:
  // that's the player re-injecting his cashed-out funds = a real buy-in (Baki
  // 2026-07-15, TJLB…/Max case — dual-registered as retired KK mère AND Max's
  // cashout; 10 real AKS buy-ins were silently skipped). An active mère of THIS
  // game still wins (fromGameMere → withdrawal) even if also registered as cashout.
  const ownCashoutsByPlayer = getOwnCashoutAddrsByPlayer();

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

  // ── Attribution des DÉPÔTS par expéditeur (A5POKER/WN, decision Hugo 2026-07-20) ──
  // A5 et WN partagent l'app (même wallet game de dépôt). La game d'un dépôt se lit sur
  // l'EXPÉDITEUR : envoyé depuis la wallet WN du joueur → dépôt WN ; toute autre source
  // (wallet A5, exchange, inconnu) → A5 par défaut. Un joueur WN-only (sans deal A5)
  // garde le game scanné. Les retraits ne changent pas (attribution par destination, Pass 2).
  const senderAttributionActive = gameName === "A5POKER" || gameName === "WN";
  let wnGameIdForDeposits: number | null = null;
  let a5GameIdForDeposits: number | null = null;
  let wnCashoutsByPlayer = new Map<number, Set<string>>();
  let a5DealPlayers = new Set<number>();
  if (senderAttributionActive) {
    wnGameIdForDeposits = getGameId("WN");
    a5GameIdForDeposits = getGameId("A5POKER");
    for (const c of getAllCashoutsByPlayer("WN")) {
      let set = wnCashoutsByPlayer.get(c.player_id);
      if (!set) wnCashoutsByPlayer.set(c.player_id, (set = new Set()));
      set.add(c.address.toLowerCase());
    }
    a5DealPlayers = getPlayerIdsWithDealOnGame("A5POKER");
  }
  function depositGameId(playerId: number, fromLower: string): number {
    if (!senderAttributionActive || wnGameIdForDeposits === null || a5GameIdForDeposits === null) return gameId!;
    if (wnCashoutsByPlayer.get(playerId)?.has(fromLower)) return wnGameIdForDeposits;
    if (a5DealPlayers.has(playerId)) return a5GameIdForDeposits;
    return gameId!;
  }

  type Result = { player: string; deposits: number; cashouts: number; error?: string };
  const results: Result[] = [];
  let totalDeposits = 0;
  let totalCashouts = 0;
  let skippedFromMere = 0;
  let skippedTokenContract = 0;
  let quarantined = 0;

  // Garde n°4 — la contrepartie est-elle un contrat de token connu ?
  // Un transfert dont l'autre bout est le contrat USDT n'est jamais un mouvement
  // de joueur. Doublon volontaire de la garde à l'enregistrement : celle-ci
  // couvre aussi les wallets entrées AVANT la mise en place des gardes.
  function skipIfTokenContract(addr: string | null | undefined, ctx: string): boolean {
    if (!addr || !isKnownTokenContract(addr)) return false;
    skippedTokenContract++;
    console.warn(`[SYNC ${gameName}] skip: contrepartie = contrat ${tokenContractLabel(addr)} (${addr}) — ${ctx}`);
    return true;
  }

  // Garde n°5 — seuil de vraisemblance.
  // Au-delà, la ligne est importée mais NON comptabilisée (status='quarantined')
  // et attend un arbitrage manuel dans le back-office. On n'ignore pas : une
  // vraie grosse transaction existe, elle doit rester visible et validable.
  function statusFor(amount: number, ctx: string): "active" | "quarantined" {
    if (!Number.isFinite(amount) || Math.abs(amount) <= PLAUSIBILITY_THRESHOLD_USDT) return "active";
    quarantined++;
    console.warn(`[SYNC ${gameName}] QUARANTAINE ${amount} USDT (> ${PLAUSIBILITY_THRESHOLD_USDT}) — ${ctx}`);
    return "quarantined";
  }

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
          // Exception: the player's own cashout address (see ownCashoutsByPlayer).
          const fromOwnCashout = ownCashoutsByPlayer.get(player.id)?.has(fromLower) ?? false;
          if (!fromGameMere && allMereAddrs.has(fromLower) && !fromOwnCashout) {
            skippedFromMere++;
            console.warn(`[SYNC ${gameName}] skip tx ${tx.transaction_id}: from mère ${fromLower.slice(0, 10)}… (another game or retired) → not a ${gameName} tx (player=${player.name})`);
            continue;
          }
          // Garde n°4 : l'expéditeur ET la wallet scannée. Scanner le contrat USDT
          // lui-même (l'incident) tombe sur le second test — chaque transfert reçu
          // par le contrat aurait `to` = contrat.
          if (skipIfTokenContract(tx.from, `pass 1 expéditeur, tx ${tx.transaction_id}, player=${player.name}`)) continue;
          if (skipIfTokenContract(walletAddr, `pass 1 wallet game scannée, player=${player.name}`)) break;
          const amount = toAmt(tx);
          const changed = insertWalletTransactionByHash({
            player_id: player.id,
            game_id: fromGameMere ? gameId : depositGameId(player.id, fromLower),
            type: fromGameMere ? "withdrawal" : "deposit",
            amount,
            currency: "USDT",
            tx_date: toDate(tx),
            tx_datetime: toDatetime(tx),
            tron_tx_hash: tx.transaction_id,
            counterparty_address: tx.from ?? null,
            status: statusFor(amount, `pass 1, tx ${tx.transaction_id}, player=${player.name}`),
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
          // Garde n°4, pass 2 : expéditeur et wallet cashout scannée.
          if (skipIfTokenContract(tx.from, `pass 2 expéditeur, tx ${tx.transaction_id}`)) continue;
          if (skipIfTokenContract(original, `pass 2 wallet cashout scannée`)) break;

          // ANTI-DOUBLE-COUNT (money-critical): a shared cashout address = same entity/team
          // (alias). The withdrawal must be counted ONCE, under a SINGLE player — never once
          // per sharer (that inflates net/agency). Deterministic + stable attribution: the
          // lowest player_id among the sharers (= the alias anchor, cf. detectAliases which
          // labels by lowest id). playerIds here are all registered on THIS game (Pass 2 is
          // game-scoped), which is the emitting mère's game — so this is exactly "the player
          // holding the address on the mère's game". INSERT OR IGNORE keeps prior rows intact
          // (no reattribution of already-imported tx).
          const attributedPid = Math.min(...playerIds);
          const amount = toAmt(tx);
          const changed = insertWalletTransactionByHash({
            player_id: attributedPid,
            game_id: gameId,
            type: "withdrawal",
            amount,
            currency: "USDT",
            tx_date: toDate(tx),
            tx_datetime: toDatetime(tx),
            tron_tx_hash: tx.transaction_id,
            counterparty_address: tx.from ?? null,
            status: statusFor(amount, `pass 2, tx ${tx.transaction_id}, player_id=${attributedPid}`),
          });
          if (changed) {
            totalCashouts++;
            const player = players.find(p => p.id === attributedPid);
            const r = results.find(r => player && r.player === player.name);
            if (r) r.cashouts++;
          }
        }
      } catch (e: any) {
        const names = playerIds.map(id => players.find(p => p.id === id)?.name ?? "?").join("/");
        results.push({ player: names, deposits: 0, cashouts: 0, error: e.message });
      }
    }
  }

  // Display-only: refresh player aliases (shared cashout wallets → same entity). Runs AFTER
  // all money logic, writes only to the alias tables, never blocks the sync response.
  try {
    const { detectAliases } = await import("@/lib/aliases");
    detectAliases();
  } catch (e: any) {
    console.warn("[SYNC] detectAliases failed (non-blocking):", e?.message ?? e);
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
    // Transferts écartés parce que leur contrepartie (ou la wallet scannée) est un
    // contrat de token connu. > 0 = une wallet douteuse est encore enregistrée.
    skipped_token_contract: skippedTokenContract,
    // Lignes importées mais NON comptabilisées, en attente d'arbitrage sur /wallets/quarantine.
    quarantined,
    wallet_meres_configured: mereAddrs.size,
    cashout_wallets_configured: cashoutOwners.size,
    results,
  });
}
