import { NextRequest, NextResponse, after } from "next/server";
import { resolveClickToken, recordClick, fallbackUrl } from "@/lib/funnels/lecercle/tracking";

export const dynamic = "force-dynamic";

/**
 * GET /b/<token> — bouton tracké des diffusions @LeCercle_Lebot.
 *
 * Contrat :
 *   1. La destination est TOUJOURS l'URL stockée pour la diffusion du jeton.
 *      Aucun paramètre de la requête n'est lu : pas de redirection ouverte.
 *   2. Jeton inconnu ou base indisponible → redirection vers le bot, rien compté.
 *   3. User-agent de robot (TelegramBot, crawlers, clients HTTP) ou absent →
 *      redirection faite, rien compté.
 *   4. Le 302 part immédiatement ; l'écriture du clic tourne dans after().
 *
 * Hors auth : exclu du matcher dans middleware.ts (`b/`).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let target: ReturnType<typeof resolveClickToken> = null;
  try {
    target = resolveClickToken(token);
  } catch (e: any) {
    console.error("[LECERCLE CLICK] résolution du jeton:", e?.message ?? e);
  }
  if (!target) return redirect(fallbackUrl());

  const ua = req.headers.get("user-agent");
  const targetId = target.targetId;
  after(() => {
    try { recordClick(targetId, ua); } catch (e: any) {
      console.error("[LECERCLE CLICK] écriture:", e?.message ?? e);
    }
  });
  return redirect(target.destination);
}

/**
 * HEAD : vérificateurs de liens et pré-chargements. Redirige comme GET, sans
 * jamais compter — sans ce handler, Next servirait HEAD via GET et un simple
 * contrôle de lien passerait pour un clic.
 */
export async function HEAD(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let dest = fallbackUrl();
  try { dest = resolveClickToken(token)?.destination ?? dest; } catch {}
  return redirect(dest);
}

function redirect(url: string) {
  const res = NextResponse.redirect(url, 302);
  // Pas de cache : un 302 mis en cache côté client ou proxy ferait disparaître
  // les clics suivants. Pas de Referer : le jeton ne fuit pas vers la destination.
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
