/**
 * Harnais du stock des ANCIENS groupes (job « groupes silencieux 7 j »).
 * Run: npx tsx scripts/group-silent-history.test.ts
 *
 * Porte sur le VRAI module lib/group-silent-history.ts (pur, sans Telegram), sur une base
 * SQLite en mémoire au schéma minimal de group_creations + settings.
 *
 * Prouve : un groupe ne redevient supprimable QUE sur un historique lu en entier et vide ;
 * tout le reste (message trouvé, historique tronqué, lectures en échec, message vu par le
 * webhook entre-temps) le laisse protégé ; le stock ancien ne passe jamais en réel sans son
 * propre dry-run, même si celui des nouveaux groupes est déjà fait.
 * Ne prouve pas : la lecture Telegram elle-même (findUserFirstMessage, userbot).
 */

import path from "path";
const REPO = path.resolve(__dirname, "..");
const Database = require(path.join(REPO, "node_modules/better-sqlite3"));
import {
  legacyHistoryBatchOn, applyHistoryVerdictOn, silentCleanupModeOn, markSilentDryRunDoneOn,
  legacyPendingOn, LEGACY_DRY_RUN_FLAG, NEW_DRY_RUN_FLAG,
} from "../lib/group-silent-history";

let passed = 0; const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log("   ✔", label); } else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

function freshDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE group_creations (chat_id TEXT PRIMARY KEY, owner_key INTEGER, created_at TEXT, joined_at TEXT,
      cleaned_at TEXT, first_msg_at TEXT, first_msg_source TEXT, history_attempts INTEGER NOT NULL DEFAULT 0);
  `);
  const ins = db.prepare(`INSERT INTO group_creations VALUES (?, ?, ?, ?, ?, ?, ?, 0)`);
  // Anciens groupes marqués par le backfill (first_msg_at = joined_at)
  ins.run("-1001", 11, "2026-07-01 10:00:00", "2026-07-01 11:00:00", null, "2026-07-01 11:00:00", "backfill");
  ins.run("-1002", 22, "2026-07-02 10:00:00", "2026-07-02 11:00:00", null, "2026-07-02 11:00:00", "backfill");
  ins.run("-1003", 33, "2026-07-03 10:00:00", "2026-07-03 11:00:00", null, "2026-07-03 11:00:00", "backfill");
  ins.run("-1004", 44, "2026-07-04 10:00:00", "2026-07-04 11:00:00", null, "2026-07-04 11:00:00", "backfill");
  ins.run("-1005", 55, "2026-07-05 10:00:00", "2026-07-05 11:00:00", null, "2026-07-05 11:00:00", "backfill");
  // Hors lot : déjà nettoyé, jamais rejoint, vu par le webhook
  ins.run("-1006", 66, "2026-07-06 10:00:00", "2026-07-06 11:00:00", "2026-08-01", "2026-07-06 11:00:00", "backfill");
  ins.run("-1007", 77, "2026-07-07 10:00:00", null, null, "2026-07-07 10:00:00", "backfill");
  ins.run("-1008", 88, "2026-07-08 10:00:00", "2026-07-08 11:00:00", null, "2026-09-26 12:00:00.000", "webhook");
  return db;
}
const src = (db: any, id: string) => db.prepare(`SELECT first_msg_at, first_msg_source, history_attempts FROM group_creations WHERE chat_id = ?`).get(id);

console.log("\n══ Lot à vérifier ══");
{
  const db = freshDb();
  eq("seuls les anciens groupes rejoints, non nettoyés, source backfill", legacyHistoryBatchOn(db, 40).map(r => r.chat_id), ["-1001", "-1002", "-1003", "-1004", "-1005"]);
  eq("limite respectée", legacyHistoryBatchOn(db, 2).length, 2);
}

console.log("\n══ Verdicts ══");
{
  const db = freshDb();
  eq("message trouvé ⇒ spoke, date réelle, protégé", [applyHistoryVerdictOn(db, "-1001", { checked: true, found_at: "2026-07-01T12:00:00.000Z", truncated: false, error: null }), src(db, "-1001")],
     ["spoke", { first_msg_at: "2026-07-01T12:00:00.000Z", first_msg_source: "history", history_attempts: 0 }]);
  eq("message trouvé sur historique tronqué ⇒ spoke quand même", applyHistoryVerdictOn(db, "-1002", { checked: true, found_at: "2026-07-02T12:00:00.000Z", truncated: true, error: null }), "spoke");
  eq("historique complet sans un mot ⇒ silent, first_msg_at NULL (candidat)", [applyHistoryVerdictOn(db, "-1003", { checked: true, found_at: null, truncated: false, error: null }), src(db, "-1003")],
     ["silent", { first_msg_at: null, first_msg_source: "history_none", history_attempts: 0 }]);
  eq("historique tronqué sans message ⇒ truncated, reste protégé", [applyHistoryVerdictOn(db, "-1004", { checked: true, found_at: null, truncated: true, error: null }), src(db, "-1004").first_msg_at !== null],
     ["truncated", true]);
  eq("lecture en échec ×1 ⇒ retry", applyHistoryVerdictOn(db, "-1005", { checked: false, found_at: null, truncated: false, error: "FLOOD" }), "retry");
  eq("lecture en échec ×2 ⇒ retry", applyHistoryVerdictOn(db, "-1005", { checked: false, found_at: null, truncated: false, error: "FLOOD" }), "retry");
  eq("lecture en échec ×3 ⇒ unreadable, reste protégé", [applyHistoryVerdictOn(db, "-1005", { checked: false, found_at: null, truncated: false, error: "FLOOD" }), src(db, "-1005").first_msg_source, src(db, "-1005").first_msg_at !== null],
     ["unreadable", "history_unreadable", true]);
  eq("groupe vu par le webhook : jamais écrasé (unchanged)", [applyHistoryVerdictOn(db, "-1008", { checked: true, found_at: null, truncated: false, error: null }), src(db, "-1008").first_msg_source],
     ["unchanged", "webhook"]);
  eq("groupe déjà tranché : un second verdict ne change rien", [applyHistoryVerdictOn(db, "-1001", { checked: true, found_at: null, truncated: false, error: null }), src(db, "-1001").first_msg_source],
     ["unchanged", "history"]);
  eq("lot suivant : plus rien à vérifier", legacyHistoryBatchOn(db, 40).length, 0);
  eq("un seul ancien groupe candidat (-1003)", legacyPendingOn(db), 1);
}

console.log("\n══ Dry-run d'abord — nouveaux groupes puis stock ancien ══");
{
  const db = freshDb();
  eq("aucun marqueur ⇒ dry-run", silentCleanupModeOn(db), { dryRun: true, legacyPending: 0 });
  eq("dry-run à vide (0 groupe examiné) ⇒ aucun marqueur", markSilentDryRunDoneOn(db, { dryRun: true, ok: true, scanned: 0, legacyPending: 0 }), []);
  eq("dry-run qui a examiné des nouveaux groupes ⇒ marqueur nouveaux seulement", markSilentDryRunDoneOn(db, { dryRun: true, ok: true, scanned: 3, legacyPending: 0 }), [NEW_DRY_RUN_FLAG]);
  eq("⇒ run suivant en réel (pas d'ancien candidat)", silentCleanupModeOn(db).dryRun, false);
  applyHistoryVerdictOn(db, "-1003", { checked: true, found_at: null, truncated: false, error: null });
  eq("un ancien groupe devient candidat ⇒ retour en DRY-RUN malgré le marqueur nouveaux", silentCleanupModeOn(db), { dryRun: true, legacyPending: 1 });
  eq("dry-run en échec (ok=false) ⇒ aucun marqueur", markSilentDryRunDoneOn(db, { dryRun: true, ok: false, scanned: 1, legacyPending: 1 }), []);
  eq("dry-run qui a examiné le stock ⇒ marqueur ancien posé", markSilentDryRunDoneOn(db, { dryRun: true, ok: true, scanned: 1, legacyPending: 1 }).includes(LEGACY_DRY_RUN_FLAG), true);
  eq("⇒ run suivant en réel", silentCleanupModeOn(db).dryRun, false);
  eq("un run RÉEL ne pose jamais de marqueur", markSilentDryRunDoneOn(db, { dryRun: false, ok: true, scanned: 5, legacyPending: 1 }), []);
}

console.log(`\n${passed} ✔  ${failures.length} ✘`);
if (failures.length) process.exit(1);
