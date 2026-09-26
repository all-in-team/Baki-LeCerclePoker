import { NextRequest, NextResponse } from "next/server";
import { syncGameWallets } from "@/lib/wallet-sync";

// La sync elle-même (Pass 1 / Pass 2, gardes, attribution) vit dans lib/wallet-sync.ts,
// partagée avec le job de nuit. Route = paramètre + appel + réponse, inchangée pour l'UI.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const gameName: string = body.game_name ?? "TELE";
  const out = await syncGameWallets(gameName, "manual");
  return NextResponse.json(out.body, { status: out.status });
}
