import { NextRequest, NextResponse } from "next/server";
import { getReports, insertReport, insertEntry, getApps } from "@/lib/queries";

export async function GET() {
  return NextResponse.json(getReports());
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { app_id, period_label, period_start, period_end, raw_content, entries } = body;

  if (!app_id || !period_label || !period_start || !period_end) {
    return NextResponse.json({ error: "app_id, period_label, period_start, period_end required" }, { status: 400 });
  }

  const reportId = insertReport({ app_id: Number(app_id), period_label, period_start, period_end, raw_content });

  if (entries && Array.isArray(entries)) {
    for (const e of entries) {
      insertEntry({
        report_id: Number(reportId),
        player_id: e.player_id || null,
        app_id: Number(app_id),
        period_label,
        period_start,
        period_end,
        gross_amount: Number(e.gross_amount),
        player_cut: Number(e.player_cut ?? 0),
        my_net: Number(e.my_net),
        notes: e.notes || null,
      });
    }
  }

  return NextResponse.json({ id: reportId }, { status: 201 });
}
