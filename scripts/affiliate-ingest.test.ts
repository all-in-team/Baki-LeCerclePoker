/**
 * Harnais du chemin d'écriture unique des semaines NEXA.
 * Run: npx tsx scripts/affiliate-ingest.test.ts
 *
 * Base SQLite RÉELLE et jetable — pas de mock : l'index UNIQUE, le CHECK de
 * tolérance et les colonnes générées sont exercés pour de vrai. C'est le point :
 * une partie des garanties de ce module est portée par le schéma, pas par le TS.
 *
 * Le schéma est construit en EXTRAYANT le SQL de add_nexa_affiliate_v1 depuis
 * lib/db.ts — jamais recopié, donc jamais désynchronisé.
 *
 * Pourquoi ne pas booter initSchema() comme le fait group-provisioning.test.ts :
 * il ne va pas au bout sur une base vierge (FK en dur ligne 589, puis BEGIN sans
 * COMMIT dans add_a5poker_game_v1 qui fait tomber tout ce qui suit). Voir
 * docs/MIGRATIONS_BASE_VIERGE.md. On monte donc les tables prérequises à la main
 * et on applique le seul bloc qui nous concerne.
 *
 * Cas couverts :
 *   résolution — par Member ID · par pseudo · non résolue · ID inconnu -> hint,
 *                jamais appliqué · aucune création implicite de joueur
 *   clés       — parité row_key JS/SQL · ligne sans Member ID vue deux fois
 *                (même semaine -> refusée, semaines différentes -> acceptées)
 *   diff       — ajoutée / modifiée / inchangée / supprimée explicitement
 *                / orpheline (omission) -> BLOQUANT
 *   tolérance  — hors tolérance sans motif refusé par le module ET par la base
 *                avec motif -> écrite, check_ok = 0
 *   commit     — idempotence du re-commit · atomicité (échec = rien d'écrit)
 *                · semaine non-lundi refusée
 */

import fs from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lecercle-ingest-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP); // avant tout import de lib/db : DATA_DIR y est figé au chargement

const Database = require(path.join(REPO, "node_modules/better-sqlite3"));

import {
  nicknameKey, computeRowKey, isMondayISO,
  resolveRowsOn, previewWeekOn, commitWeekOn, getWeekRowsOn, getKnownEntrantsOn,
} from "../lib/funnels/nexa/affiliate-ingest";
import type { RawAffiliateRow } from "../lib/funnels/nexa/affiliate-deal";

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

