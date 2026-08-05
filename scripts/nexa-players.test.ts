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
  previousWeek, currentWeekMonday, addMovementOn, getMovementsOn, deleteMovementOn,
  setRakebackOn, getRakebackPeriodsOn, getNexaRakebackDefaultsOn,
  setWeeklyWinlossOn, clearWeeklyWinlossOn, getWeeklyWinlossOn, getNexaPlayerDetailOn,
} from "../lib/funnels/nexa/players";
import { computeRakeback } from "../lib/funnels/nexa/rakeback-engine";
import { commitWeekOn } from "../lib/funnels/nexa/affiliate-ingest";
import { getLeadAnomaliesOn } from "../lib/funnels/nexa/lead-promotion";
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
      member_id TEXT UNIQUE, player_id INTEGER REFERENCES players(id),
      tg_username TEXT, stage TEXT NOT NULL DEFAULT 'started',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE nexa_lead_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES nexa_leads(id), kind TEXT NOT NULL,
      stage TEXT, payload TEXT, actor TEXT NOT NULL DEFAULT 'bot',
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE manual_settlements (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL, amount_due_usdt REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'locked');
    CREATE TABLE player_game_ids (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL, UNIQUE(game_id, external_id));
    -- Forme PROD relevée sur sqlite_master, triggers compris : les mouvements
    -- manuels doivent être exercés contre les vraies contraintes.
    CREATE TABLE wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      app_id INTEGER, game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
      type TEXT NOT NULL CHECK(type IN ('deposit','withdrawal')),
      amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USDT', note TEXT,
      tron_tx_hash TEXT, tx_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      counterparty_address TEXT, source TEXT DEFAULT 'unknown', tx_datetime TEXT,
      settled INTEGER NOT NULL DEFAULT 0, settlement_id INTEGER);
    CREATE TRIGGER wallet_tx_source_check BEFORE INSERT ON wallet_transactions
      BEGIN
        SELECT RAISE(ABORT, 'wallet_transactions: source must be sync (with tron_tx_hash) or manual')
        WHERE (NEW.source = 'sync' AND (NEW.tron_tx_hash IS NULL OR NEW.tron_tx_hash = ''))
           OR NEW.source NOT IN ('sync', 'manual', 'unknown');
      END;
    CREATE TABLE player_game_deals (id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      action_pct REAL NOT NULL DEFAULT 50, rakeback_pct REAL NOT NULL DEFAULT 0,
      -- start_date/end_date : ajoutées par ALTER dans lib/db.ts, donc hors du bloc de
      -- migration extrait par ce harnais. Sans elles la fixture ment sur le schéma réel
      -- et le miroir ne peut pas être testé.
      start_date TEXT, end_date TEXT,
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
  db.prepare(`SELECT action_pct, start_date FROM player_game_deals d JOIN games g ON g.id = d.game_id
              WHERE d.player_id = ? AND g.name = 'NEXAPOKER'`).get(pid) as
    { action_pct: number; start_date: string | null } | undefined;

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
  // start_date = PREMIÈRE période, pas la dernière : les requêtes d'argent de queries.ts
  // bornent le deal par `start_date IS NULL OR tx_datetime >= start_date`. À NULL la garde
  // ne borne rien ; datée de la dernière modif, elle amputerait l'historique déjà couvert.
  eq("MIROIR daté de la 1re période (garde temporelle armée)", pgd(db, p.player_id)?.start_date, W1);

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

console.log("\n══ Rakeback — append-only, SANS miroir ══");
{
  const db = freshDb();
  const p = createNexaPlayerOn(db, { nickname: "LeCercle", member_id: "2231053", action_pct: 25, action_start_week: W1 });
  if (!p.ok) throw new Error(p.error);

  const first = setRakebackOn(db, {
    player_id: p.player_id, pct: 30, basis: "gross_rake", makeup_carry: "carry", start_week: W1,
  });
  check("1re période créée", first.ok && first.created);
  if (first.ok) eq("rien à fermer", first.closed_previous, null);

  const bump = setRakebackOn(db, {
    player_id: p.player_id, pct: 40, basis: "affiliate_commission", makeup_carry: "reset", start_week: W3,
  });
  check("nouvelle période créée", bump.ok && bump.created);
  if (bump.ok) eq("période précédente fermée au lundi d'avant", bump.closed_previous, W2);

  const hist = getRakebackPeriodsOn(db, p.player_id);
  eq("2 périodes conservées", hist.length, 2);
  eq("l'ancienne garde SON pct et SA base", [hist[1].pct, hist[1].basis], [30, "gross_rake"]);
  eq("l'ancienne est bornée", [hist[1].start_week, hist[1].end_week], [W1, W2]);
  eq("la nouvelle est ouverte", [hist[0].start_week, hist[0].end_week], [W3, null]);
  eq("makeup_carry mémorisé par période", [hist[1].makeup_carry, hist[0].makeup_carry], ["carry", "reset"]);

  // Le point qui distingue le rakeback de la part d'action : AUCUN miroir.
  // player_game_deals.rakeback_pct doit rester à 0, comme avant l'ajout.
  const deal = db.prepare(`SELECT rakeback_pct FROM player_game_deals d JOIN games g ON g.id = d.game_id
                           WHERE d.player_id = ? AND g.name = 'NEXAPOKER'`).get(p.player_id) as { rakeback_pct: number };
  eq("PAS de miroir : player_game_deals.rakeback_pct reste 0", deal.rakeback_pct, 0);

  const same = setRakebackOn(db, {
    player_id: p.player_id, pct: 45, basis: "gross_rake", makeup_carry: "carry", start_week: W3,
  });
  check("même semaine = correction sur place", same.ok && !same.created);
  eq("toujours 2 périodes", getRakebackPeriodsOn(db, p.player_id).length, 2);
  eq("pct, base et carry corrigés ensemble",
     [getRakebackPeriodsOn(db, p.player_id)[0].pct,
      getRakebackPeriodsOn(db, p.player_id)[0].basis,
      getRakebackPeriodsOn(db, p.player_id)[0].makeup_carry],
     [45, "gross_rake", "carry"]);

  const back = setRakebackOn(db, {
    player_id: p.player_id, pct: 10, basis: "gross_rake", makeup_carry: "carry", start_week: W1,
  });
  check("effet ANTÉRIEUR à la période courante → refusé", !back.ok);
  if (!back.ok) check("message explicite", /postérieur|au moins égale/.test(back.error), back.error);
  eq("historique intact après refus", getRakebackPeriodsOn(db, p.player_id).length, 2);

  const bad = (o: any) => setRakebackOn(db, {
    player_id: p.player_id, pct: 30, basis: "gross_rake", makeup_carry: "carry", start_week: W3, ...o,
  });
  check("semaine non-lundi refusée", !bad({ start_week: "2026-07-28" }).ok);
  check("pct > 100 refusé", !bad({ pct: 150 }).ok);
  check("pct négatif refusé", !bad({ pct: -1 }).ok);
  check("base inconnue refusée", !bad({ basis: "net_rake" }).ok);
  check("makeup_carry inconnu refusé", !bad({ makeup_carry: "maybe" }).ok);
  check("joueur inexistant refusé", !setRakebackOn(db, {
    player_id: 9999, pct: 30, basis: "gross_rake", makeup_carry: "carry", start_week: W3,
  }).ok);
  eq("aucun refus n'a écrit", getRakebackPeriodsOn(db, p.player_id).length, 2);
  db.close();
}

console.log("\n══ Rakeback — défauts globaux (settings) ══");
{
  const db = freshDb();
  // La fixture ne seed PAS les settings (ils sont posés hors du bloc de migration) :
  // c'est exactement le cas « réglage absent », qui doit retomber sur 0 %.
  eq("settings absents → 0 % / commission",
     [getNexaRakebackDefaultsOn(db).defaultPct, getNexaRakebackDefaultsOn(db).defaultBasis],
     [0, "affiliate_commission"]);

  const set = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
  set.run("nexa_default_rakeback_pct", "35");
  set.run("nexa_default_rakeback_basis", "gross_rake");
  eq("settings lus", [getNexaRakebackDefaultsOn(db).defaultPct, getNexaRakebackDefaultsOn(db).defaultBasis],
     [35, "gross_rake"]);

  // Un réglage illisible ne doit JAMAIS produire un pourcentage inventé.
  set.run("nexa_default_rakeback_pct", "beaucoup");
  set.run("nexa_default_rakeback_basis", "net_rake");
  eq("réglage illisible → repli sûr",
     [getNexaRakebackDefaultsOn(db).defaultPct, getNexaRakebackDefaultsOn(db).defaultBasis],
     [0, "affiliate_commission"]);
  set.run("nexa_default_rakeback_pct", "150");
  eq("pct hors bornes → repli sûr", getNexaRakebackDefaultsOn(db).defaultPct, 0);
  db.close();
}

console.log("\n══ Rakeback — ce que la liste affiche ══");
{
  const db = freshDb();
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run("nexa_default_rakeback_pct", "12");
  const p = createNexaPlayerOn(db, { nickname: "LeCercle", member_id: "2231053", action_pct: 25, action_start_week: W1 });
  if (!p.ok) throw new Error(p.error);

  const before = getNexaPlayersOn(db)[0];
  eq("sans période : le défaut settings s'affiche", before.rakeback_pct, 12);
  eq("base par défaut", before.rakeback_basis, "affiliate_commission");
  eq("aucune période enregistrée", before.rakeback_since, null);
  check("marqué comme défaut", before.rakeback_is_default);

  setRakebackOn(db, { player_id: p.player_id, pct: 40, basis: "gross_rake", makeup_carry: "carry", start_week: W1 });
  const after = getNexaPlayersOn(db)[0];
  eq("après saisie : le % du joueur", after.rakeback_pct, 40);
  eq("sa base", after.rakeback_basis, "gross_rake");
  eq("depuis quand", after.rakeback_since, W1);
  check("ce n'est plus un défaut", !after.rakeback_is_default);

  // La liste ne montre QUE la période en cours, jamais la période close.
  setRakebackOn(db, { player_id: p.player_id, pct: 50, basis: "gross_rake", makeup_carry: "carry", start_week: W3 });
  const latest = getNexaPlayersOn(db)[0];
  eq("période courante uniquement", [latest.rakeback_pct, latest.rakeback_since], [50, W3]);
  db.close();
}

console.log("\n══ Rakeback — les périodes lues pilotent vraiment le moteur ══");
{
  const db = freshDb();
  const p = createNexaPlayerOn(db, { nickname: "ImLePAD", action_pct: 50, action_start_week: W1 });
  if (!p.ok) throw new Error(p.error);
  setRakebackOn(db, { player_id: p.player_id, pct: 40, basis: "gross_rake", makeup_carry: "carry", start_week: W1 });

  // Chaîne réelle d'ImLePAD, rejouée avec les périodes SORTIES DE LA BASE : c'est
  // le contrat entre la couche données et le moteur qui est vérifié ici.
  const r = computeRakeback(
    [
      { week_start: W1, gross_rake: 0, affiliate_commission: 0, check_ok: true, winloss: null },
      { week_start: W2, gross_rake: -41.4, affiliate_commission: -15.26, check_ok: true, winloss: null },
      { week_start: W3, gross_rake: 296.12, affiliate_commission: 119.44, check_ok: true, winloss: null },
    ],
    getRakebackPeriodsOn(db, p.player_id),
    [],
    getNexaRakebackDefaultsOn(db),
  );
  eq("la base du moteur vient de la période enregistrée", r.weeks[2].basis, "gross_rake");
  eq("le pct aussi", r.weeks[2].rakeback_pct, 40);
  check("makeup reporté sur l'assiette", Math.abs(r.weeks[2].base_net - 254.72) < 1e-9);
  check("dû = 101.888", Math.abs(r.weeks[2].due - 101.888) < 1e-9);
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

console.log("\n══ Buy-in / cash-out ══");
{
  const db = freshDb();
  const p = createNexaPlayerOn(db, { nickname: "LeCercle", member_id: "2231053", action_pct: 25 });
  if (!p.ok) throw new Error(p.error);
  const pid = p.player_id;

  const bi = addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 500, tx_date: "2026-08-03", note: "virement" });
  check("buy-in enregistré", bi.ok);
  const co = addMovementOn(db, { player_id: pid, kind: "cash_out", amount: 200, tx_date: "2026-08-04" });
  check("cash-out enregistré", co.ok);

  const w = db.prepare(`SELECT type, amount, source, currency, note, game_id FROM wallet_transactions ORDER BY id`).all();
  eq("buy-in = deposit", w[0].type, "deposit");
  eq("cash-out = withdrawal", w[1].type, "withdrawal");
  eq("source = manual (jamais 'unknown', invariant #10)", [w[0].source, w[1].source], ["manual", "manual"]);
  eq("devise USDT", w[0].currency, "USDT");
  eq("note conservée", w[0].note, "virement");
  eq("rattaché au game NEXAPOKER",
     w[0].game_id, db.prepare(`SELECT id FROM games WHERE name='NEXAPOKER'`).get().id);

  const list = getNexaPlayersOn(db).find(x => x.player_id === pid)!;
  eq("cumul buy-ins", list.deposited, 500);
  eq("cumul cash-outs", list.withdrawn, 200);
  eq("net = retraits − dépôts", list.net_movements, -300);

  const hist = getMovementsOn(db, pid);
  eq("2 mouvements dans l'historique", hist.length, 2);
  eq("plus récent en tête", hist[0].tx_date, "2026-08-04");

  check("montant négatif refusé", !addMovementOn(db, { player_id: pid, kind: "buy_in", amount: -50, tx_date: "2026-08-03" }).ok);
  check("montant nul refusé", !addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 0, tx_date: "2026-08-03" }).ok);
  check("date invalide refusée", !addMovementOn(db, { player_id: pid, kind: "buy_in", amount: 10, tx_date: "03/08/2026" }).ok);
  check("joueur inexistant refusé", !addMovementOn(db, { player_id: 9999, kind: "buy_in", amount: 10, tx_date: "2026-08-03" }).ok);
  eq("aucun mouvement parasite après les refus", getMovementsOn(db, pid).length, 2);

  const del = deleteMovementOn(db, hist[0].id);
  check("suppression d'un mouvement non réglé", del.ok);
  eq("1 mouvement restant", getMovementsOn(db, pid).length, 1);

  db.prepare(`UPDATE wallet_transactions SET settled = 1, settlement_id = 42 WHERE id = ?`).run(hist[1].id);
  const del2 = deleteMovementOn(db, hist[1].id);
  check("mouvement déjà réglé → suppression refusée", !del2.ok && /règlement/.test(del2.error));
  eq("il est toujours là", getMovementsOn(db, pid).length, 1);

  // Le trigger de la table doit rejeter tout ce qui n'est ni sync ni manual.
  let trig = false;
  try { db.prepare(`INSERT INTO wallet_transactions (player_id, game_id, type, amount, tx_date, source)
                    VALUES (?, 1, 'deposit', 10, '2026-08-03', 'bidon')`).run(pid); }
  catch (e: any) { trig = /source must be/.test(e.message); }
  check("trigger wallet_tx_source_check actif sur cette base de test", trig);

  // Corrections issues de l'audit money-auditor.
  db.prepare(`INSERT INTO wallet_transactions (player_id, game_id, type, amount, currency, tx_date, source, tron_tx_hash)
              VALUES (?, (SELECT id FROM games WHERE name='NEXAPOKER'), 'withdrawal', 999, 'USDT', '2026-08-05', 'sync', '0xabc')`).run(pid);
  check("une ligne 'sync' n'apparaît PAS dans l'historique des mouvements",
        getMovementsOn(db, pid).every(m => m.amount !== 999));
  const syncId = db.prepare(`SELECT id FROM wallet_transactions WHERE source='sync'`).get().id;
  const delSync = deleteMovementOn(db, syncId);
  check("une ligne 'sync' n'est PAS supprimable depuis cet écran", !delSync.ok);
  eq("elle est toujours en base",
     db.prepare(`SELECT COUNT(*) n FROM wallet_transactions WHERE source='sync'`).get().n, 1);

  db.prepare(`INSERT INTO wallet_transactions (player_id, game_id, type, amount, currency, tx_date, source)
              VALUES (?, (SELECT id FROM games WHERE name='NEXAPOKER'), 'deposit', 777, 'EUR', '2026-08-05', 'manual')`).run(pid);
  eq("une devise autre que USDT n'entre pas dans les cumuls (invariant #3)",
     getNexaPlayersOn(db).find(x => x.player_id === pid)!.deposited, 500);

  eq("l'import ne touche pas aux mouvements : rake inchangé",
     getNexaPlayersOn(db).find(x => x.player_id === pid)!.total_rake, 0);
  db.close();
}

