import { NextResponse } from "next/server";
import { getClubSchedules, upsertClubSchedule, deleteClubSchedule } from "@/lib/queries";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(getClubSchedules());
}

export async function POST(req: Request) {
  const body = await req.json();
  const { club_id, game_id, cadence, start_date } = body;
  if (!club_id || !game_id || !cadence || !start_date) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  upsertClubSchedule({ club_id, game_id, cadence, start_date });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  deleteClubSchedule(id);
  return NextResponse.json({ ok: true });
}
