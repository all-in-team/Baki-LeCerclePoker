// Statut active / inactive automatique (Baki 2026-09-25).
// Run: npx tsx scripts/player-status-auto.test.ts   (bloc B : LECERCLE_DB_SRC=<copie migrée d'un dump prod>)
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ Règle (décidée par Baki) :                                                 │
// │  1. active = activité de JEU dans les 21 derniers jours, inactive sinon.   │
// │  2. Nouveau joueur : active pendant 21 jours après sa création.            │
// │  3. Archivé + activité POSTÉRIEURE à l'archivage → désarchivé.             │
// │  4. « Statut manuel » : l'automate ne touche pas à son statut.             │
// │  5. Seul le jeu compte : PAS de règlement payé, semaine TELE reçue,        │
// │     commission d'affiliation payée (ni versement action/RB XPoker).        │
// │  6. Chaque bascule est tracée (player_status_changes), tout ou rien.       │
// │ A. Base en mémoire, schéma minimal : chaque source, chaque règle.          │
// │ B. Copie d'un dump migré : migration réelle, plan sur données réelles,     │
// │    application + trace, rejouabilité.                                     │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..");
// lib/db.ts fige son dossier de base (cwd/data) AU CHARGEMENT : on se place dans un dossier
// temporaire AVANT de charger le moindre module du projet.
const DB_SRC = [process.env.LECERCLE_DB_SRC, path.join(REPO, "data", "lecercle.db")]
  .filter((p): p is string => !!p).find(p => fs.existsSync(p));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lecercle-status-auto-")));
fs.mkdirSync(path.join(TMP, "data"));
if (DB_SRC) {
  fs.copyFileSync(DB_SRC, path.join(TMP, "data", "lecercle.db"));
  fs.chmodSync(path.join(TMP, "data", "lecercle.db"), 0o644);   // une copie de dump est en lecture seule
}
process.chdir(TMP);

const { planStatusAutoOn, applyStatusAutoOn, normalizeTs } = require(path.join(REPO, "lib/player-status-auto.ts")) as typeof import("../lib/player-status-auto");
const { PLAYER_STATUS_CHANGES_SQL } = require(path.join(REPO, "lib/player-status-auto-schema.ts")) as typeof import("../lib/player-status-auto-schema");

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n── A. Base en mémoire, schéma minimal ──");
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, status TEXT, archived_at TEXT, archive_reason TEXT, created_at TEXT DEFAULT '2026-01-01 00:00:00', status_manual INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE player_game_ids (player_id INT, game_id INT, external_id TEXT);
  CREATE TABLE wallet_transactions (id INTEGER PRIMARY KEY, player_id INT, source TEXT, status TEXT, tx_datetime TEXT, tx_date TEXT);
  CREATE TABLE nexa_affiliate_weeks (player_id INT, week_start TEXT, nlh REAL, mtt REAL, plo REAL, spins REAL);
  CREATE TABLE nexa_weekly_stats (member_id TEXT, week_start TEXT, rake REAL, winloss REAL);
  CREATE TABLE nexa_player_weekly_winloss (player_id INT, week_start TEXT, amount REAL);
  CREATE TABLE nexa_player_bankroll_weeks (player_id INT, week_start TEXT, transfer_movement_id INT);
  CREATE TABLE xpoker_week_rows (player_id INT, week_start TEXT, rake_chips REAL, winloss_chips REAL);
  CREATE TABLE xpoker_chip_ledger (id INTEGER PRIMARY KEY, player_id INT, occurred_at TEXT, kind TEXT, reverses_id INT);
  CREATE TABLE pool_periods (player_id INT, opened_at TEXT, closed_at TEXT);
  CREATE TABLE pool_external_movements (player_id INT, occurred_at TEXT, kind TEXT);
  CREATE TABLE qqpk_staking_blocks (player_id INT, block_start TEXT, block_end TEXT, mains INT, resultat_periode REAL);
  CREATE TABLE grindhouse_sessions (player_id INT, session_date TEXT);
  CREATE TABLE rakeback_reports (id INTEGER PRIMARY KEY, report_date TEXT, created_at TEXT);
  CREATE TABLE rakeback_entries (report_id INT, player_id INT, amount REAL DEFAULT 0, insurance_amount REAL DEFAULT 0, winnings_amount REAL DEFAULT 0);
  -- Sources EXCLUES (règle 5) : présentes pour prouver qu'elles ne comptent pas.
  CREATE TABLE weekly_settlements (player_id INT, paid_at TEXT);
  CREATE TABLE cashout_requests (player_id INT, created_at TEXT);
  INSERT INTO games VALUES (1, 'NEXAPOKER'), (2, 'KKPOKER');
