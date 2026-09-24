// Filtre d'activité du tableau joueurs (LedgerTable) — base temporaire en mémoire.
// Run: npx tsx scripts/ledger-period-filter.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ Le filtre de période masque des lignes. Une ligne masquée à tort, c'est un │
// │ règlement que Baki oublie. Propriétés vérifiées :                          │
// │  1. Un mouvement (dépôt OU retrait) dans la période affiche la ligne,      │
// │     même si le net s'annule.                                               │
// │  2. Aucun mouvement → masquée… sauf s'il reste quelque chose à régler :    │
// │     cas Grobel sur KKPOKER (2 tx non réglées, badge « à régler » masqué    │
// │     sur la page) → ligne affichée, marquée « hors période · à régler ».   │
// │  3. Les joueurs sans aucun mouvement n'apparaissent qu'en Lifetime.        │
// │  4. L'activité vient des vraies transactions, jamais du snapshot verrouillé│
// │     (weekly_settlements) : même les filtres que le P&L (source, status,   │
// │     fenêtre du deal), et une tx d'une autre game ne compte pas.            │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import { getActivePlayerIdsInPeriod } from "../lib/queries";
import { periodPresence, summarizePresence, hasPendingSettlement, SETTLE_ONLY_LABEL } from "../components/ledger/period-presence";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

// Schéma minimal : les colonnes que lisent la requête d'activité et le snapshot verrouillé.
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE player_game_deals (id INTEGER PRIMARY KEY, player_id INTEGER, game_id INTEGER, action_pct REAL, rakeback_pct REAL, start_date TEXT, end_date TEXT);
  CREATE TABLE wallet_transactions (id INTEGER PRIMARY KEY, player_id INTEGER, game_id INTEGER, type TEXT, amount REAL, tx_datetime TEXT, source TEXT, status TEXT, settled INTEGER DEFAULT 0);
  CREATE TABLE weekly_settlements (player_id INTEGER, week_start TEXT, pnl_player REAL, pnl_operator REAL);
