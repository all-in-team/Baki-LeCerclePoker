import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

export async function middleware(req: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return NextResponse.next();

  const token = req.cookies.get("session")?.value;
  if (token) {
    try {
      await jwtVerify(token, new TextEncoder().encode(secret));
      return NextResponse.next();
    } catch {}
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("from", req.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // `go` = porte d'entrée du trafic publicitaire RichAds. DOIT rester hors
    // auth : le visiteur arrive d'une pub, il n'a pas de session — sans cette
    // exclusion chaque clic acheté partirait sur /login et serait perdu.
    "/((?!login|go|api/login|api/logout|api/portal|api/telegram|api/cron|api/version|api/morning-checkin|api/agent-dispatch|api/agent-report|api/admin|_next/static|_next/image|favicon\\.ico|lecercle-logo\\.jpg|portal).*)",
  ],
};
