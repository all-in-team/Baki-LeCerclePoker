import { NextRequest, NextResponse } from "next/server";
import { getEntries, insertEntry } from "@/lib/queries";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  return NextResponse.json(getEntries({
    app_id: sp.get("app_id") ? Number(sp.get("app_id")) : undefined,
    player_id: sp.get("player_id") ? Number(sp.get("player_id")) : undefined,
    period: sp.get("period") ?? undefined,
  }));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const id = insertEntry({
    report_id: body.report_id || undefined,
    player_id: body.player_id || undefined,
    app_id: Number(body.app_id),
    period_label: body.period_label,
    period_start: body.period_start,
    period_end: body.period_end,
    gross_amount: Number(body.gross_amount),
    player_cut: Number(body.player_cut ?? 0),
    my_net: Number(body.my_net),
    notes: body.notes || undefined,
  });
  return NextResponse.json({ id }, { status: 201 });
}
