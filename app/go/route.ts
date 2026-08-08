import { NextRequest, NextResponse, after } from "next/server";
import { getDestUrl, logRichAdsClick, clientIpFromXff } from "@/lib/richads";

export const dynamic = "force-dynamic";

/**
 * GET /go — porte d'entrée du trafic RichAds vers le groupe Telegram dzpk.
 *
 * Contrat, dans cet ordre de priorité :
 *   1. ON NE PERD JAMAIS UN CLIC. Quelle que soit l'anomalie (cre absente,
 *      macro non substituée, base indisponible), on redirige.
 *   2. Le 302 part IMMÉDIATEMENT. Le log tourne dans after(), donc après
 *      l'envoi de la réponse — objectif < 100 ms côté client.
 *
 * Paramètres, alimentés par les macros RichAds (syntaxe à CROCHETS) :
 *   cre  [CREATIVE_ID]   cid  [CAMPAIGN_ID]   sid [TG_PUB_ID]
 *   app  [TG_APP_ID]     geo  [COUNTRY]       cost [BID_PRICE]
 *   pu   [TG_USER_TYPE]  cb   [CLICK_ID]
 *
 * utm_content double cb : exigé par RichAds pour leur propre comptage, ignoré
 * ici — ce n'est pas une dimension d'analyse.
 *
 * NOTE : ce chemin est exclu du middleware d'auth (cf. matcher dans
 * middleware.ts). Sans cette exclusion, chaque clic acheté partirait sur /login.
 */
export async function GET(req: NextRequest) {
  const dest = getDestUrl();

  // Sans destination configurée il n'y a nulle part où envoyer le visiteur.
  // On le dit franchement plutôt que de rediriger au hasard, et on log quand
  // même : ces clics sont facturés, ils doivent rester comptés.
  if (!dest) {
    console.error("[RICHADS] RICHADS_DEST_URL absent — clic reçu, aucune destination");
    after(() => logRichAdsClick(readClick(req)));
    return NextResponse.json({ error: "destination not configured" }, { status: 503 });
  }

  const click = readClick(req);
  after(() => logRichAdsClick(click));

  // 302 explicite : le lien t.me sert lui-même de repli web si l'app Telegram
  // ne prend pas la main. Surtout PAS de redirect vers tg:// — sans Telegram
  // installé, le visiteur tombe sur une erreur de scheme et le clic est perdu.
  return NextResponse.redirect(dest, 302);
}

/** Lecture pure de la requête : aucun accès base, aucune exception possible. */
function readClick(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  return {
    cre: q.get("cre"),
    cid: q.get("cid"),
    sid: q.get("sid"),
    app: q.get("app"),
    geo: q.get("geo"),
    cost: q.get("cost"),
    pu: q.get("pu"),
    cb: q.get("cb"),
    ip: clientIpFromXff(req.headers.get("x-forwarded-for")),
    userAgent: req.headers.get("user-agent"),
  };
}
