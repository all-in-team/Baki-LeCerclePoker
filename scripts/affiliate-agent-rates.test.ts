/**
 * Harnais du taux AGENT par (filleul, game), versionné par semaine.
 * Run: npx tsx scripts/affiliate-agent-rates.test.ts
 *
 * Porte sur les VRAIS modules (lib/affiliate/agent-rates-schema.ts + agent-rates.ts),
 * sur une base SQLite en mémoire au schéma minimal des tables lues.
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────┐
 * │ A. Migration sur la fixture PROD du 2026-09-26 (lecture GET, 12 agents) │
 * │    : le dû de CHAQUE agent est identique au centime (1) au dû affiché   │
 * │    en prod ce jour-là, (2) à l'ancien calcul recopié (legacy).          │
 * │ B. Samyaza/Grobel A5 : 10 000 de résultat joueur, base perçue 20 %,     │
 * │    taux 25 → 500 ; « 5 » saisi → 100 (le piège documenté).              │
 * │ C. Grobel A5 à 25 % dès le 2026-09-07 sur la fixture : aperçu exact,    │
 * │    confirmation exigée, écriture, historique ; refus sur période payée. │
 * │ D. Semaine à cheval : dimanche 23:59:59Z à l'ancien taux, lundi 00:00Z  │
 * │    au nouveau ; date d'effet hors lundi refusée (pas de prorata).       │
 * │ E. Semaine négative sur une game, positive sur une autre, taux          │
 * │    différents : taux AVANT compensation.                                │
 * │ F. 0 % : Antoine (Xabi) à 0 % → dû de Xabi ; note obligatoire ; 0 %     │
 * │    manuel distinct du 0 % hors fenêtre ; filleul à 0 % en perte ne      │
 * │    réduit pas le dû d'un autre filleul en gain.                         │
 * │ G. Taux manquant ⇒ blocage (dû null, paiement refusé) ; semaine gelée   │
 * │    SANS taux ⇒ pas un refus.                                            │
 * │ H. dry_run n'écrit jamais ; changement futur appliqué direct ; CHECK du │
 * │    schéma ; migration idempotente et reportée si transaction ouverte.   │
 * └─────────────────────────────────────────────────────────────────────────┘
 * ┌─ CE QU'ILS NE PROUVENT PAS ─────────────────────────────────────────────┐
 * │ L'identité sur la base PROD elle-même : la fixture est reconstruite à   │
 * │ partir des GET (nets hebdo déjà filtrés, un seul mouvement par semaine),│
 * │ pas d'un dump. La preuve prod = GET /api/affiliate-agent-rates/         │
 * │ migration-check après déploiement. Wepoker (CNY) n'est couvert que par  │
 * │ la linéarité du code, aucun filleul affilié n'y joue.                   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import path from "path";
import fs from "fs";

const REPO = path.resolve(__dirname, "..");
const Database = require(path.join(REPO, "node_modules/better-sqlite3"));

import {
  runAffiliateAgentRatesMigrationV1 as runRatesOnly, AFFILIATE_AGENT_RATES_MIGRATION_V1, runGamePerceivedMigrationV1,
} from "../lib/affiliate/agent-rates-schema";

/** Les deux migrations du chantier, dans l'ordre de lib/db.ts (perçu versionné, puis taux agents). */
function runAffiliateAgentRatesMigrationV1(db: any) {
  runGamePerceivedMigrationV1(db);
  return runRatesOnly(db);
}
import {
  computeAgentCommissionOn, legacyAgentCommissionOn, setAgentRateOn, ratePeriodsOn, rateHistoryOn,
  paymentBlockOn, mondayOf, setPerceivedDealOn, perceivedPeriodsOn, agentPortalViewOn, withFrozenGuardOn,
} from "../lib/affiliate/agent-rates";
import { seedDefaultRatesOn } from "../lib/affiliate/agent-rates-schema";

let passed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log("   ✔", label); }
  else { failures.push(`${label}${detail ? ` → ${detail}` : ""}`); console.log("   ✘", label, detail); }
}
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(label, g === w, g === w ? "" : `attendu ${w}, obtenu ${g}`);
}
/** Égalité AU CENTIME (jamais de === entre deux montants). */
function cents(label: string, got: number | null, want: number | null) {
  const ok = got !== null && want !== null ? Math.abs(got - want) < 0.005 : got === want;
  check(label, ok, ok ? "" : `attendu ${want}, obtenu ${got}`);
}
function throws(label: string, fn: () => void, re: RegExp) {
  try { fn(); check(label, false, "aucune erreur levée"); }
  catch (e: any) { check(label, re.test(String(e?.message ?? e)), `message: ${e?.message}`); }
}

const TODAY = "2026-09-26";

