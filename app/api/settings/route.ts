import { NextRequest, NextResponse } from "next/server";
import { getAllSettings, setSetting, deleteSetting } from "@/lib/queries";

export async function GET() {
  return NextResponse.json(getAllSettings());
}

export async function PATCH(req: NextRequest) {
  const body = await req.json() as Record<string, string | null>;
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === "") deleteSetting(key);
    else if (typeof value === "string") setSetting(key, value.trim());
  }
  return NextResponse.json({ ok: true });
}
