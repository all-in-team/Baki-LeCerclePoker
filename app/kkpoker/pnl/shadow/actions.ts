"use server";

import { getDb } from "@/lib/db";
import { previewSettlement } from "@/lib/manual-settlement-engine";

// Shadow route server actions — READ-ONLY BY CONSTRUCTION.
// Only the settlement preview (pure computation, zero DB writes) is exposed;
// lock/markPaid/unlock are deliberately NOT exported here, so the shadow page
// has no write path at all. The real KKPOKER migration will get its own
// actions file mirroring app/a5poker/pnl/actions.ts.

function kkGameId(): number {
  const row = getDb().prepare(`SELECT id FROM games WHERE name = 'KKPOKER'`).get() as { id: number } | undefined;
  if (!row) throw new Error("KKPOKER game not found");
  return row.id;
}

export async function previewShadowAction(playerId: number, txIds: number[]) {
  return previewSettlement(kkGameId(), playerId, txIds);
}
