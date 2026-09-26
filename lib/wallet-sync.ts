// Sync wallet TRON d'une room : Pass 1 (wallets game) + Pass 2 (wallets cashout).
// Appelée par POST /api/wallets/sync (bouton) et par le job de nuit (lib/cron.ts).
// Chaque passage est tracé dans wallet_sync_runs : « dernière sync RÉUSSIE » d'une room =
// dernier passage terminé sans aucune erreur de wallet (garde-fou du statut automatique,
// lib/player-status-auto.ts).
import { getDb } from "@/lib/db";
import { insertWalletTransactionByHash, getActiveWalletMeresForGame, getOperatorMereAddressesAnyStatus, getAllGameWalletsByPlayer, getAllCashoutsByPlayer, getOwnCashoutAddrsByPlayer, getPlayersOnGame, getPlayerIdsWithDealOnGame, isGameArchived } from "@/lib/queries";
import { classifyIncomingOnGameWallet } from "@/lib/wallet-sync-rules";
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
// Un appel TronGrid sans réponse ne doit pas bloquer une sync indéfiniment (le job de nuit
// enchaîne sur le recalcul des statuts) : passé ce délai, la wallet part en erreur, comme
// un 500, et le passage n'est pas compté réussi. Aucune tx n'est perdue : le passage
// suivant relit tout l'historique (dédup tron_tx_hash).
const FETCH_TIMEOUT_MS = 30_000;

// État du bridage PARTAGÉ par tout le process via globalThis : le bouton (bundle de la
// route) et le job de nuit (instrumentation → lib/cron.ts) peuvent charger ce module deux
// fois, et deux compteurs séparés dépasseraient 1 RPS (audit money 2026-09-27). Les appels
// sont en outre SÉRIALISÉS (chaîne de promesses) : deux appelants qui attendent ensemble
// ne repartent plus au même instant.
type TronGridGate = { lastCallAt: number; chain: Promise<void> };
const gate: TronGridGate = ((globalThis as any).__lecercleTronGridGate ??= { lastCallAt: 0, chain: Promise.resolve() });

function throttle(): Promise<void> {
  const turn = gate.chain.then(async () => {
    const wait = gate.lastCallAt + MIN_SPACING_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    gate.lastCallAt = Date.now();
  });
  gate.chain = turn.catch(() => {});
  return turn;
}

