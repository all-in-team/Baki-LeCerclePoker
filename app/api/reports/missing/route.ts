import { NextResponse } from "next/server";
import { getMissingReports } from "@/lib/queries";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(getMissingReports());
}