// ── Schéma minimal : les colonnes que le moteur et la migration lisent ─────────
function freshDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE _applied_fixes (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT NOT NULL, telegram_handle TEXT);
    CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active',
      perceived_action_pct REAL, perceived_rakeback_pct REAL, perceived_insurance_pct REAL);
    CREATE TABLE player_game_deals (id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL, game_id INTEGER NOT NULL,
      action_pct REAL NOT NULL DEFAULT 50, rakeback_pct REAL NOT NULL DEFAULT 0, insurance_pct REAL,
      start_date TEXT, end_date TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(player_id, game_id));
    CREATE TABLE wallet_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL, game_id INTEGER,
      type TEXT NOT NULL CHECK(type IN ('deposit','withdrawal')), amount REAL NOT NULL, currency TEXT DEFAULT 'USDT',
      tx_date TEXT NOT NULL, tx_datetime TEXT, source TEXT, status TEXT);
    CREATE TABLE rakeback_reports (id INTEGER PRIMARY KEY, game_id INTEGER, report_date TEXT, created_at TEXT);
    CREATE TABLE rakeback_entries (id INTEGER PRIMARY KEY, report_id INTEGER, player_id INTEGER, amount REAL, winnings_amount REAL, insurance_amount REAL);
    CREATE TABLE affiliate_relationships (id INTEGER PRIMARY KEY AUTOINCREMENT,
      affiliate_player_id INTEGER NOT NULL REFERENCES players(id), referred_player_id INTEGER NOT NULL REFERENCES players(id),
      origin_game_id INTEGER, start_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      disclosed_action_pct REAL, disclosed_rakeback_pct REAL, disclosed_insurance_pct REAL,
      exclude_agency_extras INTEGER NOT NULL DEFAULT 1, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE affiliate_relationship_games (id INTEGER PRIMARY KEY AUTOINCREMENT, relationship_id INTEGER NOT NULL, game_id INTEGER NOT NULL,
      disclosed_action_pct REAL, disclosed_rakeback_pct REAL, disclosed_insurance_pct REAL,
      exclude_agency_extras INTEGER NOT NULL DEFAULT 1, excluded INTEGER NOT NULL DEFAULT 0, UNIQUE(relationship_id, game_id));
    CREATE TABLE affiliate_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, relationship_id INTEGER NOT NULL, game_id INTEGER NOT NULL,
      week_start_date TEXT NOT NULL, week_end_date TEXT NOT NULL, amount_usdt REAL NOT NULL, tx_hash TEXT,
      paid_at TEXT NOT NULL DEFAULT (datetime('now')), notes TEXT);
  `);
  return db;
}

function tx(db: any, playerId: number, gameId: number, net: number, isoDatetime: string) {
  if (net === 0) return;
  db.prepare(`INSERT INTO wallet_transactions (player_id, game_id, type, amount, tx_date, tx_datetime, source, status)
              VALUES (?, ?, ?, ?, ?, ?, 'sync', 'active')`)
    .run(playerId, gameId, net > 0 ? "withdrawal" : "deposit", Math.abs(net), isoDatetime.slice(0, 10), isoDatetime);
}

// ── Chargement de la fixture prod ─────────────────────────────────────────────
type Fx = {
  expected_due: Record<string, number>;
  agents: [number, string][];
  rels: { id: number; agent: number; ref: string; refId: number; status: string; start: string;
    games: { gid: number; name: string; eff: number; label: string; pnl: number; created: string; weeks: Record<string, number> }[];
    pays: { amount: number; paid_at: string; game_id: number; ws: string; we: string }[] }[];
};
const FX: Fx = JSON.parse(fs.readFileSync(path.join(REPO, "scripts/fixtures/affiliate-prod-2026-09-26.json"), "utf8"));

function loadFixture() {
  const db = freshDb();
  const insP = db.prepare(`INSERT OR IGNORE INTO players (id, name) VALUES (?, ?)`);
  for (const [id, name] of FX.agents) insP.run(id, name);
  const seenDeal = new Set<string>();
  for (const r of FX.rels) {
    insP.run(r.agent, `agent#${r.agent}`);
    insP.run(r.refId, r.ref);
    db.prepare(`INSERT INTO affiliate_relationships (id, affiliate_player_id, referred_player_id, start_date, status) VALUES (?, ?, ?, ?, ?)`)
      .run(r.id, r.agent, r.refId, r.start, r.status);
    for (const g of r.games) {
      // KK et A5 : perçu 20 % AU NIVEAU GAME, comme en prod (lu le 25/09) — c'est ce niveau que
      // le perçu versionné modifie. Les autres games : le perçu effectif vu en prod, posé au
      // niveau relation × game (1er niveau de la cascade).
      const gameLevel = (g.gid === 5 || g.gid === 6) && g.eff === 20;
      db.prepare(`INSERT OR IGNORE INTO games (id, name, perceived_action_pct) VALUES (?, ?, ?)`).run(g.gid, g.name, gameLevel ? 20 : null);
      if (!gameLevel) db.prepare(`INSERT INTO affiliate_relationship_games (relationship_id, game_id, disclosed_action_pct) VALUES (?, ?, ?)`).run(r.id, g.gid, g.eff);
      const k = `${r.refId}:${g.gid}`;
      if (!seenDeal.has(k)) {
        seenDeal.add(k);
        db.prepare(`INSERT INTO player_game_deals (player_id, game_id, action_pct, created_at) VALUES (?, ?, 50, ?)`).run(r.refId, g.gid, g.created);
        for (const [w, net] of Object.entries(g.weeks)) tx(db, r.refId, g.gid, net, `${w}T12:00:00Z`);
      }
    }
    for (const p of r.pays)
      db.prepare(`INSERT INTO affiliate_payments (relationship_id, game_id, week_start_date, week_end_date, amount_usdt, paid_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(r.id, p.game_id, p.ws, p.we, p.amount, p.paid_at);
  }
  return db;
}

const due = (db: any, agent: number) => computeAgentCommissionOn(db, agent, { today: TODAY }).due_now;

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n══ A. Migration sur la fixture prod — dû identique au centime, 12 agents ══");
{
  const db = loadFixture();
  const before: Record<number, number> = {};
  for (const [id] of FX.agents) before[id] = legacyAgentCommissionOn(db, id).due_now;
  eq("migration appliquée", runAffiliateAgentRatesMigrationV1(db), "applied");
  const table: string[] = [];
  for (const [id, name] of FX.agents) {
    const after = due(db, id);
    cents(`${name} (${id}) : dû = dû prod du 26/09`, after, FX.expected_due[String(id)]);
    cents(`${name} (${id}) : dû = ancien calcul`, after, before[id]);
    table.push(`      ${name.padEnd(16)} prod ${FX.expected_due[String(id)].toFixed(4).padStart(10)}  legacy ${before[id].toFixed(4).padStart(10)}  nouveau ${(after ?? NaN).toFixed(4).padStart(10)}`);
  }
  console.log(table.join("\n"));
  const kinds = db.prepare(`SELECT kind, agent_pct, COUNT(*) n FROM affiliate_agent_rates GROUP BY kind, agent_pct ORDER BY kind`).all();
  console.log("      taux posés :", JSON.stringify(kinds));
  const mismatches: string[] = [];
  for (const r of FX.rels) for (const g of r.games) {
    const row = db.prepare(`SELECT agent_pct FROM affiliate_agent_rates WHERE relationship_id = ? AND game_id = ?`).get(r.id, g.gid) as { agent_pct: number } | undefined;
    const want = g.label === "éligible" ? 50 : 0;
    if (!row || row.agent_pct !== want) mismatches.push(`${r.id}/${g.name}: prod ${g.label}, migré ${row?.agent_pct ?? "∅"}`);
  }
  eq("chaque couple (relation, game) : taux migré = libellé prod (éligible → 50, hors fenêtre → 0)", mismatches, []);
  eq("toutes les périodes migrées sont « depuis l'origine », ouvertes",
     (db.prepare(`SELECT COUNT(*) n FROM affiliate_agent_rates WHERE start_week IS NOT NULL OR end_week IS NOT NULL`).get() as any).n, 0);
  eq("hors fenêtre prod = 0 % hors_fenetre (Antoine AKS)",
     (db.prepare(`SELECT agent_pct, kind FROM affiliate_agent_rates WHERE relationship_id = 8 AND game_id = 255`).get() as any), { agent_pct: 0, kind: "hors_fenetre" });
  eq("Grobel A5 éligible = 50 % migration (rien ne bascule hors fenêtre)",
     (db.prepare(`SELECT agent_pct, kind FROM affiliate_agent_rates WHERE relationship_id = 21 AND game_id = 6`).get() as any), { agent_pct: 50, kind: "migration" });
  // Recréer le deal A5 de Grobel (nouveau created_at bien après la fenêtre) ne change plus rien.
  db.prepare(`UPDATE player_game_deals SET created_at = '2026-09-25 10:00:00' WHERE player_id = 428 AND game_id = 6`).run();
  cents("deal A5 de Grobel recréé le 25/09 : dû de Samyaza inchangé (éligibilité découplée)", due(db, 421), 314.3693);
  check("…alors que l'ANCIEN calcul, lui, l'aurait fait basculer", legacyAgentCommissionOn(db, 421).due_now < 314.36 - 1, `legacy = ${legacyAgentCommissionOn(db, 421).due_now}`);
  eq("migration rejouée : déjà appliquée", runAffiliateAgentRatesMigrationV1(db), "already_applied");
}

console.log("\n══ B. Samyaza/Grobel A5 : 10 000 de résultat joueur → 500 ══");
{
  const db = freshDb();
  db.prepare(`INSERT INTO players (id, name) VALUES (1, 'Agent'), (2, 'Filleul')`).run();
  db.prepare(`INSERT INTO games (id, name, perceived_action_pct) VALUES (6, 'A5POKER', 20)`).run();
  db.prepare(`INSERT INTO player_game_deals (player_id, game_id, action_pct, created_at) VALUES (2, 6, 50, '2026-08-10 12:39:01')`).run();
  db.prepare(`INSERT INTO affiliate_relationships (id, affiliate_player_id, referred_player_id, start_date) VALUES (1, 1, 2, '2026-08-04')`).run();
  runAffiliateAgentRatesMigrationV1(db);
  tx(db, 2, 6, 10000, "2026-09-21T10:00:00Z");
  const r = setAgentRateOn(db, { relationship_id: 1, game_id: 6, agent_pct: 25, start_week: "2026-09-21", confirm_retroactive: true, today: TODAY });
  check("taux 25 posé", r.ok, JSON.stringify(r));
  const d = computeAgentCommissionOn(db, 1, { today: TODAY });
  const line = d.lines[0];
  cents("part agence = 10 000 × 20 % perçu = 2 000", line.weeks.find(w => w.week === "2026-09-21")!.part, 2000);
  cents("commission de la semaine = 500", line.weeks.find(w => w.week === "2026-09-21")!.commission, 500);
  cents("dû agent = 500", d.due_now, 500);
  const trap = setAgentRateOn(db, { relationship_id: 1, game_id: 6, agent_pct: 5, start_week: "2026-09-21", dry_run: true, today: TODAY });
  cents("le piège : « 5 » saisi donnerait 100, pas 500 ni 250", !trap.ok && trap.preview ? trap.preview.agent.due_after : null, 100);
}

console.log("\n══ C. Grobel A5 à 25 % dès le 2026-09-07 (fixture prod) ══");
{
  const db = loadFixture(); runAffiliateAgentRatesMigrationV1(db);
  const n0 = (db.prepare(`SELECT COUNT(*) n FROM affiliate_agent_rates`).get() as any).n;
  const dry = setAgentRateOn(db, { relationship_id: 21, game_id: 6, agent_pct: 25, start_week: "2026-09-07", dry_run: true, today: TODAY });
  eq("dry_run : rien écrit", (db.prepare(`SELECT COUNT(*) n FROM affiliate_agent_rates`).get() as any).n, n0);
  const p = (dry as any).preview;
  eq("aperçu : une semaine à activité recalculée (2026-09-21, 50 → 25)", p.weeks.map((w: any) => [w.week, w.old_pct, w.new_pct]), [["2026-09-21", 50, 25]]);
  cents("aperçu : part agence de la semaine = 3 143,66 × 20 % = 628,73", p.weeks[0].part, 628.732);
  cents("aperçu : commission 314,37 → 157,18", p.weeks[0].commission_before, 314.366);
  cents("aperçu : dû Samyaza avant = 314,37", p.agent.due_before, 314.3693);
  cents("aperçu : dû Samyaza après = 157,19", p.agent.due_after, 157.1863);
  const nc = setAgentRateOn(db, { relationship_id: 21, game_id: 6, agent_pct: 25, start_week: "2026-09-07", today: TODAY });
  check("sans confirmation : refus avec aperçu", !nc.ok && (nc as any).needs_confirmation === true);
  const ok = setAgentRateOn(db, { relationship_id: 21, game_id: 6, agent_pct: 25, start_week: "2026-09-07", confirm_retroactive: true, note: "nouveau deal 50/45/5", today: TODAY });
  check("confirmé : écrit", ok.ok && (ok as any).written === true);
  eq("historique : 50 % origine → 2026-08-31, puis 25 % dès 2026-09-07",
     ratePeriodsOn(db, 21, 6).map(r => [r.start_week, r.end_week, r.agent_pct, r.kind]),
     [[null, "2026-08-31", 50, "migration"], ["2026-09-07", null, 25, "manual"]]);
  check("la note porte la trace du rétroactif", /\[rétroactif .*2026-09-21 \(50 % → 25 %\).*314,37 → 157,19/.test(ratePeriodsOn(db, 21, 6)[1].note ?? ""), ratePeriodsOn(db, 21, 6)[1].note ?? "");
  cents("dû Samyaza après écriture = 157,19", due(db, 421), 157.1863);
  eq("Chroma KK/A5 et Grobel KK restent à 50 %",
     [ratePeriodsOn(db, 23, 5)[0].agent_pct, ratePeriodsOn(db, 23, 6)[0].agent_pct, ratePeriodsOn(db, 21, 5)[0].agent_pct], [50, 50, 50]);
  eq("rateHistoryOn(Grobel) : KK et A5 (deals) + les games actifs sans deal",
     rateHistoryOn(db, 21).map(h => [h.game_name, h.periods.length]),
     [["TELE", 1], ["KKPOKER", 1], ["A5POKER", 2], ["AKS", 1], ["QQPK", 1], ["NUTSPK", 1], ["XPOKER_TWD", 1]]);
  eq("games sans deal de Grobel (fenêtre fermée le 03/09) : 0 % hors fenêtre, comme l'ancienne règle pour un deal créé aujourd'hui",
     rateHistoryOn(db, 21).filter(h => !["KKPOKER", "A5POKER"].includes(h.game_name)).map(h => [h.periods[0].agent_pct, h.periods[0].kind]),
     [[0, "hors_fenetre"], [0, "hors_fenetre"], [0, "hors_fenetre"], [0, "hors_fenetre"], [0, "hors_fenetre"]]);

  // Refus : toute date d'effet ≤ semaine du paiement du 02/09 (lundi 31/08).
  for (const S of [null, "2026-08-03", "2026-08-31"]) {
    const db2 = loadFixture(); runAffiliateAgentRatesMigrationV1(db2);
    const before = (db2.prepare(`SELECT COUNT(*) n FROM affiliate_agent_rates`).get() as any).n;
    const r = setAgentRateOn(db2, { relationship_id: 21, game_id: 6, agent_pct: 25, start_week: S, confirm_retroactive: true, today: TODAY });
    check(`refus dès ${S ?? "l'origine"} : période payée le 02/09`, !r.ok && !!(r as any).frozen && /déjà payées/.test((r as any).error), JSON.stringify(r).slice(0, 200));
    eq(`refus dès ${S ?? "l'origine"} : date au plus tôt proposée = 2026-09-07`, (r as any).frozen?.earliest_week, "2026-09-07");
    eq(`refus dès ${S ?? "l'origine"} : rien écrit`, (db2.prepare(`SELECT COUNT(*) n FROM affiliate_agent_rates`).get() as any).n, before);
    cents(`refus dès ${S ?? "l'origine"} : dû inchangé`, due(db2, 421), 314.3693);
  }
  // Même un taux IDENTIQUE en montant mais d'une autre game touche des semaines gelées → autorisé seulement s'il ne change rien.
  const same = setAgentRateOn(db, { relationship_id: 23, game_id: 5, agent_pct: 50, start_week: "2026-08-03", today: TODAY });
  check("50 → 50 sur une semaine gelée : pas un refus (aucun montant ne bouge)", same.ok || !(same as any).frozen, JSON.stringify(same).slice(0, 200));
}

console.log("\n══ C2. Gel sur une période MANUELLE datée (audit F1) ══");
{
  // Scénario de l'auditeur : 30 % dès le 06/07, activité 06/07 et 13/07, paiement de 600 le 20/07.
  const mk = () => {
    const db = freshDb();
    db.prepare(`INSERT INTO players (id, name) VALUES (1, 'Agent'), (2, 'Filleul')`).run();
    db.prepare(`INSERT INTO games (id, name, perceived_action_pct) VALUES (5, 'KKPOKER', 100)`).run();
    db.prepare(`INSERT INTO player_game_deals (player_id, game_id, created_at) VALUES (2, 5, '2026-06-01 00:00:00')`).run();
    db.prepare(`INSERT INTO affiliate_relationships (id, affiliate_player_id, referred_player_id, start_date) VALUES (1, 1, 2, '2026-06-01')`).run();
    runAffiliateAgentRatesMigrationV1(db);
    const r = setAgentRateOn(db, { relationship_id: 1, game_id: 5, agent_pct: 30, start_week: "2026-07-06", confirm_retroactive: true, today: "2026-07-01" });
    if (!r.ok) throw new Error("setup: " + JSON.stringify(r));
    tx(db, 2, 5, 1000, "2026-07-07T10:00:00Z");
    tx(db, 2, 5, 1000, "2026-07-14T10:00:00Z");
    db.prepare(`INSERT INTO affiliate_payments (relationship_id, game_id, week_start_date, week_end_date, amount_usdt, paid_at) VALUES (1, 5, '2026-07-06', '2026-07-19', 600, '2026-07-20 18:00:00')`).run();
    return db;
  };
  const cases: [string, number, string][] = [
    ["30 → 10 % dès le 06/07 (période ouverte datée)", 10, "2026-07-06"],
    ["30 → 100 % dès le 13/07 (double paiement évité)", 100, "2026-07-13"],
    ["30 → 50 % dès le 20/07 (semaine du paiement)", 50, "2026-07-20"],
  ];
  for (const [label, pctV, S] of cases) {
    const db = mk();
    cents(`${label} : dû avant = 0`, computeAgentCommissionOn(db, 1, { today: TODAY }).due_now, 0);
    const r = setAgentRateOn(db, { relationship_id: 1, game_id: 5, agent_pct: pctV, start_week: S, confirm_retroactive: true, today: TODAY });
    check(`${label} : REFUSÉ`, !r.ok && !!(r as any).frozen, JSON.stringify(r).slice(0, 160));
    eq(`${label} : périodes inchangées`, ratePeriodsOn(db, 1, 5).map(x => [x.start_week, x.end_week, x.agent_pct]), [[null, "2026-06-29", 50], ["2026-07-06", null, 30]]);
  }
  const db = mk();
  const ok = setAgentRateOn(db, { relationship_id: 1, game_id: 5, agent_pct: 10, start_week: "2026-07-27", today: TODAY });
  check("30 → 10 % dès le 27/07 (après la semaine payée) : accepté", ok.ok, JSON.stringify(ok).slice(0, 160));
  // Période FERMÉE datée : 20 % du 06/07 au 13/07, puis 30 % ; paiement le 20/07 ; changer la période fermée = refus.
  const db2 = freshDb();
  db2.prepare(`INSERT INTO players (id, name) VALUES (1, 'Agent'), (2, 'Filleul')`).run();
  db2.prepare(`INSERT INTO games (id, name, perceived_action_pct) VALUES (5, 'KKPOKER', 100)`).run();
  db2.prepare(`INSERT INTO player_game_deals (player_id, game_id, created_at) VALUES (2, 5, '2026-06-01 00:00:00')`).run();
  db2.prepare(`INSERT INTO affiliate_relationships (id, affiliate_player_id, referred_player_id, start_date) VALUES (1, 1, 2, '2026-06-01')`).run();
  runAffiliateAgentRatesMigrationV1(db2);
  setAgentRateOn(db2, { relationship_id: 1, game_id: 5, agent_pct: 20, start_week: "2026-07-06", today: "2026-07-01" });
  setAgentRateOn(db2, { relationship_id: 1, game_id: 5, agent_pct: 30, start_week: "2026-07-20", today: "2026-07-01" });
  db2.prepare(`INSERT INTO affiliate_payments (relationship_id, game_id, week_start_date, week_end_date, amount_usdt, paid_at) VALUES (1, 5, '2026-07-06', '2026-07-26', 1, '2026-07-27 18:00:00')`).run();
  const r2 = setAgentRateOn(db2, { relationship_id: 1, game_id: 5, agent_pct: 40, start_week: "2026-07-13", confirm_retroactive: true, today: TODAY });
  check("période fermée datée (20 %) touchée sous le gel : REFUSÉ", !r2.ok && !!(r2 as any).frozen, JSON.stringify(r2).slice(0, 160));
  // Cas réel dérivé : Grobel A5 25 % dès 09-07, paiement le 28/09, puis 50 % dès 09-14 ⇒ refus.
  const db3 = loadFixture(); runAffiliateAgentRatesMigrationV1(db3);
  setAgentRateOn(db3, { relationship_id: 21, game_id: 6, agent_pct: 25, start_week: "2026-09-07", confirm_retroactive: true, note: "nouveau deal", today: TODAY });
  db3.prepare(`INSERT INTO affiliate_payments (relationship_id, game_id, week_start_date, week_end_date, amount_usdt, paid_at) VALUES (21, 5, '2026-09-01', '2026-09-27', 157.19, '2026-09-28 12:00:00')`).run();
  const r3 = setAgentRateOn(db3, { relationship_id: 21, game_id: 6, agent_pct: 50, start_week: "2026-09-14", confirm_retroactive: true, today: "2026-09-29" });
  check("Grobel A5 : 25 → 50 % dès le 14/09 après paiement du 28/09 : REFUSÉ", !r3.ok && !!(r3 as any).frozen, JSON.stringify(r3).slice(0, 160));
  eq("…date au plus tôt proposée = 2026-10-05", (r3 as any).frozen?.earliest_week, "2026-10-05");
  // Trace conservée quand la nouvelle période est fusionnée dans la précédente (audit, réserve 7).
  // Grobel A5 (activité la semaine du 21/09) : 25 % dès 07/09, 40 % dès 21/09, puis retour à 25 % dès 21/09
  // → la période du 21/09 fusionne dans celle du 07/09 ; le dernier rétroactif doit rester tracé.
  const db4 = loadFixture(); runAffiliateAgentRatesMigrationV1(db4);
  setAgentRateOn(db4, { relationship_id: 21, game_id: 6, agent_pct: 25, start_week: "2026-09-07", confirm_retroactive: true, today: TODAY });
  setAgentRateOn(db4, { relationship_id: 21, game_id: 6, agent_pct: 40, start_week: "2026-09-21", confirm_retroactive: true, today: TODAY });
  const m = setAgentRateOn(db4, { relationship_id: 21, game_id: 6, agent_pct: 25, start_week: "2026-09-21", confirm_retroactive: true, today: TODAY });
  check("fusion : écrit (rétroactif)", m.ok && (m as any).retroactive === true, JSON.stringify(m).slice(0, 160));
  const manual = ratePeriodsOn(db4, 21, 6).filter(r => r.kind === "manual");
  eq("fusion : une seule période manuelle à 25 % dès 09-07", manual.map(r => [r.start_week, r.end_week, r.agent_pct]), [["2026-09-07", null, 25]]);
  check("fusion : la trace du dernier rétroactif (2026-09-21 40 % → 25 %) est conservée", /2026-09-21 \(40 % → 25 %\)/.test(manual[0]?.note ?? ""), manual[0]?.note ?? "");
  cents("fusion : dû Samyaza = 157,19 (identique au seul passage à 25 %)", due(db4, 421), 157.1863);
}

console.log("\n══ D. Semaine à cheval sur la date d'effet ══");
{
  const db = freshDb();
  db.prepare(`INSERT INTO players (id, name) VALUES (1, 'Agent'), (2, 'Filleul')`).run();
  db.prepare(`INSERT INTO games (id, name, perceived_action_pct) VALUES (6, 'A5POKER', 20)`).run();
  db.prepare(`INSERT INTO player_game_deals (player_id, game_id, created_at) VALUES (2, 6, '2026-08-10 00:00:00')`).run();
  db.prepare(`INSERT INTO affiliate_relationships (id, affiliate_player_id, referred_player_id, start_date) VALUES (1, 1, 2, '2026-08-04')`).run();
  runAffiliateAgentRatesMigrationV1(db);
  tx(db, 2, 6, 1000, "2026-09-06T23:59:59Z");   // dimanche : semaine du 31/08, ancien taux
  tx(db, 2, 6, 1000, "2026-09-07T00:00:00Z");   // lundi : semaine du 07/09, nouveau taux
  eq("lundi de 2026-09-06 = 2026-08-31", mondayOf("2026-09-06T23:59:59Z"), "2026-08-31");
  const r = setAgentRateOn(db, { relationship_id: 1, game_id: 6, agent_pct: 25, start_week: "2026-09-07", confirm_retroactive: true, today: TODAY });
  check("taux posé", r.ok, JSON.stringify(r).slice(0, 200));
  const w = computeAgentCommissionOn(db, 1, { today: TODAY }).lines[0].weeks;
  eq("dimanche 23:59:59Z → semaine 31/08 à 50 %", w.filter(x => x.week === "2026-08-31").map(x => [x.pct, Math.round(x.commission! * 100) / 100]), [[50, 100]]);
  eq("lundi 00:00:00Z → semaine 07/09 à 25 %", w.filter(x => x.week === "2026-09-07").map(x => [x.pct, Math.round(x.commission! * 100) / 100]), [[25, 50]]);
  cents("dû = 100 + 50", computeAgentCommissionOn(db, 1, { today: TODAY }).due_now, 150);
  const bad = setAgentRateOn(db, { relationship_id: 1, game_id: 6, agent_pct: 30, start_week: "2026-09-09", today: TODAY });
  check("date d'effet un mercredi : refusée (pas de prorata)", !bad.ok && /lundi/.test((bad as any).error));
}

console.log("\n══ E. Négatif sur une game, positif sur une autre, taux différents ══");
{
  const mk = (kk: number, a5: number) => {
    const db = freshDb();
    db.prepare(`INSERT INTO players (id, name) VALUES (1, 'Agent'), (2, 'Filleul')`).run();
    db.prepare(`INSERT INTO games (id, name, perceived_action_pct) VALUES (5, 'KKPOKER', 100), (6, 'A5POKER', 100)`).run();
    db.prepare(`INSERT INTO player_game_deals (player_id, game_id, created_at) VALUES (2, 5, '2026-08-05 00:00:00'), (2, 6, '2026-08-05 00:00:00')`).run();
    db.prepare(`INSERT INTO affiliate_relationships (id, affiliate_player_id, referred_player_id, start_date) VALUES (1, 1, 2, '2026-08-04')`).run();
    runAffiliateAgentRatesMigrationV1(db);
    // base perçue 100 % : la part agence = le résultat, pour lire les chiffres directement
    tx(db, 2, 5, kk, "2026-09-15T10:00:00Z");
    tx(db, 2, 6, a5, "2026-09-15T11:00:00Z");
    setAgentRateOn(db, { relationship_id: 1, game_id: 6, agent_pct: 25, start_week: null, confirm_retroactive: true, today: TODAY });
    return computeAgentCommissionOn(db, 1, { today: TODAY });
  };
  const a = mk(-1000, 2000);
  cents("KK −1 000 à 50 % + A5 +2 000 à 25 % : −500 + 500 = 0", a.commission_signed, 0);
  cents("…dû 0 (compensation d'abord aurait donné 500 à 50 % ou 250 à 25 %)", a.due_now, 0);
  const b = mk(2000, -1000);
  cents("KK +2 000 à 50 % + A5 −1 000 à 25 % : 1 000 − 250 = 750", b.due_now, 750);
}

console.log("\n══ F. Le 0 % — Antoine / Xabi (fixture prod) ══");
{
  const db = loadFixture(); runAffiliateAgentRatesMigrationV1(db);
  cents("Xabi avant : 129,79", due(db, 175), 129.7862);
  const noNote = setAgentRateOn(db, { relationship_id: 8, game_id: 5, agent_pct: 0, start_week: null, confirm_retroactive: true, today: TODAY });
  check("0 % sans note : refusé", !noNote.ok && /note/.test((noNote as any).error));
  // Aperçu game par game, puis écriture des trois games éligibles (TELE, KK, A5).
  const steps: string[] = [];
  for (const g of [1, 5, 6]) {
    const r = setAgentRateOn(db, { relationship_id: 8, game_id: g, agent_pct: 0, start_week: null, note: "on prend 70 % d'action sur Antoine, Xavier ne touche rien sur lui", confirm_retroactive: true, today: TODAY });
    check(`Antoine game ${g} → 0 % écrit`, r.ok, JSON.stringify(r).slice(0, 200));
    if (r.ok && r.preview) steps.push(`${r.preview.game_name} ${r.preview.agent.due_before?.toFixed(4)} → ${r.preview.agent.due_after?.toFixed(4)}`);
  }
  console.log("      Xabi, pas à pas :", steps.join(" ; "));
  cents("Xabi après (0 % depuis l'origine sur TELE, KK, A5) : 0", due(db, 175), 0);
  const kinds = db.prepare(`SELECT game_id, agent_pct, kind, note IS NOT NULL AS has_note FROM affiliate_agent_rates WHERE relationship_id = 8 ORDER BY game_id`).all();
  eq("0 % manuel (avec note) distinct du 0 % hors fenêtre", kinds.map((k: any) => [k.game_id, k.agent_pct, k.kind, k.has_note]),
     [[1, 0, "manual", 1], [5, 0, "manual", 1], [6, 0, "manual", 1], [255, 0, "hors_fenetre", 1], [448, 0, "hors_fenetre", 1], [654, 0, "hors_fenetre", 1], [2539, 0, "hors_fenetre", 1]]);
  check("la note du 0 % garde l'ancien taux (« avant : 50 % (migration) »)", /avant : 50 % \(migration\)/.test(ratePeriodsOn(db, 8, 5)[0].note ?? ""));
  check("…et la note de migration n'est pas écrasée (audit R2)", /taux unique d'avant le .*deal créé le 2026-05-17/.test(ratePeriodsOn(db, 8, 5)[0].note ?? ""), ratePeriodsOn(db, 8, 5)[0].note ?? "");

  // Variante : 0 % seulement à partir de la semaine prochaine (aucune semaine passée touchée).
  const db2 = loadFixture(); runAffiliateAgentRatesMigrationV1(db2);
  const fut = setAgentRateOn(db2, { relationship_id: 8, game_id: 5, agent_pct: 0, start_week: "2026-09-28", note: "0 % à partir de la semaine prochaine", today: TODAY });
  check("0 % dès le 2026-09-28 : appliqué direct (fin de chronologie, rien de passé)", fut.ok && !(fut as any).retroactive, JSON.stringify(fut).slice(0, 200));
  cents("…dû de Xabi inchangé : 129,79", due(db2, 175), 129.7862);

  // Filleul à 0 % en perte + autre filleul en gain chez le même agent.
  const db3 = freshDb();
  db3.prepare(`INSERT INTO players (id, name) VALUES (1, 'Agent'), (2, 'F0'), (3, 'F50')`).run();
  db3.prepare(`INSERT INTO games (id, name, perceived_action_pct) VALUES (5, 'KKPOKER', 100)`).run();
  db3.prepare(`INSERT INTO player_game_deals (player_id, game_id, created_at) VALUES (2, 5, '2026-08-05 00:00:00'), (3, 5, '2026-08-05 00:00:00')`).run();
  db3.prepare(`INSERT INTO affiliate_relationships (id, affiliate_player_id, referred_player_id, start_date) VALUES (1, 1, 2, '2026-08-04'), (2, 1, 3, '2026-08-04')`).run();
  runAffiliateAgentRatesMigrationV1(db3);
  tx(db3, 2, 5, -1000, "2026-09-15T10:00:00Z");
  tx(db3, 3, 5, 1000, "2026-09-15T10:00:00Z");
  cents("avant : les deux à 50 %, −1 000 et +1 000 se compensent → dû 0", computeAgentCommissionOn(db3, 1, { today: TODAY }).due_now, 0);
  setAgentRateOn(db3, { relationship_id: 1, game_id: 5, agent_pct: 0, start_week: null, note: "filleul à 0 %", confirm_retroactive: true, today: TODAY });
  const d3 = computeAgentCommissionOn(db3, 1, { today: TODAY });
  cents("F0 à 0 % en perte ne réduit pas le dû : 1 000 × 50 % = 500", d3.due_now, 500);
  cents("…sa part agence reste visible (−1 000) mais ne compte pas", d3.lines.find(l => l.relationship_id === 1)!.part_agence, -1000);
  cents("…et sa commission vaut 0", d3.lines.find(l => l.relationship_id === 1)!.commission, 0);
}

console.log("\n══ G. Taux manquant ⇒ blocage ══");
{
  const db = loadFixture(); runAffiliateAgentRatesMigrationV1(db);
  // Grobel ouvre une nouvelle game APRÈS la migration, et y joue.
  db.prepare(`INSERT INTO games (id, name) VALUES (999, 'NEWGAME')`).run();
  db.prepare(`INSERT INTO affiliate_relationship_games (relationship_id, game_id, disclosed_action_pct) VALUES (21, 999, 20)`).run();
  db.prepare(`INSERT INTO player_game_deals (player_id, game_id, created_at) VALUES (428, 999, '2026-09-20 10:00:00')`).run();
  tx(db, 428, 999, 500, "2026-09-22T10:00:00Z");
  const d = computeAgentCommissionOn(db, 421, { today: TODAY });
  eq("dû Samyaza = null (bloqué, jamais un zéro inventé)", d.due_now, null);
  eq("raison : Grobel / NEWGAME sans taux sur 2026-09-21", d.blocked.map(b => [b.referred_name, b.game_name, b.weeks, b.reason]), [["Grobel", "NEWGAME", ["2026-09-21"], "taux_manquant"]]);
  check("paiement refusé avec un message nommé", /Grobel \/ NEWGAME sans taux agent/.test(paymentBlockOn(d) ?? ""));
  const r = setAgentRateOn(db, { relationship_id: 21, game_id: 999, agent_pct: 50, start_week: "2026-09-21", confirm_retroactive: true, today: TODAY });
  check("taux posé dès la semaine de l'activité", r.ok, JSON.stringify(r).slice(0, 200));
  cents("débloqué : 314,37 + 500 × 20 % × 50 % = 364,37", due(db, 421), 364.3693);
  // Une activité SANS taux dans une semaine GELÉE n'a jamais été payée : la noter n'est pas un refus.
  const db2 = loadFixture(); runAffiliateAgentRatesMigrationV1(db2);
  db2.prepare(`INSERT INTO games (id, name) VALUES (999, 'NEWGAME')`).run();
  db2.prepare(`INSERT INTO affiliate_relationship_games (relationship_id, game_id, disclosed_action_pct) VALUES (21, 999, 20)`).run();
  db2.prepare(`INSERT INTO player_game_deals (player_id, game_id, created_at) VALUES (428, 999, '2026-09-20 10:00:00')`).run();
  tx(db2, 428, 999, 500, "2026-08-18T10:00:00Z");   // semaine du 17/08, gelée par le paiement du 02/09
  const r2 = setAgentRateOn(db2, { relationship_id: 21, game_id: 999, agent_pct: 50, start_week: null, today: TODAY });
  check("semaine gelée SANS taux : pas un refus, un rétroactif à confirmer", !r2.ok && (r2 as any).needs_confirmation === true && !(r2 as any).frozen, JSON.stringify(r2).slice(0, 200));
}

console.log("\n══ H. Garde-fous ══");
{
  const db = loadFixture(); runAffiliateAgentRatesMigrationV1(db);
  const fut = setAgentRateOn(db, { relationship_id: 23, game_id: 5, agent_pct: 30, start_week: "2026-10-05", today: TODAY });
  check("changement futur sans activité : appliqué direct", fut.ok && (fut as any).written && !(fut as any).retroactive, JSON.stringify(fut).slice(0, 200));
  const again = setAgentRateOn(db, { relationship_id: 23, game_id: 5, agent_pct: 30, start_week: "2026-10-05", today: TODAY });
  check("même taux, même nature : rien à écrire", again.ok && (again as any).unchanged === true);
  const ins = setAgentRateOn(db, { relationship_id: 23, game_id: 5, agent_pct: 40, start_week: "2026-09-28", today: TODAY });
  check("période insérée avant une période existante : confirmation exigée", !ins.ok && (ins as any).needs_confirmation === true);
  eq("…et la période du 05/10 n'est pas réécrite",
     ratePeriodsOn(db, 23, 5).map(r => [r.start_week, r.end_week, r.agent_pct]), [[null, "2026-09-28", 50], ["2026-10-05", null, 30]]);
  const frac = setAgentRateOn(db, { relationship_id: 23, game_id: 5, agent_pct: 0.25, start_week: "2026-10-12", today: TODAY });
  check("0.25 refusé (fraction déguisée)", !frac.ok && /fraction/.test((frac as any).error));
  throws("CHECK : 0 % manuel sans note refusé en base", () =>
    db.prepare(`INSERT INTO affiliate_agent_rates (relationship_id, game_id, agent_pct, start_week, end_week, kind, note) VALUES (23, 6, 0, '2026-11-02', '2026-11-02', 'manual', NULL)`).run(), /CHECK/);
  throws("CHECK : date d'effet hors lundi refusée en base", () =>
    db.prepare(`INSERT INTO affiliate_agent_rates (relationship_id, game_id, agent_pct, start_week, end_week, kind, note) VALUES (23, 6, 30, '2026-11-03', '2026-11-03', 'manual', 'x')`).run(), /CHECK/);
  throws("UNIQUE : deux périodes ouvertes refusées", () =>
    db.prepare(`INSERT INTO affiliate_agent_rates (relationship_id, game_id, agent_pct, start_week, end_week, kind, note) VALUES (23, 6, 30, '2026-11-02', NULL, 'manual', 'x')`).run(), /UNIQUE/);
  const db2 = loadFixture();
  db2.exec("BEGIN");
  eq("migration dans une transaction étrangère : reportée", runAffiliateAgentRatesMigrationV1(db2), "deferred");
  db2.exec("ROLLBACK");
  eq("…sans marqueur", db2.prepare(`SELECT 1 FROM _applied_fixes WHERE name = ?`).get(AFFILIATE_AGENT_RATES_MIGRATION_V1), undefined);
}

console.log("\n══ I. Deal PERÇU versionné ══");
{
  const db = loadFixture(); runAffiliateAgentRatesMigrationV1(db);
  eq("migration : perçu A5 et KK repris depuis l'origine (20 %)",
     [perceivedPeriodsOn(db, 5), perceivedPeriodsOn(db, 6)].map(ps => ps.map(p => [p.start_week, p.end_week, p.action_pct])), [[[null, null, 20]], [[null, null, 20]]]);
  cents("dû Samyaza inchangé avec le perçu lu dans la table", due(db, 421), 314.3693);
  // L'erreur du 25/09 rejouée : A5 20 → 50 % depuis l'origine.
  const n0 = (db.prepare(`SELECT COUNT(*) n FROM game_perceived_deals`).get() as any).n;
  const err = setPerceivedDealOn(db, { game_id: 6, action_pct: 50, rakeback_pct: null, insurance_pct: null, start_week: null, confirm_retroactive: true, today: TODAY });
  check("A5 20 → 50 % depuis l'origine : REFUSÉ", !err.ok && !!(err as any).frozen, JSON.stringify(err).slice(0, 200));
  const names = ((err as any).frozen ?? []).map((h: any) => h.agent_name);
  check("…nommément à cause du paiement de Samyaza du 02/09", names.includes("Samyaza") && /Samyaza .*paiement du 2026-09-02/.test((err as any).error), (err as any).error);
  check("…et de celui de Leo (31/08, filleuls A5)", names.includes("Leo La Truite"), JSON.stringify(names));
  eq("…rien écrit", (db.prepare(`SELECT COUNT(*) n FROM game_perceived_deals`).get() as any).n, n0);
  cents("…dû Samyaza inchangé", due(db, 421), 314.3693);
  const dry = setPerceivedDealOn(db, { game_id: 6, action_pct: 50, rakeback_pct: null, insurance_pct: null, start_week: null, dry_run: true, today: TODAY });
  check("…même en dry_run : refus (pas d'aperçu trompeur)", !dry.ok && !!(dry as any).frozen);
  // Après les semaines payées : autorisé, rétroactif (Grobel a joué la semaine du 21/09), avec aperçu par agent.
  const p = setPerceivedDealOn(db, { game_id: 6, action_pct: 50, rakeback_pct: null, insurance_pct: null, start_week: "2026-09-07", today: TODAY });
  check("A5 à 50 % dès le 07/09 : confirmation exigée (semaine à activité touchée)", !p.ok && (p as any).needs_confirmation === true && !(p as any).frozen, JSON.stringify(p).slice(0, 200));
  const sam = (p as any).preview.agents.find((a: any) => a.agent_name === "Samyaza");
  eq("aperçu Samyaza : Grobel sem. du 21/09, perçu 20 → 50", sam.weeks.map((w: any) => [w.referred_name, w.week, w.eff_before, w.eff_after]), [["Grobel", "2026-09-21", 20, 50]]);
  cents("aperçu Samyaza : dû 314,37 → 785,92", sam.due_after, 314.3693 + 3143.66 * 0.3 * 0.5);
  // Futur sans activité : direct.
  const db2 = loadFixture(); runAffiliateAgentRatesMigrationV1(db2);
  const f = setPerceivedDealOn(db2, { game_id: 6, action_pct: 25, rakeback_pct: null, insurance_pct: null, start_week: "2026-09-28", note: "test", today: TODAY });
  check("A5 à 25 % dès le 28/09 (aucune activité) : appliqué direct", f.ok && !(f as any).retroactive, JSON.stringify(f).slice(0, 200));
  eq("historique perçu A5", perceivedPeriodsOn(db2, 6).map(q => [q.start_week, q.end_week, q.action_pct]), [[null, "2026-09-21", 20], ["2026-09-28", null, 25]]);
  cents("…dûs inchangés (Samyaza)", due(db2, 421), 314.3693);
  const frac = setPerceivedDealOn(db2, { game_id: 6, action_pct: 0.2, rakeback_pct: null, insurance_pct: null, start_week: "2026-10-05", today: TODAY });
  check("perçu 0.2 refusé (fraction déguisée)", !frac.ok && /fraction/.test((frac as any).error));
  // Gel = argent : un agent payé dont le filleul n'a PAS joué ce game dans la zone gelée n'est pas un refus.
  const db3 = loadFixture(); runAffiliateAgentRatesMigrationV1(db3);
  const kk = setPerceivedDealOn(db3, { game_id: 5, action_pct: 30, rakeback_pct: null, insurance_pct: null, start_week: "2026-09-07", confirm_retroactive: true, today: TODAY });
  check("KK à 30 % dès le 07/09 : accepté (aucune semaine payée ne bouge)", kk.ok, JSON.stringify(kk).slice(0, 200));
}

console.log("\n══ I2. Gel du perçu sur une relation EN PAUSE (audit R1) ══");
{
  const db = loadFixture(); runAffiliateAgentRatesMigrationV1(db);
  db.prepare(`UPDATE affiliate_relationships SET status = 'paused' WHERE id = 21`).run();   // Grobel en pause (Samyaza payé le 02/09)
  const r = setPerceivedDealOn(db, { game_id: 6, action_pct: 50, rakeback_pct: null, insurance_pct: null, start_week: null, confirm_retroactive: true, today: TODAY });
  check("A5 20 → 50 % depuis l'origine avec Grobel en pause : REFUSÉ quand même", !r.ok && ((r as any).frozen ?? []).some((h: any) => h.agent_name === "Samyaza"), JSON.stringify(r).slice(0, 200));
  db.prepare(`UPDATE affiliate_relationships SET status = 'active' WHERE id = 21`).run();
  cents("…réactivé : dû Samyaza toujours 314,37", due(db, 421), 314.3693);
}

console.log("\n══ I3. Semaine payée à 0 % : le perçu peut changer (aucun argent ne bouge) ══");
{
  const db = loadFixture(); runAffiliateAgentRatesMigrationV1(db);
  // Antoine (Xabi) : AKS hors fenêtre à 0 %, activité semaine du 15/06 ; on paie Xabi le 20/08 (gel).
  db.prepare(`INSERT INTO affiliate_payments (relationship_id, game_id, week_start_date, week_end_date, amount_usdt, paid_at) VALUES (8, 5, '2026-08-01', '2026-08-16', 1, '2026-08-20 12:00:00')`).run();
  db.prepare(`DELETE FROM affiliate_relationship_games WHERE relationship_id = 8 AND game_id = 255`).run();   // AKS au perçu game
  db.prepare(`INSERT INTO game_perceived_deals (game_id, action_pct, start_week, end_week, note) VALUES (255, 20, NULL, NULL, 'test')`).run();
  const r = setPerceivedDealOn(db, { game_id: 255, action_pct: 30, rakeback_pct: null, insurance_pct: null, start_week: null, confirm_retroactive: true, today: TODAY });
  const xabi = ((r as any).frozen ?? []).filter((h: any) => h.agent_name === "Xabi Carricart");
  eq("AKS 20 → 30 % depuis l'origine : aucune semaine payée de Xabi signalée (Antoine y est à 0 %)", xabi.length, 0);
}

console.log("\n══ J. Taux par défaut d'une NOUVELLE relation ══");
{
  const db = loadFixture(); runAffiliateAgentRatesMigrationV1(db);
  db.prepare(`INSERT INTO games (id, name, status) VALUES (777, 'ARCHIVED', 'archived')`).run();
  db.prepare(`INSERT INTO players (id, name) VALUES (9001, 'Nouveau')`).run();
  db.prepare(`INSERT INTO affiliate_relationships (id, affiliate_player_id, referred_player_id, start_date) VALUES (900, 421, 9001, '2026-09-25')`).run();
  const seeded = seedDefaultRatesOn(db, 900);
  eq("50 % par défaut sur chaque game ACTIF (pas l'archivé)", seeded.map(g => g.game_id).sort((a, b) => a - b), [1, 5, 6, 255, 448, 654, 2539]);
  eq("…nature 'default', note « par défaut — à confirmer »",
     [...new Set((db.prepare(`SELECT kind, agent_pct, note FROM affiliate_agent_rates WHERE relationship_id = 900`).all() as any[]).map(r => `${r.kind}|${r.agent_pct}|${r.note}`))],
     ["default|50|par défaut — à confirmer"]);
  eq("seed rejoué : rien de plus", seedDefaultRatesOn(db, 900).length, 0);
  db.prepare(`INSERT INTO player_game_deals (player_id, game_id, created_at) VALUES (9001, 5, '2026-09-25 10:00:00')`).run();
  tx(db, 9001, 5, 1000, "2026-09-22T10:00:00Z");
  cents("son activité KK compte à 50 % (base 20 %) : dû Samyaza 314,37 + 100", due(db, 421), 414.3693);
  // Confirmer = reposer à l'identique en « manuel » : aucun montant ne bouge.
  const c = setAgentRateOn(db, { relationship_id: 900, game_id: 5, agent_pct: 50, start_week: null, note: "taux par défaut confirmé", confirm_retroactive: true, today: TODAY });
  check("confirmer le défaut : écrit", c.ok && (c as any).written, JSON.stringify(c).slice(0, 200));
  eq("…devient manuel à 50 %, trace « avant : 50 % (default) »", ratePeriodsOn(db, 900, 5).map(r => [r.kind, r.agent_pct, /avant : 50 % \(default\)/.test(r.note ?? "")]), [["manual", 50, true]]);
  cents("…dû inchangé", due(db, 421), 414.3693);
  // Un game créé APRÈS la relation n'a aucune ligne : blocage (seul cas restant).
  db.prepare(`INSERT INTO games (id, name) VALUES (888, 'NEWGAME')`).run();
  db.prepare(`INSERT INTO player_game_deals (player_id, game_id, created_at) VALUES (9001, 888, '2026-09-25 10:00:00')`).run();
  db.prepare(`INSERT INTO affiliate_relationship_games (relationship_id, game_id, disclosed_action_pct) VALUES (900, 888, 20)`).run();
  tx(db, 9001, 888, 100, "2026-09-22T11:00:00Z");
  eq("game sans aucune ligne de taux + activité : dû null (bloqué)", due(db, 421), null);
}

console.log("\n══ K. Vue PORTAIL (Samyaza après Grobel A5 à 25 % dès le 07/09) ══");
{
  const db = loadFixture(); runAffiliateAgentRatesMigrationV1(db);
  setAgentRateOn(db, { relationship_id: 21, game_id: 6, agent_pct: 25, start_week: "2026-09-07", confirm_retroactive: true, note: "Deal Grobel A5 50/45/5", today: TODAY });
  const v = agentPortalViewOn(db, 421, { today: TODAY });
  cents("commission lifetime 1 344,65", v.earned, 1344.6463);
  cents("payé 1 187,46", v.paid, 1187.46);
  cents("dû 157,19", v.due_now, 157.1863);
  const grobel = v.filleuls.find(f => f.name === "Grobel")!, chroma = v.filleuls.find(f => f.name === "Chroma")!;
  cents("Grobel +1 347,70", grobel.commission, 1347.6963);
  cents("Chroma −3,05", chroma.commission, -3.05);
  eq("Grobel A5 : 10 % de ses résultats jusqu'à la semaine du 31/08 (+886,72), puis 5 % dès le 07/09 (+157,18)",
     grobel.games.find(g => g.game_name === "A5POKER")!.periods.map(p => [p.player_pct, p.start_week, p.end_week, Math.round(p.commission * 100) / 100]),
     [[10, null, "2026-08-31", 886.72], [5, "2026-09-07", null, 157.18]]);
  eq("Grobel KK : 10 % de ses résultats (+303,79)", grobel.games.find(g => g.game_name === "KKPOKER")!.periods.map(p => [p.player_pct, Math.round(p.commission * 100) / 100]), [[10, 303.79]]);
  const json = JSON.stringify(v);
  check("la vue portail ne contient ni part agence, ni base perçue, ni deal joueur, ni % de la part agence", !/part_agence|agency|eff_action|effective_action|perceived|action_pct|agent_pct|player_pnl|cumul/.test(json), json.slice(0, 300));
  // Audit F1 : la part agence ne se déduit plus (commission ÷ % de la part agence). Ce qui se déduit
  // désormais (commission ÷ % du résultat) est le résultat du filleul, pas la base perçue.
  // Perçu qui change DANS une période : segments distincts, % du résultat juste pour chacun.
  const dbS = loadFixture(); runAffiliateAgentRatesMigrationV1(dbS);
  setPerceivedDealOn(dbS, { game_id: 6, action_pct: 40, rakeback_pct: null, insurance_pct: null, start_week: "2026-09-21", confirm_retroactive: true, today: TODAY });
  const vs = agentPortalViewOn(dbS, 421, { today: TODAY });
  eq("perçu A5 20 → 40 % dès le 21/09 dans la période à 50 % : 10 % jusqu'au 14/09, puis 20 % EN COURS (ouvert)",
     vs.filleuls.find(f => f.name === "Grobel")!.games.find(g => g.game_name === "A5POKER")!.periods.map(p => [p.player_pct, p.start_week, p.end_week]),
     [[10, null, "2026-09-14"], [20, "2026-09-21", null]]);
  // Audit : taux en vigueur même sans activité après le changement ; pas de chevauchement si le perçu revient.
  const dbT = loadFixture(); runAffiliateAgentRatesMigrationV1(dbT);
  setPerceivedDealOn(dbT, { game_id: 5, action_pct: 40, rakeback_pct: null, insurance_pct: null, start_week: "2026-09-28", today: TODAY });
  eq("KK perçu 40 % dès le 28/09 (futur au 26/09) : le portail montre le 10 % EN VIGUEUR, sans révéler la date future",
     agentPortalViewOn(dbT, 421, { today: TODAY }).filleuls.find(f => f.name === "Grobel")!.games.find(g => g.game_name === "KKPOKER")!.periods.map(p => [p.player_pct, p.start_week, p.end_week]),
     [[10, null, null]]);
  eq("…le 28/09 venu : 10 % jusqu'au 21/09, puis 20 % en cours",
     agentPortalViewOn(dbT, 421, { today: "2026-09-29" }).filleuls.find(f => f.name === "Grobel")!.games.find(g => g.game_name === "KKPOKER")!.periods.map(p => [p.player_pct, p.start_week, p.end_week]),
     [[10, null, "2026-09-21"], [20, "2026-09-28", null]]);
  setPerceivedDealOn(dbT, { game_id: 5, action_pct: 20, rakeback_pct: null, insurance_pct: null, start_week: "2026-10-05", today: TODAY });
  eq("perçu qui revient à 20 % (vu au 06/10) : segments sans chevauchement (le 20 % du 28/09, sans activité et révolu, n'est pas affiché)",
     agentPortalViewOn(dbT, 421, { today: "2026-10-06" }).filleuls.find(f => f.name === "Grobel")!.games.find(g => g.game_name === "KKPOKER")!.periods.map(p => [p.player_pct, p.start_week, p.end_week]),
     [[10, null, "2026-09-21"], [10, "2026-10-05", null]]);
  // Taux agent daté dans le futur : le portail montre le taux EN VIGUEUR, pas le futur.
  const dbU = loadFixture(); runAffiliateAgentRatesMigrationV1(dbU);
  setAgentRateOn(dbU, { relationship_id: 21, game_id: 5, player_pct: 3, start_week: "2026-10-12", today: TODAY });
  eq("Grobel KK passe à 3 % du résultat au 12/10 (futur) : le portail montre 10 % en cours, sans la date",
     agentPortalViewOn(dbU, 421, { today: TODAY }).filleuls.find(f => f.name === "Grobel")!.games.find(g => g.game_name === "KKPOKER")!.periods.map(p => [p.player_pct, p.start_week, p.end_week]),
     [[10, null, null]]);
  eq("…le 12/10 venu : 10 % jusqu'au 11/10, puis 3 % en cours",
     agentPortalViewOn(dbU, 421, { today: "2026-10-13" }).filleuls.find(f => f.name === "Grobel")!.games.find(g => g.game_name === "KKPOKER")!.periods.map(p => [p.player_pct, p.start_week, p.end_week]),
     [[10, null, "2026-10-05"], [3, "2026-10-12", null]]);
  // Lignes à 0 % masquées ; filleul sans ligne masqué (affichage seul).
  const dbZ = loadFixture(); runAffiliateAgentRatesMigrationV1(dbZ);
  const theo = agentPortalViewOn(dbZ, 90, { today: TODAY });
  eq("Theo : Loïc QQPK (perçu 0 %) masqué, Loïc KK visible", theo.filleuls.find(f => f.name === "Loïc")!.games.map(g => g.game_name), ["KKPOKER"]);
  const maxime = agentPortalViewOn(dbZ, 181, { today: TODAY });
  check("Maxime : ppkd (AKS perçu 0 %, seule ligne) n'apparaît plus", !maxime.filleuls.some(f => f.name === "ppkd"), JSON.stringify(maxime.filleuls.map(f => f.name)));
  for (const g of [1, 5, 6]) setAgentRateOn(dbZ, { relationship_id: 8, game_id: g, agent_pct: 0, start_week: null, confirm_retroactive: true, note: "Deal Antoine 50 % — Xabi ne touche rien sur ce filleul", today: TODAY });
  const xabi = agentPortalViewOn(dbZ, 175, { today: TODAY });
  eq("Xabi après Antoine à 0 % : Antoine n'apparaît plus, dû 0", [xabi.filleuls.length, xabi.due_now], [0, 0]);
  cents("…montants inchangés par le masquage (Theo 174,00)", theo.due_now, 173.9996);
  // Bloqué : null, jamais 0.
  db.prepare(`INSERT INTO games (id, name) VALUES (888, 'NEWGAME')`).run();
  db.prepare(`INSERT INTO player_game_deals (player_id, game_id, created_at) VALUES (428, 888, '2026-09-25 10:00:00')`).run();
  db.prepare(`INSERT INTO affiliate_relationship_games (relationship_id, game_id, disclosed_action_pct) VALUES (21, 888, 20)`).run();
  tx(db, 428, 888, 100, "2026-09-22T11:00:00Z");
  const b = agentPortalViewOn(db, 421, { today: TODAY });
  eq("agent bloqué : lifetime / dû / total = null (« en cours de calcul »), jamais 0", [b.earned, b.due_now, b.commission_signed, b.filleuls.find(f => f.name === "Grobel")!.commission], [null, null, null, null]);
}

console.log("\n══ L. Garde d'argent sur l'override relation × game (audit F1 du 25/09) ══");
{
  const db = loadFixture(); runAffiliateAgentRatesMigrationV1(db);
  const ok = setPerceivedDealOn(db, { game_id: 6, action_pct: 50, rakeback_pct: null, insurance_pct: null, start_week: "2026-09-28", today: TODAY });
  check("perçu A5 à 50 % dès le 28/09 : accepté", ok.ok);
  // « Override » pré-rempli avec le perçu EN VIGUEUR (50) : override valable pour tout l'historique de Grobel/A5.
  const n0 = (db.prepare(`SELECT COUNT(*) n FROM affiliate_relationship_games WHERE relationship_id = 21`).get() as any).n;
  const r = withFrozenGuardOn(db, 421, () => {
    db.prepare(`INSERT INTO affiliate_relationship_games (relationship_id, game_id, disclosed_action_pct) VALUES (21, 6, 50)`).run();
  }, TODAY);
  check("override Grobel A5 à 50 % sur tout l'historique : REFUSÉ", !r.ok && /déjà payées/.test((r as any).error), JSON.stringify(r).slice(0, 200));
  check("…semaines gelées nommées (17/08)", !r.ok && (r as any).weeks.some((w: any) => w.week === "2026-08-17" && w.game_name === "A5POKER"));
  eq("…écriture annulée (transaction)", (db.prepare(`SELECT COUNT(*) n FROM affiliate_relationship_games WHERE relationship_id = 21`).get() as any).n, n0);
  cents("…dû Samyaza inchangé", due(db, 421), 314.3693);
  // Même override chez un agent jamais payé (Xabi) : aucune semaine gelée → autorisé.
  const r2 = withFrozenGuardOn(db, 175, () => {
    db.prepare(`UPDATE affiliate_relationship_games SET disclosed_action_pct = 30 WHERE relationship_id = 8 AND game_id = 1`).run();
  }, TODAY);
  check("override chez un agent jamais payé : autorisé", r2.ok);
  eq("…et écrit", (db.prepare(`SELECT disclosed_action_pct v FROM affiliate_relationship_games WHERE relationship_id = 8 AND game_id = 1`).get() as any).v, 30);
  // La course du formulaire : enregistrer une liste vide supprime les overrides existants → refus si des semaines payées bougent.
  const leoBefore = due(db, 9);
  const r3 = withFrozenGuardOn(db, 9, () => {
    db.prepare(`DELETE FROM affiliate_relationship_games WHERE relationship_id = 18`).run();
  }, TODAY);
  check("suppression des overrides (vides) de Nicolas, Leo payé : pas un refus, la base ne bouge pas (A5 au perçu 20 %)", r3.ok, JSON.stringify(r3).slice(0, 160));
  cents("…dû de Leo réellement inchangé", due(db, 9), leoBefore);
  // Audit F-A : override posé pendant une PAUSE, puis réactivation.
  const db2 = loadFixture(); runAffiliateAgentRatesMigrationV1(db2);
  const r4 = withFrozenGuardOn(db2, 421, () => {
    db2.prepare(`UPDATE affiliate_relationships SET status = 'paused' WHERE id = 21`).run();
    db2.prepare(`INSERT INTO affiliate_relationship_games (relationship_id, game_id, disclosed_action_pct) VALUES (21, 6, 50)`).run();
  }, TODAY);
  check("pause + override dans la même écriture : REFUSÉ", !r4.ok, JSON.stringify(r4).slice(0, 160));
  eq("…statut resté actif (rien écrit)", (db2.prepare(`SELECT status FROM affiliate_relationships WHERE id = 21`).get() as any).status, "active");
  db2.prepare(`UPDATE affiliate_relationships SET status = 'paused' WHERE id = 21`).run();   // pause « à part » (hors garde, chantier séparé)
  const r5 = withFrozenGuardOn(db2, 421, () => {
    db2.prepare(`INSERT INTO affiliate_relationship_games (relationship_id, game_id, disclosed_action_pct) VALUES (21, 6, 50)`).run();
  }, TODAY);
  check("override sur relation EN PAUSE dont les semaines sont payées : REFUSÉ", !r5.ok, JSON.stringify(r5).slice(0, 160));
  db2.prepare(`UPDATE affiliate_relationships SET status = 'active' WHERE id = 21`).run();
  cents("…réactivée : dû Samyaza toujours 314,37", due(db2, 421), 314.3693);
}

console.log("\n══ M. Saisie en « % du résultat joueur » (unité seule, aucun changement de calcul) ══");
{
  const strip = (rows: any[]) => rows.map(r => [r.start_week, r.end_week, r.agent_pct, r.kind]);
  const dbA = loadFixture(); runAffiliateAgentRatesMigrationV1(dbA);
  const dbB = loadFixture(); runAffiliateAgentRatesMigrationV1(dbB);
  const a = setAgentRateOn(dbA, { relationship_id: 21, game_id: 6, player_pct: 5, start_week: "2026-09-07", confirm_retroactive: true, note: "n", today: TODAY });
  const b = setAgentRateOn(dbB, { relationship_id: 21, game_id: 6, agent_pct: 25, start_week: "2026-09-07", confirm_retroactive: true, note: "n", today: TODAY });
  check("5 % du résultat joueur (A5, perçu 20 %) : écrit", a.ok, JSON.stringify(a).slice(0, 160));
  check("stocké EXACTEMENT 25 (=== 25, pas 25,000…01)", ratePeriodsOn(dbA, 21, 6)[1]?.agent_pct === 25, String(ratePeriodsOn(dbA, 21, 6)[1]?.agent_pct));
  // Audit F2 : 4,6 × 100 / 20 = 22.999999999999996 en flottant brut → arrondi à 1e-8 : 23 exactement.
  const dbF = loadFixture(); runAffiliateAgentRatesMigrationV1(dbF);
  setAgentRateOn(dbF, { relationship_id: 21, game_id: 6, player_pct: 4.6, start_week: "2026-10-05", today: TODAY });
  check("4,6 % du résultat joueur (perçu 20) : stocké EXACTEMENT 23", ratePeriodsOn(dbF, 21, 6).find(r => r.start_week === "2026-10-05")?.agent_pct === 23, String(ratePeriodsOn(dbF, 21, 6).find(r => r.start_week === "2026-10-05")?.agent_pct));
  eq("périodes identiques à une saisie directe de 25 % de la part agence", strip(ratePeriodsOn(dbA, 21, 6)), strip(ratePeriodsOn(dbB, 21, 6)));
  check("dû Samyaza identique au bit près (157,19)", due(dbA, 421) === due(dbB, 421), `${due(dbA, 421)} vs ${due(dbB, 421)}`);
  eq("aperçu : base à la date d'effet = 20 (affichage 25 % × 20 / 100 = 5 %)", (a as any).preview?.base_at_start, 20);
  // La conversion utilise le perçu DE LA DATE D'EFFET, pas celui du jour.
  const dbC = loadFixture(); runAffiliateAgentRatesMigrationV1(dbC);
  setPerceivedDealOn(dbC, { game_id: 6, action_pct: 25, rakeback_pct: null, insurance_pct: null, start_week: "2026-10-05", today: TODAY });
  const c = setAgentRateOn(dbC, { relationship_id: 21, game_id: 6, player_pct: 5, start_week: "2026-10-05", today: TODAY });
  check("perçu 25 % dès le 05/10 : 5 % du résultat joueur dès le 05/10 → 20 % de la part agence", c.ok && ratePeriodsOn(dbC, 21, 6).find(r => r.start_week === "2026-10-05")?.agent_pct === 20, JSON.stringify(ratePeriodsOn(dbC, 21, 6).map(r => [r.start_week, r.agent_pct])));
  // Bornes, exprimées dans l'unité stockée.
  const db = loadFixture(); runAffiliateAgentRatesMigrationV1(db);
  const over = setAgentRateOn(db, { relationship_id: 21, game_id: 6, player_pct: 25, start_week: "2026-10-05", today: TODAY });
  check("25 % du résultat joueur sur perçu 20 % (= 125 % de la part) : refusé", !over.ok && /125/.test((over as any).error), (over as any).error);
  const tiny = setAgentRateOn(db, { relationship_id: 21, game_id: 6, player_pct: 0.1, start_week: "2026-10-05", today: TODAY });
  check("0,1 % du résultat joueur (= 0,5 % de la part) : refusé", !tiny.ok && /sous 1 %/.test((tiny as any).error), (tiny as any).error);
  const both = setAgentRateOn(db, { relationship_id: 21, game_id: 6, player_pct: 5, agent_pct: 25, start_week: "2026-10-05", today: TODAY });
  check("deux unités à la fois : refusé", !both.ok && /UNE unité/.test((both as any).error));
  const none = setAgentRateOn(db, { relationship_id: 21, game_id: 6, start_week: "2026-10-05", today: TODAY } as any);
  check("aucune unité : refusé", !none.ok && /UNE unité/.test((none as any).error));
  const zero = setAgentRateOn(db, { relationship_id: 8, game_id: 5, player_pct: 0, start_week: null, confirm_retroactive: true, today: TODAY });
  check("0 % du résultat joueur sans note : refusé (note obligatoire)", !zero.ok && /note/.test((zero as any).error));
  const zeroOk = setAgentRateOn(db, { relationship_id: 8, game_id: 5, player_pct: 0, start_week: null, confirm_retroactive: true, note: "Deal Antoine 50 % — Xabi ne touche rien sur ce filleul", today: TODAY });
  check("0 % avec note : stocké 0", zeroOk.ok && ratePeriodsOn(db, 8, 5)[0].agent_pct === 0);
  // Formule composite : pas de % du résultat joueur.
  db.prepare(`INSERT INTO games (id, name) VALUES (2, 'Wepoker')`).run();
  db.prepare(`INSERT INTO player_game_deals (player_id, game_id, created_at) VALUES (428, 2, '2026-08-05 00:00:00')`).run();
  const wp = setAgentRateOn(db, { relationship_id: 21, game_id: 2, player_pct: 5, start_week: "2026-10-05", today: TODAY });
  check("Wepoker (composite) en % du résultat joueur : refusé, saisir en % de la part agence", !wp.ok && /composite/.test((wp as any).error), (wp as any).error);
  // Affichage : base par période exposée pour l'historique.
  const lines = computeAgentCommissionOn(dbA, 421, { today: TODAY }).lines.find(l => l.relationship_id === 21 && l.game_id === 6)!;
  eq("historique : base 20 % au début de chaque période (→ 10 % puis 5 % du résultat joueur)", lines.period_eff, [20, 20]);
}

console.log(`\n${passed} ✔  ${failures.length} ✘`);
if (failures.length) { console.log(failures.map(f => "  ✘ " + f).join("\n")); process.exit(1); }
