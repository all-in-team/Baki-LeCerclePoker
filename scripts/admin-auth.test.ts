// Routes /api/admin : aucune n'est joignable sans session (hotfix db-diagnostic, 2026-09-25).
// Run: npx tsx scripts/admin-auth.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ `api/admin` était exclu du middleware : 37 routes ne tenaient qu'à une clé, │
// │ en dur dans un dépôt public pour neuf d'entre elles — dont db-diagnostic,  │
// │ qui exécutait du SQL arbitraire (écriture comprise), supprimait un joueur  │
// │ (reset-player) ou reconstruisait deux tables d'argent (migrate).           │
// │ Propriétés vérifiées :                                                     │
// │  1. Le matcher du middleware couvre TOUTES les routes admin présentes sur  │
// │     disque, plus db-diagnostic (supprimée) et une route inventée.          │
// │  2. Sans cookie, cookie invalide ou cookie signé d'un autre secret → 401   │
// │     JSON, jamais une redirection ni un passage.                            │
// │  3. AUTH_SECRET absent → l'admin se ferme (503), le reste garde son        │
// │     comportement historique.                                               │
// │  4. Session valide → la requête passe ; db-diagnostic n'existe plus (404   │
// │     au routage) et plus aucun code (app, lib, components, scripts) ne      │
// │     l'appelle ni ne porte `run-sql`.                                       │
// │  5. Les webhooks Telegram / DZPK restent HORS middleware : Telegram les    │
// │     appelle sans session, ils se protègent par leur secret de webhook.     │
// │  6. Plus aucune clé en dur (champ `key` du corps, clé datée) ; les routes  │
// │     qui en avaient une appellent adminTokenGuard avant toute autre chose.  │
// │  7. adminTokenGuard : fail-closed (503 sans variable, 401 sans ou avec un  │
// │     mauvais en-tête), passe avec le bon jeton.                             │
// └────────────────────────────────────────────────────────────────────────────┘

import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { middleware, config } from "../middleware";
import { adminTokenGuard } from "../lib/admin-token";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

const ROOT = path.resolve(__dirname, "..");
const ADMIN_DIR = path.join(ROOT, "app/api/admin");
const adminRoutes = fs.readdirSync(ADMIN_DIR)
  .filter((d) => fs.existsSync(path.join(ADMIN_DIR, d, "route.ts")))
  .map((d) => `/api/admin/${d}`);
const probes = [...adminRoutes, "/api/admin/db-diagnostic", "/api/admin/route-inventee", "/api/admin"];

// Le matcher Next est une regex sur le pathname entier.
const matcher = new RegExp("^" + config.matcher[0] + "$");
const isMatched = (p: string) => matcher.test(p);

