import { loadWalletLedger, type WalletLedgerData, type WalletLedgerRow } from "@/lib/games/wallet-ledger";

/**
 * KKPOKER ledger loader — thin wrapper around the generic wallet-game loader
 * (lib/games/wallet-ledger.tsx), which is the generalized version of the
 * original KKPOKER-specific loader validated via the shadow route. Kept so
 * the shadow page (app/kkpoker/pnl/shadow) and the real page share the exact
 * same data path.
 */

export type KkLedgerRow = WalletLedgerRow;
export type KkLedgerData = WalletLedgerData;

export function loadKkpokerLedger(
  params: { filter?: string; player?: string },
  basePath = "/kkpoker/pnl",
): KkLedgerData {
  return loadWalletLedger(params, {
    gameName: "KKPOKER",
    extrasKey: "kkpoker",
    title: "KKPOKER — P&L",
    basePath,
  });
}
