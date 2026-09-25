import { NextRequest, NextResponse } from "next/server";
import {
  createBroadcast, startBroadcast, scheduleBroadcast, pauseBroadcast, cancelBroadcast,
  listBroadcasts, getBroadcast, getStats, getGuard, sendTest, listTargets, runBroadcastDrain,
  spacingMs, drainBatch, TARGET_FILTERS, type TargetFilter,
} from "@/lib/funnels/lecercle/broadcast";
import { countAudience, segmentError, type LecercleSegment } from "@/lib/funnels/lecercle/audience";

/**
 * API de l'écran Diffusion @LeCercle_Lebot.
 *
 * Protégée par le middleware de session (chemin non exclu du matcher).
 *
 *   GET                         → historique, garde-fou anti-spam, réglages
 *   POST {action:"count"}       → destinataires + exclus par motif d'un segment
 *   POST {action:"create"}      → BROUILLON, destinataires figés ; rien ne part
 *   POST {action:"start"}       → envoi, exige expectedTotal == total figé
 *   POST {action:"schedule"}    → programmation (at en UTC+8), même exigence
 *   POST {action:"pause"|"cancel"}
 *   POST {action:"test"}        → envoi de contrôle, comptes autorisés seulement
 *   POST {action:"detail"}      → diffusion + statistiques
 *   POST {action:"recipients"}  → liste nominative filtrée
 */
export const dynamic = "force-dynamic";

function snapshot() {
  return {
    broadcasts: listBroadcasts(30),
    guard: getGuard(),
    settings: { spacingMs: spacingMs(), batch: drainBatch() },
  };
}

export async function GET() {
  return NextResponse.json(snapshot());
}

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const action = String(body.action ?? "");
  const id = body.id;

  if (action === "count") {
    const segment = body.segment as LecercleSegment;
    const err = segment ? segmentError(segment) : "segment requis";
    if (err) return NextResponse.json({ recipients: 0, excluded: {}, unproven: 0, error: err });
    return NextResponse.json(countAudience(segment));
  }

  if (action === "create") {
    const res = createBroadcast({
      title: String(body.title ?? ""),
      body: String(body.body ?? ""),
      buttonLabel: body.buttonLabel == null ? null : String(body.buttonLabel),
      buttonUrl: body.buttonUrl == null ? null : String(body.buttonUrl),
      segment: body.segment as LecercleSegment,
      createdBy: "baki",
    });
    if (!res.ok) return NextResponse.json(res, { status: 400 });
    return NextResponse.json({ ...res, ...snapshot() });
  }

  if (action === "start") {
    if (!Number.isInteger(id)) return bad("id requis");
    const expected = body.expectedTotal === undefined ? undefined : Number(body.expectedTotal);
    const res = startBroadcast(id, expected);
    if (!res.ok) return NextResponse.json(res, { status: 400 });
    // Premier tour tout de suite plutôt qu'à la minute suivante.
    runBroadcastDrain().catch(e => console.error("[LECERCLE BROADCAST] drain immédiat:", e?.message ?? e));
    return NextResponse.json({ ok: true, ...snapshot() });
  }

  if (action === "schedule") {
    if (!Number.isInteger(id)) return bad("id requis");
    const res = scheduleBroadcast(id, String(body.at ?? ""), Number(body.expectedTotal));
    if (!res.ok) return NextResponse.json(res, { status: 400 });
    return NextResponse.json({ ...res, ...snapshot() });
  }

  if (action === "pause" || action === "cancel") {
    if (!Number.isInteger(id)) return bad("id requis");
    const res = action === "pause" ? pauseBroadcast(id, "Mise en pause manuelle") : cancelBroadcast(id);
    if (!res.ok) return NextResponse.json(res, { status: 400 });
    return NextResponse.json({ ok: true, ...snapshot() });
  }

  if (action === "test") {
    const chatId = Number(body.chatId);
    if (!Number.isInteger(chatId)) return bad("chatId requis (ton telegram_id)");
    const res = await sendTest(chatId, {
      body: String(body.body ?? ""),
      buttonLabel: body.buttonLabel == null ? null : String(body.buttonLabel),
      buttonUrl: body.buttonUrl == null ? null : String(body.buttonUrl),
    });
    if (!res.ok) return NextResponse.json(res, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  if (action === "detail") {
    if (!Number.isInteger(id)) return bad("id requis");
    const bc = getBroadcast(id);
    if (!bc) return bad("Diffusion introuvable", 404);
    return NextResponse.json({ broadcast: bc, stats: getStats(id) });
  }

  if (action === "recipients") {
    if (!Number.isInteger(id)) return bad("id requis");
    const filter = (TARGET_FILTERS.includes(body.filter) ? body.filter : "all") as TargetFilter;
    return NextResponse.json({
      rows: listTargets(id, filter, String(body.q ?? "")),
      stats: getStats(id),
    });
  }

  return bad(`action inconnue : ${action}`);
}
