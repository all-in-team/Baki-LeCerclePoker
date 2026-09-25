// Chantier Joueurs — les deux verrous de l'archive (Baki 2026-09-25).
// Run: npx tsx scripts/players-archive-guard.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ Règle qui ne se négocie pas : un joueur qui a quelque chose à régler ou un │
// │ solde non nul ne disparaît JAMAIS de la vue principale de /players.        │
// │  (a) le moteur refuse d'archiver un joueur ouvert (erreur explicite, le lot│
// │      entier est refusé) ;                                                  │
// │  (b) vue principale = non archivé OU ouvert : un archivé qui s'ouvre après │
// │      coup (dépôt entrant) réapparaît ; si l'état ne se calcule pas, tout le│
// │      monde est affiché (fail-closed).                                      │
// │ « Ouvert » = lib/queries/player-open.ts. Un deal ou une wallet ne sont PAS │
// │ ouverts (réglage, pas argent) : ils remontent en « lien actif ».           │
// │ A. Base en mémoire, schéma minimal : chaque source, les deux verrous.      │
// │ B. Copie de la base locale, schéma réel (migrations) : archivePlayers réel,│
// │    NEXA, liste blanche d'updatePlayer, seul écrivain de archived_at.       │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..");
// lib/db.ts fige son dossier de base (cwd/data) AU CHARGEMENT : on se place dans un dossier
// temporaire AVANT de charger le moindre module du projet (d'où les require ci-dessous).
// Sinon getDb() ouvrirait un data/lecercle.db neuf dans le dépôt.
const DB_SRC = [process.env.LECERCLE_DB_SRC, path.join(REPO, "data", "lecercle.db"), path.join(REPO, "..", "..", "..", "data", "lecercle.db")]
  .filter((p): p is string => !!p).find(p => fs.existsSync(p));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lecercle-archive-guard-")));
fs.mkdirSync(path.join(TMP, "data"));
if (DB_SRC) fs.copyFileSync(DB_SRC, path.join(TMP, "data", "lecercle.db"));
process.chdir(TMP);

const { getPlayersOpenStateOn, assertPlayersArchivableOn, PlayerOpenError } = require(path.join(REPO, "lib/queries/player-open.ts")) as typeof import("../lib/queries/player-open");
const { attachOpenState, isHiddenFromMain } = require(path.join(REPO, "app/players/shared.ts")) as typeof import("../app/players/shared");

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
  CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active', archived_at TEXT, archive_reason TEXT, tron_address TEXT, tele_wallet_cashout TEXT);
  CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active');
  CREATE TABLE wallet_transactions (id INTEGER PRIMARY KEY, player_id INT, game_id INT, type TEXT, amount REAL, currency TEXT DEFAULT 'USDT', settled INT DEFAULT 0, source TEXT, status TEXT, tx_datetime TEXT, tx_date TEXT);
  CREATE TABLE weekly_settlements (id INTEGER PRIMARY KEY, player_id INT, status TEXT, payment_received INT DEFAULT 0);
  CREATE TABLE manual_settlements (id INTEGER PRIMARY KEY, player_id INT, status TEXT);
  CREATE TABLE nexa_player_action_shares (id INTEGER PRIMARY KEY, player_id INT, pct REAL, start_week TEXT, end_week TEXT);
  CREATE TABLE nexa_affiliate_weeks (player_id INT);
  CREATE TABLE nexa_player_bankroll_weeks (player_id INT);
  CREATE TABLE pool_players (player_id INT);
  CREATE TABLE pool_accounts (player_id INT, closed_at TEXT);
  CREATE TABLE pool_periods (player_id INT, closed_at TEXT);
  CREATE TABLE qqpk_staking_blocks (player_id INT, status TEXT, block_start TEXT, block_end TEXT);
  CREATE TABLE xpoker_week_rows (player_id INT);
  CREATE TABLE xpoker_player_deals (player_id INT, end_week TEXT);
  CREATE TABLE grindhouse_settlements (player_id INT, status TEXT, period_start TEXT, period_end TEXT, created_at TEXT DEFAULT '2026-09-01 00:00:00');
  CREATE TABLE grindhouse_sessions (player_id INT, session_date TEXT, created_at TEXT DEFAULT '2026-08-01 00:00:00');
  CREATE TABLE xpoker_chip_ledger (player_id INT, kind TEXT, direction TEXT, chips REAL);
  CREATE TABLE cashout_requests (player_id INT, status TEXT);
  CREATE TABLE rakeback_entries (player_id INT);
  CREATE TABLE affiliate_relationships (affiliate_player_id INT, referred_player_id INT, status TEXT);
  CREATE TABLE player_game_deals (player_id INT, game_id INT, end_date TEXT);
  CREATE TABLE player_wallet_games (player_id INT, game_id INT, address TEXT);
  INSERT INTO games (id, name, status) VALUES (1,'KKPOKER','active'), (2,'TELE','archived'), (3,'QQPK','active'), (4,'NEXAPOKER','active'), (5,'ROOM_FUTURE','active');
