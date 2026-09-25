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

import { runAffiliateAgentRatesMigrationV1, AFFILIATE_AGENT_RATES_MIGRATION_V1 } from "../lib/affiliate/agent-rates-schema";
import {
  computeAgentCommissionOn, legacyAgentCommissionOn, setAgentRateOn, ratePeriodsOn, rateHistoryOn,
  paymentBlockOn, mondayOf,
} from "../lib/affiliate/agent-rates";

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
    CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
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
      db.prepare(`INSERT OR IGNORE INTO games (id, name) VALUES (?, ?)`).run(g.gid, g.name);
      // Le taux perçu effectif vu en prod, posé au niveau relation × game (1er niveau de la cascade).
      db.prepare(`INSERT INTO affiliate_relationship_games (relationship_id, game_id, disclosed_action_pct) VALUES (?, ?, ?)`).run(r.id, g.gid, g.eff);
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
  eq("rateHistoryOn(Grobel) : KK et A5", rateHistoryOn(db, 21).map(h => [h.game_name, h.periods.length]), [["KKPOKER", 1], ["A5POKER", 2]]);

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
     [[1, 0, "manual", 1], [5, 0, "manual", 1], [6, 0, "manual", 1], [255, 0, "hors_fenetre", 1], [448, 0, "hors_fenetre", 1], [2539, 0, "hors_fenetre", 1]]);
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

console.log(`\n${passed} ✔  ${failures.length} ✘`);
if (failures.length) { console.log(failures.map(f => "  ✘ " + f).join("\n")); process.exit(1); }
