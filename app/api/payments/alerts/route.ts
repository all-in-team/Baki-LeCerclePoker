import { NextResponse } from "next/server";
import { getPendingSettlements, getOverdueBuckets, getPaymentsTotals } from "@/lib/manual-settlement-engine";

export const dynamic = "force-dynamic";

/**
 * Compteurs du cockpit Paiements — alimente la pastille de la sidebar, visible
 * depuis n'importe quelle page (couche anti-oubli n°1 : plus besoin d'ouvrir la
 * room pour découvrir qu'un joueur a été zappé).
 *
 * Lecture pure, aucune math ici : tout vient de l'engine (invariant #2).
 *
 * FAIL LOUD : en cas d'erreur la réponse porte `failed: true` et la sidebar affiche
 * une pastille grise "!" au lieu de disparaître. Un système d'alerte qui tombe en
 * silence sur "0" est pire que pas d'alerte du tout — c'est exactement le mode de
 * défaillance que cette page existe pour empêcher.
 */

// Le scan est relu à chaque navigation ; un cache court évite de rejouer la lecture
// synchrone better-sqlite3 sur chaque clic de menu, sans jamais masquer un changement
// plus de quelques secondes.
const TTL_MS = 20_000;
let cache: { at: number; body: Record<string, unknown> } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < TTL_MS) return NextResponse.json(cache.body);
  try {
    const pending = getPendingSettlements();
    const overdue = getOverdueBuckets();
    const t = getPaymentsTotals(pending, overdue);
    const body = {
      pending: t.pending_count,
      overdue: t.overdue_count,
      oldest_pending_days: t.oldest_pending_days,
      unassigned_tx: t.unassigned_tx,
      failed: false,
    };
    cache = { at: Date.now(), body };
    return NextResponse.json(body);
  } catch (e: any) {
    console.error("[payments/alerts] FAILED:", e?.message);
    cache = null;
    return NextResponse.json({ pending: 0, overdue: 0, failed: true, error: e?.message ?? "unknown" }, { status: 200 });
  }
}