`);
let nextId = 100;
const P = (name: string, archived = false) =>
  Number(db.prepare(`INSERT INTO players (id, name, archived_at) VALUES (?, ?, ?)`).run(nextId++, name, archived ? "2026-09-13 03:26:18" : null).lastInsertRowid);
const tx = (pid: number, game: number, o: Partial<{ type: string; amount: number; settled: number; source: string; status: string | null; at: string }> = {}) =>
  db.prepare(`INSERT INTO wallet_transactions (player_id, game_id, type, amount, settled, source, status, tx_datetime, tx_date) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(pid, game, o.type ?? "deposit", o.amount ?? 100, o.settled ?? 0, o.source ?? "sync", o.status === undefined ? "active" : o.status, o.at ?? "2026-09-01T10:00:00Z", (o.at ?? "2026-09-01").slice(0, 10));

const DUE = new Map<number, number | null>();
const OPTS = { agentDue: (id: number) => (DUE.has(id) ? DUE.get(id)! : 0) };
const state = () => getPlayersOpenStateOn(db, undefined, OPTS);
const codes = (pid: number) => (state().get(pid)?.open ?? []).map(r => r.code);
const linkCodes = (pid: number) => (state().get(pid)?.links ?? []).map(l => `${l.code}:${l.game}`);

// Sources
const pTx = P("Tx non réglée"); tx(pTx, 1);
eq("tx non réglée KKPOKER → ouvert", codes(pTx), ["tx_unsettled"]);
const pSettled = P("Tout réglé"); tx(pSettled, 1, { settled: 1 });
eq("tx réglée seulement → pas ouvert", codes(pSettled), []);
const pQuar = P("Quarantaine"); tx(pQuar, 1, { status: "quarantined" });
eq("tx en quarantaine → ouvert (la quarantaine n'est pas close)", codes(pQuar), ["tx_unsettled"]);
const pRej = P("Rejetée"); tx(pRej, 1, { status: "rejected" });
eq("tx rejetée → pas ouvert", codes(pRej), []);
const pUnknown = P("Source unknown"); tx(pUnknown, 1, { source: "unknown" });
eq("tx source unknown (hors agrégats) → pas ouvert", codes(pUnknown), []);
const pFuture = P("Room inconnue"); tx(pFuture, 5);
eq("room inconnue (flag settled supposé) → ouvert, fail-closed", codes(pFuture), ["tx_unsettled"]);
const pTele = P("Héritage TELE"); tx(pTele, 2);
db.prepare(`INSERT INTO weekly_settlements (player_id, status, payment_received) VALUES (?, 'pending_manual', 0), (?, 'auto_settled', 1)`).run(pTele, pTele);
eq("héritage TELE (tx + semaine non reçue) → ouvert, pas d'exception", codes(pTele), ["tele_tx", "tele_weekly"]);
const pLocked = P("Règlement verrouillé"); db.prepare(`INSERT INTO manual_settlements (player_id, status) VALUES (?, 'locked'), (?, 'paid')`).run(pLocked, pLocked);
eq("règlement locked non payé → ouvert", codes(pLocked), ["settlement_locked"]);
const pPaid = P("Règlement payé"); db.prepare(`INSERT INTO manual_settlements (player_id, status) VALUES (?, 'paid')`).run(pPaid);
eq("règlement payé → pas ouvert", codes(pPaid), []);

