/**
 * Harnais des routes HTTP de saisie NEXA.
 * Run: npx tsx scripts/affiliate-api.test.ts
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────┐
 * │ Le COMPORTEMENT des handlers exportés (GET / POST / PUT), appelés avec  │
 * │ de vraies NextRequest sur une vraie base SQLite : codes de statut,      │
 * │ forme des réponses, refus (semaine non-lundi, orpheline, écart sans     │
 * │ motif), et le fait que validate n'écrit RIEN.                           │
 * └─────────────────────────────────────────────────────────────────────────┘
 * ┌─ CE QU'ILS NE PROUVENT PAS ─────────────────────────────────────────────┐
 * │ QUE L'APPLI DÉMARRE À FROID. Le schéma est PRÉ-FABRIQUÉ ici : on pose   │
 * │ tous les marqueurs de _applied_fixes sauf add_nexa_affiliate_v1, et on  │
 * │ crée nexa_leads / manual_settlements à la main, pour que initSchema()   │
 * │ saute tout le reste. C'est un contournement du chemin base-vierge, qui  │
 * │ est cassé (FK en dur ligne 589, puis BEGIN sans COMMIT dans             │
 * │ add_a5poker_game_v1) — voir docs/MIGRATIONS_BASE_VIERGE.md.             │
 * │                                                                         │
 * │ Si tu lis ceci dans six mois : ce fichier au vert ne veut PAS dire que  │
 * │ le boot fonctionne. Il ne couvre pas les migrations.                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Piège corrigé (constaté en vrai le 2026-08-04) : les `import` sont hissés en
 * tête de module, donc exécutés AVANT le process.chdir(). lib/db fige
 * DATA_DIR = cwd + "/data" au chargement — un import statique de lib/db ouvrait
 * donc une base dans le WORKTREE et déroulait initSchema dessus. D'où deux
 * précautions ci-dessous : import dynamique après le chdir, et une garde qui
 * fait échouer bruyamment si le chemin de base n'est pas dans le dossier
 * temporaire. Ne pas retransformer ces require() en import statiques.
 */

import fs from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lecercle-api-")));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const Database = require(path.join(REPO, "node_modules/better-sqlite3"));
const SRC = fs.readFileSync(path.join(REPO, "lib/db.ts"), "utf8");

// Tous les noms de migration du fichier, sauf la nôtre.
const MARKERS = [...SRC.matchAll(/_applied_fixes \(name\) VALUES \(\?\)`\)\.run\("([^"]+)"\)/g)]
  .map(m => m[1]).filter(n => n !== "add_nexa_affiliate_v1");

{
  const boot = new Database(path.join(TMP, "data", "lecercle.db"));
  // Les tables que add_nexa_affiliate_v1 touche mais qui sont créées ou complétées
  // par des migrations qu'on vient de marquer « appliquées ». On les pose donc
  // ici, DANS LA FORME QU'ELLES ONT EN PROD (relevée par
  // SELECT sql FROM sqlite_master) — initSchema utilisant CREATE TABLE IF NOT
  // EXISTS, la nôtre l'emporte.
  //
  // `games` en particulier : sa forme d'origine dans initSchema n'a que
  // (id, name, status) ; default_action_pct et currency arrivent par
  // add_a5poker_game_v1 et add_games_currency_v1, sautées ici. Sans ça, la
  // migration échoue sur « table games has no column named currency ».
  boot.exec(`
    CREATE TABLE IF NOT EXISTS _applied_fixes (name TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
      default_action_pct REAL,
      exact_action_pct REAL, exact_rakeback_pct REAL, exact_insurance_pct REAL,
      perceived_action_pct REAL, perceived_rakeback_pct REAL, perceived_insurance_pct REAL,
      currency TEXT NOT NULL DEFAULT 'USDT');
    -- Forme réelle : player_id vient de add_nexa_affiliate_v1, stage/tg_username de
    -- add_nexa_funnel_v1. commitWeek promeut les leads, il lit ces colonnes.
    CREATE TABLE IF NOT EXISTS nexa_leads (id INTEGER PRIMARY KEY AUTOINCREMENT, tg_user_id INTEGER NOT NULL UNIQUE,
      member_id TEXT UNIQUE, player_id INTEGER REFERENCES players(id), tg_username TEXT,
      stage TEXT NOT NULL DEFAULT 'started', updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS nexa_lead_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES nexa_leads(id), kind TEXT NOT NULL,
      stage TEXT, payload TEXT, actor TEXT NOT NULL DEFAULT 'bot',
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS manual_settlements (id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL, player_id INTEGER NOT NULL,
      amount_due_usdt REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'locked');
  `);
  const ins = boot.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`);
  for (const m of MARKERS) ins.run(m);
  boot.close();
  console.log(`Base préparée : ${MARKERS.length} marqueurs posés, add_nexa_affiliate_v1 laissée à jouer.`);
}

// GARDE ANTI-BASE-PARASITE — doit rester AVANT tout chargement de lib/db.
// Le 2026-08-04, un import hissé a fait ouvrir data/lecercle.db dans le worktree
// (1,1 Mo de WAL) sans que rien ne le signale : le test échouait plus loin, sur
// une erreur sans rapport apparent. On vérifie donc que le chemin que lib/db VA
// calculer tombe bien dans le dossier temporaire, et on meurt bruyamment sinon.
{
  const willOpen = path.join(process.cwd(), "data", "lecercle.db");
  if (path.resolve(process.cwd()) !== TMP || !willOpen.startsWith(TMP + path.sep)) {
    console.error(
      `\n❌ GARDE : lib/db ouvrirait ${willOpen}\n` +
      `   attendu sous ${TMP}\n` +
      `   cwd = ${process.cwd()}\n` +
      `   Cause probable : un import STATIQUE de lib/db (ou d'un module qui en dépend)\n` +
      `   a été hissé au-dessus du process.chdir(). Repasse-le en require() dynamique.\n` +
      `   Test interrompu AVANT de créer une base parasite dans le dépôt.`);
    process.exit(1);
  }
}

// Chargements DYNAMIQUES : ils doivent avoir lieu après le chdir ET après la garde.
// Un `import` statique ici serait hissé et casserait tout (cf. en-tête).
const { NextRequest } = require("next/server");
const { getDb } = require(path.join(REPO, "lib/db.ts"));
const { GET: weekGET, PUT: weekPUT } = require(path.join(REPO, "app/api/nexa/affiliate/week/route.ts"));
const { POST: validatePOST } = require(path.join(REPO, "app/api/nexa/affiliate/validate/route.ts"));
const { GET: knownGET } = require(path.join(REPO, "app/api/nexa/affiliate/known-players/route.ts"));

let passed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log("   ✔", label); }
  else { failures.push(label); console.log("   ✘", label, detail); }
}
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(label, g === w, g === w ? "" : `attendu ${w}, obtenu ${g}`);
}

