/**
 * XPoker Twd — DEAL RÉTROACTIF sur des semaines importées NON réglées (F2 recalibrée).
 * Run: npx tsx scripts/xpoker-deal-retro.test.ts
 *
 * Cas de prod (Léo, Player ID 4020202, 2026-09-21) : semaine 09-07 importée
 * « aucun deal » (incalculable), deal 10 % posé depuis 09-14 seulement. La garde
 * calibrée sur « semaine importée » interdisait de faire commencer le deal au 09-07
 * alors que RIEN n'était figé (aucun règlement). La règle devient :
 *   • un deal PEUT commencer sur une semaine importée tant qu'AUCUNE semaine de la
 *     plage réécrite n'est dans un règlement (locked OU paid) ;
 *   • refus dur, nommé (semaine, règlement #), si une seule l'est ;
 *   • la réécriture n'est jamais SILENCIEUSE : aperçu avant/après semaine par semaine,
 *     confirmation explicite (un clic), trace AUTOMATIQUE dans la note de la période —
 *     le motif est optionnel (Baki, 2026-09-21).
 *
 * Tout en :memory:, même SQL que la prod (runXpokerMigrationV1).
 */
import path from "path";
const REPO = path.resolve(__dirname, "..");
const Database = require(path.join(REPO, "node_modules/better-sqlite3"));
import { runXpokerMigrationV1, type XpokerSeed } from "../lib/games/xpoker/schema";
import { XPOKER_GAME_NAME, XPOKER_DEFAULT_ACTION_PCT, XPOKER_SEED_CHIPS_PER_USD, XPOKER_SEED_RATE_EFFECTIVE_FROM, XPOKER_SEED_AGENCY_ACCOUNTS } from "../lib/games/xpoker/config";
import { commitImportOn, linkMemberIdOn, setDealOn, dealHistoryOn, playerWeeksOn } from "../lib/games/xpoker/engine";
import { lockXpokerSettlementOn } from "../lib/games/xpoker/settlement";
import { block, type FixRow } from "./xpoker-fixture";

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
function eq2(label: string, got: number | null | undefined, want: number, digits = 2) {
  const g = got == null ? "null" : got.toFixed(digits), w = want.toFixed(digits);
  check(label, g === w, g === w ? "" : `attendu ${w}, obtenu ${g}`);
}

const SEED: XpokerSeed = { gameName: XPOKER_GAME_NAME, defaultActionPct: XPOKER_DEFAULT_ACTION_PCT, seedChipsPerUsd: XPOKER_SEED_CHIPS_PER_USD, seedRateEffectiveFrom: XPOKER_SEED_RATE_EFFECTIVE_FROM, agencyAccounts: XPOKER_SEED_AGENCY_ACCOUNTS };
const LEO = 1, LEO_ID = "4020202";
const W_0907 = { week_start: "2026-09-07", week_end: "2026-09-13" };
const W_0914 = { week_start: "2026-09-14", week_end: "2026-09-20" };
const ROWS_0907: FixRow[] = [{ pid: LEO_ID, nick: "LaTruiteMorte", wl: -4808.9, rake: 89.03 }];
const ROWS_0914: FixRow[] = [{ pid: LEO_ID, nick: "LaTruiteMorte", wl: -201.6, rake: 119.21 }];