const pQ = P("QQPK couvert"); db.prepare(`INSERT INTO qqpk_staking_blocks VALUES (?, 'settled', '2026-06-21T22:00:00Z', '2026-07-21T21:59:59Z')`).run(pQ); tx(pQ, 3, { at: "2026-06-29T16:23:33Z" });
eq("tx QQPK settled=0 couverte par un bloc réglé → pas ouvert (QQPK n'utilise pas le flag)", codes(pQ), []);
const pQout = P("QQPK hors bloc"); db.prepare(`INSERT INTO qqpk_staking_blocks VALUES (?, 'settled', '2026-06-21T22:00:00Z', '2026-07-21T21:59:59Z')`).run(pQout); tx(pQout, 3, { at: "2026-03-26T10:17:21Z" });
eq("tx QQPK hors de tout bloc → ouvert", codes(pQout), ["qqpk_outside_block"]);
const pQblock = P("QQPK bloc ouvert"); db.prepare(`INSERT INTO qqpk_staking_blocks VALUES (?, 'draft', '2026-08-21T22:00:00Z', '2026-09-21T21:59:59Z')`).run(pQblock);
eq("bloc QQPK non réglé → ouvert", codes(pQblock), ["qqpk_block"]);
const pPool = P("Pool"); db.prepare(`INSERT INTO pool_players VALUES (?)`).run(pPool);
eq("membre du pool AK multi-Account → ouvert (fail-closed)", codes(pPool), ["pool"]);
const pCash = P("Cashout"); db.prepare(`INSERT INTO cashout_requests VALUES (?, 'approved'), (?, 'paid')`).run(pCash, pCash);
eq("demande de cashout approuvée non payée → ouvert", codes(pCash), ["cashout_request"]);
const pCashDone = P("Cashout clos"); db.prepare(`INSERT INTO cashout_requests VALUES (?, 'paid'), (?, 'cancelled')`).run(pCashDone, pCashDone);
eq("cashouts payé / annulé → pas ouvert", codes(pCashDone), []);
const pGrind = P("Grindhouse"); db.prepare(`INSERT INTO grindhouse_settlements (player_id, status, period_start, period_end) VALUES (?, 'pending', '2026-09-01', '2026-09-07')`).run(pGrind);
eq("grindhouse non payé → ouvert", codes(pGrind), ["grindhouse"]);
const pSess = P("Sessions grindhouse");
db.prepare(`INSERT INTO grindhouse_sessions (player_id, session_date) VALUES (?, '2026-08-03'), (?, '2026-09-10')`).run(pSess, pSess);
db.prepare(`INSERT INTO grindhouse_settlements (player_id, status, period_start, period_end) VALUES (?, 'paid', '2026-08-01', '2026-08-31')`).run(pSess);
eq("session grindhouse hors de tout règlement payé → ouvert (audit B1)", codes(pSess), ["grindhouse_sessions"]);
const pSessOk = P("Sessions réglées");
db.prepare(`INSERT INTO grindhouse_sessions (player_id, session_date) VALUES (?, '2026-08-03')`).run(pSessOk);
db.prepare(`INSERT INTO grindhouse_settlements (player_id, status, period_start, period_end) VALUES (?, 'paid', '2026-08-01', '2026-08-31')`).run(pSessOk);
eq("session couverte par un règlement payé → pas ouvert", codes(pSessOk), []);
const pSessLate = P("Session antidatée");
db.prepare(`INSERT INTO grindhouse_settlements (player_id, status, period_start, period_end, created_at) VALUES (?, 'paid', '2026-08-01', '2026-08-31', '2026-09-01 00:00:00')`).run(pSessLate);
db.prepare(`INSERT INTO grindhouse_sessions (player_id, session_date, created_at) VALUES (?, '2026-08-15', '2026-09-20 10:00:00')`).run(pSessLate);
eq("session antidatée saisie APRÈS le règlement payé → ouvert (contre-audit N1)", codes(pSessLate), ["grindhouse_sessions"]);
const pQnull = P("QQPK hors bloc source NULL"); tx(pQnull, 3, { source: null as any, at: "2026-03-01T10:00:00Z" });
eq("tx QQPK hors bloc à source NULL → ouvert (contre-audit M2)", codes(pQnull), ["qqpk_outside_block"]);
const pWnull = P("Hebdo reçu NULL"); db.prepare(`INSERT INTO weekly_settlements (player_id, status, payment_received) VALUES (?, 'pending_manual', NULL)`).run(pWnull);
eq("semaine hebdo à payment_received NULL → ouvert (contre-audit N3)", codes(pWnull), ["tele_weekly"]);
const pChips = P("Buy-in XPoker");
db.prepare(`INSERT INTO xpoker_chip_ledger VALUES (?, 'buyin', 'out', 49500), (?, 'action_paid', 'in', 300)`).run(pChips, pChips);
eq("buy-in XPoker non soldé → ouvert (audit B2)", codes(pChips), ["xpoker_chips"]);
const pChipsOk = P("Buy-in rendu");
db.prepare(`INSERT INTO xpoker_chip_ledger VALUES (?, 'buyin', 'out', 6600), (?, 'cashout', 'in', 6600)`).run(pChipsOk, pChipsOk);
eq("buy-in intégralement rendu → pas ouvert", codes(pChipsOk), []);
// Room sans flag settled (QQPK ici ; NEXA, dont le rejeu a besoin du schéma réel, en partie B).
const pQQ = P("QQPK en quarantaine"); db.prepare(`INSERT INTO qqpk_staking_blocks VALUES (?, 'settled', '2026-06-21T22:00:00Z', '2026-07-21T21:59:59Z')`).run(pQQ); tx(pQQ, 3, { status: "quarantined", at: "2026-06-29T16:23:33Z" });
eq("tx QQPK en quarantaine (dans un bloc réglé) → ouvert (audit I2)", codes(pQQ), ["tx_quarantined"]);
const pNexaCcy = P("NEXA hors USDT");
db.prepare(`INSERT INTO wallet_transactions (player_id, game_id, type, amount, currency, settled, source, status) VALUES (?, 3, 'deposit', 10, 'CNY', 0, 'manual', 'active')`).run(pNexaCcy);
eq("tx QQPK hors USDT → ouvert", codes(pNexaCcy).includes("tx_other_currency"), true);
const pNullSrc = P("Source NULL"); tx(pNullSrc, 1, { source: null as any });
eq("tx source NULL non réglée → ouvert (audit M2)", codes(pNullSrc), ["tx_unsettled"]);
const pWeekly = P("Hebdo settled non reçue"); db.prepare(`INSERT INTO weekly_settlements (player_id, status, payment_received) VALUES (?, 'carry_over', 0)`).run(pWeekly);
eq("semaine hebdo carry_over non reçue → ouvert (audit M1)", codes(pWeekly), ["tele_weekly"]);
const pRb = P("Report rakeback"); db.prepare(`INSERT INTO rakeback_entries VALUES (?)`).run(pRb);
eq("ligne de report rakeback (aucun état réglé) → ouvert, fail-closed", codes(pRb), ["rakeback_report"]);

