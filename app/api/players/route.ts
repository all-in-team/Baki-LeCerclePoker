import { NextRequest, NextResponse } from "next/server";
import { getPlayers, insertPlayer } from "@/lib/queries";

export async function GET() {
  return NextResponse.json(getPlayers());
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.name?.trim()) return NextResponse.json({ error: "Name required" }, { status: 400 });
  const id = insertPlayer({
    name: body.name.trim(),
    telegram_handle: body.telegram_handle || undefined,
    telegram_phone: body.telegram_phone || undefined,
    status: "active",
    tier: body.tier || "A",
  });
  return NextResponse.json({ id }, { status: 201 });
}
