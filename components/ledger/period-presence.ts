/**
 * Which ledger rows the period filter shows — display-only, no money math.
 *
 * A row is shown when the player moved money in the period (deposit OR withdrawal),
 * OR when something is still to settle for them (unsettled tx, all history, or a locked
 * settlement not yet paid). The second rule is non-negotiable: a pending settlement never
 * disappears behind a filter. Such rows are marked "hors période · à régler" — on KKPOKER,
 * where the "à régler" pills are hidden, that mark is the only explanation of the row.
 *
 * activeIds = null → lifetime → nothing is hidden.
 */

export type Presence = "active" | "settle-only" | "hidden";

export const SETTLE_ONLY_LABEL = "hors période · à régler";

/** Something still to settle: an unsettled tx (any date) or a locked settlement not yet paid. */
export function hasPendingSettlement(unsettledTxCount: number, settlementStatuses: readonly string[]): boolean {
  return unsettledTxCount > 0 || settlementStatuses.includes("locked");
}

export function periodPresence(playerId: number, activeIds: ReadonlySet<number> | null, toSettle: boolean): Presence {
  if (activeIds === null || activeIds.has(playerId)) return "active";
  return toSettle ? "settle-only" : "hidden";
}

export function summarizePresence(
  playerIds: number[],
  activeIds: ReadonlySet<number> | null,
  toSettle: (playerId: number) => boolean,
): { presence: Map<number, Presence>; active: number; settleOnly: number; hidden: number } {
  const presence = new Map<number, Presence>();
  let active = 0, settleOnly = 0, hidden = 0;
  for (const id of playerIds) {
    const p = periodPresence(id, activeIds, toSettle(id));
    presence.set(id, p);
    if (p === "active") active++; else if (p === "settle-only") settleOnly++; else hidden++;
  }
  return { presence, active, settleOnly, hidden };
}
