import { NextRequest, NextResponse } from "next/server";
import { getCrmNotes, insertCrmNote } from "@/lib/queries";

export async function GET(req: NextRequest) {
  const player_id = req.nextUrl.searchParams.get("player_id");
  return NextResponse.json(getCrmNotes(player_id ? Number(player_id) : undefined));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.player_id || !body.content?.trim())
    return NextResponse.json({ error: "player_id and content required" }, { status: 400 });
  const id = insertCrmNote({ player_id: Number(body.player_id), content: body.content.trim(), type: body.type || "note" });
  return NextResponse.json({ id }, { status: 201 });
}