// ── Schéma de test ────────────────────────────────────────────────────────
const SRC = fs.readFileSync(path.join(REPO, "lib/db.ts"), "utf8");
const anchor = SRC.indexOf("const alreadyApplied = db.prepare");
if (anchor === -1) throw new Error("bloc add_nexa_affiliate_v1 introuvable dans lib/db.ts");
const execStart = SRC.indexOf("db.exec(`", anchor);
const MIGRATION_SQL = SRC.slice(execStart + "db.exec(`".length, SRC.indexOf("`);", execStart + 9));

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE _applied_fixes (name TEXT PRIMARY KEY);
    CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active', default_action_pct REAL, currency TEXT NOT NULL DEFAULT 'USDT');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nexa_leads (id INTEGER PRIMARY KEY AUTOINCREMENT, tg_user_id INTEGER NOT NULL UNIQUE, member_id TEXT UNIQUE);
    CREATE TABLE manual_settlements (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL, amount_due_usdt REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'locked');
    CREATE TABLE player_game_ids (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL, UNIQUE(game_id, external_id));
  `);
  db.exec(MIGRATION_SQL);
  return db;
}

const DEAL = "40% NLH and MTT, 45% PLO, 55% Spins";
const MONDAY = "2026-07-13";
const MONDAY2 = "2026-07-20";

const row = (over: Partial<RawAffiliateRow> = {}): RawAffiliateRow => ({
  nickname: "Jopok", member_id: "2518550", deal_text: DEAL,
  nlh: 800, mtt: 200, plo: 400, spins: 100, affiliate_payment: 635, ...over,
});
/** Une ligne cohérente sans Member ID. 1200 NLH @40% = 480. */
const noId = (nickname: string): RawAffiliateRow => ({
  nickname, member_id: null, deal_text: DEAL,
  nlh: 1200, mtt: 0, plo: 0, spins: 0, affiliate_payment: 480,
});

function seed(db: any) {
  const p1 = db.prepare(`INSERT INTO players (name) VALUES ('Jopok')`).run().lastInsertRowid;
  const p2 = db.prepare(`INSERT INTO players (name) VALUES ('Mareck')`).run().lastInsertRowid;
  const gid = db.prepare(`SELECT id FROM games WHERE name='NEXAPOKER'`).get().id;
  return { p1, p2, gid };
}

console.log("\n══ Helpers de clés ══");
eq("nicknameKey : casse et espaces", nicknameKey("  JoPok  "), "jopok");
eq("computeRowKey : ID présent", computeRowKey("2518550", "jopok"), "2518550");
eq("computeRowKey : ID null", computeRowKey(null, "jopok"), "nick:jopok");
eq("computeRowKey : ID vide", computeRowKey("  ", "jopok"), "nick:jopok");
check("isMondayISO : lundi", isMondayISO("2026-07-13"));
check("isMondayISO : dimanche refusé", !isMondayISO("2026-07-12"));
check("isMondayISO : mardi refusé", !isMondayISO("2026-07-14"));
check("isMondayISO : date impossible refusée", !isMondayISO("2026-02-31"));
check("isMondayISO : format libre refusé", !isMondayISO("13/07/2026"));

console.log("\n══ Parité row_key JS ↔ colonne générée SQL ══");
{
  const db = freshDb(); const { p1, gid } = seed(db);
  db.prepare(`INSERT INTO player_game_ids (player_id, game_id, external_id) VALUES (?,?,?)`).run(p1, gid, "2518550");
  commitWeekOn(db, MONDAY, [row(), noId("Mareck")]);
  const stored = getWeekRowsOn(db, MONDAY);
  for (const s of stored) {
    eq(`row_key SQL = JS pour « ${s.nickname} »`, s.row_key, computeRowKey(s.member_id, s.nickname_key));
  }
  db.close();
}

console.log("\n══ resolveRows — aucune devinette ══");
{
  const db = freshDb(); const { p1, p2, gid } = seed(db);
  db.prepare(`INSERT INTO player_game_ids (player_id, game_id, external_id) VALUES (?,?,?)`).run(p1, gid, "2518550");
  db.prepare(`INSERT INTO nexa_nickname_links (nickname_key, player_id) VALUES ('mareck', ?)`).run(p2);

  const r = resolveRowsOn(db, [
    row(),                                        // ID connu
    noId("MARECK"),                               // pas d'ID, pseudo lié (casse différente)
    noId("Inconnu"),                              // pas d'ID, pseudo inconnu
    row({ nickname: "Mareck", member_id: "9999999" }), // ID INCONNU alors que le pseudo est lié
  ]);

  eq("ID connu → rattaché par member_id", [r[0].player_id, r[0].resolved_by], [p1, "member_id"]);
  eq("pas d'ID + pseudo lié → rattaché par nickname", [r[1].player_id, r[1].resolved_by], [p2, "nickname"]);
  eq("pseudo inconnu → non rattaché", [r[2].player_id, r[2].resolved_by, r[2].hint], [null, null, null]);
  eq("ID inconnu → NON rattaché malgré le pseudo lié", [r[3].player_id, r[3].resolved_by], [null, null]);
  eq("… mais le candidat est proposé en hint", r[3].hint, { player_id: p2, via: "nickname" });

  eq("aucun joueur créé implicitement", db.prepare(`SELECT COUNT(*) n FROM players`).get().n, 2);
  eq("aucun lien pseudo créé implicitement", db.prepare(`SELECT COUNT(*) n FROM nexa_nickname_links`).get().n, 1);
  eq("aucun lien member_id créé implicitement", db.prepare(`SELECT COUNT(*) n FROM player_game_ids`).get().n, 1);
  db.close();
}

console.log("\n══ Ligne sans Member ID vue deux fois ══");
{
  const db = freshDb(); seed(db);
  // Même semaine, même pseudo, pas d'ID → indistinguables → les DEUX refusées.
  const res = commitWeekOn(db, MONDAY, [noId("Mareck"), noId("mareck")]);
  check("même semaine → commit refusé", !res.ok && res.reason === "duplicate_row_key");
  if (!res.ok) eq("clé en double signalée", res.diff.duplicates, ["nick:mareck"]);
  eq("rien écrit", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks`).get().n, 0);
  eq("aucune entrée de journal", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_entries`).get().n, 0);

  // Deux semaines différentes → parfaitement légitime.
  check("semaine 1 acceptée", commitWeekOn(db, MONDAY, [noId("Mareck")]).ok);
  check("semaine 2 acceptée (même pseudo)", commitWeekOn(db, MONDAY2, [noId("Mareck")]).ok);
  eq("2 lignes stockées", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks`).get().n, 2);
  eq("une par semaine",
     db.prepare(`SELECT COUNT(DISTINCT week_start) n FROM nexa_affiliate_weeks WHERE row_key='nick:mareck'`).get().n, 2);
  db.close();
}

