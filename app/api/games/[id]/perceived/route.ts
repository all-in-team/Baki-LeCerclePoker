import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { perceivedPeriodsOn, setPerceivedDealOn } from "@/lib/affiliate/agent-rates";

// Deal PERÇU d'un game, versionné par semaine. Route mince : toute la règle (aperçu
// par agent, gel des semaines payées, rétroactif) vit dans lib/affiliate/agent-rates.ts.

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: NextRequest, { params }: Ctx) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "id invalide" }, { status: 400 });
  return NextResponse.json(perceivedPeriodsOn(getDb(), id));
}

// Corps : { action_pct, rakeback_pct|null, insurance_pct|null, start_week: lundi | null (origine), note?, dry_run?, confirm_retroactive? }
export async function POST(req: NextRequest, { params }: Ctx) {
  const id = Number((await params).id);
  const b = await req.json().catch(() => null);
  const numOrNull = (v: unknown) => v === null || typeof v === "number";
  if (!Number.isInteger(id) || id <= 0 || !b || typeof b.action_pct !== "number" || !numOrNull(b.rakeback_pct) || !numOrNull(b.insurance_pct)
      || !(b.start_week === null || typeof b.start_week === "string"))
    return NextResponse.json({ ok: false, error: "Corps invalide : { action_pct, rakeback_pct|null, insurance_pct|null, start_week (lundi ou null) } attendu." }, { status: 400 });
  return NextResponse.json(setPerceivedDealOn(getDb(), {
    game_id: id, action_pct: b.action_pct, rakeback_pct: b.rakeback_pct, insurance_pct: b.insurance_pct,
    start_week: b.start_week, note: typeof b.note === "string" ? b.note : null,
    dry_run: b.dry_run === true, confirm_retroactive: b.confirm_retroactive === true,
  }));
}