/** Base vierge + Léo + ses deux semaines importées (aucun deal encore). */
function leoDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE _applied_fixes (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')), default_action_pct REAL, currency TEXT NOT NULL DEFAULT 'USDT');
    CREATE TABLE player_game_ids (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE, game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL, UNIQUE(game_id, external_id));
    CREATE TABLE manual_settlements (id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE, player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      net_selected_usdt REAL NOT NULL DEFAULT 0, action_pct_applied REAL NOT NULL DEFAULT 0, amount_due_usdt REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','paid')), tx_hash TEXT, notes TEXT,
      locked_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_date TEXT, kind TEXT NOT NULL DEFAULT 'action');
    INSERT INTO players (name) VALUES ('Léo');
  `);
  runXpokerMigrationV1(db, SEED);
  linkMemberIdOn(db, { player_id: LEO, member_id: LEO_ID, nickname: "LaTruiteMorte" });
  const r1 = commitImportOn(db, { block: block({ rows: ROWS_0907 }, "9/14"), ...W_0907, source: "xlsx" });
  const r2 = commitImportOn(db, { block: block({ rows: ROWS_0914 }, "9/21"), ...W_0914, source: "xlsx" });
  if (!r1.ok || !r2.ok) throw new Error("fixture : import refusé " + JSON.stringify([r1, r2]));
  return db;
}
const snapshot = (db: any) => ({
  deals: db.prepare(`SELECT id, action_pct, rb_pct, start_week, end_week, note FROM xpoker_player_deals ORDER BY id`).all(),
  settled: db.prepare(`SELECT id, settlement_id, player_id, week_start, action_pct, rb_pct, action_chips, rb_chips, due_chips FROM xpoker_settlement_weeks ORDER BY id`).all(),
  ledger: db.prepare(`SELECT id, kind, direction, chips, settlement_id FROM xpoker_chip_ledger ORDER BY id`).all(),
});
const dueOf = (db: any, pid: number, w: string) => playerWeeksOn(db, pid).find(x => x.week_start === w)!.due_chips;
const totalDue = (db: any, pid: number) => playerWeeksOn(db, pid).reduce((s, w) => s + (w.due_chips ?? 0), 0);
const openPeriods = (db: any, pid: number) => (db.prepare(`SELECT COUNT(*) n FROM xpoker_player_deals WHERE player_id = ? AND end_week IS NULL`).get(pid) as { n: number }).n;

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n── 1. Cas Léo : deal 10 % depuis 09-14, on le fait commencer au 09-07 (mêmes taux) ──");
{
  const db = leoDb();
  eq("premier deal 10 %/0 depuis 09-14 : accepté sans confirmation (rien à réécrire)", setDealOn(db, { player_id: LEO, action_pct: 10, rb_pct: 0, start_week: "2026-09-14" }).ok, true);
  eq("09-07 incalculable, 09-14 = −20,16", { a: dueOf(db, LEO, "2026-09-07"), b: dueOf(db, LEO, "2026-09-14")?.toFixed(2) }, { a: null, b: "-20.16" });
  eq("aucun règlement ⇒ aucune limite de semaine d'effet", { e: dealHistoryOn(db, LEO).earliest_change_week, s: dealHistoryOn(db, LEO).last_settled_week }, { e: null, s: null });

  const before = snapshot(db);
  const ask = setDealOn(db, { player_id: LEO, action_pct: 10, rb_pct: 0, start_week: "2026-09-07" });
  check("sans confirmation ⇒ pas appliqué, mais PAS un refus : confirmation demandée avec aperçu", !ask.ok && ask.needs_confirmation === true && !!ask.preview, JSON.stringify(ask));
  eq("rien écrit tant que non confirmé", snapshot(db), before);
  const pv = ask.preview!;
  eq("aperçu : une seule semaine réécrite, 09-07, incalculable → 10 %/0", pv.weeks.map(w => [w.week_start, w.before?.action_pct ?? null, w.after.action_pct, w.after.rb_pct]), [["2026-09-07", null, 10, 0]]);
  eq2("aperçu 09-07 : part d'action après = −480,89", pv.weeks[0].after.action_chips, -480.89);
  eq2("aperçu 09-07 : RB après = 0", pv.weeks[0].after.rb_chips, 0);
  eq2("aperçu : total du dû avant = −20,16", pv.total_due_before, -20.16);
  eq2("aperçu : total du dû après = −501,05", pv.total_due_after, -501.05);
  eq("aperçu : période écrite du 09-07 au 09-07 (la période 09-14 est conservée)", [pv.start_week, pv.end_week], ["2026-09-07", "2026-09-07"]);

  const ok = setDealOn(db, { player_id: LEO, action_pct: 10, rb_pct: 0, start_week: "2026-09-07", confirm_retroactive: true });
  eq("6. confirmé SANS motif ⇒ appliqué (le motif est optionnel), marqué rétroactif", { ok: ok.ok, retro: ok.ok && !!ok.retroactive }, { ok: true, retro: true });
  const h = dealHistoryOn(db, LEO);
  eq("UNE SEULE période, 10 %/0 depuis le 09-07, rien en historique", { cur: [h.current?.action_pct, h.current?.rb_pct, h.current?.start_week, h.current?.end_week], prev: h.previous.length, rows: (db.prepare(`SELECT COUNT(*) n FROM xpoker_player_deals`).get() as any).n }, { cur: [10, 0, "2026-09-07", null], prev: 0, rows: 1 });
  check("… trace AUTOMATIQUE dans la note : date, semaine recalculée ∅ → 10 %, dû −20,16 → −501,05",
        /^\[rétroactif \d{4}-\d{2}-\d{2}\] — semaines recalculées : 2026-09-07 \(∅ → 10 %\/0 %\) ; dû total -20,16 \(1 semaine incalculable exclue\) → -501,05$/.test(h.current?.note ?? ""), h.current?.note ?? "");
  eq2("09-07 = −480,89", dueOf(db, LEO, "2026-09-07"), -480.89);
  eq2("09-14 inchangée = −20,16", dueOf(db, LEO, "2026-09-14"), -20.16);
  eq2("dû total = −501,05 (je lui dois 501,05)", totalDue(db, LEO), -501.05);
  eq("5. ni xpoker_settlement_weeks ni le grand livre n'ont bougé", { s: snapshot(db).settled, l: snapshot(db).ledger }, { s: [], l: [] });
  eq("re-poser exactement le même deal ⇒ no-op (rien à écrire)", setDealOn(db, { player_id: LEO, action_pct: 10, rb_pct: 0, start_week: "2026-09-07" }).ok, true);
  eq("… toujours une seule période", (db.prepare(`SELECT COUNT(*) n FROM xpoker_player_deals`).get() as any).n, 1);
}

console.log("\n── 2. Rétroactif à taux différents : 10 % depuis 09-14, 15 % sur la seule semaine 09-07 ──");
{
  const db = leoDb();
  setDealOn(db, { player_id: LEO, action_pct: 10, rb_pct: 0, start_week: "2026-09-14" });
  const ask = setDealOn(db, { player_id: LEO, action_pct: 15, rb_pct: 0, start_week: "2026-09-07" });
  check("confirmation demandée", !ask.ok && ask.needs_confirmation === true, JSON.stringify(ask));
  eq2("aperçu 09-07 après = 15 % × −4808,90 = −721,335", ask.preview!.weeks[0].after.due_chips, -721.335, 3);
  eq2("aperçu total après = −741,495", ask.preview!.total_due_after, -741.495, 3);
  eq("appliqué (avec motif, cette fois)", setDealOn(db, { player_id: LEO, action_pct: 15, rb_pct: 0, start_week: "2026-09-07", confirm_retroactive: true, note: "15 % négocié sur sa 1ʳᵉ semaine" }).ok, true);
  const h = dealHistoryOn(db, LEO);
  check("… le motif est dans la trace, avant les semaines recalculées", /^\[rétroactif \d{4}-\d{2}-\d{2}\] 15 % négocié sur sa 1ʳᵉ semaine — semaines recalculées : 2026-09-07/.test(h.previous[0]?.note ?? ""), h.previous[0]?.note ?? "");
  eq("deux périodes, sans chevauchement : 15 % du 09-07 au 09-07, 10 % depuis 09-14",
     { cur: [h.current?.action_pct, h.current?.start_week, h.current?.end_week], prev: h.previous.map(p => [p.action_pct, p.start_week, p.end_week]) },
     { cur: [10, "2026-09-14", null], prev: [[15, "2026-09-07", "2026-09-07"]] });
  eq("une seule période ouverte (index partiel idx_xpoker_deals_one_open respecté)", openPeriods(db, LEO), 1);
  eq2("09-07 = −721,335", dueOf(db, LEO, "2026-09-07"), -721.335, 3);
  eq2("09-14 inchangée = −20,16", dueOf(db, LEO, "2026-09-14"), -20.16);
  eq("5. rien au règlement ni au grand livre", { s: snapshot(db).settled, l: snapshot(db).ledger }, { s: [], l: [] });
}

console.log("\n── 3 & 4. Une semaine RÉGLÉE dans la plage ⇒ refus nommé, rien écrit (locked puis paid) ──");
for (const status of ["locked", "paid"] as const) {
  const db = leoDb();
  setDealOn(db, { player_id: LEO, action_pct: 10, rb_pct: 0, start_week: "2026-09-14" });
  const lock = lockXpokerSettlementOn(db, { player_id: LEO, week_starts: ["2026-09-14"] });
  check(`règlement ${status} sur 09-14`, lock.ok, JSON.stringify(lock));
  const sid = lock.ok ? lock.settlement_id : 0;
  if (status === "paid") db.prepare(`UPDATE manual_settlements SET status = 'paid', paid_at = datetime('now'), paid_date = '2026-09-21' WHERE id = ?`).run(sid);
  const before = snapshot(db);
  // La période en cours commence le 09-14 : changer ses taux depuis le 09-14 réécrit une semaine réglée.
  const r = setDealOn(db, { player_id: LEO, action_pct: 15, rb_pct: 0, start_week: "2026-09-14", confirm_retroactive: true, note: "tentative" });
  check(`[${status}] 15 % depuis 09-14 ⇒ refus dur, même confirmé`, !r.ok && !r.needs_confirmation, JSON.stringify(r));
  eq(`[${status}] … qui NOMME la semaine et le règlement`, r.ok ? null : r.settled_weeks, [{ week_start: "2026-09-14", settlement_id: sid }]);
  check(`[${status}] … et le message dit « règlement #${sid} »`, !r.ok && new RegExp(`règlement #${sid}`).test(r.error), r.ok ? "" : r.error);
  eq(`[${status}] rien écrit`, snapshot(db), before);
  // Depuis le 09-07 en revanche, la plage réécrite s'arrête au 09-07 : 09-14 (réglée) n'est pas touchée.
  const ask = setDealOn(db, { player_id: LEO, action_pct: 10, rb_pct: 0, start_week: "2026-09-07" });
  eq(`[${status}] deal depuis 09-07 : plage 09-07 → 09-07, la semaine réglée reste hors de portée`, !ask.ok && ask.needs_confirmation ? [ask.preview!.start_week, ask.preview!.end_week, ask.preview!.weeks.map(w => w.week_start)] : ask, ["2026-09-07", "2026-09-07", ["2026-09-07"]]);
  eq(`[${status}] appliqué`, setDealOn(db, { player_id: LEO, action_pct: 10, rb_pct: 0, start_week: "2026-09-07", confirm_retroactive: true }).ok, true);
  eq2(`[${status}] 09-07 = −480,89`, dueOf(db, LEO, "2026-09-07"), -480.89);
  eq(`[${status}] 5. la semaine réglée est intacte : xpoker_settlement_weeks et grand livre identiques`, { s: snapshot(db).settled, l: snapshot(db).ledger }, { s: before.settled, l: before.ledger });
  eq(`[${status}] première semaine d'effet proposée = lendemain de la dernière semaine RÉGLÉE`, { e: dealHistoryOn(db, LEO).earliest_change_week, s: dealHistoryOn(db, LEO).last_settled_week }, { e: "2026-09-21", s: "2026-09-14" });
  eq(`[${status}] une seule période ouverte`, openPeriods(db, LEO), 1);
}

