// XPoker Twd — grand livre chips : buy-in, cash-out, règlement club reçu, ajustement.
// Route fine (invariant #2). Le sens est imposé par la nature dans addLedgerLineOn ;
// un règlement club exige son import (F1). 'action_paid' / 'rb_paid' n'existent
// pas ici : ils naissent au markPaid (étape 4).
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { addLedgerLineOn } from "@/lib/games/xpoker/engine";

const KINDS = new Set(["club_settlement", "buyin", "cashout", "adjustment"]);
const DIRECTION: Record<string, "in" | "out" | null> = { buyin: "out", cashout: "in", club_settlement: null, adjustment: null };

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  if (!b || !KINDS.has(b.kind) || typeof b.occurred_at !== "string") return NextResponse.json({ error: "kind, occurred_at, chips requis" }, { status: 400 });
  const direction = DIRECTION[b.kind] ?? (b.direction === "out" ? "out" : b.direction === "in" ? "in" : null);
  if (!direction) return NextResponse.json({ error: "direction ('in' | 'out') requise pour cette nature" }, { status: 400 });
  const r = addLedgerLineOn(getDb(), {
    occurred_at: b.occurred_at, kind: b.kind, direction, chips: Number(b.chips),
    player_id: b.player_id ? Number(b.player_id) : null, member_id: b.member_id ? String(b.member_id) : null,
    import_id: b.import_id ? Number(b.import_id) : null, note: b.note ?? null,
  });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
  return NextResponse.json({ ok: true, id: r.id });
}
