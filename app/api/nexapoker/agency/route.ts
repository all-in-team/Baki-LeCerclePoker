// Vue agence NEXAPOKER : rentrée hebdomadaire + position nette par joueur.
// Lecture seule. Route fine (invariant #2) : zéro math, tout vient de lib/funnels/nexa/agency.
import { NextResponse } from "next/server";
import { getNexaAgency } from "@/lib/funnels/nexa/agency";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, agency: getNexaAgency() });
  } catch (e: any) {
    console.error("[NEXAPOKER_AGENCY]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