const pAgent = P("Agent dû"), pAgentZero = P("Agent soldé"), pAgentNull = P("Agent incalculable"), pFilleul = P("Filleul");
db.prepare(`INSERT INTO affiliate_relationships VALUES (?, ?, 'active'), (?, ?, 'active'), (?, ?, 'active')`).run(pAgent, pFilleul, pAgentZero, pFilleul, pAgentNull, pFilleul);
DUE.set(pAgent, 12.5); DUE.set(pAgentZero, 0); DUE.set(pAgentNull, null);
eq("agent avec commission due → ouvert", codes(pAgent), ["affiliate_due"]);
eq("agent à 0 → pas ouvert", codes(pAgentZero), []);
eq("agent au dû incalculable (null) → ouvert, jamais un 0 supposé", codes(pAgentNull), ["affiliate_due"]);
eq("le filleul ne porte aucune dette d'affiliation", codes(pFilleul), []);

// Liens actifs : pas « ouvert »
const pLink = P("Deal + wallets");
db.prepare(`INSERT INTO player_game_deals VALUES (?, 1, NULL), (?, 2, '2026-05-25')`).run(pLink, pLink);
db.prepare(`INSERT INTO player_wallet_games VALUES (?, 1, 'TXXX')`).run(pLink);
db.prepare(`UPDATE players SET tron_address = 'TYYY' WHERE id = ?`).run(pLink);
eq("deal ouvert + wallet + wallet legacy → PAS ouvert", codes(pLink), []);
eq("… mais remontent en liens actifs (deal fermé exclu)", linkCodes(pLink), ["deal:KKPOKER", "wallet:KKPOKER", "wallet_legacy:null"]);