console.log("\n══ Point 5 — promotion des leads depuis le report ══");
const gid = (db: any) => db.prepare(`SELECT id FROM games WHERE name='NEXAPOKER'`).get().id;
const lead = (db: any, tg: number, member: string | null, stage = "account_created") =>
  Number(db.prepare(`INSERT INTO nexa_leads (tg_user_id, member_id, tg_username, stage) VALUES (?,?,?,?)`)
    .run(tg, member, `user${tg}`, stage).lastInsertRowid);
{
  // Cas 1 — lead sans joueur, ID confirmé par le report → création + lien + stage.
  const db = freshDb();
  const lid = lead(db, 7001, "2231053");
  const res = commitWeekOn(db, W1, [row()]);
  check("semaine écrite", res.ok);
  if (res.ok) {
    eq("1 joueur créé", res.promotions.created, 1);
    eq("1 lead promu", res.promotions.promoted, 1);
    eq("aucune anomalie", res.promotions.anomalies.length, 0);
  }
  const l = db.prepare(`SELECT player_id, stage FROM nexa_leads WHERE id=?`).get(lid);
  check("lead lié à un joueur", l.player_id !== null);
  eq("stage = played (rake > 0 sur la ligne)", l.stage, "played");
  const p = db.prepare(`SELECT name FROM players WHERE id=?`).get(l.player_id);
  eq("name = pseudo du REPORT, pas le prénom Telegram", p.name, "LeCercle");
  eq("player_game_ids posé", db.prepare(`SELECT external_id e FROM player_game_ids`).get().e, "2231053");
  eq("PAS de nexa_nickname_links (l'ID suffit)", db.prepare(`SELECT COUNT(*) n FROM nexa_nickname_links`).get().n, 0);
  eq("PAS de part d'action créée", db.prepare(`SELECT COUNT(*) n FROM nexa_player_action_shares`).get().n, 0);
  eq("événement tracé actor='import'",
     db.prepare(`SELECT actor FROM nexa_lead_events WHERE lead_id=?`).get(lid).actor, "import");
  eq("la ligne du report est rattachée",
     db.prepare(`SELECT COUNT(*) n FROM nexa_affiliate_weeks WHERE player_id IS NOT NULL`).get().n, 1);
  db.close();
}
{
  // Rake nul → room_verified seulement, et jamais à reculons.
  const db = freshDb();
  const lid = lead(db, 7002, "9990001");
  commitWeekOn(db, W1, [row({ nickname: "Zero", member_id: "9990001", nlh: 0, mtt: 0, plo: 0, spins: 0, affiliate_payment: 0 })]);
  eq("rake nul → room_verified", db.prepare(`SELECT stage FROM nexa_leads WHERE id=?`).get(lid).stage, "room_verified");
  const before = db.prepare(`SELECT stage FROM nexa_leads WHERE id=?`).get(lid).stage;
  commitWeekOn(db, W2, [row({ nickname: "Zero", member_id: "9990001", nlh: 0, mtt: 0, plo: 0, spins: 0, affiliate_payment: 0 })]);
  eq("le stage ne recule jamais", db.prepare(`SELECT stage FROM nexa_leads WHERE id=?`).get(lid).stage, before);
  db.close();
}
{
  // Cas 3 — joueur préexistant porte l'ID, lead non lié → lien seul, AUCUNE création.
  const db = freshDb();
  const p = createNexaPlayerOn(db, { nickname: "LeCercle", member_id: "2231053", action_pct: 25 });
  if (!p.ok) throw new Error(p.error);
  const lid = lead(db, 7003, "2231053");
  const before = db.prepare(`SELECT COUNT(*) n FROM players`).get().n;
  const res = commitWeekOn(db, W1, [row()]);
  if (res.ok) {
    eq("aucune création", res.promotions.created, 0);
    eq("1 rattachement", res.promotions.linked, 1);
  }
  eq("aucun joueur en plus", db.prepare(`SELECT COUNT(*) n FROM players`).get().n, before);
  eq("lead lié au joueur existant", db.prepare(`SELECT player_id FROM nexa_leads WHERE id=?`).get(lid).player_id, p.player_id);
  eq("part d'action intacte", db.prepare(`SELECT pct FROM nexa_player_action_shares`).get().pct, 25);
  db.close();
}
{
  // Cas 4 — deux leads pour un joueur : on ne touche à RIEN.
  const db = freshDb();
  const p = createNexaPlayerOn(db, { nickname: "LeCercle", member_id: "2231053" });
  if (!p.ok) throw new Error(p.error);
  const first = lead(db, 7004, null);
  db.prepare(`UPDATE nexa_leads SET player_id=? WHERE id=?`).run(p.player_id, first);
  const second = lead(db, 7005, "2231053");
  const res = commitWeekOn(db, W1, [row()]);
  if (res.ok) {
    eq("aucune création ni rattachement", [res.promotions.created, res.promotions.linked], [0, 0]);
    eq("1 anomalie remontée", res.promotions.anomalies.length, 1);
    eq("les deux leads sont nommés",
       [res.promotions.anomalies[0].lead_id, res.promotions.anomalies[0].other_lead_id], [second, first]);
  }
  eq("le 2e lead reste NON lié", db.prepare(`SELECT player_id FROM nexa_leads WHERE id=?`).get(second).player_id, null);
  eq("le 1er lead n'a pas bougé", db.prepare(`SELECT player_id FROM nexa_leads WHERE id=?`).get(first).player_id, p.player_id);
  const anom = getLeadAnomaliesOn(db, gid(db));
  eq("l'anomalie est visible pour la réconciliation", anom.length, 1);
  eq("avec le nom du joueur", anom[0].player_name, "LeCercle");
  db.close();
}
{
  // Cas 5 — aucune création sans Member ID, et aucun ID inconnu ne crée personne.
  const db = freshDb();
  const res = commitWeekOn(db, W1, [noId("ImLePAD"), row({ member_id: "0000000" })]);
  if (res.ok) eq("aucune création", [res.promotions.created, res.promotions.promoted, res.promotions.linked], [0, 0, 0]);
  eq("aucun joueur créé", db.prepare(`SELECT COUNT(*) n FROM players`).get().n, 0);
  eq("les 2 lignes restent à réconcilier", getUnreconciledOn(db).length, 2);
  db.close();
}
{
  // ZÉRO message Telegram : le module de promotion ne doit importer aucun réseau.
  const src = fs.readFileSync(path.join(REPO, "lib/funnels/nexa/lead-promotion.ts"), "utf8");
  // On teste les IMPORTS, pas le texte : le fichier PARLE de sendMsg dans son
  // encadré pour interdire son ajout, ce qui est voulu.
  const importsOf = (code: string) => code.split("\n").filter(l => /^\s*import\b/.test(l)).join("\n");
  check("lead-promotion n'importe ni sendMsg ni telegram-api",
        !/sendMsg|telegram-api|telegram-commands/.test(importsOf(src)));
  const ing = fs.readFileSync(path.join(REPO, "lib/funnels/nexa/affiliate-ingest.ts"), "utf8");
  check("affiliate-ingest non plus", !/sendMsg|telegram-api/.test(importsOf(ing)));
}

