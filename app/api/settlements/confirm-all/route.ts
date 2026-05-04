import { NextResponse } from "next/server";
import { confirmAllAuto } from "@/lib/settlement-engine";

export async function POST(req: Request) {
  const body = await req.json();
  const { week_start } = body;
  if (!week_start) return NextResponse.json({ error: "Missing week_start" }, { status: 400 });

  const result = confirmAllAuto(week_start);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}
