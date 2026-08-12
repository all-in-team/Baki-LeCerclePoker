import { NextRequest, NextResponse } from "next/server";
import {
  createBroadcast, startBroadcast, pauseBroadcast, cancelBroadcast,
  listBroadcasts, getBroadcast, getCounts, getGuard, countSegment, sendTest,
  runBroadcastDrain, spacingMs, drainBatch,
  type DzpkSegment,
} from "@/lib/funnels/dzpk/broadcast";

/**
 * API de l'écran de diffusion dzpk.
 *
 * Protégée par le middleware d'auth de session (ce chemin n'est PAS dans la
 * liste d'exclusions du matcher) : c'est un écran de back-office. Même parti
 * pris que `/api/dzpk-reconciliation`, d'où l'absence de `x-admin-token`.
 *
 *   GET                        → historique, garde-fou anti-spam, réglages
 *   POST {action:"count"}      → compte de destinataires d'un segment
 *   POST {action:"create"}     → crée un BROUILLON et fige ses destinataires
 *   POST {action:"start"}      → met le brouillon en file d'envoi
 *   POST {action:"pause"}      → suspend, les restants demeurent 'pending'
 *   POST {action:"cancel"}     → abandonne ce qui n'est pas parti
 *   POST {action:"test"}       → envoi de contrôle à UN compte, hors file
 *   POST {action:"drain"}      → pousse un tour de file sans attendre le cron
 */
export const dynamic = "force-dynamic";

function snapshot() {
  return {
    broadcasts: listBroadcasts(20),
    guard: getGuard(),
    settings: { spacingMs: spacingMs(), batch: drainBatch() },
  };
}

export async function GET() {
  return NextResponse.json(snapshot());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const action = String(body.action ?? "");

  // ── Compte de destinataires ───────────────────────────────────────────────
  // Appelé à chaque changement de case dans l'écran : c'est ce chiffre que le
  // récap de confirmation affiche, il doit venir de la MÊME requête SQL que
  // celle qui figera les destinataires. Le recalculer autrement côté client
  // ferait diverger ce qui est annoncé de ce qui part.
  if (action === "count") {
    const segment = body.segment as DzpkSegment;
    if (!segment) return NextResponse.json({ error: "segment requis" }, { status: 400 });
    return NextResponse.json({ count: countSegment(segment) });
  }

  if (action === "create") {
    const res = createBroadcast({
      title: String(body.title ?? ""),
      body: String(body.body ?? ""),
      buttonLabel: body.buttonLabel ?? null,
      buttonUrl: body.buttonUrl ?? null,
      segment: body.segment as DzpkSegment,
      createdBy: body.operator ? String(body.operator) : "baki",
    });
    if (!res.ok) return NextResponse.json(res, { status: 400 });
    return NextResponse.json({ ...res, ...snapshot() });
  }

  if (action === "start" || action === "pause" || action === "cancel") {
    const id = body.id;
    if (!Number.isInteger(id)) return NextResponse.json({ error: "id requis" }, { status: 400 });

    const res = action === "start" ? startBroadcast(id)
      : action === "pause" ? pauseBroadcast(id, "Mise en pause manuelle")
      : cancelBroadcast(id);
    if (!res.ok) return NextResponse.json(res, { status: 400 });

    // Le premier tour part TOUT DE SUITE plutôt qu'à la minute suivante : sans
    // ça, l'écran affiche « 0 envoyé » pendant une minute entière après le clic
    // et rien ne distingue un démarrage réussi d'un cron mort.
    if (action === "start") {
      runBroadcastDrain().catch(e => console.error("[DZPK BROADCAST] drain immédiat:", e?.message ?? e));
    }
    return NextResponse.json({ ok: true, ...snapshot() });
  }

  // ── Envoi de contrôle ─────────────────────────────────────────────────────
  // Le seul moyen de vérifier le rendu HTML et le bouton AVANT d'engager la
  // liste : Telegram ne valide pas un message autrement qu'en l'envoyant.
  if (action === "test") {
    const chatId = Number(body.chatId);
    if (!Number.isFinite(chatId)) {
      return NextResponse.json({ error: "chatId requis (ton telegram_id)" }, { status: 400 });
    }
    const res = await sendTest(chatId, {
      body: String(body.body ?? ""),
      buttonLabel: body.buttonLabel ?? null,
      buttonUrl: body.buttonUrl ?? null,
    });
    if (!res.ok) return NextResponse.json(res, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  if (action === "drain") {
    const res = await runBroadcastDrain();
    return NextResponse.json({ ok: true, drain: res, ...snapshot() });
  }

  if (action === "detail") {
    const id = body.id;
    if (!Number.isInteger(id)) return NextResponse.json({ error: "id requis" }, { status: 400 });
    const bc = getBroadcast(id);
    if (!bc) return NextResponse.json({ error: "Diffusion introuvable" }, { status: 404 });
    return NextResponse.json({ broadcast: bc, counts: getCounts(id) });
  }

  return NextResponse.json({ error: `action inconnue : ${action}` }, { status: 400 });
}