`);
db.exec(PLAYER_STATUS_CHANGES_SQL);

const NOW = new Date("2026-09-25T21:22:00Z");       // fenêtre : depuis 2026-09-04 21:22:00
const RECENT = "2026-09-20", OLD = "2026-08-01";
let nextId = 1;
const P = (status: string, extra: Partial<{ archived_at: string; created_at: string; status_manual: number }> = {}) => {
  const id = nextId++;
  db.prepare(`INSERT INTO players (id, name, status, archived_at, created_at, status_manual) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, `p${id}`, status, extra.archived_at ?? null, extra.created_at ?? "2026-01-01 00:00:00", extra.status_manual ?? 0);
  return id;
};
const plan = () => planStatusAutoOn(db, NOW).changes;
const changeOf = (id: number, kind = "status") => plan().find(c => c.player_id === id && c.kind === kind);
const newStatus = (id: number) => changeOf(id)?.new_value ?? "inchangé";

console.log("  Chaque source de jeu rend actif (joueur inactive, activité récente) :");
const sources: [string, (id: number) => void][] = [
  ["tx wallet sync", id => db.prepare(`INSERT INTO wallet_transactions (player_id, source, status, tx_datetime, tx_date) VALUES (?, 'sync', NULL, ?, NULL)`).run(id, `${RECENT} 10:00:00`)],
  ["tx wallet manuelle (date seule)", id => db.prepare(`INSERT INTO wallet_transactions (player_id, source, status, tx_datetime, tx_date) VALUES (?, 'manual', 'active', NULL, ?)`).run(id, RECENT)],
  ["rake NEXA (report du club)", id => db.prepare(`INSERT INTO nexa_affiliate_weeks VALUES (?, '2026-09-14', 0, 3, 0, 0)`).run(id)],
  ["rake NEXA par compte", id => { db.prepare(`INSERT INTO player_game_ids VALUES (?, 1, ?)`).run(id, `m${id}`); db.prepare(`INSERT INTO nexa_weekly_stats VALUES (?, '2026-09-14', 1.5, 0)`).run(`m${id}`); }],
  ["win/loss NEXA saisi", id => db.prepare(`INSERT INTO nexa_player_weekly_winloss VALUES (?, '2026-09-14', -40)`).run(id)],
  ["BR NEXA", id => db.prepare(`INSERT INTO nexa_player_bankroll_weeks VALUES (?, '2026-09-14', NULL)`).run(id)],
  ["rake XPoker", id => db.prepare(`INSERT INTO xpoker_week_rows VALUES (?, '2026-09-14', 10, 0)`).run(id)],
  ["buy-in XPoker", id => db.prepare(`INSERT INTO xpoker_chip_ledger (player_id, occurred_at, kind) VALUES (?, ?, 'buyin')`).run(id, RECENT)],
  ["période pool", id => db.prepare(`INSERT INTO pool_periods VALUES (?, '2026-08-01', ?)`).run(id, `${RECENT} 00:00:00`)],
  ["mouvement pool", id => db.prepare(`INSERT INTO pool_external_movements VALUES (?, ?, 'declared')`).run(id, `${RECENT}T08:00:00Z`)],
  ["bloc QQPK joué", id => db.prepare(`INSERT INTO qqpk_staking_blocks VALUES (?, '2026-09-01', ?, 120, 0)`).run(id, RECENT)],
  ["session grindhouse", id => db.prepare(`INSERT INTO grindhouse_sessions VALUES (?, ?)`).run(id, RECENT)],
  ["report rakeback", id => { const r = db.prepare(`INSERT INTO rakeback_reports (report_date) VALUES (?)`).run(RECENT); db.prepare(`INSERT INTO rakeback_entries (report_id, player_id, amount) VALUES (?, ?, 12)`).run(r.lastInsertRowid, id); }],
];
for (const [label, add] of sources) { const id = P("inactive"); add(id); eq(label, newStatus(id), "active"); }

