import { NextRequest, NextResponse } from "next/server";
import { dzpkAutoMatchEnabled } from "@/lib/funnels/dzpk/config";
import {
  getReconciliationQueue, getReconciliationStats, searchLeads, resolveManually,
  runMatching, flagContestedLinks, getObservedMatches,
} from "@/lib/funnels/dzpk/matcher";

/**
 * API de l'écran de réconciliation dzpk.
 *
 * Protégée par le middleware d'auth de session (ce chemin n'est PAS dans la
 * liste d'exclusions) : c'est un écran de back-office, pas un endpoint machine.
 * D'où l'absence de `x-admin-token` ici, contrairement aux routes api/admin.
 *
 *   GET                      → file + compteurs
 *   GET ?q=…                 → recherche de leads
 *   POST {club_message_id,
 *         lead_id}           → rattachement manuel, mémorisé
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q");
  if (q !== null) return NextResponse.json({ results: searchLeads(q) });

  return NextResponse.json({
    stats: getReconciliationStats(),
    queue: getReconciliationQueue(),
    // Le troisième état : certains, calculés, PAS appliqués. Listés item par
    // item pour être vérifiés un à un avant la levée du drapeau.
    observed: getObservedMatches(),
    autoMatchEnabled: dzpkAutoMatchEnabled(),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const { club_message_id, lead_id, operator } = body;

  if (!Number.isInteger(club_message_id) || !Number.isInteger(lead_id)) {
    return NextResponse.json({ error: "club_message_id et lead_id requis (entiers)" }, { status: 400 });
  }

  // Le rattachement manuel MÉMORISE le lien : les notifications suivantes
  // portant le même nom se rattacheront seules. C'est le cœur du self-learning,
  // et la raison pour laquelle cet écran s'allège avec le temps.
  const res = resolveManually(club_message_id, lead_id, String(operator ?? "baki"));
  if (!res.ok) return NextResponse.json(res, { status: 400 });

  // Le lien qu'on vient d'apprendre peut résoudre d'AUTRES notifications déjà en
  // attente — typiquement les suivantes du même joueur. On les propage tout de
  // suite, sinon elles resteraient affichées alors qu'elles n'attendent plus
  // rien, et Baki les rattacherait une seconde fois.
  flagContestedLinks();
  runMatching();

  return NextResponse.json({
    ok: true,
    stats: getReconciliationStats(),
    queue: getReconciliationQueue(),
    observed: getObservedMatches(),
    autoMatchEnabled: dzpkAutoMatchEnabled(),
  });
}