async function fetchTronGrid(url: string, headers: Record<string, string>): Promise<any> {
  const maxRetries = 5;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await throttle();
    const res = await fetch(url, { headers, next: { revalidate: 0 }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < maxRetries) {
      await new Promise(r => setTimeout(r, RETRY_AFTER_429_MS));
      gate.lastCallAt = Date.now(); // reset so we wait the full spacing again
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

// Corps d'un passage de sync, DÉPLACÉ tel quel depuis le POST de app/api/wallets/sync/route.ts
// pour que le job de nuit puisse l'appeler : seules les réponses HTTP sont devenues des
// valeurs de retour { status, body }. Aucune règle d'import, d'attribution ou de garde ne
// change. Passer par syncGameWallets() (qui trace le passage), jamais par cette fonction.
export type SyncOutcome = { status: number; body: any };
async function runGameSync(gameName: string): Promise<SyncOutcome> {
  if (isGameArchived(gameName)) {
    return { status: 403, body: { error: `Game ${gameName} archived, sync disabled` } };
  }

  const gameId = getGameId(gameName);
  if (!gameId)
    return { status: 200, body: { ok: false, message: `Game ${gameName} not found.` } };

  const players = getPlayersOnGame(gameName);
  if (players.length === 0)
    return { status: 200, body: { ok: true, imported: 0, message: "Aucun joueur avec un Wallet Game configuré." } };

  const mereAddrs = getActiveWalletMeresForGame(gameId);
  if (mereAddrs.size === 0) {
    console.warn(`[SYNC] No active wallet_mère for game=${gameName}, withdrawals cannot be detected`);
  }
  // Mères de nature 'operator' UNIQUEMENT, tous statuts : un transfert venant
  // d'une mère retirée reste de l'argent opérateur, jamais un dépôt joueur
  // (history: retired KKPOKER mère funding a player's OKPOKER/AKS game wallets
  // got imported as 8 phantom deposits).
  // Les mères 'room_hot' en sont exclues — elles versent l'argent de la room, pas
  // le tien, donc un entrant sur une wallet de dépôt EST un dépôt. Elles restent
  // dans mereAddrs ci-dessus quand elles sont actives sur CE game, et le Pass 2
  // continue de leur attribuer les cashouts qu'elles paient.
  const operatorMereAddrs = getOperatorMereAddressesAnyStatus();
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
  // Détail des lignes écartées par la garde mère — remonté à l'UI pour qu'un
  // écart ne puisse plus passer inaperçu (le bouton n'affichait que `imported`).
  const skippedDetails: { player: string; game_wallet: string; from: string; amount: number; tx_datetime: string; tron_tx_hash: string }[] = [];
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
          // Règle unique, testable hors réseau : lib/wallet-sync-rules.ts.
          // Strict per-game rule (Baki 2026-07-07): a cashout of game X comes ONLY
          // from a mère OF GAME X. An incoming from another game's mère OPÉRATEUR
          // is your own money, never a buy-in, so it is skipped. Exceptions: the
          // player's own cashout address (réinjection), et les mères 'room_hot'
          // dont l'argent est celui de la room (→ vrai dépôt).
          const verdict = classifyIncomingOnGameWallet({
            from: fromLower,
            gameMereAddrs: mereAddrs,
            operatorMereAddrs,
            ownCashoutAddrs: ownCashoutsByPlayer.get(player.id) ?? new Set<string>(),
          });
          if (verdict.action === "skip") {
            skippedFromMere++;
            skippedDetails.push({
              player: player.name,
              game_wallet: walletAddr,
              from: tx.from ?? "",
              amount: toAmt(tx),
              tx_datetime: toDatetime(tx),
              tron_tx_hash: tx.transaction_id,
            });
            console.warn(`[SYNC ${gameName}] skip tx ${tx.transaction_id}: from mère opérateur ${fromLower.slice(0, 10)}… (another game or retired) → not a ${gameName} tx (player=${player.name})`);
            continue;
          }
          const fromGameMere = verdict.action === "withdrawal";
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

  return { status: 200, body: {
    ok: true,
    imported: totalDeposits + totalCashouts,
    deposits: totalDeposits,
    cashouts: totalCashouts,
    // Txs seen on game wallets but coming from a mère that is not an active mère
    // of THIS game (another game's cashout, or a retired mère) — deliberately not
    // imported. Surfaced so a mis-registered cashout wallet doesn't fail silently.
    skipped_from_mere: skippedFromMere,
    // Les lignes concrètes, pour que l'UI puisse les montrer plutôt qu'un compteur muet.
    skipped_details: skippedDetails,
    // Transferts écartés parce que leur contrepartie (ou la wallet scannée) est un
    // contrat de token connu. > 0 = une wallet douteuse est encore enregistrée.
    skipped_token_contract: skippedTokenContract,
    // Lignes importées mais NON comptabilisées, en attente d'arbitrage sur /wallets/quarantine.
    quarantined,
    wallet_meres_configured: mereAddrs.size,
    cashout_wallets_configured: cashoutOwners.size,
    results,
  } };
}

export type WalletSyncTrigger = "manual" | "nightly" | "sunday";

/**
 * Lance la sync d'une room et trace le passage. Réussi (ok = 1) = passage allé au bout, sans
 * aucune erreur de wallet : un TronGrid en échec sur UNE wallet suffit à ne pas compter la
 * room comme synchronisée (une tx manquée ferait passer à tort un joueur en inactive).
 * Une room archivée ou inconnue n'est pas tracée (aucun passage n'a eu lieu).
 */
export async function syncGameWallets(gameName: string, trigger: WalletSyncTrigger): Promise<SyncOutcome> {
  const db = getDb();
  const game = db.prepare(`SELECT id FROM games WHERE name = ?`).get(gameName) as { id: number } | undefined;
  const startedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  const record = (ok: boolean, walletErrors: number, imported: number | null, error: string | null) => {
    if (!game) return;
    try {
      db.prepare(`INSERT INTO wallet_sync_runs (game_id, trigger, started_at, finished_at, ok, wallet_errors, imported, error)
                  VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?)`)
        .run(game.id, trigger, startedAt, ok ? 1 : 0, walletErrors, imported, error);
    } catch (e: any) {
      // La trace ne doit jamais faire échouer une sync qui a importé : au pire la room
      // paraît « non synchronisée » et le statut auto la retient (sens prudent).
      console.error(`[SYNC ${gameName}] trace wallet_sync_runs impossible:`, e?.message ?? e);
    }
  };
  let out: SyncOutcome;
  try {
    out = await runGameSync(gameName);
  } catch (e: any) {
    record(false, 0, null, String(e?.message ?? e).slice(0, 500));
    throw e;
  }
  const v = syncRunVerdict(out);
  if (v) record(v.ok, v.walletErrors, v.imported, v.error);
  return out;
}

/**
 * Verdict d'un passage terminé (pur, testable hors réseau). null = rien à tracer (room
 * archivée : 403). Réussi = ok: true ET aucune ligne `results` en erreur.
 */
export function syncRunVerdict(out: SyncOutcome):
  { ok: boolean; walletErrors: number; imported: number | null; error: string | null } | null {
  if (out.status !== 200) return null;
  const failed = Array.isArray(out.body?.results) ? out.body.results.filter((r: { error?: string }) => r.error) as { player: string; error: string }[] : [];
  const errs = failed.length;
  const ok = out.body?.ok === true && errs === 0;
  // Les wallets en erreur sont nommées (joueur + début d'adresse + motif) : l'alerte ops dit
  // QUOI corriger quand une adresse morte bloque la room.
  const detail = failed.slice(0, 3).map(f => `${f.player} : ${f.error}`).join(" | ") + (errs > 3 ? ` | … +${errs - 3}` : "");
  return { ok, walletErrors: errs, imported: typeof out.body?.imported === "number" ? out.body.imported : null,
    error: ok ? null : (errs ? `${errs} wallet(s) en erreur — ${detail}`.slice(0, 500) : String(out.body?.message ?? "échec")) };
}