console.log("  Ce qui NE compte PAS comme activité (joueur active, rien de récent en jeu) :");
const notActivity: [string, (id: number) => void][] = [
  ["tx wallet rejetée", id => db.prepare(`INSERT INTO wallet_transactions (player_id, source, status, tx_datetime) VALUES (?, 'sync', 'rejected', ?)`).run(id, `${RECENT} 10:00:00`)],
  ["tx wallet en quarantaine (audit C1)", id => db.prepare(`INSERT INTO wallet_transactions (player_id, source, status, tx_datetime) VALUES (?, 'sync', 'quarantined', ?)`).run(id, `${RECENT} 10:00:00`)],
  ["tx wallet source unknown", id => db.prepare(`INSERT INTO wallet_transactions (player_id, source, status, tx_datetime) VALUES (?, 'unknown', NULL, ?)`).run(id, `${RECENT} 10:00:00`)],
  ["versement de part BR NEXA (règlement payé, audit B1)", id => {
    const tx = db.prepare(`INSERT INTO wallet_transactions (player_id, source, tx_date, tx_datetime) VALUES (?, 'manual', ?, ?)`).run(id, RECENT, `${RECENT}T00:00:00Z`);
    db.prepare(`INSERT INTO nexa_player_bankroll_weeks VALUES (?, '2026-07-06', ?)`).run(id, tx.lastInsertRowid); }],
  ["mouvement pool de règlement (audit B2)", id => db.prepare(`INSERT INTO pool_external_movements VALUES (?, ?, 'settlement')`).run(id, `${RECENT}T08:00:00Z`)],
  ["versement action XPoker (règlement payé)", id => db.prepare(`INSERT INTO xpoker_chip_ledger (player_id, occurred_at, kind) VALUES (?, ?, 'action_paid')`).run(id, RECENT)],
  ["versement RB XPoker (règlement payé)", id => db.prepare(`INSERT INTO xpoker_chip_ledger (player_id, occurred_at, kind) VALUES (?, ?, 'rb_paid')`).run(id, RECENT)],
  ["contre-passation d'un versement XPoker", id => {
    const paid = db.prepare(`INSERT INTO xpoker_chip_ledger (player_id, occurred_at, kind) VALUES (?, '2026-07-01', 'action_paid')`).run(id);
    db.prepare(`INSERT INTO xpoker_chip_ledger (player_id, occurred_at, kind, reverses_id) VALUES (?, ?, 'adjustment', ?)`).run(id, RECENT, paid.lastInsertRowid); }],
  ["win/loss NEXA saisi à zéro", id => db.prepare(`INSERT INTO nexa_player_weekly_winloss VALUES (?, '2026-09-14', 0)`).run(id)],
  ["report rakeback à zéro", id => { const r = db.prepare(`INSERT INTO rakeback_reports (report_date) VALUES (?)`).run(RECENT); db.prepare(`INSERT INTO rakeback_entries (report_id, player_id) VALUES (?, ?)`).run(r.lastInsertRowid, id); }],
  ["ligne NEXA club à zéro", id => db.prepare(`INSERT INTO nexa_affiliate_weeks VALUES (?, '2026-09-14', 0, 0, 0, 0)`).run(id)],
  ["ligne XPoker à zéro", id => db.prepare(`INSERT INTO xpoker_week_rows VALUES (?, '2026-09-14', 0, 0)`).run(id)],
  ["bloc QQPK sans main ni résultat", id => db.prepare(`INSERT INTO qqpk_staking_blocks VALUES (?, '2026-09-01', ?, 0, 0)`).run(id, RECENT)],
  ["règlement hebdo payé", id => db.prepare(`INSERT INTO weekly_settlements VALUES (?, ?)`).run(id, RECENT)],
  ["demande de cashout", id => db.prepare(`INSERT INTO cashout_requests VALUES (?, ?)`).run(id, RECENT)],
  ["stats NEXA d'un compte d'une AUTRE room", id => { db.prepare(`INSERT INTO player_game_ids VALUES (?, 2, ?)`).run(id, `k${id}`); db.prepare(`INSERT INTO nexa_weekly_stats VALUES (?, '2026-09-14', 1.5, 0)`).run(`k${id}`); }],
];
for (const [label, add] of notActivity) { const id = P("active"); add(id); eq(label, newStatus(id), "inactive"); }

