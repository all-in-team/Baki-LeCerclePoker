import { NextResponse } from "next/server";
import { detectAliases } from "@/lib/aliases";

// Owner action "Re-scanner les alias" — re-runs shared-cashout detection. Display-only:
// writes to the alias tables, touches no money data. Stable (never moves an existing member).
export async function POST() {
  const result = detectAliases();
  return NextResponse.json({ ok: true, ...result });
}