console.log("\n── 8. Correction EN PLACE de la période ouverte, sur une semaine IMPORTÉE non réglée : aperçu, un clic ──");
{
  const db = leoDb();
  setDealOn(db, { player_id: LEO, action_pct: 10, rb_pct: 0, start_week: "2026-09-07" });   // premier deal, couvre 09-07 et 09-14
  const before = snapshot(db);
  const ask = setDealOn(db, { player_id: LEO, action_pct: 20, rb_pct: 0, start_week: "2026-09-07" });
  check("20 % depuis 09-07 (même début que la période ouverte, 2 semaines importées) ⇒ confirmation, pas un refus", !ask.ok && ask.needs_confirmation === true, JSON.stringify(ask));
  eq("aperçu : les 2 semaines, 10 % → 20 %, plage ouverte", !ask.ok && ask.preview ? { w: ask.preview.weeks.map(w => [w.week_start, w.before?.action_pct, w.after.action_pct]), r: [ask.preview.start_week, ask.preview.end_week] } : ask, { w: [["2026-09-07", 10, 20], ["2026-09-14", 10, 20]], r: ["2026-09-07", null] });
  eq2("aperçu : dû total −501,05 → −1 002,10", ask.ok ? null : ask.preview!.total_due_after, -1002.10);
  eq("rien écrit avant confirmation", snapshot(db), before);
  eq("un clic, sans motif ⇒ appliqué", setDealOn(db, { player_id: LEO, action_pct: 20, rb_pct: 0, start_week: "2026-09-07", confirm_retroactive: true }).ok, true);
  const h = dealHistoryOn(db, LEO);
  eq("EN PLACE : toujours une seule période (même id), 20 %/0 depuis 09-07", { id: h.current?.id, cur: [h.current?.action_pct, h.current?.start_week, h.current?.end_week], n: (db.prepare(`SELECT COUNT(*) n FROM xpoker_player_deals`).get() as any).n }, { id: (before.deals[0] as any).id, cur: [20, "2026-09-07", null], n: 1 });
  check("… trace auto : 09-07 et 09-14 (10 %/0 % → 20 %/0 %), dû −501,05 → −1002,10", /2026-09-07 \(10 %\/0 % → 20 %\/0 %\), 2026-09-14 \(10 %\/0 % → 20 %\/0 %\) ; dû total -501,05 → -1002,10/.test(h.current?.note ?? ""), h.current?.note ?? "");
  eq2("09-07 = −961,78", dueOf(db, LEO, "2026-09-07"), -961.78);
  eq2("09-14 = −40,32", dueOf(db, LEO, "2026-09-14"), -40.32);
  eq("rien au règlement ni au grand livre", { s: snapshot(db).settled, l: snapshot(db).ledger }, { s: [], l: [] });
}

