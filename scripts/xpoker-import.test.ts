/**
 * Harnais de l'ingestion XPoker Twd — aperçu puis commit d'un onglet, sur fixtures.
 * Run: npx tsx scripts/xpoker-import.test.ts
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────┐
 * │ L'aperçu lit TOUS les onglets d'un classeur (modèle ignoré, onglet        │
 * │ illisible signalé sans bloquer les autres), propose une plage d'après le  │
 * │ libellé + l'année suggérée (jamais appliquée seule), signale les Player   │
 * │ ID inconnus et les semaines déjà importées, et n'écrit RIEN. Le commit    │
 * │ reparse le fichier, refuse un onglet inconnu / modèle / déjà importé /    │
 * │ hors checksum sans motif, écrit une semaine avec sa provenance (hash),    │
 * │ et accepte un CSV natif comme un XLSX. Un bloc décalé passe.             │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
import path from "path";
import * as XLSX from "xlsx";
const REPO = path.resolve(__dirname, "..");
const Database = require(path.join(REPO, "node_modules/better-sqlite3"));
import { runXpokerMigrationV1, type XpokerSeed } from "../lib/games/xpoker/schema";
import { XPOKER_GAME_NAME, XPOKER_DEFAULT_ACTION_PCT, XPOKER_SEED_CHIPS_PER_USD, XPOKER_SEED_RATE_EFFECTIVE_FROM, XPOKER_SEED_AGENCY_ACCOUNTS } from "../lib/games/xpoker/config";
import { previewWorkbookOn, commitTabOn } from "../lib/games/xpoker/import";
import { linkMemberIdOn } from "../lib/games/xpoker/engine";
import { sheet, CAS1, CAS2 } from "./xpoker-fixture";

let passed = 0; const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") { if (cond) { passed++; console.log("   ✔", label); } else { failures.push(label); console.log("   ✘", label, detail); } }
function eq(label: string, got: unknown, want: unknown) { const g = JSON.stringify(got), w = JSON.stringify(want); check(label, g === w, g === w ? "" : `attendu ${w}, obtenu ${g}`); }

const SEED: XpokerSeed = { gameName: XPOKER_GAME_NAME, defaultActionPct: XPOKER_DEFAULT_ACTION_PCT, seedChipsPerUsd: XPOKER_SEED_CHIPS_PER_USD, seedRateEffectiveFrom: XPOKER_SEED_RATE_EFFECTIVE_FROM, agencyAccounts: XPOKER_SEED_AGENCY_ACCOUNTS };
const db = new Database(":memory:"); db.pragma("foreign_keys = ON");
db.exec(`CREATE TABLE _applied_fixes (name TEXT PRIMARY KEY); CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
  CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active', default_action_pct REAL, currency TEXT NOT NULL DEFAULT 'USDT');
  CREATE TABLE player_game_ids (id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE, game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE, external_id TEXT NOT NULL, UNIQUE(game_id, external_id));
  CREATE TABLE manual_settlements (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id INTEGER, player_id INTEGER, amount_due_usdt REAL);
  INSERT INTO players (name) VALUES ('Alice');`);
runXpokerMigrationV1(db, SEED);
linkMemberIdOn(db, { player_id: 1, member_id: "3062825" });

// Classeur : modèle + 8/3 (cas 1) + 7/20 (cas 2) + 3/23 (TAX=0, checksum KO) + un onglet cassé (libellé absent) + un bloc décalé.
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, sheet({ rows: [] }), "公版");
XLSX.utils.book_append_sheet(wb, sheet({ rows: CAS1 }), "83");
XLSX.utils.book_append_sheet(wb, sheet({ rows: CAS2 }), "720");
XLSX.utils.book_append_sheet(wb, sheet({ rows: CAS1, taxParam: 0 }), "323");
XLSX.utils.book_append_sheet(wb, sheet({ rows: CAS1, dropLabel: "Total Win/Lose" }), "cassé");
XLSX.utils.book_append_sheet(wb, sheet({ rows: CAS2, dc: 5, dr: 7, otherBlocks: true }), "111");
const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

console.log("\n── 1. Aperçu : tout le classeur, zéro écriture ──");
const pv = previewWorkbookOn(db, buf, "3970004.xlsx", 2026);
eq("source, 6 onglets, hash présent", [pv.source, pv.tabs.length, pv.file_hash.length, pv.year_suggested], ["xlsx", 6, 64, 2026]);
const by = Object.fromEntries(pv.tabs.map(t => [t.label, t]));
eq("modèle ignoré", [by["公版"].is_template, by["公版"].block], [true, null]);
eq("83 → proposé lundi 2026-08-03, semaine précédente 07-27 → 08-02, checksum ok", [by["83"].proposals.map(p => [p.tab_date, p.tab_day, p.week_start, p.week_end]), by["83"].ambiguous, by["83"].block?.checks.checksum_ok],
   [[["2026-08-03", "lundi", "2026-07-27", "2026-08-02"]], false, true]);
eq("720 : 2 Player ID inconnus (4136708, 4107823), 3062825 connu", by["720"].unlinked, ["4136708", "4107823"]);
eq("323 : checksum KO signalé, pas bloquant pour l'aperçu", [by["323"].block?.checks.checksum_ok, +(by["323"].block!.checks.check_delta).toFixed(4)], [false, 6.0115]);
check("cassé : erreur nommée, les autres onglets sont lus quand même", by["cassé"].block === null && /Total Win\/Lose/.test(by["cassé"].error ?? ""), by["cassé"].error ?? "");
eq("111 : libellé ambigu ⇒ 2 propositions, aucune choisie ; bloc décalé lu", [by["111"].ambiguous, by["111"].proposals.map(p => p.tab_date), by["111"].block?.checks.checksum_ok], [true, ["2026-01-11", "2026-11-01"], true]);
eq("rien n'a été écrit", db.prepare(`SELECT COUNT(*) n FROM xpoker_imports`).get().n, 0);
eq("année suggérée différente ⇒ autres propositions (2025 : 8/3 est un dimanche)", previewWorkbookOn(db, buf, null, 2025).tabs.find(t => t.label === "83")!.proposals[0].tab_day, "dimanche");

console.log("\n── 2. Commit : refus nommés ──");
check("onglet inconnu", !commitTabOn(db, buf, { tab_label: "999", week_start: "2026-07-27", week_end: "2026-08-02" }).ok);
check("onglet modèle", !commitTabOn(db, buf, { tab_label: "公版", week_start: "2026-07-27", week_end: "2026-08-02" }).ok);
check("onglet illisible", /Total Win\/Lose/.test((commitTabOn(db, buf, { tab_label: "cassé", week_start: "2026-07-27", week_end: "2026-08-02" }) as any).error));
check("checksum KO sans motif", /Checksum KO/.test((commitTabOn(db, buf, { tab_label: "323", week_start: "2026-03-16", week_end: "2026-03-22" }) as any).error));
check("plage non lundi→dimanche", !commitTabOn(db, buf, { tab_label: "83", week_start: "2026-07-28", week_end: "2026-08-03" }).ok);
eq("toujours rien d'écrit", db.prepare(`SELECT COUNT(*) n FROM xpoker_imports`).get().n, 0);

console.log("\n── 3. Commit : une semaine avec sa provenance, puis « déjà importée » ──");
const c1 = commitTabOn(db, buf, { tab_label: "83", week_start: "2026-07-27", week_end: "2026-08-02", filename: "3970004.xlsx" });
check("commit 83 ok", c1.ok, JSON.stringify(c1));
eq("provenance : onglet, source, hash, fichier, taux figé", db.prepare(`SELECT tab_label, source, file_hash, filename, rate_chips_per_usd, rows_total FROM xpoker_imports`).get(), { tab_label: "83", source: "xlsx", file_hash: pv.file_hash, filename: "3970004.xlsx", rate_chips_per_usd: 33, rows_total: 1 });
eq("ligne résolue sur Alice", db.prepare(`SELECT member_id, player_id FROM xpoker_week_rows`).all(), [{ member_id: "3062825", player_id: 1 }]);
eq("l'aperçu signale maintenant « déjà importé »", previewWorkbookOn(db, buf, null, 2026).tabs.find(t => t.label === "83")!.already_imported, { import_id: (c1 as any).import_id, week_start: "2026-07-27" });
check("re-commit ⇒ refus « déjà importée »", /déjà importée/.test((commitTabOn(db, buf, { tab_label: "83", week_start: "2026-07-27", week_end: "2026-08-02" }) as any).error));
const c2 = commitTabOn(db, buf, { tab_label: "323", week_start: "2026-03-16", week_end: "2026-03-22", override_reason: "TAX=0 en D2 — écart acté" });
check("323 avec motif ⇒ importé et marqué", c2.ok && db.prepare(`SELECT check_ok FROM xpoker_imports WHERE week_start = '2026-03-16'`).get().check_ok === 0);
// Le candidat 1/11 tombe AVANT la graine de taux (2026-03-16) : refus nommé « aucun taux » — c'est voulu.
check("semaine avant tout taux en vigueur ⇒ refus nommé", /Aucun taux/.test((commitTabOn(db, buf, { tab_label: "111", week_start: "2026-01-05", week_end: "2026-01-11" }) as any).error));
const c3 = commitTabOn(db, buf, { tab_label: "111", week_start: "2026-10-26", week_end: "2026-11-01" });
check("bloc décalé entre d'autres clubs ⇒ importé (candidat 11/1)", c3.ok, JSON.stringify(c3));

console.log("\n── 4. CSV natif (onglet « Sheet1 », taux en texte) ──");
const csv = Buffer.from("﻿" + XLSX.utils.sheet_to_csv(sheet({ rows: CAS2, asText: true })), "utf8");
const pc = previewWorkbookOn(db, csv, "export.csv", 2026);
eq("un onglet Sheet1, pas de date proposée, checksum ok", [pc.source, pc.tabs.map(t => [t.label, t.ambiguous, t.proposals.length, t.block?.checks.checksum_ok])], ["csv", [["Sheet1", true, 0, true]]]);
const c4 = commitTabOn(db, csv, { tab_label: "Sheet1", week_start: "2026-07-13", week_end: "2026-07-19", filename: "export.csv" });
check("commit CSV avec plage saisie à la main ⇒ ok, source csv", c4.ok && db.prepare(`SELECT source FROM xpoker_imports WHERE week_start = '2026-07-13'`).get().source === "csv", JSON.stringify(c4));
eq("4 semaines importées", db.prepare(`SELECT COUNT(*) n FROM xpoker_imports`).get().n, 4);

console.log(`\n${passed} ✔  ${failures.length} ✘`);
if (failures.length) { console.log("ÉCHECS :", failures); process.exit(1); }