`);
const G = { A5POKER: 1, NUTSPK: 2, WN: 3, KKPOKER: 4 };
for (const [n, id] of Object.entries(G)) db.prepare(`INSERT INTO games VALUES (?, ?)`).run(id, n);

const P = {
  Raph: 16, Grobel: 428, Hakim: 53, NetZero: 900, WithdrawOnly: 901, Phantom: 902, BeforeDeal: 903, WnOnly: 904,
  // Les 7 sans aucun mouvement A5NUTS (données prod du 2026-09-24).
  AlexD: 13, Daniel: 144, NathanB: 4, Romain: 11, U: 277, VS: 185, Joker: 154,
};
const NEVER_MOVED = [P.AlexD, P.Daniel, P.NathanB, P.Romain, P.U, P.VS, P.Joker];
for (const [n, id] of Object.entries(P)) db.prepare(`INSERT INTO players VALUES (?, ?)`).run(id, n);

const deal = (pid: number, gid: number, start: string | null = null) =>
  db.prepare(`INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct, start_date) VALUES (?, ?, 50, 0, ?)`).run(pid, gid, start);
const tx = (pid: number, gid: number, type: string, amount: number, when: string, extra: { source?: string; status?: string; settled?: number } = {}) =>
  db.prepare(`INSERT INTO wallet_transactions (player_id, game_id, type, amount, tx_datetime, source, status, settled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(pid, gid, type, amount, when, extra.source ?? "sync", extra.status ?? "active", extra.settled ?? 1);

for (const id of Object.values(P)) if (id !== P.WnOnly) deal(id, G.A5POKER);
deal(P.WnOnly, G.WN);
deal(P.Grobel, G.KKPOKER);
deal(P.BeforeDeal, G.NUTSPK, "2026-09-23T00:00:00Z");

// Semaine courante : lun 21/09 00:00 Paris → jeu 24/09.
const WEEK = { since_date: "2026-09-20T22:00:00Z", end_date: "2026-09-24T15:51:23Z" };
const D30 = { since_date: "2026-08-25T15:51:23Z", end_date: "2026-09-24T15:51:23Z" };
const CUSTOM = { since_date: "2026-08-31T22:00:00Z", end_date: "2026-09-24T21:59:59Z" };
const A5NUTS = ["A5POKER", "NUTSPK", "WN"];

tx(P.Raph, G.A5POKER, "deposit", 500, "2026-09-22T10:00:00Z");                  // dépôt seul
tx(P.WithdrawOnly, G.A5POKER, "withdrawal", 120, "2026-09-23T10:00:00Z");       // retrait seul
tx(P.NetZero, G.A5POKER, "deposit", 100, "2026-09-21T10:00:00Z");              // net = 0
tx(P.NetZero, G.A5POKER, "withdrawal", 100, "2026-09-22T10:00:00Z");
tx(P.Hakim, G.A5POKER, "deposit", 200, "2026-09-05T10:00:00Z");                // 30 j, pas la semaine
tx(P.Phantom, G.A5POKER, "deposit", 999, "2026-09-22T10:00:00Z", { source: "unknown" }); // exclu du P&L
tx(P.Phantom, G.A5POKER, "deposit", 999, "2026-09-22T11:00:00Z", { status: "excluded" });
tx(P.BeforeDeal, G.NUTSPK, "deposit", 50, "2026-09-21T10:00:00Z");            // avant le début du deal NUTSPK
tx(P.WnOnly, G.WN, "deposit", 80, "2026-09-22T10:00:00Z");                     // WN fait partie d'A5NUTS
// Grobel : 2 tx KK non réglées d'août, aucun mouvement KK cette semaine ; il bouge sur A5.
tx(P.Grobel, G.KKPOKER, "deposit", 300, "2026-08-10T10:00:00Z", { settled: 0 });
tx(P.Grobel, G.KKPOKER, "withdrawal", 150, "2026-08-12T10:00:00Z", { settled: 0 });
tx(P.Grobel, G.A5POKER, "deposit", 40, "2026-09-23T10:00:00Z");
// Piège du snapshot : une semaine verrouillée à net 0 ne doit ni ajouter ni retirer personne.
db.prepare(`INSERT INTO weekly_settlements VALUES (?, '2026-09-21', 0, 0)`).run(P.NetZero);
db.prepare(`INSERT INTO weekly_settlements VALUES (?, '2026-09-21', -300, -150)`).run(P.AlexD);

const ids = (f: object) => { const r = getActivePlayerIdsInPeriod(f, db); return r === null ? null : [...r].sort((a, b) => a - b); };

console.log("1. Mouvement dans la période → actif (A5NUTS, cette semaine)");
const weekA5 = ids({ game_names: A5NUTS, ...WEEK })!;
eq("dépôt seul (Raph)", weekA5.includes(P.Raph), true);
eq("retrait seul", weekA5.includes(P.WithdrawOnly), true);
eq("net 0, mouvements qui s'annulent", weekA5.includes(P.NetZero), true);
eq("tx WN compte pour A5NUTS", weekA5.includes(P.WnOnly), true);
eq("Grobel actif sur A5", weekA5.includes(P.Grobel), true);
eq("liste exacte", weekA5, [P.Raph, P.Grobel, P.NetZero, P.WithdrawOnly, P.WnOnly].sort((a, b) => a - b));

console.log("2. Mêmes filtres que le P&L — et jamais le snapshot verrouillé");
eq("source 'unknown' / status exclu → pas actif", weekA5.includes(P.Phantom), false);
eq("tx avant le début du deal → pas actif", weekA5.includes(P.BeforeDeal), false);
eq("ligne weekly_settlements seule → pas actif (Alex D)", weekA5.includes(P.AlexD), false);
eq("30 j inclut Hakim", ids({ game_names: A5NUTS, ...D30 })!.includes(P.Hakim), true);
eq("semaine exclut Hakim", weekA5.includes(P.Hakim), false);

console.log("3. Cas Grobel sur KKPOKER (badge « à régler » masqué sur la page)");
const weekKK = ids({ game_name: "KKPOKER", ...WEEK })!;
eq("tx A5 ne compte pas sur KK", weekKK, []);
const kkUnsettled = (db.prepare(`SELECT COUNT(*) AS n FROM wallet_transactions WHERE player_id = ? AND game_id = ? AND settled = 0`).get(P.Grobel, G.KKPOKER) as { n: number }).n;
eq("Grobel a 2 tx KK non réglées", kkUnsettled, 2);
const kkSet = new Set(weekKK);
eq("présence Grobel KK", periodPresence(P.Grobel, kkSet, kkUnsettled > 0), "settle-only");
eq("marque affichée", SETTLE_ONLY_LABEL, "hors période · à régler");
const kkSummary = summarizePresence([P.Grobel, P.Raph, P.AlexD], kkSet, id => id === P.Grobel);
eq("compteur KK", { active: kkSummary.active, settleOnly: kkSummary.settleOnly, hidden: kkSummary.hidden }, { active: 0, settleOnly: 1, hidden: 2 });
eq("sans règlement en attente, Grobel serait masqué", periodPresence(P.Grobel, kkSet, false), "hidden");

console.log("3b. Prédicat « à régler » tel que LedgerTable l'appelle");
eq("2 tx non réglées → à régler (Grobel KK)", hasPendingSettlement(kkUnsettled, []), true);
eq("règlement verrouillé non payé, 0 tx → à régler", hasPendingSettlement(0, ["paid", "locked"]), true);
eq("tout payé, 0 tx → rien à régler", hasPendingSettlement(0, ["paid"]), false);
eq("règlement verrouillé hors période → affiché", periodPresence(P.AlexD, kkSet, hasPendingSettlement(0, ["locked"])), "settle-only");

console.log("4. Les 7 sans aucun mouvement : Lifetime seulement");
for (const [label, f] of [["cette semaine", WEEK], ["30 jours", D30], ["custom 01/09 → 24/09", CUSTOM]] as const) {
  const set = new Set(ids({ game_names: A5NUTS, ...f })!);
  eq(`${label} : tous masqués`, NEVER_MOVED.map(id => periodPresence(id, set, false)), NEVER_MOVED.map(() => "hidden"));
}
const life = ids({ game_names: A5NUTS });
eq("lifetime → pas de filtre (null)", life, null);
eq("lifetime : tous affichés", NEVER_MOVED.map(id => periodPresence(id, life === null ? null : new Set(life), false)), NEVER_MOVED.map(() => "active"));

console.log(`\n${passed} OK, ${failures.length} échec(s)`);
if (failures.length) { console.log("Échecs :", failures.join(" · ")); process.exit(1); }
