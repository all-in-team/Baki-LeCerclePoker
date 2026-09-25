import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { rateHistoryOn, setAgentRateOn } from "@/lib/affiliate/agent-rates";

// Taux agent par (filleul, game), versionné par semaine. Route mince : validation de
// forme ici, toute la règle (gel des semaines payées, rétroactif, 0 % avec note) dans
// le moteur lib/affiliate/agent-rates.ts.

export async function GET(req: NextRequest) {
  const relId = Number(req.nextUrl.searchParams.get("relationship_id"));
  if (!Number.isInteger(relId) || relId <= 0) return NextResponse.json({ error: "relationship_id requis" }, { status: 400 });
  return NextResponse.json(rateHistoryOn(getDb(), relId));
}

// Corps : { relationship_id, game_id, player_pct (% du résultat joueur, converti côté serveur)
//           OU agent_pct (% de la part agence), start_week: 'YYYY-MM-DD' (lundi) | null (origine),
//           note?, dry_run?, confirm_retroactive? }
// Réponse : le résultat du moteur tel quel. ok:false + needs_confirmation = aperçu à
// confirmer ; ok:false + frozen = refus dur (semaines payées) ; ok:false seul = invalide.
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  const isNum = (v: unknown) => typeof v === "number";
  if (!b || !Number.isInteger(b.relationship_id) || !Number.isInteger(b.game_id) || isNum(b.agent_pct) === isNum(b.player_pct)
      || !(b.start_week === null || typeof b.start_week === "string"))
    return NextResponse.json({ ok: false, error: "Corps invalide : { relationship_id, game_id, player_pct OU agent_pct (un seul, nombre), start_week (lundi ou null) } attendu." }, { status: 400 });
  const r = setAgentRateOn(getDb(), {
    relationship_id: b.relationship_id, game_id: b.game_id,
    ...(isNum(b.player_pct) ? { player_pct: b.player_pct } : { agent_pct: b.agent_pct }),
    start_week: b.start_week,
    note: typeof b.note === "string" ? b.note : null,
    dry_run: b.dry_run === true, confirm_retroactive: b.confirm_retroactive === true,
  });
  return NextResponse.json(r);
}