console.log("\n── 9. F-A (audit) : une semaine incalculable HORS plage reste exclue du total, et la trace le dit ──");
{
  const db = leoDb();
  setDealOn(db, { player_id: LEO, action_pct: 10, rb_pct: 0, start_week: "2026-09-14" });   // 09-07 reste incalculable
  const ask = setDealOn(db, { player_id: LEO, action_pct: 20, rb_pct: 0, start_week: "2026-09-14" });
  eq("aperçu : 1 incalculable avant ET après, total −20,16 → −40,32 (09-07 exclue des deux)",
     !ask.ok && ask.preview ? { ib: ask.preview.incalculable_before, ia: ask.preview.incalculable_after, tb: ask.preview.total_due_before.toFixed(2), ta: ask.preview.total_due_after.toFixed(2) } : ask,
     { ib: 1, ia: 1, tb: "-20.16", ta: "-40.32" });
  eq("appliqué", setDealOn(db, { player_id: LEO, action_pct: 20, rb_pct: 0, start_week: "2026-09-14", confirm_retroactive: true }).ok, true);
  check("… la trace dit l'exclusion des deux côtés", /dû total -20,16 \(1 semaine incalculable exclue\) → -40,32 \(1 semaine incalculable exclue\)/.test(dealHistoryOn(db, LEO).current?.note ?? ""), dealHistoryOn(db, LEO).current?.note ?? "");
  eq("09-07 toujours incalculable", dueOf(db, LEO, "2026-09-07"), null);
}

