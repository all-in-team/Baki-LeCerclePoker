import { NextRequest, NextResponse } from "next/server";
import { getPlayerCashouts, setPlayerCashouts } from "@/lib/queries";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(getPlayerCashouts(Number(id)));
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  if (!Array.isArray(body.addresses)) {
    return NextResponse.json({ error: "addresses array required" }, { status: 400 });
  }
  const cleaned = body.addresses
    .filter((a: any) => typeof a === "object" && typeof a.address === "string")
    .map((a: any) => ({ address: a.address.trim(), label: a.label?.trim() || null }))
    .filter((a: any) => a.address.length > 0);
  setPlayerCashouts(Number(id), cleaned);
  return NextResponse.json({ ok: true, count: cleaned.length });
}