console.log("  Fenêtre de 21 jours, fin de semaine, nouveaux joueurs :");
{
  const a = P("active"); db.prepare(`INSERT INTO grindhouse_sessions VALUES (?, ?)`).run(a, OLD);
  eq("activité vieille de 55 jours → inactive", newStatus(a), "inactive");
  eq("motif tracé avec la dernière activité", changeOf(a)?.reason, "aucune activité de jeu depuis 21 jours (dernière : 2026-08-01 00:00:00, session grindhouse)");
  const b = P("active"); db.prepare(`INSERT INTO grindhouse_sessions VALUES (?, ?)`).run(b, "2026-09-05");
  eq("activité le 2026-09-05 (dans la fenêtre) → reste active", newStatus(b), "inchangé");
  const b2 = P("active"); db.prepare(`INSERT INTO grindhouse_sessions VALUES (?, ?)`).run(b2, "2026-09-04");
  eq("activité le 2026-09-04 (date seule = 00:00, avant 21:22) → inactive", newStatus(b2), "inactive");
  const c = P("active"); db.prepare(`INSERT INTO nexa_player_bankroll_weeks VALUES (?, '2026-08-29', NULL)`).run(c);
  eq("semaine du 29/08 : sa FIN (04/09 00:00) est hors fenêtre → inactive", newStatus(c), "inactive");
  const c2 = P("active"); db.prepare(`INSERT INTO nexa_player_bankroll_weeks VALUES (?, '2026-08-31', NULL)`).run(c2);
  eq("semaine du 31/08 : sa FIN (06/09) est dans la fenêtre → reste active", newStatus(c2), "inchangé");
  const d = P("inactive", { created_at: "2026-09-10 12:00:00" });
  eq("créé il y a 15 jours, sans activité → active", newStatus(d), "active");
  eq("motif nouveau joueur", changeOf(d)?.reason, "nouveau joueur (créé le 2026-09-10)");
  const e = P("active", { created_at: "2026-09-01 12:00:00" });
  eq("créé il y a 24 jours, sans activité → inactive", newStatus(e), "inactive");
  const f = P("active", { created_at: null as unknown as string });
  eq("date de création inconnue, sans activité → inactive", newStatus(f), "inactive");
}

console.log("  Statuts signed / churned (décision 4) :");
{
  const s = P("signed"); db.prepare(`INSERT INTO grindhouse_sessions VALUES (?, ?)`).run(s, RECENT);
  eq("signed actif → inchangé (compte comme actif)", newStatus(s), "inchangé");
  const s2 = P("signed");
  eq("signed sans activité → inactive", newStatus(s2), "inactive");
  const ch = P("churned");
  eq("churned sans activité → inchangé (compte comme inactif)", newStatus(ch), "inchangé");
  const ch2 = P("churned"); db.prepare(`INSERT INTO grindhouse_sessions VALUES (?, ?)`).run(ch2, RECENT);
  eq("churned avec activité → active", newStatus(ch2), "active");
}

console.log("  Statut manuel :");
{
  const m = P("active", { status_manual: 1 });
  eq("manuel active sans activité → inchangé", newStatus(m), "inchangé");
  const m2 = P("inactive", { status_manual: 1 }); db.prepare(`INSERT INTO grindhouse_sessions VALUES (?, ?)`).run(m2, RECENT);
  eq("manuel inactive avec activité → inchangé", newStatus(m2), "inchangé");
}