console.log("\n── 7. Changement futur (aucune semaine importée touchée) : comportement inchangé, sans confirmation ──");
{
  const db = leoDb();
  setDealOn(db, { player_id: LEO, action_pct: 10, rb_pct: 0, start_week: "2026-09-07" });
  const r = setDealOn(db, { player_id: LEO, action_pct: 20, rb_pct: 0, start_week: "2026-09-21", note: "renégocié" });
  eq("20 % depuis 09-21 : appliqué directement, non rétroactif", { ok: r.ok, retro: r.ok && !!r.retroactive }, { ok: true, retro: false });
  const h = dealHistoryOn(db, LEO);
  eq("période précédente fermée au 09-14", h.previous.map(p => [p.action_pct, p.start_week, p.end_week]), [[10, "2026-09-07", "2026-09-14"]]);
  eq2("09-14 toujours à 10 %", dueOf(db, LEO, "2026-09-14"), -20.16);
  // Corriger la période future sur son propre début (rien d'importé) : autorisé, pas rétroactif.
  eq("corriger 20 → 25 % depuis 09-21 (rien d'importé) : direct", setDealOn(db, { player_id: LEO, action_pct: 25, rb_pct: 0, start_week: "2026-09-21" }).ok, true);
  eq("… en place, toujours 2 périodes", { cur: dealHistoryOn(db, LEO).current?.action_pct, n: (db.prepare(`SELECT COUNT(*) n FROM xpoker_player_deals`).get() as any).n }, { cur: 25, n: 2 });
}

console.log(`\n${passed} ✔  ${failures.length} ✘`);
if (failures.length) { console.log("ÉCHECS :\n - " + failures.join("\n - ")); process.exit(1); }
