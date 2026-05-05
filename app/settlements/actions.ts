"use server";

import { computeWeekByDate } from "@/lib/settlement-engine";

export async function runSettlement(weekStart: string) {
  return computeWeekByDate(weekStart);
}
