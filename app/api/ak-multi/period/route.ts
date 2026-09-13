// AK multi-Account — périodes.
// GET  ?player_id            → historique des périodes figées + leurs soldes.
// POST { mode: "preview" }   → aperçu de la clôture (même fonction que le lock, rien persisté).
// POST { mode: "lock" }      → fige la période (une transaction : règlement + période + soldes).
// DELETE ?player_id&period_id → déverrouille la DERNIÈRE période.
//
// Route fine (invariant #2). Le corps porte des SOLDES et un instant, jamais un
// montant : résultat et part sont recalculés au lock. `now` vient du serveur, en
// heure murale (lib/pool/clock) — jamais du navigateur.
import { NextRequest, NextResponse } from "next/server";
import { previewPoolPeriod, lockPoolPeriod, unlockPoolPeriod, getPeriods, getPeriodBalances } from "@/lib/pool/periods";
import { poolNow } from "@/lib/pool/clock";

function parseArgs(b: any) {
  if (!b || !Number.isInteger(b.player_id) || typeof b.closed_at !== "string" || !Array.isArray(b.balances)) return null;
  for (const x of b.balances) {
    if (!x || (x.account_id !== null && !Number.isInteger(x.account_id)) || !["ak", "okpay", "main"].includes(x.wallet_kind)
        || typeof x.balance !== "number" || typeof x.observed_at !== "string") return null;
  }
  return {
    player_id: b.player_id as number, closed_at: b.closed_at as string, balances: b.balances,
    pool_open_manual: typeof b.pool_open_manual === "number" ? b.pool_open_manual : null,
    note: typeof b.note === "string" && b.note.trim() ? b.note.trim() : null,
    now: poolNow(),
  };
}

export async function GET(req: NextRequest) {
  const playerId = Number(req.nextUrl.searchParams.get("player_id"));
  if (!Number.isInteger(playerId) || playerId <= 0) return NextResponse.json({ error: "player_id invalide." }, { status: 400 });
  const periods = getPeriods(playerId).map(p => ({ ...p, balances: getPeriodBalances(p.id) }));
  return NextResponse.json({ ok: true, periods, now: poolNow() });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => null);
    const args = parseArgs(b);
    if (!args) return NextResponse.json({ error: "Corps invalide : { mode, player_id, closed_at, balances[], pool_open_manual?, note? } attendu." }, { status: 400 });
    if (b.mode === "preview") {
      const r = previewPoolPeriod(args);
      if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 400 });
      return NextResponse.json({ ok: true, preview: r.preview });
    }
    if (b.mode === "lock") {
      const r = lockPoolPeriod(args);
      // 409 : le refus porte sur l'ÉTAT (blocker), pas sur la forme. Le message dit quoi faire.
      if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
      return NextResponse.json({ ok: true, period_id: r.period_id, settlement_id: r.settlement_id, computed: r.computed });
    }
    return NextResponse.json({ error: "mode attendu : preview | lock." }, { status: 400 });
  } catch (e: any) {
    console.error("[AKMULTI_PERIOD_POST]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const playerId = Number(q.get("player_id")), periodId = Number(q.get("period_id"));
  if (!Number.isInteger(playerId) || !Number.isInteger(periodId)) return NextResponse.json({ error: "player_id / period_id invalides." }, { status: 400 });
  const r = unlockPoolPeriod(playerId, periodId);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
  return NextResponse.json({ ok: true, closed_at: r.closed_at });
}