console.log("\n══ Win/loss hebdo — saisie, correction, dé-saisie ══");
{
  const db = freshDb();
  const p = createNexaPlayerOn(db, { nickname: "ImLePAD", action_pct: 50, action_start_week: W1 });
  if (!p.ok) throw new Error(p.error);

  check("saisie acceptée", setWeeklyWinlossOn(db, { player_id: p.player_id, week_start: W2, amount: 1000 }).ok);
  eq("montant en base", getWeeklyWinlossOn(db, p.player_id).get(W2), 1000);

  // UPSERT : corriger une semaine ne crée pas de doublon (UNIQUE player_id, week_start).
  check("correction sur place", setWeeklyWinlossOn(db, { player_id: p.player_id, week_start: W2, amount: -600 }).ok);
  eq("montant corrigé", getWeeklyWinlossOn(db, p.player_id).get(W2), -600);
  eq("une seule ligne", (db.prepare(`SELECT COUNT(*) c FROM nexa_player_weekly_winloss WHERE player_id = ?`)
                          .get(p.player_id) as any).c, 1);

  // ZÉRO SAISI ≠ NON SAISI. C'est toute la doctrine du moteur.
  check("zéro est une saisie valide", setWeeklyWinlossOn(db, { player_id: p.player_id, week_start: W3, amount: 0 }).ok);
  check("W3 est présent dans la Map", getWeeklyWinlossOn(db, p.player_id).has(W3));
  eq("et vaut 0", getWeeklyWinlossOn(db, p.player_id).get(W3), 0);

  clearWeeklyWinlossOn(db, p.player_id, W3);
  check("après retrait, W3 n'est plus dans la Map", !getWeeklyWinlossOn(db, p.player_id).has(W3));

  check("semaine non-lundi refusée", !setWeeklyWinlossOn(db, { player_id: p.player_id, week_start: "2026-07-28", amount: 10 }).ok);
  check("montant non fini refusé", !setWeeklyWinlossOn(db, { player_id: p.player_id, week_start: W2, amount: NaN }).ok);
  check("joueur inexistant refusé", !setWeeklyWinlossOn(db, { player_id: 9999, week_start: W2, amount: 10 }).ok);
  eq("aucun refus n'a écrit", (db.prepare(`SELECT COUNT(*) c FROM nexa_player_weekly_winloss`).get() as any).c, 1);
  db.close();
}

