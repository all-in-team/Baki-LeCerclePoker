import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

// Routes d'administration : session obligatoire, sans exception (hotfix 2026-09-25).
// Elles étaient exclues du matcher et ne tenaient qu'à une clé — en dur dans un dépôt
// public pour neuf d'entre elles, dont `db-diagnostic` qui exécutait du SQL arbitraire.
// La session est désormais le verrou de ces routes. Le jeton `x-admin-token` que
// la plupart vérifient en plus ne compte pas pour les neuf routes à clé en dur,
// devenues publiques (retrait des clés : branche chore/admin-keys-cleanup).
const ADMIN_PREFIX = "/api/admin";

function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PREFIX || pathname.startsWith(ADMIN_PREFIX + "/");
}

export async function middleware(req: NextRequest) {
  const admin = isAdminPath(req.nextUrl.pathname);
  const secret = process.env.AUTH_SECRET;
  // Sans AUTH_SECRET le reste de l'app s'ouvre (comportement historique) ; l'admin,
  // elle, se ferme : un secret manquant ne doit jamais valoir accès.
  if (!secret) {
    return admin
      ? NextResponse.json({ error: "AUTH_SECRET not configured" }, { status: 503 })
      : NextResponse.next();
  }

  const token = req.cookies.get("session")?.value;
  if (token) {
    try {
      await jwtVerify(token, new TextEncoder().encode(secret));
      return NextResponse.next();
    } catch {}
  }

  // Un appel d'API sans session reçoit un 401, pas une redirection vers une page HTML.
  if (admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("from", req.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // `go` = porte d'entrée du trafic publicitaire RichAds. DOIT rester hors
    // auth : le visiteur arrive d'une pub, il n'a pas de session — sans cette
    // exclusion chaque clic acheté partirait sur /login et serait perdu.
    // `api/admin` n'est PLUS exclu : cf. ADMIN_PREFIX ci-dessus.
    "/((?!login|go|api/login|api/logout|api/portal|api/telegram|api/cron|api/version|api/morning-checkin|api/agent-dispatch|api/agent-report|_next/static|_next/image|favicon\\.ico|lecercle-logo\\.jpg|portal).*)",
  ],
};