// Verrou (a)
let err: unknown = null;
try { assertPlayersArchivableOn(db, [pTx], OPTS); } catch (e) { err = e; }
eq("verrou (a) : archiver un joueur ouvert lève PlayerOpenError", err instanceof PlayerOpenError, true);
eq("… avec le motif explicite", (err as PlayerOpenError)?.blocked?.[0]?.reasons.map(r => r.code), ["tx_unsettled"]);
err = null;
try { assertPlayersArchivableOn(db, [pLink, pSettled], OPTS); } catch (e) { err = e; }
eq("verrou (a) : un lot sans ouvert passe", err, null);
err = null;
try { assertPlayersArchivableOn(db, [pLink, pTx, pSettled], OPTS); } catch (e) { err = e; }
eq("verrou (a) : un seul ouvert dans le lot → lot refusé, seul l'ouvert est cité", (err as PlayerOpenError)?.blocked?.map(b => b.player_id), [pTx]);
err = null;
const throwingOpts = { agentDue: () => { throw new Error("moteur d'affiliation indisponible"); } };
try { assertPlayersArchivableOn(db, [pAgent], throwingOpts); } catch (e) { err = e; }
eq("verrou (a) : une erreur de calcul bloque l'archivage (fail-closed)", (err as Error)?.message, "moteur d'affiliation indisponible");

// Verrou (b)
const rows = (db.prepare(`SELECT id, name, archived_at FROM players`).all() as { id: number; name: string; archived_at: string | null }[]);
const pArchOpen = P("Archivé mais ouvert", true); tx(pArchOpen, 1);
const pArchClean = P("Archivé propre", true);
const view = (st: ReturnType<typeof state> | null) => attachOpenState(db.prepare(`SELECT id, name, archived_at FROM players`).all() as { id: number; name: string; archived_at: string | null }[], st);
const hidden = (st: ReturnType<typeof state> | null) => view(st).filter(isHiddenFromMain).map(p => p.name);
eq("verrou (b) : seul l'archivé sans rien d'ouvert est masqué", hidden(state()), ["Archivé propre"]);
eq("verrou (b) : un non-archivé n'est jamais masqué", rows.every(r => !hidden(state()).includes(r.name)), true);
tx(pArchClean, 1, { at: "2026-09-26T08:00:00Z" });   // dépôt reçu après archivage
eq("verrou (b) : dépôt entrant sur un archivé → il réapparaît", hidden(state()), []);
eq("verrou (b) : état incalculable → personne n'est masqué (fail-closed)", hidden(null), []);
eq("… et chaque ligne porte le motif de repli", view(null).every(p => p.open.length === 1), true);
void pArchOpen;

