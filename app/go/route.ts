import { NextRequest, NextResponse, after } from "next/server";
import { getDestUrl, getBotStartUrl, creToStartParam, logRichAdsClick, resolveClientIp } from "@/lib/richads";

export const dynamic = "force-dynamic";

/**
 * GET /go — porte d'entrée du trafic publicitaire vers le BOT dzpk.
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
  // Lu en premier : la créative détermine désormais la destination, plus
  // seulement le contenu du log.
  const click = readClick(req);
  const dest = resolveDestination(click.cre);

  // Sans destination configurée il n'y a nulle part où envoyer le visiteur.
  // On le dit franchement plutôt que de rediriger au hasard, et on log quand
  // même : ces clics sont facturés, ils doivent rester comptés.
  if (!dest) {
    console.error("[RICHADS] ni DZPK_BOT_URL ni RICHADS_DEST_URL — clic reçu, aucune destination");
    after(() => logRichAdsClick(click));
    return NextResponse.json({ error: "destination not configured" }, { status: 503 });
  }

  after(() => logRichAdsClick(click));

  // 302 explicite : le lien t.me sert lui-même de repli web si l'app Telegram
  // ne prend pas la main. Surtout PAS de redirect vers tg:// — sans Telegram
  // installé, le visiteur tombe sur une erreur de scheme et le clic est perdu.
  return NextResponse.redirect(dest, 302);
}

/**
 * Où envoyer le visiteur.
 *
 * Le trafic publicitaire passe désormais par le BOT et non plus directement par
 * le lien de groupe du club. C'est ce détour qui rend l'attribution possible :
 * le `/start` crée un lead porteur de sa source, alors qu'une entrée directe
 * dans le groupe n'en laisse aucune trace côté back-office.
 *
 * Le prix est réel et assumé : une étape de plus (bot → bouton → groupe), donc
 * une part de visiteurs perdue en route. Sans elle, on ne sait pas quelle
 * créative convertit.
 *
 * Repli sur l'ancienne destination si `DZPK_BOT_URL` manque — un clic acheté ne
 * doit jamais tomber dans le vide pour une variable oubliée.
 */
function resolveDestination(rawCre: string | null): string | null {
  const bot = getBotStartUrl();
  if (bot) {
    const source = creToStartParam(rawCre);
    // `creToStartParam` ne rend que [A-Za-z0-9_] : l'encodage est un no-op, il
    // est là pour que la construction reste sûre si cette garantie évolue.
    return `${bot}?start=${encodeURIComponent(source)}`;
  }
  console.warn("[RICHADS] DZPK_BOT_URL absent — repli sur RICHADS_DEST_URL, aucune source capturée");
  return getDestUrl();
}

/** Lecture pure de la requête : aucun accès base, aucune exception possible. */
function readClick(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  // Derrière Railway, x-forwarded-for porte plusieurs hops dont le dernier est
  // l'edge de la plateforme : on interroge des en-têtes candidats et on trace
  // celui qui a répondu. Cf. resolveClientIp.
  const { ip, source, hops } = resolveClientIp(n => req.headers.get(n));
  return {
    cre: q.get("cre"),
    cid: q.get("cid"),
    sid: q.get("sid"),
    app: q.get("app"),
    geo: q.get("geo"),
    cost: q.get("cost"),
    pu: q.get("pu"),
    cb: q.get("cb"),
    ip,
    ipSource: source,
    ipHops: hops,
    userAgent: req.headers.get("user-agent"),
  };
}
