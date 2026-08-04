/**
 * Harnais de la couche joueurs NEXAPOKER.
 * Run: npx tsx scripts/nexa-players.test.ts
 *
 * ┌─ CE QUE CES TESTS PROUVENT ─────────────────────────────────────────────┐
 * │ Liste, part d'action append-only + son MIROIR dans player_game_deals,   │
 * │ ajout manuel, réconciliation, et le rattrapage rétroactif de            │
 * │ l'historique. Base SQLite réelle : les contraintes SQL sont exercées.   │
 * └─────────────────────────────────────────────────────────────────────────┘
 * ┌─ CE QU'ILS NE PROUVENT PAS ─────────────────────────────────────────────┐
 * │ Que l'appli démarre à froid — schéma pré-fabriqué, cf.                  │
 * │ docs/MIGRATIONS_BASE_VIERGE.md. Ni aucune UI : il n'y a pas de page ici.│
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import fs from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lecercle-nexaplayers-")));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const Database = require(path.join(REPO, "node_modules/better-sqlite3"));

import {
  getNexaPlayersOn, getNexaPlayerWeeksOn, setActionShareOn, getActionSharesOn,
  createNexaPlayerOn, getUnreconciledOn, linkRowToPlayerOn, backfillPlayerIdOn,
  previousWeek, currentWeekMonday,
} from "../lib/funnels/nexa/players";
import { commitWeekOn } from "../lib/funnels/nexa/affiliate-ingest";
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

const SRC = fs.readFileSync(path.join(REPO, "lib/db.ts"), "utf8");
const anchor = SRC.indexOf("const alreadyApplied = db.prepare");
const execStart = SRC.indexOf("db.exec(`", anchor);
const MIGRATION_SQL = SRC.slice(execStart + "db.exec(`".length, SRC.indexOf("`);", execStart + 9));

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE _applied_fixes (name TEXT PRIMARY KEY);
    CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, telegram_handle TEXT);
    CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active', default_action_pct REAL, currency TEXT NOT NULL DEFAULT 'USDT');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- player_id est ajoutée par un ALTER de add_nexa_affiliate_v1 situé HORS du
    -- bloc db.exec extrait ci-dessus : la fixture doit la porter elle-même.
    CREATE TABLE nexa_leads (id INTEGER PRIMARY KEY AUTOINCREMENT, tg_user_id INTEGER NOT NULL UNIQUE,
      member_id TEXT UNIQUE, player_id INTEGER REFERENCES players(id));
    CREATE TABLE manual_settlements (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL, amount_due_usdt REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'locked');
    CREATE TABLE player_game_ids (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL, UNIQUE(game_id, external_id));
    CREATE TABLE player_game_deals (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      action_pct REAL NOT NULL DEFAULT 50, rakeback_pct REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(player_id, game_id));
  `);
  db.exec(MIGRATION_SQL);
  return db;
}

const DEAL = "40% NLH and MTT, 45% PLO, 55% Spins";
const W1 = "2026-07-13", W2 = "2026-07-20", W3 = "2026-07-27";
const row = (o: Partial<RawAffiliateRow>): RawAffiliateRow => ({
  nickname: "LeCercle", member_id: "2231053", deal_text: DEAL,
  nlh: 800, mtt: 200, plo: 400, spins: 100, affiliate_payment: 635, ...o,
});
/** 1200 NLH @40% = 480 — ligne cohérente sans Member ID. */
const noId = (nickname: string): RawAffiliateRow => ({
  nickname, member_id: null, deal_text: DEAL, nlh: 1200, mtt: 0, plo: 0, spins: 0, affiliate_payment: 480,
});
const pgd = (db: any, pid: number) =>
  db.prepare(`SELECT action_pct FROM player_game_deals d JOIN games g ON g.id = d.game_id
              WHERE d.player_id = ? AND g.name = 'NEXAPOKER'`).get(pid) as { action_pct: number } | undefined;

