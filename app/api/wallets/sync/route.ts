import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { insertWalletTransactionByHash } from "@/lib/queries";

const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// ─── DIRECTION RULE (never change without understanding this fully) ───────────
//
// On TELE, every account has a dedicated TRC20 wallet (tron_address).
// ALL deposits and withdrawals go through that same wallet.
//
//   USDT arrives  INTO  tron_address  →  player is funding their account  →  DEPOSIT
//   USDT leaves   FROM  tron_address  →  player is cashing out             →  WITHDRAWAL
//
// Net P&L = sum(WITHDRAWAL) − sum(DEPOSIT)
//
// ─────────────────────────────────────────────────────────────────────────────

function classifyTronTx(
  tx: { to?: string; from?: string },
  playerAddress: string
): "deposit" | "withdrawal" | null {
  const addr   = playerAddress.toLowerCase();
  const toAddr = (tx.to   ?? "").toLowerCase();
  const frAddr = (tx.from ?? "").toLowerCase();

  if (toAddr === addr) return "deposit";
  if (frAddr === addr) return "withdrawal";
  return null;
}

async function fetchTronTxs(address: string): Promise<any[]> {
  const apiKey = process.env.TRONGRID_API_KEY;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

  const url =
    `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20` +
    `?limit=200&contract_address=${USDT_CONTRACT}&only_confirmed=true`;

  const res = await fetch(url, { headers, next: { revalidate: 0 } });
  if (!res.ok) throw new Error(`TronGrid ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.data ?? [];
}

function getTeleGameId(): number | null {
  const row = getDb().prepare(`SELECT id FROM games WHERE name = 'TELE'`).get() as { id: number } | undefined;
  return row?.id ?? null;
}

function getPlayersOnTele() {
  return getDb().prepare(`
    SELECT p.id, p.name, p.tron_address
    FROM players p
    JOIN player_game_deals pgd ON pgd.player_id = p.id
    JOIN games g ON g.id = pgd.game_id AND g.name = 'TELE'
    WHERE p.tron_address IS NOT NULL AND p.tron_address != ''
  `).all() as { id: number; name: string; tron_address: string }[];
}

export async function POST() {
  const teleGameId = getTeleGameId();
  if (!teleGameId)
    return NextResponse.json({ ok: true, imported: 0, message: "TELE game not found." });

  const players = getPlayersOnTele();

  if (players.length === 0)
    return NextResponse.json({ ok: true, imported: 0, message: "No players have a Tron address configured." });

  let totalImported = 0;
  const results: { player: string; imported: number; deposits: number; withdrawals: number; error?: string }[] = [];

  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    if (i > 0) await new Promise(r => setTimeout(r, 300));

    try {
      const txs = await fetchTronTxs(player.tron_address);
      let imported = 0;
      let deposits = 0;
      let withdrawals = 0;

      for (const tx of txs) {
        const type = classifyTronTx(tx, player.tron_address);
        if (!type) continue;

        const decimals = tx.token_info?.decimals ?? 6;
        const amount   = Number(tx.value) / Math.pow(10, decimals);
        const tx_date  = new Date(tx.block_timestamp).toISOString().slice(0, 10);

        const changed = insertWalletTransactionByHash({
          player_id: player.id,
          game_id: teleGameId,
          type,
          amount,
          currency: "USDT",
          tx_date,
          tron_tx_hash: tx.transaction_id,
        });

        if (changed) {
          imported++;
          if (type === "deposit")    deposits++;
          if (type === "withdrawal") withdrawals++;
        }
      }

      totalImported += imported;
      results.push({ player: player.name, imported, deposits, withdrawals });
    } catch (e: any) {
      results.push({ player: player.name, imported: 0, deposits: 0, withdrawals: 0, error: e.message });
    }
  }

  return NextResponse.json({ ok: true, imported: totalImported, results });
}