console.log("  Archive (décision 3 + désarchivage) :");
{
  const a = P("inactive", { archived_at: "2026-09-25 20:05:00", created_at: "2026-09-15 00:00:00" });
  eq("nouveau joueur archivé → active…", newStatus(a), "active");
  eq("…mais reste archivé (pas d'activité après l'archivage)", changeOf(a, "unarchive"), undefined);
  const b = P("inactive", { archived_at: "2026-09-18 10:00:00" }); db.prepare(`INSERT INTO grindhouse_sessions VALUES (?, ?)`).run(b, RECENT);
  eq("archivé le 18/09, joue le 20/09 → désarchivé", changeOf(b, "unarchive")?.reason, "nouvelle activité de jeu le 2026-09-20 00:00:00 (session grindhouse), postérieure à l'archivage");
  const c = P("inactive", { archived_at: "2026-09-21 10:00:00" }); db.prepare(`INSERT INTO grindhouse_sessions VALUES (?, ?)`).run(c, RECENT);
  eq("archivé le 21/09 APRÈS une activité du 20/09 → reste archivé", changeOf(c, "unarchive"), undefined);
  eq("…mais passe active (activité dans les 21 jours)", newStatus(c), "active");
  const d = P("inactive", { archived_at: "2026-09-20 10:00:00" }); db.prepare(`INSERT INTO grindhouse_sessions VALUES (?, ?)`).run(d, "2026-09-20");
  eq("activité datée (sans heure) du jour de l'archivage → reste archivé", changeOf(d, "unarchive"), undefined);
  const e = P("inactive", { archived_at: "2026-09-18 10:00:00", status_manual: 1 }); db.prepare(`INSERT INTO grindhouse_sessions VALUES (?, ?)`).run(e, RECENT);
  eq("statut manuel : désarchivé quand même, statut intact", [changeOf(e, "unarchive")?.kind, newStatus(e)], ["unarchive", "inchangé"]);
  // Audit C2 : une période commencée AVANT l'archivage ne prouve pas un jeu APRÈS.
  const f = P("inactive", { archived_at: "2026-09-23 10:00:00" }); db.prepare(`INSERT INTO nexa_player_bankroll_weeks VALUES (?, '2026-09-21', NULL)`).run(f);
  eq("archivé mercredi, semaine en cours saisie (début lundi) → reste archivé", changeOf(f, "unarchive"), undefined);
  eq("…mais passe active, fin de semaine plafonnée à maintenant", [newStatus(f), changeOf(f)?.last_activity_at], ["active", "2026-09-25 21:22:00"]);
  const f2 = P("inactive", { archived_at: "2026-09-10 10:00:00" }); db.prepare(`INSERT INTO qqpk_staking_blocks VALUES (?, '2026-09-01', '2026-09-30T23:59:59Z', 50, 0)`).run(f2);
  eq("bloc QQPK du mois commencé avant l'archivage (fin future) → reste archivé", changeOf(f2, "unarchive"), undefined);
  const f3 = P("inactive", { archived_at: "2026-09-10 10:00:00" }); db.prepare(`INSERT INTO nexa_player_bankroll_weeks VALUES (?, '2026-09-14', NULL)`).run(f3);
  eq("semaine commencée après l'archivage → désarchivé, daté du début de semaine", changeOf(f3, "unarchive")?.last_activity_at, "2026-09-14 00:00:00");
  const f4 = P("inactive", { archived_at: "2026-09-10 10:00:00" }); db.prepare(`INSERT INTO nexa_player_bankroll_weeks VALUES (?, '2026-09-28', NULL)`).run(f4);
  eq("semaine qui commence dans le futur → pas de désarchivage", changeOf(f4, "unarchive"), undefined);
}