const SECRET = "test-secret-admin-auth";
async function sign(secret: string) {
  return new SignJWT({ role: "admin" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt()
    .setExpirationTime("1h").sign(new TextEncoder().encode(secret));
}
function req(p: string, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = `session=${cookie}`;
  return new NextRequest(`https://example.test${p}`, { method: "POST", headers });
}
const passes = (r: Response) => r.headers.get("x-middleware-next") === "1";

async function main() {
  console.log(`\n1. Le matcher couvre les ${adminRoutes.length} routes admin sur disque (+ 3 sondes)`);
  eq("au moins 30 routes admin trouvées", adminRoutes.length >= 30, true);
  eq("toutes les sondes admin passent par le middleware", probes.filter((p) => !isMatched(p)), []);
  // Témoins : les exclusions voulues restent exclues.
  eq("/go reste hors middleware (trafic RichAds)", isMatched("/go/abc"), false);
  eq("/api/telegram/webhook reste hors middleware", isMatched("/api/telegram/webhook"), false);
  eq("/api/telegram/dzpk/webhook reste hors middleware", isMatched("/api/telegram/dzpk/webhook"), false);
  eq("/players reste protégé", isMatched("/players"), true);

  process.env.AUTH_SECRET = SECRET;

  console.log("\n2. Sans session valide → 401 JSON sur chaque route admin");
  const bad: string[] = [];
  const wrongSecret = await sign("un-autre-secret");
  for (const p of probes) {
    for (const [label, cookie] of [["sans cookie", undefined], ["cookie bidon", "abc.def.ghi"], ["autre secret", wrongSecret]] as const) {
      const r = await middleware(req(p, cookie));
      if (r.status !== 401 || passes(r)) bad.push(`${p} (${label}) → ${r.status}`);
    }
  }
  eq(`${probes.length} routes × 3 cas refusés en 401`, bad, []);
  const one = await middleware(req("/api/admin/db-diagnostic"));
  eq("db-diagnostic sans session : 401 JSON", [one.status, await one.json()], [401, { error: "Unauthorized" }]);
  const page = await middleware(req("/players"));
  eq("page hors admin sans session : redirection /login inchangée", [page.status, new URL(page.headers.get("location")!).pathname], [307, "/login"]);

  console.log("\n3. AUTH_SECRET absent → l'admin se ferme");
  delete process.env.AUTH_SECRET;
  const closed = await middleware(req("/api/admin/reset-player"));
  eq("admin sans AUTH_SECRET : 503, pas de passage", [closed.status, passes(closed)], [503, false]);
  const open = await middleware(req("/players"));
  eq("hors admin sans AUTH_SECRET : comportement historique (passe)", passes(open), true);
  process.env.AUTH_SECRET = SECRET;

  console.log("\n4. Session valide → la requête passe ; db-diagnostic et run-sql ont disparu");
  const good = await sign(SECRET);
  const ok = await middleware(req("/api/admin/reset-player", good));
  eq("admin avec session : passe", passes(ok), true);
  eq("db-diagnostic n'existe plus sur disque (404 au routage)", fs.existsSync(path.join(ADMIN_DIR, "db-diagnostic")), false);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".next"].includes(e.name)) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(ts|tsx|js|mjs|sh)$/.test(e.name) && !f.endsWith("admin-auth.test.ts")
        && /["']run-sql["']|api\/admin\/db-diagnostic/.test(fs.readFileSync(f, "utf8"))) offenders.push(path.relative(ROOT, f));
    }
  };
  for (const d of ["app", "lib", "components", "scripts"]) walk(path.join(ROOT, d));
  eq("aucun code (app, lib, components, scripts) n'appelle db-diagnostic ni run-sql", offenders, []);

  console.log("\n6. Plus aucune clé en dur ; garde x-admin-token en tête des anciennes routes à clé");
  const keyed: string[] = [];
  const walkKeys = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".next"].includes(e.name)) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walkKeys(f);
      else if (/\.(ts|tsx|js|mjs|sh)$/.test(e.name) && !f.endsWith("admin-auth.test.ts")
        && /body\.key\s*!==|key:\s*["'][a-z0-9-]+-20\d{6}["']|=\s*["'][a-z0-9-]+-20\d{6}["']/.test(fs.readFileSync(f, "utf8"))) keyed.push(path.relative(ROOT, f));
    }
  };
  for (const d of ["app", "lib", "components", "scripts"]) walkKeys(path.join(ROOT, d));
  eq("aucune clé en dur dans app, lib, components, scripts", keyed, []);
  const formerlyKeyed = ["archive-never-players", "cleanup-shells", "drain-queue", "purge-ghost-groups", "test-onboarding", "treasury-backfill", "userbot-leave-groups"];
  const notGuardedFirst = formerlyKeyed.filter((r) => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, r, "route.ts"), "utf8");
    const post = src.slice(src.indexOf("export async function POST"));
    const lines = post.slice(post.indexOf("{") + 1).split("\n").map((l) => l.trim()).filter(Boolean);
    // Seule instruction tolérée avant le garde : la lecture du corps (sans effet).
    const i = lines.findIndex((l) => l.startsWith("const denied = adminTokenGuard(req)"));
    return i < 0 || lines.slice(0, i).some((l) => !l.startsWith("const body = await req.json()"));
  });
  eq("les 7 anciennes routes à clé appellent adminTokenGuard en premier", notGuardedFirst, []);

  console.log("\n7. adminTokenGuard");
  const hreq = (tok?: string) => new NextRequest("https://example.test/api/admin/x", { method: "POST", headers: tok ? { "x-admin-token": tok } : {} });
  delete process.env.ADMIN_RECONCILE_TOKEN;
  eq("sans ADMIN_RECONCILE_TOKEN : 503", adminTokenGuard(hreq("x"))?.status, 503);
  process.env.ADMIN_RECONCILE_TOKEN = "jeton-test";
  eq("sans en-tête : 401", adminTokenGuard(hreq())?.status, 401);
  eq("mauvais en-tête : 401", adminTokenGuard(hreq("faux"))?.status, 401);
  eq("bon en-tête : passe", adminTokenGuard(hreq("jeton-test")), null);

  console.log(`\n${passed} ✔, ${failures.length} ✘`);
  if (failures.length) { console.log("ÉCHECS :", failures); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