console.log("\n══ Vue détail joueur — le moteur branché sur la base ══");
{
  const db = freshDb();
  const p = createNexaPlayerOn(db, { nickname: "ImLePAD", member_id: "2231053", action_pct: 50, action_start_week: W1 });
  if (!p.ok) throw new Error(p.error);
  setRakebackOn(db, { player_id: p.player_id, pct: 40, basis: "gross_rake", makeup_carry: "carry", start_week: W1 });

  // Chaîne réelle d'ImLePAD : 07-20 rake négatif, 07-27 positif.
  commitWeekOn(db, W2, [{ nickname: "ImLePAD", member_id: "2231053", deal_text: DEAL,
    nlh: -61.46, mtt: 0, plo: 17.05, spins: 3.01, affiliate_payment: -15.26 }]);
  commitWeekOn(db, W3, [{ nickname: "ImLePAD", member_id: "2231053", deal_text: DEAL,
    nlh: 288.87, mtt: 0, plo: 1, spins: 6.25, affiliate_payment: 119.44 }]);

  const d0 = getNexaPlayerDetailOn(db, p.player_id)!;
  eq("2 semaines rejouées", d0.weeks.length, 2);
  check("makeup reporté sur l'assiette", Math.abs(d0.weeks[1].base_net - 254.72) < 1e-9);
  check("dû = 254.72 × 40 %", Math.abs(d0.weeks[1].due - 101.888) < 1e-9);

  // Aucun win/loss saisi : la part d'action et la position nette sont INCALCULABLES,
  // pas nulles. C'est ce que l'écran doit montrer.
  eq("action de la semaine : null", d0.weeks[1].action_amount, null);
  eq("total action : null", d0.totals.action_amount, null);
  eq("position nette : null", d0.net_position, null);
  eq("compteur de semaines manquantes", d0.totals.weeks_missing_winloss, 2);

  setWeeklyWinlossOn(db, { player_id: p.player_id, week_start: W2, amount: -600 });
  setWeeklyWinlossOn(db, { player_id: p.player_id, week_start: W3, amount: 1000 });
  const d1 = getNexaPlayerDetailOn(db, p.player_id)!;
  eq("action W2 (−600 × 50 %)", d1.weeks[0].action_amount, -300);
  eq("action W3 (1000 × 50 %)", d1.weeks[1].action_amount, 500);
  eq("total action", d1.totals.action_amount, 200);
  eq("plus aucune semaine manquante", d1.totals.weeks_missing_winloss, 0);

  // Position nette = action + net des mouvements, MÊME convention de signe
  // (positif = le joueur doit au Cercle). Sans mouvement, elle vaut l'action.
  eq("net mouvements à vide", d1.net_movements, 0);
  eq("position nette = action seule", d1.net_position, 200);

  // Un buy-in de 300 : le Cercle détient 300 de plus → la position baisse d'autant.
  addMovementOn(db, { player_id: p.player_id, kind: "buy_in", amount: 300, tx_date: "2026-07-28" });
  const d2 = getNexaPlayerDetailOn(db, p.player_id)!;
  eq("buy-in enregistré", d2.deposited, 300);
  eq("net mouvements", d2.net_movements, -300);
  eq("position nette (200 − 300)", d2.net_position, -100);

  // Le rakeback ne se règle pas et n'entre pas dans la position — il reste calculé.
  check("le dû rakeback reste exposé", d2.totals.due > 0);
  eq("joueur inconnu → null", getNexaPlayerDetailOn(db, 9999), null);
  db.close();
}

