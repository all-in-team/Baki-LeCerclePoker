/**
 * Harnais de la migration `add_xpoker_twd_v1`.
 * Run: npx tsx scripts/xpoker-schema.test.ts
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────┐
 * │ A. Sur un schéma minimal : marqueur posé APRÈS le travail et seulement   │
 * │    si tout a réussi ; échec ⇒ ROLLBACK complet (zéro table, zéro         │
 * │    marqueur) ; transaction étrangère ouverte ⇒ report SANS marqueur ;    │
 * │    rejeu idempotent ; colonnes additives présentes et inertes (NULL /    │
 * │    'active') sur les lignes existantes ; contraintes du schéma (checksum │
 * │    hors tolérance refusé sans motif, colonnes générées, garde-fous du    │
 * │    grand livre, unicités).                                               │
 * │ B. Sur une COPIE de data/lecercle.db : la chaîne COMPLÈTE d'initSchema   │
 * │    passe, le marqueur est là, XPOKER_TWD existe, le legacy Xpoker id=3   │
 * │    n'a pas bougé, et un second boot ne change rien.                      │
 * └─────────────────────────────────────────────────────────────────────────┘
 * ┌─ CE QU'ILS NE PROUVENT PAS ─────────────────────────────────────────────┐
 * │ L'état RÉEL de la base de prod (schéma supposé ≡ local jusqu'à lecture   │
 * │ prod des _applied_fixes et de PRAGMA table_info(manual_settlements)).    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import fs from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..");
const Database = require(path.join(REPO, "node_modules/better-sqlite3"));

import {
  runXpokerMigrationV1, XPOKER_MIGRATION_V1, XPOKER_ADDED_COLUMNS, XPOKER_CHECK_TOLERANCE, type XpokerSeed,
} from "../lib/games/xpoker/schema";
import {
  XPOKER_GAME_NAME, XPOKER_DEFAULT_ACTION_PCT, XPOKER_SEED_CHIPS_PER_USD,
  XPOKER_SEED_RATE_EFFECTIVE_FROM, XPOKER_SEED_AGENCY_ACCOUNTS,
} from "../lib/games/xpoker/config";

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
function throws(label: string, fn: () => void, re: RegExp) {
  try { fn(); check(label, false, "aucune erreur levée"); }
  catch (e: any) { check(label, re.test(String(e?.message ?? e)), `message: ${e?.message}`); }
}

const SEED: XpokerSeed = {
  gameName: XPOKER_GAME_NAME,
  defaultActionPct: XPOKER_DEFAULT_ACTION_PCT,
  seedChipsPerUsd: XPOKER_SEED_CHIPS_PER_USD,
  seedRateEffectiveFrom: XPOKER_SEED_RATE_EFFECTIVE_FROM,
  agencyAccounts: XPOKER_SEED_AGENCY_ACCOUNTS,
};

/** Schéma minimal : les seules tables que la migration touche ou référence. */
function minimalDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE _applied_fixes (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE games (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
      default_action_pct REAL, currency TEXT NOT NULL DEFAULT 'USDT');
    CREATE TABLE player_game_ids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL, UNIQUE(game_id, external_id));
    CREATE TABLE manual_settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      net_selected_usdt REAL NOT NULL DEFAULT 0, action_pct_applied REAL NOT NULL DEFAULT 0,
      amount_due_usdt REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','paid')),
      tx_hash TEXT, notes TEXT, locked_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_date TEXT, kind TEXT NOT NULL DEFAULT 'action');
    INSERT INTO games (id, name, status) VALUES (3, 'Xpoker', 'archived');
    INSERT INTO games (name, default_action_pct) VALUES ('KKPOKER', 30);
    INSERT INTO players (name) VALUES ('Alice');
    INSERT INTO player_game_ids (player_id, game_id, external_id) VALUES (1, 3, 'legacy-1');
    INSERT INTO manual_settlements (game_id, player_id, amount_due_usdt) VALUES (4, 1, 120.5);
  `);
  return db;
}
const tables = (db: any): string[] =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'xpoker_%' ORDER BY name`).all().map((r: any) => r.name);
const marker = (db: any) => !!db.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`).get(XPOKER_MIGRATION_V1);
const cols = (db: any, t: string): string[] => db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t).map((r: any) => r.name);

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n── A1. Application nominale ──");
{
  const db = minimalDb();
  eq("résultat", runXpokerMigrationV1(db, SEED), "applied");
  check("marqueur posé", marker(db));
  eq("tables créées", tables(db), [
    "xpoker_agency_accounts", "xpoker_chip_ledger", "xpoker_chip_rates", "xpoker_imports",
    "xpoker_player_deals", "xpoker_settlement_weeks", "xpoker_week_rows",
  ]);
  for (const c of XPOKER_ADDED_COLUMNS) check(`colonne ${c.table}.${c.column}`, cols(db, c.table).includes(c.column));
  const g = db.prepare(`SELECT id, name, status, default_action_pct, currency FROM games WHERE name = ?`).get(XPOKER_GAME_NAME);
  eq("games XPOKER_TWD", { ...g, id: g.id > 4 }, { id: true, name: "XPOKER_TWD", status: "active", default_action_pct: 10, currency: "TWD" });
  eq("legacy Xpoker id=3 intouché", db.prepare(`SELECT id, name, status FROM games WHERE id = 3`).get(), { id: 3, name: "Xpoker", status: "archived" });
  eq("graine taux", db.prepare(`SELECT effective_from, chips_per_usd FROM xpoker_chip_rates`).all(), [{ effective_from: "2026-03-16", chips_per_usd: 33 }]);
  eq("graine comptes agence", db.prepare(`SELECT member_id FROM xpoker_agency_accounts ORDER BY 1`).all().map((r: any) => r.member_id), ["3970004", "3999050"]);
  // Inertie sur l'existant : les lignes d'avant n'ont rien gagné d'autre que NULL / 'active'.
  eq("player_game_ids existant", db.prepare(`SELECT external_id, nickname, status, added_at FROM player_game_ids`).get(),
     { external_id: "legacy-1", nickname: null, status: "active", added_at: null });
  eq("manual_settlements existant", db.prepare(`SELECT amount_due_usdt, amount_due_native, native_currency, fx_rate_applied FROM manual_settlements`).get(),
     { amount_due_usdt: 120.5, amount_due_native: null, native_currency: null, fx_rate_applied: null });
  check("INSERT positionnel historique de manual_settlements toujours valide (colonnes explicites)",
    db.prepare(`INSERT INTO manual_settlements (game_id, player_id, net_selected_usdt, action_pct_applied, amount_due_usdt, status, notes, locked_at)
                VALUES (4, 1, 10, 30, 3, 'locked', NULL, datetime('now'))`).run().changes === 1);
  console.log("\n── A2. Rejeu idempotent ──");
  eq("second appel", runXpokerMigrationV1(db, SEED), "already_applied");
  eq("un seul marqueur", db.prepare(`SELECT COUNT(*) n FROM _applied_fixes WHERE name = ?`).get(XPOKER_MIGRATION_V1).n, 1);
  eq("une seule ligne games", db.prepare(`SELECT COUNT(*) n FROM games WHERE name = ?`).get(XPOKER_GAME_NAME).n, 1);
  // Corps rejouable même sans marqueur (cas : marqueur perdu, tables présentes).
  db.prepare(`DELETE FROM _applied_fixes WHERE name = ?`).run(XPOKER_MIGRATION_V1);
  eq("rejeu sans marqueur, tables présentes", runXpokerMigrationV1(db, SEED), "applied");
  eq("toujours une seule ligne games", db.prepare(`SELECT COUNT(*) n FROM games WHERE name = ?`).get(XPOKER_GAME_NAME).n, 1);
  eq("toujours une seule graine taux", db.prepare(`SELECT COUNT(*) n FROM xpoker_chip_rates`).get().n, 1);
}

console.log("\n── A3. Échec ⇒ ROLLBACK complet, aucun marqueur ──");
{
  const db = minimalDb();
  // On fait échouer l'INSERT games (colonne currency absente) APRÈS les CREATE TABLE :
  // si le rollback est incomplet, des tables xpoker_* survivent.
  db.exec(`ALTER TABLE games RENAME COLUMN currency TO currency_old`);
  throws("jette", () => runXpokerMigrationV1(db, SEED), /currency/);
  eq("aucune table xpoker_*", tables(db), []);
  check("aucun marqueur", !marker(db));
  check("pas de transaction laissée ouverte", !db.inTransaction);
  check("colonne additive annulée aussi", !cols(db, "player_game_ids").includes("status"));
  // Et au « boot suivant », une fois la cause corrigée, elle passe.
  db.exec(`ALTER TABLE games RENAME COLUMN currency_old TO currency`);
  eq("boot suivant", runXpokerMigrationV1(db, SEED), "applied");
}

console.log("\n── A4. Transaction étrangère ouverte ⇒ report, aucun marqueur ──");
{
  const db = minimalDb();
  db.exec("BEGIN");
  eq("résultat", runXpokerMigrationV1(db, SEED), "deferred");
  check("aucun marqueur", !marker(db));
  eq("aucune table", tables(db), []);
  check("la transaction étrangère est toujours là (pas touchée)", db.inTransaction);
  db.exec("ROLLBACK");
  eq("boot suivant", runXpokerMigrationV1(db, SEED), "applied");
}

console.log("\n── A5. Contraintes du schéma ──");
{
  const db = minimalDb();
  runXpokerMigrationV1(db, SEED);
  const gid = db.prepare(`SELECT id FROM games WHERE name = ?`).get(XPOKER_GAME_NAME).id;
  const insImport = (delta: number, override: string | null, cleared: number | null) => db.prepare(`
    INSERT INTO xpoker_imports (week_start, week_end, tab_label, source, club_name, chip_value, rb_pct, tax_pct,
      sheet_total_winloss, sheet_total_rake, sheet_tax, sheet_rb_amount, sheet_total, sheet_cleared,
      recomputed_rb, recomputed_tax, recomputed_total, check_delta, override_reason, rate_chips_per_usd, rows_total)
    VALUES (@ws, date(@ws, '+6 days'), '8/3', 'xlsx', '花順', 1, 0.8, 0.05,
      -136.2, 256.43, -6.0115, 205.144, 199.1325, @cleared,
      205.144, -6.0115, 199.1325 + @delta, @delta, @override, 33, 1)
  `).run({ ws: "2026-07-27", delta, override, cleared });
  throws("checksum hors tolérance sans motif ⇒ refusé par la base",
    () => insImport(0.01, null, 199.1325), /CHECK constraint failed/);
  check("checksum hors tolérance AVEC motif ⇒ accepté", insImport(0.01, "TAX=0 en D2, formule à 5 % — écart acté", 199.1325).changes === 1);
  eq("check_ok généré = 0 sur cette ligne", db.prepare(`SELECT check_ok, cleared_matches FROM xpoker_imports`).get(), { check_ok: 0, cleared_matches: 1 });
  db.exec(`DELETE FROM xpoker_imports`);
  check("dans la tolérance sans motif ⇒ accepté", insImport(XPOKER_CHECK_TOLERANCE / 2, null, 190).changes === 1);
  eq("check_ok=1 et cleared_matches=0 quand 總交收 ≠ Total", db.prepare(`SELECT check_ok, cleared_matches FROM xpoker_imports`).get(), { check_ok: 1, cleared_matches: 0 });
  throws("une seule semaine par week_start", () => insImport(0, null, null), /UNIQUE/);
  const impId = db.prepare(`SELECT id FROM xpoker_imports`).get().id;

  const insRow = (member: string) => db.prepare(`
    INSERT INTO xpoker_week_rows (import_id, week_start, member_id, winloss_chips, rake_chips) VALUES (?, '2026-07-27', ?, -136.2, 256.43)
  `).run(impId, member);
  insRow("3062825");
  throws("un Player ID par semaine", () => insRow("3062825"), /UNIQUE/);
  db.exec(`DELETE FROM xpoker_imports`);
  eq("cascade import → lignes", db.prepare(`SELECT COUNT(*) n FROM xpoker_week_rows`).get().n, 0);

  const led = (kind: string, dir: string, extra: Record<string, unknown> = {}) => db.prepare(`
    INSERT INTO xpoker_chip_ledger (occurred_at, kind, direction, chips, rate_chips_per_usd, player_id, member_id, settlement_id)
    VALUES ('2026-08-03', @kind, @dir, 100, 33, @player_id, @member_id, @settlement_id)
  `).run({ kind, dir, player_id: null, member_id: null, settlement_id: null, ...extra });
  throws("buy-in sans compte ⇒ refusé", () => led("buyin", "out", { player_id: 1 }), /CHECK constraint failed/);
  check("buy-in avec joueur + compte ⇒ ok", led("buyin", "out", { player_id: 1, member_id: "3062825" }).changes === 1);
  throws("règlement club rattaché à un joueur ⇒ refusé", () => led("club_settlement", "in", { player_id: 1 }), /CHECK constraint failed/);
  check("règlement club anonyme ⇒ ok", led("club_settlement", "in").changes === 1);
  throws("chips ≤ 0 ⇒ refusé", () => db.prepare(`INSERT INTO xpoker_chip_ledger (occurred_at, kind, direction, chips, rate_chips_per_usd) VALUES ('2026-08-03','adjustment','in',0,33)`).run(), /CHECK constraint failed/);
  const sid = db.prepare(`INSERT INTO manual_settlements (game_id, player_id, amount_due_usdt, amount_due_native, native_currency, fx_rate_applied) VALUES (?, 1, 3.03, 100, 'TWD', 33)`).run(gid).lastInsertRowid;
  check("mouvement de règlement", led("action_paid", "out", { player_id: 1, settlement_id: sid }).changes === 1);
  throws("un seul mouvement par règlement", () => led("action_paid", "out", { player_id: 1, settlement_id: sid }), /UNIQUE/);
  throws("DELETE d'un règlement porteur d'un mouvement ⇒ refusé (NO ACTION)",
    () => db.prepare(`DELETE FROM manual_settlements WHERE id = ?`).run(sid), /FOREIGN KEY/);

  const sw = (week: string) => db.prepare(`
    INSERT INTO xpoker_settlement_weeks (settlement_id, player_id, week_start, winloss_chips, rake_chips, action_pct, rb_pct, action_chips, rb_chips, due_chips, rate_chips_per_usd)
    VALUES (?, 1, ?, 14053.56, 2845.38, 10, 0, 1405.356, 0, 1405.356, 33)
  `).run(sid, week);
  sw("2026-07-13");
  throws("double règlement d'une semaine ⇒ impossible", () => sw("2026-07-13"), /UNIQUE/);
  throws("deal : % hors bornes", () => db.prepare(`INSERT INTO xpoker_player_deals (player_id, action_pct, start_week) VALUES (1, 101, '2026-03-16')`).run(), /CHECK constraint failed/);
  throws("player_game_ids.status hors valeurs", () => db.prepare(`UPDATE player_game_ids SET status = 'deleted'`).run(), /CHECK constraint failed/);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n── B. Chaîne complète d'initSchema sur une COPIE de data/lecercle.db ──");
{
  // Depuis un worktree (.claude/worktrees/<x>), data/ n'existe pas : on prend la
  // base du checkout principal. LECERCLE_DB_SRC force une autre copie source.
  const candidates = [process.env.LECERCLE_DB_SRC, path.join(REPO, "data", "lecercle.db"), path.join(REPO, "..", "..", "..", "data", "lecercle.db")]
    .filter((p): p is string => !!p);
  const src = candidates.find(p => fs.existsSync(p)) ?? candidates[0];
  if (!fs.existsSync(src)) {
    console.log("   (data/lecercle.db absent — bloc B sauté)");
  } else {
    const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lecercle-xpoker-")));
    fs.mkdirSync(path.join(TMP, "data"));
    fs.copyFileSync(src, path.join(TMP, "data", "lecercle.db"));
    const before = new Database(path.join(TMP, "data", "lecercle.db"), { readonly: true });
    const nBefore = before.prepare(`SELECT COUNT(*) n FROM _applied_fixes`).get().n;
    const gamesBefore = before.prepare(`SELECT COUNT(*) n FROM games`).get().n;
    const msBefore = before.prepare(`SELECT COUNT(*) n FROM manual_settlements`).get().n;
    const pgiBefore = before.prepare(`SELECT COUNT(*) n FROM player_game_ids`).get().n;
    const legacyBefore = before.prepare(`SELECT id, name, status, default_action_pct, currency FROM games WHERE id = 3`).get();
    const fixesBefore: string[] = before.prepare(`SELECT name FROM _applied_fixes`).all().map((r: any) => r.name);
    before.close();
    console.log(`   copie : ${TMP}  (_applied_fixes=${nBefore}, games=${gamesBefore})`);

    process.chdir(TMP);
    // require APRÈS chdir : lib/db.ts fige DATA_DIR sur process.cwd() au chargement.
    const logs: string[] = [];
    const origLog = console.log, origErr = console.error;
    console.log = (...a: any[]) => { logs.push(a.join(" ")); };
    console.error = (...a: any[]) => { logs.push("ERR " + a.join(" ")); };
    const { getDb } = require(path.join(REPO, "lib/db.ts"));
    const db = getDb();
    console.log = origLog; console.error = origErr;

    const errs = logs.filter(l => l.startsWith("ERR") && /MIGRATION/.test(l));
    eq("aucune migration en erreur au boot", errs, []);
    check("log applied", logs.some(l => l.includes(`${XPOKER_MIGRATION_V1} applied`)), logs.filter(l => /xpoker/i.test(l)).join(" | "));
    check("marqueur posé", marker(db));
    const applied: string[] = db.prepare(`SELECT name FROM _applied_fixes ORDER BY name`).all().map((r: any) => r.name);
    const newMarkers = applied.length - nBefore;
    console.log(`   marqueurs : ${nBefore} → ${applied.length} (nouveaux : ${newMarkers}) = ${applied.filter(n => !fixesBefore.includes(n)).join(", ")}`);
    check("le nouveau marqueur est bien le nôtre", applied.includes(XPOKER_MIGRATION_V1));
    eq("tables xpoker_*", tables(db).length, 7);
    eq("colonnes manual_settlements (prod supposée ≡ local)", cols(db, "manual_settlements"),
       ["id","game_id","player_id","net_selected_usdt","action_pct_applied","amount_due_usdt","status","tx_hash","notes",
        "locked_at","paid_at","created_at","paid_date","kind","amount_due_native","native_currency","fx_rate_applied"]);
    check("colonnes player_game_ids", ["nickname","status","added_at"].every(c => cols(db, "player_game_ids").includes(c)));
    // Sur une copie locale en retard, add_pool_settlement_v1 s'applique dans le même
    // boot et ajoute sa propre ligne games : on la compte, on n'invente rien.
    const poolAppliedNow = logs.some(l => l.includes("add_pool_settlement_v1 applied")) ? 1 : 0;
    eq("games : +1 (XPOKER_TWD) + pool si appliqué ce boot", db.prepare(`SELECT COUNT(*) n FROM games`).get().n - gamesBefore, 1 + poolAppliedNow);
    // Comparé à son état AVANT (local = 'active', prod = 'archived') : intouché, pas « archivé ».
    eq("legacy Xpoker id=3 intouché", db.prepare(`SELECT id, name, status, default_action_pct, currency FROM games WHERE id = 3`).get(), legacyBefore);
    eq("manual_settlements : même nombre de lignes", db.prepare(`SELECT COUNT(*) n FROM manual_settlements`).get().n, msBefore);
    eq("player_game_ids : même nombre de lignes, tous 'active'", db.prepare(`SELECT COUNT(*) n FROM player_game_ids WHERE status = 'active'`).get().n, pgiBefore);
    check("pas de transaction laissée ouverte", !db.inTransaction);
    eq("intégrité", db.pragma("integrity_check")[0].integrity_check, "ok");
    eq("clés étrangères", db.pragma("foreign_key_check").length, 0);

    // Second boot : rien ne bouge.
    db.close();
    const db2 = new Database(path.join(TMP, "data", "lecercle.db"));
    db2.pragma("foreign_keys = ON");
    eq("second boot : already_applied", runXpokerMigrationV1(db2, SEED), "already_applied");
    eq("second boot : marqueurs inchangés", db2.prepare(`SELECT COUNT(*) n FROM _applied_fixes`).get().n, applied.length);
    db2.close();
    process.chdir(REPO);
  }
}

console.log(`\n${passed} ✔  ${failures.length} ✘`);
if (failures.length) { console.log("ÉCHECS :", failures); process.exit(1); }