console.log("  Garde-fou de masse (audit C4) :");
{
  const { MAX_VISIBLE_DEACTIVATIONS, visibleDeactivations, StatusAutoGuardError } = require(path.join(REPO, "lib/player-status-auto.ts")) as typeof import("../lib/player-status-auto");
  const snap = () => JSON.stringify(db.prepare(`SELECT id, status, archived_at FROM players ORDER BY id`).all());
  for (let i = visibleDeactivations(db, plan()).length; i <= MAX_VISIBLE_DEACTIVATIONS; i++) P("active");
  eq(`plus de ${MAX_VISIBLE_DEACTIVATIONS} visibles → inactive`, visibleDeactivations(db, plan()).length > MAX_VISIBLE_DEACTIVATIONS, true);
  const s0 = snap(); let err: unknown = null;
  try { applyStatusAutoOn(db, "nightly", NOW); } catch (x) { err = x; }
  eq("cron nightly : refus nommé", err instanceof StatusAutoGuardError, true);
  eq("…et rien n'est écrit", [snap() === s0, (db.prepare(`SELECT COUNT(*) n FROM player_status_changes`).get() as any).n], [true, 0]);
  err = null;
  try { applyStatusAutoOn(db, "sunday", NOW); } catch (x) { err = x; }
  eq("cron sunday : même refus", err instanceof StatusAutoGuardError, true);
  // Le déclenchement « manual » passe outre : c'est lui qu'applique la section suivante.
}