let skippedB: string | null = null;
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n── B. Schéma réel (copie de la base locale, migrations appliquées) ──");
{
  if (!DB_SRC) { console.log("   (data/lecercle.db absent — bloc B sauté)"); }
  else {
    console.log(`   source : ${DB_SRC}`);
    const ol = console.log, oe = console.error; console.log = () => {}; console.error = () => {};
    const { getDb } = require(path.join(REPO, "lib/db.ts"));
    const { archivePlayers, unarchivePlayer, getPlayersOpenState, deletePlayerChecked, resetPlayerChecked } = require(path.join(REPO, "lib/players-archive.ts"));
    const { updatePlayer } = require(path.join(REPO, "lib/queries.ts"));
    const d = getDb();
    console.log = ol; console.error = oe;

    const gid = (name: string) => (d.prepare(`SELECT id FROM games WHERE name = ?`).get(name) as { id: number }).id;
    const ins = (name: string) => Number(d.prepare(`INSERT INTO players (name) VALUES (?)`).run(name).lastInsertRowid);
    const depot = (pid: number, game: string) => d.prepare(
      `INSERT INTO wallet_transactions (player_id, game_id, type, amount, currency, tx_date, tx_datetime, source, settled) VALUES (?, ?, 'deposit', 50, 'USDT', '2026-09-20', '2026-09-20T10:00:00Z', 'manual', 0)`,
    ).run(pid, gid(game));
    const archivedAt = (pid: number) => (d.prepare(`SELECT archived_at FROM players WHERE id = ?`).get(pid) as { archived_at: string | null }).archived_at;

    let open1 = 0;
    try { open1 = ins("ZZ garde ouvert"); depot(open1, "KKPOKER"); }
    catch (x: any) {
      // Base source incohérente (vieille base locale : FK vers une table disparue…) : on le
      // DIT, on ne le compte ni en réussite ni en échec. La partie A a prouvé les verrous.
      skippedB = `la base source refuse l'insertion d'une tx (${x.message}) — relancer avec LECERCLE_DB_SRC=<copie migrée d'un dump prod>`;
    }
    if (!skippedB) {
    const clean1 = ins("ZZ garde propre"); d.prepare(`INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct) VALUES (?, ?, 50, 0)`).run(clean1, gid("KKPOKER"));
    const clean2 = ins("ZZ garde propre 2");

    let e: any = null;
    try { archivePlayers([open1], "test"); } catch (x) { e = x; }
    eq("archivePlayers réel : joueur ouvert refusé (PlayerOpenError)", e?.name, "PlayerOpenError");
    eq("… et rien n'est écrit", archivedAt(open1), null);
    e = null;
    try { archivePlayers([clean2, open1], "test"); } catch (x) { e = x; }
    eq("archivePlayers réel : lot avec un ouvert refusé en bloc", [e?.name, archivedAt(clean2)], ["PlayerOpenError", null]);
    eq("archivePlayers réel : joueur avec seulement un deal archivé", [archivePlayers([clean1], "test"), archivedAt(clean1) !== null], [1, true]);
    depot(clean1, "KKPOKER");
    eq("dépôt après archivage : redevient ouvert (réapparaît dans la vue principale)", (getPlayersOpenState([clean1]).get(clean1)?.open ?? []).map((r: any) => r.code), ["tx_unsettled"]);
    unarchivePlayer(clean1);
    eq("désarchiver : toujours permis, même ouvert", archivedAt(clean1), null);

    const nx = ins("ZZ garde nexa"); depot(nx, "NEXAPOKER");
    const nxCodes = (getPlayersOpenState([nx]).get(nx)?.open ?? []).map((r: any) => r.code);
    eq("NEXAPOKER : tx settled=0 pas comptée comme tx non réglée…", nxCodes.includes("tx_unsettled"), false);
    eq("… mais le solde des mouvements NEXA rend ouvert", nxCodes.includes("nexa_movements"), true);
    const nxq = ins("ZZ garde nexa quarantaine");
    d.prepare(`INSERT INTO wallet_transactions (player_id, game_id, type, amount, currency, tx_date, tx_datetime, source, settled, status) VALUES (?, ?, 'deposit', 50, 'USDT', '2026-09-20', '2026-09-20T10:00:00Z', 'manual', 0, 'quarantined')`).run(nxq, gid("NEXAPOKER"));
    eq("tx NEXA en quarantaine → ouvert, alors que le moteur NEXA l'ignore (audit I2)", (getPlayersOpenState([nxq]).get(nxq)?.open ?? []).map((r: any) => r.code), ["tx_quarantined"]);
    d.prepare(`INSERT INTO nexa_player_action_shares (player_id, pct, start_week) VALUES (?, 50, '2026-09-14')`).run(clean2);
    eq("staké NEXA (semaine BR ouverte) → ouvert", (getPlayersOpenState([clean2]).get(clean2)?.open ?? []).some((r: any) => r.code === "nexa_stake"), true);

    e = null;
    try { deletePlayerChecked(open1); } catch (x) { e = x; }
    eq("suppression définitive d'un joueur ouvert refusée (audit I1)", [e?.name, !!d.prepare(`SELECT 1 FROM players WHERE id = ?`).get(open1)], ["PlayerOpenError", true]);
    e = null;
    try { resetPlayerChecked({ player_id: open1 }); } catch (x) { e = x; }
    eq("reset-player d'un joueur ouvert refusé, joueur intact", [e?.name, !!d.prepare(`SELECT 1 FROM players WHERE id = ?`).get(open1)], ["PlayerOpenError", true]);
    const resettable = ins("ZZ garde reset propre");
    eq("reset-player d'un joueur sans rien d'ouvert : effectué", [resetPlayerChecked({ player_id: resettable }).found, !!d.prepare(`SELECT 1 FROM players WHERE id = ?`).get(resettable)], [true, false]);
    e = null;
    try { updatePlayer(clean2, { archived_at: null } as any); } catch (x) { e = x; }
    eq("updatePlayer : archived_at refusé (contournement du verrou fermé)", /non modifiable/.test(e?.message ?? ""), true);
    e = null;
    try { updatePlayer(clean2, { "name = 'x', status": "y" } as any); } catch (x) { e = x; }
    eq("updatePlayer : nom de colonne injecté refusé", /non modifiable/.test(e?.message ?? ""), true);
    }
  }
}
if (skippedB) console.log(`   ⚠ BLOC B SAUTÉ : ${skippedB}`);