console.log("\n══ Helpers de semaine ══");
eq("previousWeek", previousWeek("2026-07-20"), "2026-07-13");
eq("previousWeek à cheval sur l'année", previousWeek("2027-01-04"), "2026-12-28");
check("currentWeekMonday tombe un lundi",
  new Date(`${currentWeekMonday(new Date("2026-08-05T12:00:00Z"))}T00:00:00Z`).getUTCDay() === 1);
eq("currentWeekMonday d'un mercredi", currentWeekMonday(new Date("2026-08-05T12:00:00Z")), "2026-08-03");
eq("currentWeekMonday d'un lundi = lui-même", currentWeekMonday(new Date("2026-08-03T00:00:00Z")), "2026-08-03");

console.log("\n══ Création manuelle — le cas courant (hors funnel) ══");
{
  const db = freshDb();
  const r = createNexaPlayerOn(db, { nickname: "LeCercle", member_id: "2231053", action_pct: 25 });
  check("créé", r.ok);
  if (!r.ok) { db.close(); }
  else {
    eq("players", db.prepare(`SELECT COUNT(*) n FROM players`).get().n, 1);
    eq("player_game_ids posé", db.prepare(`SELECT external_id e FROM player_game_ids`).get().e, "2231053");
    eq("nexa_nickname_links posé", db.prepare(`SELECT nickname_key k FROM nexa_nickname_links`).get().k, "lecercle");
    eq("part d'action enregistrée", db.prepare(`SELECT pct FROM nexa_player_action_shares`).get().pct, 25);
    eq("MIROIR : player_game_deals aligné", pgd(db, r.player_id)?.action_pct, 25);
    eq("aucun lead (hors funnel)", getNexaPlayersOn(db)[0].lead_id, null);
    db.close();
  }
}
{
  const db = freshDb();
  const r = createNexaPlayerOn(db, { nickname: "ImLePAD" }); // ni ID, ni %
  check("joueur sans Member ID accepté", r.ok);
  if (r.ok) {
    eq("aucun player_game_ids", db.prepare(`SELECT COUNT(*) n FROM player_game_ids`).get().n, 0);
    eq("part par défaut = 0", db.prepare(`SELECT pct FROM nexa_player_action_shares`).get().pct, 0);
    eq("MIROIR à 0 (pas le défaut 50 de la table)", pgd(db, r.player_id)?.action_pct, 0);
  }
  db.close();
}
{
  const db = freshDb();
  createNexaPlayerOn(db, { nickname: "LeCercle", member_id: "2231053" });
  const dup = createNexaPlayerOn(db, { nickname: "Autre", member_id: "2231053" });
  check("Member ID déjà pris → refus explicite", !dup.ok && /déjà rattaché/.test(dup.error));
  const dupNick = createNexaPlayerOn(db, { nickname: "lecercle" });
  check("pseudo déjà pris (casse ignorée) → refus", !dupNick.ok && /déjà rattaché/.test(dupNick.error));
  eq("aucun joueur parasite créé", db.prepare(`SELECT COUNT(*) n FROM players`).get().n, 1);
  db.close();
}

