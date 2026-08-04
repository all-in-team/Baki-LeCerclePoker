// Source de l'autocomplétion de la grille : pseudos déjà vus, leur Member ID et
// leur dernier deal. Purement indicatif — rien ne se rattache d'ici.
import { NextResponse } from "next/server";
import { getKnownEntrants } from "@/lib/funnels/nexa/affiliate-ingest";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, entrants: getKnownEntrants() });
  } catch (e: any) {
    console.error("[NEXA_AFFILIATE_KNOWN]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