const BASE = "http://localhost";
const getReq = (qs: string) => new NextRequest(`${BASE}/api/nexa/affiliate/week${qs}`);
const jsonReq = (url: string, method: string, body: unknown) =>
  new NextRequest(`${BASE}${url}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  } as any);

const DEAL = "40% NLH and MTT, 45% PLO, 55% Spins";
const MONDAY = "2026-07-13";
const jopok = { nickname: "Jopok", member_id: "2518550", deal_text: DEAL,
                nlh: 800, mtt: 200, plo: 400, spins: 100, affiliate_payment: 635 };
const mareck = { nickname: "Mareck", member_id: null, deal_text: DEAL,
                 nlh: 1200, mtt: 0, plo: 0, spins: 0, affiliate_payment: 480 };
/** 950×40 + 150×40 = 440, mais on saisit 404. */
const typo = { ...jopok, nlh: 950, mtt: 150, plo: 0, spins: 0, affiliate_payment: 404 };

const db = getDb();
const countRows = () => db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks`).get() as any;
const countEntries = () => db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_entries`).get() as any;

async function main() {
  console.log("\n══ Montage ══");
  check("la migration a tourné via le vrai getDb()",
    !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='nexa_affiliate_weeks'`).get());
  check("game NEXAPOKER seedé", !!db.prepare(`SELECT id FROM games WHERE name='NEXAPOKER'`).get());
  db.prepare(`INSERT INTO players (name) VALUES ('Jopok')`).run();

  console.log("\n══ GET semaine ══");
  {
    const res = await weekGET(getReq(`?week_start=${MONDAY}`));
    const j = await res.json();
    eq("statut 200 sur semaine vide", res.status, 200);
    eq("ok", j.ok, true);
    eq("grille vide, pas une erreur", j.rows, []);
    eq("semaine renvoyée", j.week_start, MONDAY);
  }
  {
    const res = await weekGET(getReq(`?week_start=2026-07-12`)); // dimanche
    eq("statut 400 sur non-lundi", res.status, 400);
    check("message explicite", /LUNDI/.test((await res.json()).error));
  }
  {
    const res = await weekGET(getReq(``));
    eq("statut 400 sans paramètre", res.status, 400);
  }

  console.log("\n══ POST validate — dry-run, n'écrit RIEN ══");
  {
    const before = { rows: countRows().n, entries: countEntries().n };
    const res = await validatePOST(jsonReq("/api/nexa/affiliate/validate", "POST",
      { week_start: MONDAY, rows: [jopok, mareck] }));
    const j = await res.json();
    eq("statut 200", res.status, 200);
    eq("un verdict par ligne", j.rows.length, 2);
    check("ligne 1 valide", j.rows[0].verdict.ok);
    check("recalcul renvoyé", Math.abs(j.rows[0].verdict.recomputed - 635) < 1e-9);
    eq("2 ajouts annoncés", j.diff.added.length, 2);
    const after = { rows: countRows().n, entries: countEntries().n };
    eq("AUCUNE ligne écrite", after.rows, before.rows);
    eq("AUCUNE entrée de journal écrite", after.entries, before.entries);
  }
  {
    const res = await validatePOST(jsonReq("/api/nexa/affiliate/validate", "POST",
      { week_start: MONDAY, rows: [typo] }));
    const j = await res.json();
    eq("statut 200 même sur ligne fautive (c'est un avis, pas une écriture)", res.status, 200);
    eq("verdict en échec", j.rows[0].verdict.ok, false);
    eq("code", j.rows[0].verdict.code, "payment_mismatch");
    check("attendu renvoyé pour affichage", Math.abs(j.rows[0].verdict.expected - 440) < 1e-9);
    eq("toujours rien en base", countRows().n, 0);
  }
  {
    const res = await validatePOST(jsonReq("/api/nexa/affiliate/validate", "POST",
      { week_start: "2026-07-12", rows: [jopok] }));
    eq("400 sur semaine non-lundi", res.status, 400);
    const bad = await validatePOST(jsonReq("/api/nexa/affiliate/validate", "POST", { week_start: MONDAY }));
    eq("400 sans rows[]", bad.status, 400);
  }

  console.log("\n══ PUT — refus ══");
  {
    const res = await weekPUT(jsonReq("/api/nexa/affiliate/week", "PUT",
      { week_start: "2026-07-14", rows: [jopok] })); // mardi
    const j = await res.json();
    eq("409 sur semaine non-lundi", res.status, 409);
    eq("raison", j.reason, "invalid_week");
    eq("rien écrit", countRows().n, 0);
  }
  {
    const res = await weekPUT(jsonReq("/api/nexa/affiliate/week", "PUT",
      { week_start: MONDAY, rows: [typo] }));
    const j = await res.json();
    eq("409 sur écart sans motif", res.status, 409);
    eq("raison", j.reason, "validation");
    eq("le diff porte le rejet", j.diff.rejected[0].code, "payment_mismatch");
    eq("rien écrit", countRows().n, 0);
  }

  console.log("\n══ PUT — écriture puis garde anti-omission ══");
  {
    const res = await weekPUT(jsonReq("/api/nexa/affiliate/week", "PUT",
      { week_start: MONDAY, rows: [jopok, mareck] }));
    const j = await res.json();
    eq("200", res.status, 200);
    eq("2 lignes écrites", j.written, 2);
    eq("2 en base", countRows().n, 2);
    check("entry_id renvoyé", typeof j.entry_id === "number" && j.entry_id > 0);
  }
  {
    // On renvoie une seule des deux lignes, sans demander de suppression.
    const res = await weekPUT(jsonReq("/api/nexa/affiliate/week", "PUT",
      { week_start: MONDAY, rows: [jopok] }));
    const j = await res.json();
    eq("409 sur orpheline", res.status, 409);
    eq("raison", j.reason, "orphans");
    eq("orpheline nommée", j.diff.orphans, ["nick:mareck"]);
    eq("les 2 lignes sont intactes", countRows().n, 2);
  }
  {
    const res = await weekPUT(jsonReq("/api/nexa/affiliate/week", "PUT",
      { week_start: MONDAY, rows: [jopok], deletions: ["nick:mareck"] }));
    eq("200 avec suppression explicite", res.status, 200);
    eq("1 ligne restante", countRows().n, 1);
  }

  console.log("\n══ PUT — écart AVEC motif ══");
  {
    const res = await weekPUT(jsonReq("/api/nexa/affiliate/week", "PUT",
      { week_start: MONDAY, rows: [typo], overrides: { "2518550": "screenshot NEXA incohérent" } }));
    eq("200", res.status, 200);
    const stored = db.prepare(`SELECT check_ok, override_reason, check_delta, affiliate_payment
                               FROM nexa_affiliate_weeks WHERE row_key='2518550'`).get() as any;
    eq("check_ok = 0", stored.check_ok, 0);
    eq("motif conservé", stored.override_reason, "screenshot NEXA incohérent");
    eq("montant du screenshot intact", stored.affiliate_payment, 404);
    check("écart stocké", Math.abs(stored.check_delta - 36) < 1e-9);
  }

  console.log("\n══ GET après écriture · autocomplétion ══");
  {
    const j = await (await weekGET(getReq(`?week_start=${MONDAY}`))).json();
    eq("la grille se recharge", j.rows.length, 1);
    eq("row_key exposé pour la suppression explicite", j.rows[0].row_key, "2518550");
    const k = await (await knownGET()).json();
    eq("autocomplétion 200", k.ok, true);
    check("Jopok proposé", k.entrants.some((e: any) => e.nickname_key === "jopok"));
  }

  console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} passés, ${failures.length} échoués`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  if (failures.length) { failures.forEach(f => console.log("   ✘", f)); process.exit(1); }
}

void main();