console.log("\n══ Part d'action — append-only ══");
{
  const db = freshDb();
  const p = createNexaPlayerOn(db, { nickname: "LeCercle", member_id: "2231053", action_pct: 25, action_start_week: W1 });
  if (!p.ok) throw new Error(p.error);

  const bump = setActionShareOn(db, { player_id: p.player_id, pct: 40, start_week: W3 });
  check("nouvelle période créée", bump.ok && bump.created);
  if (bump.ok) eq("période précédente fermée au lundi d'avant", bump.closed_previous, W2);

  const hist = getActionSharesOn(db, p.player_id);
  eq("2 périodes conservées", hist.length, 2);
  eq("l'ancienne garde SON pct", hist[1].pct, 25);
  eq("l'ancienne est bornée", [hist[1].start_week, hist[1].end_week], [W1, W2]);
  eq("la nouvelle est ouverte", [hist[0].start_week, hist[0].end_week], [W3, null]);
  eq("MIROIR suit la période courante", pgd(db, p.player_id)?.action_pct, 40);

  const same = setActionShareOn(db, { player_id: p.player_id, pct: 45, start_week: W3 });
  check("même semaine = correction sur place", same.ok && !same.created);
  eq("toujours 2 périodes", getActionSharesOn(db, p.player_id).length, 2);
  eq("pct corrigé", getActionSharesOn(db, p.player_id)[0].pct, 45);
  eq("MIROIR suit la correction", pgd(db, p.player_id)?.action_pct, 45);

  const back = setActionShareOn(db, { player_id: p.player_id, pct: 10, start_week: W1 });
  check("effet ANTÉRIEUR à la période courante → refusé", !back.ok);
  if (!back.ok) check("message explicite", /postérieur|au moins égale/.test(back.error), back.error);
  eq("historique intact après refus", getActionSharesOn(db, p.player_id).length, 2);
  eq("MIROIR intact après refus", pgd(db, p.player_id)?.action_pct, 45);

  check("semaine non-lundi refusée", !setActionShareOn(db, { player_id: p.player_id, pct: 30, start_week: "2026-07-28" }).ok);
  check("pct > 100 refusé", !setActionShareOn(db, { player_id: p.player_id, pct: 150, start_week: W3 }).ok);
  check("joueur inexistant refusé", !setActionShareOn(db, { player_id: 9999, pct: 30, start_week: W3 }).ok);
  db.close();
}

console.log("\n══ Réconciliation + rattrapage rétroactif ══");
{
  const db = freshDb();
  // 3 semaines saisies AVANT que le moindre joueur existe : c'est la situation réelle.
  for (const w of [W1, W2, W3]) {
    const res = commitWeekOn(db, w, [row(), noId("ImLePAD")]);
    if (!res.ok) throw new Error(`${w}: ${res.message}`);
  }
  eq("6 lignes de report", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks`).get().n, 6);
  eq("aucune rattachée", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks WHERE player_id IS NOT NULL`).get().n, 0);

  const un = getUnreconciledOn(db);
  eq("2 clés à réconcilier", un.length, 2);
  const byKey = Object.fromEntries(un.map(u => [u.row_key, u]));
  eq("LeCercle : 3 semaines agrégées", byKey["2231053"].weeks, 3);
  eq("LeCercle : rake cumulé", byKey["2231053"].total_rake, 4500);
  eq("ImLePAD : sans Member ID", byKey["nick:imlepad"].member_id, null);
  eq("aucun hint au départ", un.every(u => u.hint_player_id === null), true);

  // Création depuis une ligne à réconcilier → tout l'historique se rattache.
  const p = createNexaPlayerOn(db, { nickname: "LeCercle", member_id: "2231053", action_pct: 25 });
  check("joueur créé depuis la ligne", p.ok);
  if (p.ok) {
    eq("3 semaines rattrapées rétroactivement", p.backfilled, 3);
    eq("en base", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks WHERE player_id = ?`).get(p.player_id).n, 3);
    eq("il reste 1 clé à réconcilier", getUnreconciledOn(db).length, 1);
    eq("historique visible sur la fiche", getNexaPlayerWeeksOn(db, p.player_id).length, 3);
  }

  // Rattachement d'une ligne SANS ID à un joueur existant.
  const other = createNexaPlayerOn(db, { nickname: "PadLeVrai" });
  if (!other.ok) throw new Error(other.error);
  const link = linkRowToPlayerOn(db, { player_id: other.player_id, member_id: null, nickname: "ImLePAD" });
  check("rattachement par pseudo accepté", link.ok);
  if (link.ok) eq("3 semaines rattrapées", link.backfilled, 3);
  eq("plus rien à réconcilier", getUnreconciledOn(db).length, 0);
  eq("lien pseudo mémorisé pour les imports suivants",
     db.prepare(`SELECT COUNT(*) n FROM nexa_nickname_links WHERE nickname_key = 'imlepad'`).get().n, 1);
  db.close();
}
{
  // Le hint : Member ID inconnu, pseudo déjà lié → proposé, jamais appliqué.
  const db = freshDb();
  const p = createNexaPlayerOn(db, { nickname: "themozz" });
  if (!p.ok) throw new Error(p.error);
  const res = commitWeekOn(db, W1, [row({ nickname: "themozz", member_id: "9999999" })]);
  if (!res.ok) throw new Error(res.message);
  const un = getUnreconciledOn(db);
  eq("la ligne reste à réconcilier", un.length, 1);
  eq("candidat proposé", un[0].hint_player_id, p.player_id);
  eq("nom du candidat affiché", un[0].hint_player_name, "themozz");
  eq("MAIS rien n'est rattaché", db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks WHERE player_id IS NOT NULL`).get().n, 0);
  db.close();
}
{
  // Un rattachement déjà fait ne doit jamais être écrasé par un autre.
  const db = freshDb();
  const a = createNexaPlayerOn(db, { nickname: "Alpha", member_id: "1111111" });
  const b = createNexaPlayerOn(db, { nickname: "Beta" });
  if (!a.ok || !b.ok) throw new Error("setup");
  commitWeekOn(db, W1, [row({ nickname: "Alpha", member_id: "1111111" })]);
  const moved = backfillPlayerIdOn(db, b.player_id, "1111111", null);
  eq("aucune ligne volée à un joueur déjà rattaché", moved, 0);
  eq("la ligne reste chez Alpha",
     db.prepare(`SELECT player_id p FROM nexa_affiliate_weeks`).get().p, a.player_id);
  const steal = linkRowToPlayerOn(db, { player_id: b.player_id, member_id: "1111111", nickname: "Beta" });
  check("Member ID déjà pris par un autre → refus", !steal.ok && /déjà rattaché/.test(steal.error));
  db.close();
}

