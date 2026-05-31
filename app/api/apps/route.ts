import { NextRequest, NextResponse } from "next/server";
import { getApps, insertApp } from "@/lib/queries";

export async function GET() {
  return NextResponse.json(getApps());
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.name?.trim()) return NextResponse.json({ error: "Name required" }, { status: 400 });
  if (body.deal_value === undefined || body.deal_value === null || body.deal_value === "") return NextResponse.json({ error: "% Rakeback requis" }, { status: 400 });
  try {
    const id = insertApp({
      name: body.name.trim(),
      deal_type: "rakeback",
      deal_value: Number(body.deal_value),
      currency: body.currency || "EUR",
      payout_schedule: body.payout_schedule || "monthly",
      club_id: body.club_id?.trim() || null,
      club_name: body.club_name?.trim() || null,
      notes: body.notes || null,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (e: any) {
    const msg = e?.message ?? "";
    if (msg.includes("UNIQUE")) return NextResponse.json({ error: "Un app avec ce nom existe déjà" }, { status: 409 });
    return NextResponse.json({ error: msg || "Erreur serveur" }, { status: 500 });
  }
}