console.log("\n══ Idempotence du re-commit ══");
{
  const db = freshDb(); seed(db);
  const rows = [row(), noId("Mareck")];
  const first = commitWeekOn(db, MONDAY, rows);
  check("premier commit OK", first.ok);
  if (first.ok) eq("2 ajoutées", first.diff.added.length, 2);

  const second = commitWeekOn(db, MONDAY, rows);
  check("re-commit identique OK", second.ok);
  if (second.ok) {
    eq("2 inchangées", second.diff.unchanged.length, 2);
    eq("0 ajoutée", second.diff.added.length, 0);
    eq("0 orpheline", second.diff.orphans.length, 0);
  }
  eq("toujours 2 lignes, pas 4", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks`).get().n, 2);
  eq("2 entrées de journal (une par commit)", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_entries`).get().n, 2);

  // Correction d'un montant : modifiée, pas dupliquée.
  const third = commitWeekOn(db, MONDAY, [row({ nlh: 900, affiliate_payment: 675 }), noId("Mareck")]);
  check("correction acceptée", third.ok);
  if (third.ok) eq("1 modifiée", third.diff.modified.map(m => m.changes).flat().sort(), ["affiliate_payment", "nlh"]);
  eq("toujours 2 lignes après correction", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks`).get().n, 2);
  eq("montant corrigé en base",
     db.prepare(`SELECT nlh FROM nexa_affiliate_weeks WHERE row_key='2518550'`).get().nlh, 900);
  db.close();
}

console.log("\n══ Suppression explicite, jamais par omission ══");
{
  const db = freshDb(); seed(db);
  commitWeekOn(db, MONDAY, [row(), noId("Mareck")]);

  // Omission : on renvoie une seule des deux lignes, sans rien demander.
  const omitted = commitWeekOn(db, MONDAY, [row()]);
  check("omission → commit refusé", !omitted.ok && omitted.reason === "orphans");
  if (!omitted.ok) eq("orpheline signalée nommément", omitted.diff.orphans, ["nick:mareck"]);
  eq("les 2 lignes sont toujours là", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks`).get().n, 2);

  // Suppression demandée explicitement.
  const removed = commitWeekOn(db, MONDAY, [row()], { deletions: ["nick:mareck"] });
  check("suppression explicite acceptée", removed.ok);
  if (removed.ok) eq("supprimée listée dans le diff", removed.diff.deleted, ["nick:mareck"]);
  eq("1 ligne restante", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks`).get().n, 1);
  eq("c'est bien la bonne qui reste",
     db.prepare(`SELECT row_key FROM nexa_affiliate_weeks`).get().row_key, "2518550");
  db.close();
}

console.log("\n══ Tolérance : hors 0,02 sans motif ══");
{
  const db = freshDb(); seed(db);
  // 950 NLH + 150 MTT @40% = 440, mais on saisit 404.
  const typo = row({ nlh: 950, mtt: 150, plo: 0, spins: 0, affiliate_payment: 404 });

  const res = commitWeekOn(db, MONDAY, [typo]);
  check("module : commit refusé", !res.ok && res.reason === "validation");
  if (!res.ok) {
    eq("code du rejet", res.diff.rejected[0].code, "payment_mismatch");
    check("message chiffré", /440\.00/.test(res.diff.rejected[0].message), res.diff.rejected[0].message);
  }
  eq("rien écrit", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks`).get().n, 0);

  // Et si on court-circuite le module, la BASE refuse aussi.
  let dbRefused = false;
  try {
    db.prepare(`INSERT INTO nexa_affiliate_weeks
      (week_start, nickname, nickname_key, deal_text, rate_nlh, rate_mtt, rate_plo, rate_spins,
       affiliate_payment, affiliate_payment_recomputed, check_delta)
      VALUES (?, 'Zed','zed',?, 40,40,45,55, 404, 440, 36)`).run(MONDAY, DEAL);
  } catch (e: any) { dbRefused = /CHECK/i.test(e.message); }
  check("base : INSERT direct hors tolérance refusé par le CHECK", dbRefused);
  db.close();
}