console.log("\n══ Liste ══");
{
  const db = freshDb();
  const a = createNexaPlayerOn(db, { nickname: "LeCercle", member_id: "2231053", action_pct: 25, telegram_handle: "@lecercle" });
  const b = createNexaPlayerOn(db, { nickname: "ImLePAD" });
  if (!a.ok || !b.ok) throw new Error("setup");
  commitWeekOn(db, W1, [row(), noId("ImLePAD")]);
  commitWeekOn(db, W2, [row()]);

  const list = getNexaPlayersOn(db);
  eq("2 joueurs listés", list.length, 2);
  const lc = list.find(p => p.name === "LeCercle")!;
  const ip = list.find(p => p.name === "ImLePAD")!;
  eq("member_id remonté", lc.member_id, "2231053");
  eq("@ Telegram remonté", lc.telegram_handle, "@lecercle");
  eq("action % courante", lc.action_pct, 25);
  eq("2 semaines", lc.weeks_count, 2);
  eq("rake cumulé", lc.total_rake, 3000);
  eq("commission cumulée", lc.total_commission, 1270);
  eq("joueur sans part enregistrée → 0, pas null", ip.action_pct, 0);
  eq("joueur sans Member ID listé quand même", ip.member_id, null);
  eq("trié par rake décroissant", list[0].name, "LeCercle");
  eq("aucune alerte de recalcul", lc.check_ko, 0);

  // Une semaine écrite avec motif d'écart doit remonter en alerte.
  commitWeekOn(db, W3, [row({ affiliate_payment: 600 })], { overrides: { "2231053": "screenshot incohérent" } });
  eq("semaine hors tolérance comptée", getNexaPlayersOn(db).find(p => p.name === "LeCercle")!.check_ko, 1);
  db.close();
}

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} passés, ${failures.length} échoués`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
if (failures.length) { failures.forEach(f => console.log("   ✘", f)); process.exit(1); }
