import { NextResponse } from "next/server";
import { lockWeek } from "@/lib/settlement-engine";

export async function POST(req: Request) {
  const body = await req.json();
  const { week_start } = body;
  if (!week_start) return NextResponse.json({ error: "Missing week_start" }, { status: 400 });

  const result = lockWeek(week_start);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}
