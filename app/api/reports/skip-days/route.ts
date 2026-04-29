import { NextResponse } from "next/server";
import { upsertReportSkipDay, deleteReportSkipDay } from "@/lib/queries";

export async function POST(req: Request) {
  const body = await req.json();
  const { club_id, game_id, skip_date, reason } = body;
  if (!club_id || !game_id || !skip_date) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  upsertReportSkipDay({ club_id, game_id, skip_date, reason });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  deleteReportSkipDay(id);
  return NextResponse.json({ ok: true });
}