console.log("\n══ Vue détail — une semaine en échec de contrôle ══");
{
  const db = freshDb();
  const p = createNexaPlayerOn(db, { nickname: "LeCercle", member_id: "2231053", action_pct: 50, action_start_week: W1 });
  if (!p.ok) throw new Error(p.error);
  // affiliate_payment incohérent avec le deal. Sans motif la ligne est REJETÉE ;
  // avec un motif explicite elle est écrite avec check_ok = 0 — c'est ce cas-là qui
  // nous intéresse, celui d'un écart accepté en connaissance de cause.
  commitWeekOn(db, W2, [{ nickname: "LeCercle", member_id: "2231053", deal_text: DEAL,
    nlh: 1000, mtt: 0, plo: 0, spins: 0, affiliate_payment: 999 }],
    { overrides: { "2231053": "arrondi NEXA, écart accepté" } });
  commitWeekOn(db, W3, [row({ nlh: 1000, mtt: 0, plo: 0, spins: 0, affiliate_payment: 400 })]);
  setWeeklyWinlossOn(db, { player_id: p.player_id, week_start: W2, amount: 200 });
  setWeeklyWinlossOn(db, { player_id: p.player_id, week_start: W3, amount: 200 });

  const d = getNexaPlayerDetailOn(db, p.player_id)!;
  const blocked = d.weeks.filter(w => w.status === "blocked");
  check("la semaine incohérente est hors calcul", blocked.length === 1 && blocked[0].week_start === W2);
  eq("elle est chiffrée à part", d.blocked_weeks.count, 1);
  // Flux indépendant : le win/loss saisi reste valable même sur une semaine bloquée.
  eq("part d'action calculée quand même", blocked[0].action_amount, 100);
  // Mais elle n'entre pas dans les totaux, qui gardent un périmètre unique.
  eq("total action = semaines ok seulement", d.totals.action_amount, 100);
  db.close();
}

// ══ Garde-fou NEXAPOKER sur player_game_deals — NON TESTÉ ICI, volontairement ══
//
// upsertPlayerGameDeal / deletePlayerGameDeal (lib/queries.ts) portent la garde, mais
// sont liées à getDb(), dont le DB_PATH est calculé au chargement du module et ne suit
// PAS le process.chdir() de ce harnais. Les exercer ici écrit dans la vraie
// data/lecercle.db — constaté, puis nettoyé. Un test qui pollue la base de travail est
// pire que pas de test.
//
// La garde est vérifiée de bout en bout par HTTP sur le serveur de dev :
//   PATCH  /api/games/deals/<id nexa>  -> 409, aucune écriture
//   DELETE /api/games/deals/<id nexa>  -> 409, aucune écriture
//   POST   /api/games/deals {game_id: nexa} -> 409, aucune écriture
// Pour la couvrir en unitaire il faudrait donner à ces deux fonctions une forme
// `xOn(db, …)`, comme le reste des modules NEXA. À faire si on y retouche.

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} passés, ${failures.length} échoués`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
if (failures.length) { failures.forEach(f => console.log("   ✘", f)); process.exit(1); }
