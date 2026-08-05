/**
 * Mesure de volumétrie du tableau de bord NEXAPOKER.
 * Run: npx tsx scripts/nexa-dashboard-bench.ts
 *
 * Question posée : à partir de combien de joueurs × semaines le rendu de
 * /nexapoker (page `force-dynamic`, donc recalculée à CHAQUE affichage) devient-il
 * un problème ? getNexaDashboardOn rejoue la chaîne complète de chaque joueur à
 * chaque rendu, sans cache.
 *
 * Base SQLite RÉELLE en mémoire, schéma extrait de lib/db.ts — mêmes requêtes,
 * mêmes index, mêmes contraintes que la prod. Ce n'est pas une simulation du coût,
 * c'est le coût.
 */

import fs from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lecercle-bench-")));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const Database = require(path.join(REPO, "node_modules/better-sqlite3"));

import { getNexaDashboardOn } from "../lib/funnels/nexa/dashboard";

const SRC = fs.readFileSync(path.join(REPO, "lib/db.ts"), "utf8");
const anchor = SRC.indexOf("const alreadyApplied = db.prepare");
const execStart = SRC.indexOf("db.exec(`", anchor);
const MIGRATION_SQL = SRC.slice(execStart + "db.exec(`".length, SRC.indexOf("`);", execStart + 9));
const SETTLE_START = SRC.indexOf("CREATE TABLE IF NOT EXISTS nexa_action_settlement_weeks");
const SETTLE_SQL = SRC.slice(SETTLE_START, SRC.indexOf("`);", SETTLE_START));

function build(nPlayers: number, nWeeks: number) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE _applied_fixes (name TEXT PRIMARY KEY);
    CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, telegram_handle TEXT);
    CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active', default_action_pct REAL, currency TEXT NOT NULL DEFAULT 'USDT');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE nexa_leads (id INTEGER PRIMARY KEY AUTOINCREMENT, tg_user_id INTEGER NOT NULL UNIQUE,
      member_id TEXT UNIQUE, player_id INTEGER REFERENCES players(id), tg_username TEXT,
      stage TEXT NOT NULL DEFAULT 'started', updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE player_game_ids (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL, UNIQUE(game_id, external_id));
    CREATE TABLE wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL REFERENCES players(id),
      app_id INTEGER, game_id INTEGER REFERENCES games(id), type TEXT NOT NULL,
      amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USDT', note TEXT,
      tron_tx_hash TEXT, tx_date TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      counterparty_address TEXT, source TEXT DEFAULT 'manual', tx_datetime TEXT,
      settled INTEGER NOT NULL DEFAULT 0, settlement_id INTEGER);
    CREATE TABLE player_game_deals (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id), game_id INTEGER NOT NULL REFERENCES games(id),
      action_pct REAL NOT NULL DEFAULT 50, rakeback_pct REAL NOT NULL DEFAULT 0,
      start_date TEXT, end_date TEXT);
  `);
  db.exec(MIGRATION_SQL);
  db.exec(SETTLE_SQL);

  const gid = (db.prepare(`SELECT id FROM games WHERE name = 'NEXAPOKER'`).get() as any)?.id
    ?? (db.prepare(`INSERT INTO games (name) VALUES ('NEXAPOKER')`).run(),
        (db.prepare(`SELECT id FROM games WHERE name = 'NEXAPOKER'`).get() as any).id);

  const insPlayer = db.prepare(`INSERT INTO players (name) VALUES (?)`);
  const insGid = db.prepare(`INSERT INTO player_game_ids (player_id, game_id, external_id) VALUES (?,?,?)`);
  // check_ok est une colonne GÉNÉRÉE (ABS(check_delta) <= 0.02) : on ne l'écrit pas,
  // on met check_delta à 0 pour que toutes les semaines soient saines.
  const insWeek = db.prepare(`INSERT INTO nexa_affiliate_weeks
    (week_start, member_id, nickname, nickname_key, player_id, nlh, mtt, plo, spins,
     rate_nlh, rate_mtt, rate_plo, rate_spins,
     affiliate_payment, affiliate_payment_recomputed, check_delta, deal_text)
    VALUES (?,?,?,?,?,?,?,?,?, 40,40,40,40, ?,?,0,?)`);
  const insWl = db.prepare(`INSERT INTO nexa_player_weekly_winloss (player_id, week_start, amount) VALUES (?,?,?)`);
  const insAct = db.prepare(`INSERT INTO nexa_player_action_shares (player_id, pct, start_week) VALUES (?,?,?)`);
  const insRb = db.prepare(`INSERT INTO nexa_player_rakeback (player_id, pct, basis, start_week) VALUES (?,?,?,?)`);

  const weeks: string[] = [];
  for (let w = 0; w < nWeeks; w++) {
    const d = new Date(Date.UTC(2025, 0, 6) + w * 7 * 86400000);
    weeks.push(d.toISOString().slice(0, 10));
  }

  db.transaction(() => {
    for (let i = 1; i <= nPlayers; i++) {
      const pid = insPlayer.run(`Joueur ${i}`).lastInsertRowid as number;
      insGid.run(pid, gid, `MID${i}`);
      insAct.run(pid, 50, weeks[0]);
      insRb.run(pid, 40, "affiliate_commission", weeks[0]);
      for (let w = 0; w < nWeeks; w++) {
        const rake = 100 + ((i * 7 + w * 13) % 900);
        insWeek.run(weeks[w], `MID${i}`, `nick${i}`, `nick${i}`, pid,
                    rake, 0, 0, 0, rake * 0.4, rake * 0.4, "40%");
        // Un win/loss sur deux : le cas réaliste (grille partiellement remplie).
        if (w % 2 === 0) insWl.run(pid, weeks[w], ((i + w) % 11 - 5) * 100);
      }
    }
  })();
  return db;
}

function bench(nPlayers: number, nWeeks: number) {
  const db = build(nPlayers, nWeeks);
  // Un tour à blanc : on mesure le régime établi, pas le premier accès.
  getNexaDashboardOn(db, { from: null, to: null });
  const runs = 5;
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    const d = getNexaDashboardOn(db, { from: null, to: null });
    const t1 = process.hrtime.bigint();
    t.push(Number(t1 - t0) / 1e6);
    if (i === 0) {
      console.log(`   (contrôle : ${d.players.length} joueurs, ${d.weeks.length} semaines, ` +
                  `commission ${d.totals.commission.toFixed(0)})`);
    }
  }
  t.sort((a, b) => a - b);
  const med = t[Math.floor(runs / 2)];
  db.close();
  return { med, min: t[0], max: t[runs - 1] };
}

console.log("Rendu complet de /nexapoker — getNexaDashboardOn, lifetime, base réelle\n");
const cas: [number, number][] = [[8, 3], [8, 40], [25, 40], [50, 40], [100, 40], [50, 104]];
for (const [p, w] of cas) {
  const r = bench(p, w);
  const lignes = p * w;
  console.log(`${String(p).padStart(4)} joueurs × ${String(w).padStart(3)} semaines ` +
              `(${String(lignes).padStart(5)} lignes) → médiane ${r.med.toFixed(1).padStart(7)} ms  ` +
              `[min ${r.min.toFixed(1)} / max ${r.max.toFixed(1)}]`);
}
console.log("\nRepère : au-delà de ~300 ms par rendu, la page devient perceptiblement lente ;");
console.log("au-delà de ~1 s, il faut un cache (unstable_cache ou un agrégat matérialisé).");
