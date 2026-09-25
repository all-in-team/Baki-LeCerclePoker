import { NextRequest, NextResponse } from "next/server";

/**
 * Second verrou des routes /api/admin (le premier est la session, cf. middleware.ts) :
 * en-tête `x-admin-token` === ADMIN_RECONCILE_TOKEN, fail-closed si la variable manque.
 * Même contrat que les routes qui l'implémentent déjà en ligne (reconcile, reset-player…).
 *
 * Remplace les clés en dur comparées au champ `key` du corps : elles sont dans l'historique
 * d'un dépôt public, donc compromises — jamais de secret dans le code.
 *
 * Retourne la réponse de refus, ou null si l'appel est autorisé.
 */
export function adminTokenGuard(req: NextRequest): NextResponse | null {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  if (req.headers.get("x-admin-token") !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}