console.log("  Application : écritures, trace, tout ou rien, rejouabilité :");
{
  const before = plan();
  const r = applyStatusAutoOn(db, "manual", NOW);
  eq("manual passe outre le plafond : toutes les bascules appliquées", r.applied.status + r.applied.unarchived, before.length);
  eq("une ligne de trace par bascule", (db.prepare(`SELECT COUNT(*) n FROM player_status_changes`).get() as any).n, before.length);
  const t = db.prepare(`SELECT kind, old_value, new_value, trigger, changed_at, last_activity_source FROM player_status_changes WHERE player_id = 1`).get();
  eq("trace complète (ancien → nouveau, déclencheur, date, source)", t, { kind: "status", old_value: "inactive", new_value: "active", trigger: "manual", changed_at: "2026-09-25 21:22:00", last_activity_source: "tx wallet" });
  eq("seconde passe : rien à changer", plan().length, 0);
  eq("seconde application : aucune écriture", applyStatusAutoOn(db, "sunday", NOW).applied, { status: 0, unarchived: 0 });

  // Tout ou rien : une trace qui échoue annule aussi les UPDATE déjà faits.
  const g = P("active");
  db.exec(`CREATE TRIGGER boom BEFORE INSERT ON player_status_changes BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  let err = "";
  try { applyStatusAutoOn(db, "nightly", NOW); } catch (x: any) { err = x.message; }
  eq("échec de la trace → exception", err, "boom");
  eq("…et le statut n'a pas bougé", (db.prepare(`SELECT status FROM players WHERE id = ?`).get(g) as any).status, "active");
  db.exec(`DROP TRIGGER boom`);

  // Une source illisible (table absente) → exception, aucune écriture.
  db.exec(`ALTER TABLE grindhouse_sessions RENAME TO gs_tmp`);
  err = "";
  try { applyStatusAutoOn(db, "nightly", NOW); } catch (x: any) { err = x.message; }
  eq("source illisible → exception, rien d'écrit", [/no such table/.test(err), (db.prepare(`SELECT status FROM players WHERE id = ?`).get(g) as any).status], [true, "active"]);
  db.exec(`ALTER TABLE gs_tmp RENAME TO grindhouse_sessions`);
}
eq("normalizeTs ISO", normalizeTs("2026-09-20T08:00:00.123Z"), "2026-09-20 08:00:00");

console.log("  PATCH : valeur de status_manual (audit C5) :");
{
  const { assertUpdatablePlayerFields } = require(path.join(REPO, "lib/queries.ts")) as typeof import("../lib/queries");
  const verdict = (v: unknown) => { try { assertUpdatablePlayerFields(["status_manual"], { status_manual: v }); return "ok"; } catch (x: any) { return /non modifiable/.test(x.message) ? "400" : x.message; } };
  eq("true / false / 1 / 0 acceptés", [true, false, 1, 0].map(verdict), ["ok", "ok", "ok", "ok"]);
  eq("\"false\", \"0\", \"1\", 2, null refusés (400)", ["false", "0", "1", 2, null].map(verdict), ["400", "400", "400", "400", "400"]);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n── B. Copie d'un dump migré, schéma réel ──");
let skippedB = "";
if (!DB_SRC) skippedB = "aucune base source (LECERCLE_DB_SRC)";
else {
  const { getDb } = require(path.join(REPO, "lib/db.ts")) as typeof import("../lib/db");
  let real: Database.Database | null = null;
  try { real = getDb(); } catch (x: any) { skippedB = `la base source ne s'ouvre pas (${x.message})`; }
  if (real) {
    const hasCol = !!real.prepare(`SELECT 1 FROM pragma_table_info('players') WHERE name = 'status_manual'`).get();
    const hasTable = !!real.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'player_status_changes'`).get();
    if (!hasCol || !hasTable) skippedB = `migration non appliquée sur cette base (colonne ${hasCol}, table ${hasTable}) — voir les logs [MIGRATION]`;
    else {
      eq("migration : status_manual à 0 pour tous", (real.prepare(`SELECT COUNT(*) n FROM players WHERE status_manual <> 0`).get() as any).n, 0);
      eq("migration rejouée : marqueur unique", (real.prepare(`SELECT COUNT(*) n FROM _applied_fixes WHERE name = 'add_player_status_auto_v1'`).get() as any).n, 1);
      const snapshot = () => real!.prepare(`SELECT id, status, archived_at FROM players ORDER BY id`).all();
      const s0 = JSON.stringify(snapshot());
      const RNOW = new Date("2026-09-25T21:22:00Z");
      const pl = planStatusAutoOn(real, RNOW);
      eq("le plan n'écrit rien", JSON.stringify(snapshot()) === s0, true);
      const toInactive = pl.changes.filter(c => c.kind === "status" && c.new_value === "inactive");
      const toActive = pl.changes.filter(c => c.kind === "status" && c.new_value === "active");
      const unarch = pl.changes.filter(c => c.kind === "unarchive");
      console.log(`   plan sur le dump : ${toInactive.length} → inactive, ${toActive.length} → active, ${unarch.length} désarchivage(s)`);
      const visible = toInactive.filter(c => !(real!.prepare(`SELECT archived_at FROM players WHERE id = ?`).get(c.player_id) as any).archived_at).map(c => c.player_id).sort((a, b) => a - b);
      console.log(`   visibles → inactive : ${JSON.stringify(visible)}`);
      // Statut manuel posé sur Baki #51 et Leo La Truite #9 (décision 1) : plus touchés.
      real.prepare(`UPDATE players SET status_manual = 1 WHERE id IN (9, 51)`).run();
      eq("statut manuel #9 et #51 : absents du plan", planStatusAutoOn(real, RNOW).changes.filter(c => c.kind === "status" && [9, 51].includes(c.player_id)).length, 0);
      const { getNeverPlayerBucket } = require(path.join(REPO, "lib/queries.ts")) as typeof import("../lib/queries");
      const bucket0 = getNeverPlayerBucket().map(r => r.id).sort((a, b) => a - b);
      const r = applyStatusAutoOn(real, "manual", RNOW);
      // Audit C3 : un inactive posé par l'automate n'est pas un « statut travaillé à la main ».
      eq(`bucket « jamais joueur » inchangé par l'automate (${bucket0.length})`, getNeverPlayerBucket().map(r => r.id).sort((a, b) => a - b), bucket0);
      eq("application : bascules = traces", (real.prepare(`SELECT COUNT(*) n FROM player_status_changes`).get() as any).n, r.applied.status + r.applied.unarchived);
      eq("rejouée : rien à changer", planStatusAutoOn(real, RNOW).changes.length, 0);
    }
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} ✔, ${failures.length} ✘${skippedB ? ` (bloc B sauté : ${skippedB})` : ""}`);
if (failures.length) { console.log("ÉCHECS :", failures); process.exit(1); }
