// Compteur « À répondre » — interrogé toutes les 30 s par l'onglet ouvert.
//
// Endpoint volontairement minuscule : un COUNT, rien d'autre. La page complète
// (`/nexa-funnel`) recharge des milliers de lignes ; la rafraîchir toutes les 30 s
// pour savoir s'il y a du nouveau serait absurde.
import { NextResponse } from "next/server";
import { countNeedsReply } from "@/lib/funnels/live-takeover";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { count: countNeedsReply() },
    // Un compteur temps réel ne doit jamais être servi depuis un cache.
    { headers: { "Cache-Control": "no-store" } },
  );
}
