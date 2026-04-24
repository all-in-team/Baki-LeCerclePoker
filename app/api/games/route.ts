import { NextResponse } from "next/server";
import { getGames } from "@/lib/queries";

export async function GET() {
  return NextResponse.json(getGames());
}
