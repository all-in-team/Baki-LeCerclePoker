import { NextRequest, NextResponse } from "next/server";
import { getPlayers, insertPlayer } from "@/lib/queries";

// ?include_archived=1 : pour AFFICHER ou configurer (modale des wallets TELE) ; sans, la liste
// sert aux sélecteurs d'ajout et exclut les archivés (cf. getPlayers).
export async function GET(req: NextRequest) {
  return NextResponse.json(getPlayers({ includeArchived: req.nextUrl.searchParams.get("include_archived") === "1" }));
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