console.log("\n══ Tolérance : hors 0,02 AVEC motif ══");
{
  const db = freshDb(); seed(db);
  const typo = row({ nlh: 950, mtt: 150, plo: 0, spins: 0, affiliate_payment: 404 });
  const res = commitWeekOn(db, MONDAY, [typo], { overrides: { "2518550": "screenshot NEXA incohérent" } });
  check("commit accepté avec motif", res.ok);
  const stored = getWeekRowsOn(db, MONDAY)[0];
  eq("check_ok = 0", stored.check_ok, 0);
  eq("motif conservé", stored.override_reason, "screenshot NEXA incohérent");
  check("écart stocké", Math.abs(stored.check_delta - 36) < 1e-9, `delta=${stored.check_delta}`);
  check("recalcul stocké", Math.abs(stored.affiliate_payment_recomputed - 440) < 1e-9);
  eq("montant du screenshot conservé tel quel", stored.affiliate_payment, 404);

  // Un motif vide ne vaut pas motif.
  const db2 = freshDb(); seed(db2);
  const blank = commitWeekOn(db2, MONDAY, [typo], { overrides: { "2518550": "   " } });
  check("motif vide → toujours refusé", !blank.ok && blank.reason === "validation");
  // Et seul payment_mismatch est forçable.
  const bad = commitWeekOn(db2, MONDAY, [row({ deal_text: "40% NLHE" })], { overrides: { "2518550": "je force" } });
  check("un deal illisible n'est PAS forçable", !bad.ok && bad.reason === "validation");
  if (!bad.ok) eq("code non forçable", bad.diff.rejected[0].code, "unknown_variant");
  db.close(); db2.close();
}

