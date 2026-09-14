// AK multi-Account — grand livre OkPay.
// POST { text } → ingestion d'une page collée (filet de secours du transfert Telegram).
// GET ?wallet   → lignes de la wallet + ruptures de chaîne (mode audit).
import { NextRequest, NextResponse } from "next/server";
import { ingestPastedOkpay } from "@/lib/pool/okpay-forward";
import { getLedger } from "@/lib/pool/periods";
import { checkLedgerChain, sortLedgerDetailed } from "@/lib/pool/engine";

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => null);
    if (!b || typeof b.text !== "string" || b.text.trim() === "") return NextResponse.json({ error: "text attendu." }, { status: 400 });
    const r = ingestPastedOkpay(b.text);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 422 });
    return NextResponse.json(r);
  } catch (e: any) {
    console.error("[AKMULTI_OKPAY_POST]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");
  if (!wallet || !/^\d{5,15}$/.test(wallet)) return NextResponse.json({ error: "wallet invalide." }, { status: 400 });
  const lines = getLedger(wallet);
  const { sorted, ambiguities } = sortLedgerDetailed(lines);
  return NextResponse.json({ ok: true, lines: sorted, breaks: checkLedgerChain(lines), ambiguities });
}
