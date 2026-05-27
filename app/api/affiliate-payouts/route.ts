import { NextResponse } from "next/server";
import { getPendingPayoutsForAllAffiliates } from "@/lib/queries/affiliate";

export async function GET() {
  const payouts = getPendingPayoutsForAllAffiliates();
  return NextResponse.json(payouts);
}