console.log("\n══ Semaine invalide ══");
{
  const db = freshDb(); seed(db);
  const sunday = commitWeekOn(db, "2026-07-12", [row()]);
  check("dimanche refusé", !sunday.ok && sunday.reason === "invalid_week");
  eq("rien écrit", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks`).get().n, 0);
  db.close();
}

console.log("\n══ Atomicité : un échec n'écrit rien ══");
{
  const db = freshDb(); const { gid } = seed(db);
  // Lien pointant vers un joueur inexistant (posé FK OFF) : l'INSERT de la ligne
  // violera la FK player_id en pleine transaction.
  db.pragma("foreign_keys = OFF");
  db.prepare(`INSERT INTO player_game_ids (player_id, game_id, external_id) VALUES (424242, ?, '2518550')`).run(gid);
  db.pragma("foreign_keys = ON");

  let threw = false;
  try { commitWeekOn(db, MONDAY, [row(), noId("Mareck")]); }
  catch (e: any) { threw = /FOREIGN KEY/i.test(e.message); }
  check("l'échec remonte (pas d'écriture partielle silencieuse)", threw);
  eq("aucune ligne écrite", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks`).get().n, 0);
  eq("aucune entrée de journal écrite", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_entries`).get().n, 0);
  db.close();
}

console.log("\n══ previewWeek n'écrit jamais ══");
{
  const db = freshDb(); seed(db);
  const d = previewWeekOn(db, MONDAY, [row(), noId("Mareck")]);
  eq("2 ajouts annoncés", d.added.length, 2);
  eq("base toujours vide", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks`).get().n, 0);
  eq("aucune entrée de journal", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_entries`).get().n, 0);
  db.close();
}

console.log("\n══ Journal des saisies ══");
{
  const db = freshDb(); seed(db);
  commitWeekOn(db, MONDAY, [row()], { actor: "baki", note: "screenshot du 04/08" });
  const e = db.prepare(`SELECT week_start, source, actor, rows_total, rows_ok, rows_rejected, note FROM nexa_affiliate_entries`).get();
  eq("semaine", e.week_start, MONDAY);
  eq("source par défaut = manual", e.source, "manual");
  eq("acteur", e.actor, "baki");
  eq("compteurs", [e.rows_total, e.rows_ok, e.rows_rejected], [1, 1, 0]);
  eq("note", e.note, "screenshot du 04/08");
  eq("ligne reliée à son entrée",
     db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks w JOIN nexa_affiliate_entries en ON en.id = w.entry_id`).get().n, 1);
  db.close();
}

console.log("\n══ Autocomplétion (getKnownEntrants) ══");
{
  const db = freshDb(); const { p1, p2, gid } = seed(db);
  db.prepare(`INSERT INTO player_game_ids (player_id, game_id, external_id) VALUES (?,?,?)`).run(p1, gid, "2518550");
  db.prepare(`INSERT INTO nexa_nickname_links (nickname_key, player_id) VALUES ('mareck', ?)`).run(p2);
  eq("base vierge de saisies → propose quand même les liens connus",
     getKnownEntrantsOn(db).length >= 2, true);

  // Deux semaines : c'est le deal de la PLUS RÉCENTE qui doit être proposé.
  commitWeekOn(db, MONDAY, [row()]);
  // 800×50% + 200×50% + 400×45% + 100×55% = 400 + 100 + 180 + 55 = 735
  const w2 = commitWeekOn(db, MONDAY2, [row({ deal_text: "50% NLH and MTT, 45% PLO, 55% Spins", affiliate_payment: 735 })]);
  check("semaine 2 écrite (sinon le « dernier deal » ne veut rien dire)", w2.ok);
  const known = getKnownEntrantsOn(db);
  const jopok = known.find(e => e.nickname_key === "jopok");
  check("pseudo saisi proposé", !!jopok);
  eq("member_id proposé", jopok?.member_id, "2518550");
  eq("dernier deal proposé (celui de la semaine la plus récente)",
     jopok?.last_deal_text, "50% NLH and MTT, 45% PLO, 55% Spins");
  eq("un seul enregistrement par pseudo malgré 2 semaines",
     known.filter(e => e.nickname_key === "jopok").length, 1);
  db.close();
}

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} passés, ${failures.length} échoués`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
if (failures.length) { failures.forEach(f => console.log("   ✘", f)); process.exit(1); }