// Seul lib/players-archive.ts écrit players.archived_at (la colonne XPoker homonyme de
// player_game_ids est hors sujet).
const writers: string[] = [];
const walk = (dir: string) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next"].includes(ent.name)) continue;
    const f = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(f);
    else if (/\.(ts|tsx)$/.test(ent.name) && !f.endsWith(".test.ts")) {
      const src = fs.readFileSync(f, "utf8");
      if (/UPDATE\s+players\s+SET[^`]*archived_at/.test(src)) writers.push(path.relative(REPO, f));
    }
  }
};
for (const dir of ["app", "lib", "components"]) walk(path.join(REPO, dir));
eq("un seul écrivain de players.archived_at", writers, ["lib/players-archive.ts"]);
const resetSrc = fs.readFileSync(path.join(REPO, "app/api/admin/reset-player/route.ts"), "utf8");
eq("la route reset-player passe par resetPlayerChecked et ne supprime rien elle-même", [/resetPlayerChecked\(/.test(resetSrc), /DELETE\s+FROM/i.test(resetSrc)], [true, false]);

console.log(`\n${passed} ✔, ${failures.length} ✘${skippedB ? " (bloc B sauté, voir ci-dessus)" : ""}`);
if (failures.length) { console.log("ÉCHECS :", failures); process.exit(1); }
