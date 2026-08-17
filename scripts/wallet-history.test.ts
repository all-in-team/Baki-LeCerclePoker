// Historique joueur — règle de comptage, filtres, totaux, CSV.
// Run: npx tsx scripts/wallet-history.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ L'écran Historique affiche une ligne de totaux qui suit les filtres. Ces    │
// │ totaux sont calculés en JS (lib/wallet-history.ts) alors que TOUS les       │
// │ autres montants du repo sortent du SQL. Deux implémentations d'une même     │
// │ règle, c'est une dérive qui attend son heure — et une colonne de total      │
// │ fausse est pire qu'une colonne absente.                                     │
// │                                                                            │
// │ Ce test fait tourner les DEUX chemins sur les MÊMES lignes et exige le      │
// │ même résultat au centime :                                                  │
// │   • le prédicat SQL `(source != 'unknown') AND (status = 'active')`         │
// │   • la fonction JS isCountable()                                            │
// │                                                                            │
// │ Le jeu de données reproduit des cas réels de la base : lignes réglées,      │
// │ non réglées, en quarantaine, rejetées, et legacy `source='unknown'`.        │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import {
  isCountable, computeTotals, filterHistory, matchesStatus, historyToCsv, statusBadge,
  type HistoryTx,
} from "../lib/wallet-history";
import type { PlayersPeriod } from "../app/players/shared";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

// ── Jeu de données ───────────────────────────────────────────────────────────
type Seed = [id: number, at: string, type: "deposit" | "withdrawal", amount: number,
             source: string | null, status: string | null, settled: number, sid: number | null];
const SEED: Seed[] = [
  // Les 6 premières reproduisent la trace A5POKER réelle de Samyaza (joueur 421).
  [1, "2026-08-16T12:49:39Z", "deposit",    1919.00, "sync",    "active",      0, null],
  [2, "2026-08-16T12:48:45Z", "withdrawal", 1921.20, "sync",    "active",      1, 176],
  [3, "2026-08-15T22:56:09Z", "withdrawal", 1000.00, "sync",    "active",      1, 176],
  [4, "2026-08-13T13:27:09Z", "deposit",     995.80, "sync",    "active",      1, 176],
  [5, "2026-08-13T12:12:12Z", "deposit",    1000.70, "sync",    "active",      1, 176],
  [6, "2026-08-11T13:10:39Z", "deposit",     498.80, "sync",    "active",      1, 176],
  // Lignes qui doivent être VISIBLES mais JAMAIS comptées.
  [7, "2026-08-10T10:00:00Z", "deposit",  250000.00, "sync",    "quarantined", 0, null],
  [8, "2026-08-09T10:00:00Z", "deposit",  999999.00, "sync",    "rejected",    0, null],
  [9, "2026-08-08T10:00:00Z", "withdrawal", 4242.00, "unknown", "active",      0, null],
  // Une manuelle, comptée normalement.
  [10, "2026-08-07T10:00:00Z", "withdrawal", 100.00, "manual",  "active",      0, null],
];

function toTx([id, at, type, amount, source, status, settled, sid]: Seed): HistoryTx {
  return {
    id, tx_at: at, game_name: "A5POKER", type, amount, currency: "USDT",
    source, status, settled, settlement_id: sid,
    settlement_status: sid ? "locked" : null, settlement_kind: sid ? "action" : null,
    settlement_paid_at: null, settlement_amount_due: null,
    counterparty_address: "TVGMzHejH9pbgREEQxCCDK7EzexDCvAKpB",
    tron_tx_hash: `hash${id}`, note: "auto-sync", created_at: at.replace("T", " ").replace("Z", ""),
  };
}
const ROWS = SEED.map(toTx);

// ── 1. JS vs SQL sur les mêmes lignes ────────────────────────────────────────
console.log("\n1. La règle JS et le prédicat SQL donnent le même résultat");
{
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE wallet_transactions (
    id INTEGER PRIMARY KEY, tx_datetime TEXT, type TEXT, amount REAL,
    source TEXT, status TEXT, settled INTEGER, settlement_id INTEGER)`);
  const ins = db.prepare(`INSERT INTO wallet_transactions VALUES (?,?,?,?,?,?,?,?)`);
  for (const s of SEED) ins.run(...s);

  // Le prédicat, copié tel qu'il est écrit dans les 28 requêtes d'argent du repo.
  const GUARD = `(source IS NULL OR source != 'unknown') AND (status IS NULL OR status = 'active')`;
  const sql = db.prepare(`
    SELECT COUNT(*) AS n,
      COALESCE(SUM(CASE WHEN type='deposit'    THEN amount ELSE 0 END), 0) AS deposited,
      COALESCE(SUM(CASE WHEN type='withdrawal' THEN amount ELSE 0 END), 0) AS withdrawn,
      COALESCE(SUM(CASE WHEN type='withdrawal' THEN amount ELSE -amount END), 0) AS net
    FROM wallet_transactions WHERE ${GUARD}
  `).get() as { n: number; deposited: number; withdrawn: number; net: number };

  const js = computeTotals(ROWS);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  eq("nombre de lignes comptées", js.counted, sql.n);
  eq("dépôts", r2(js.deposited), r2(sql.deposited));
  eq("retraits", r2(js.withdrawn), r2(sql.withdrawn));
  eq("net", r2(js.net), r2(sql.net));
  // Valeurs attendues en dur : si les deux chemins dérivaient ENSEMBLE, l'égalité
  // ci-dessus resterait vraie et ne prouverait plus rien.
  eq("dépôts (valeur absolue attendue)", r2(js.deposited), 4414.30);
  eq("retraits (valeur absolue attendue)", r2(js.withdrawn), 3021.20);
  eq("net (valeur absolue attendue)", r2(js.net), -1393.10);
  db.close();
}

// ── 2. Les lignes non comptables sont visibles mais hors totaux ──────────────
console.log("\n2. Quarantaine / rejet / legacy : visibles, jamais comptés");
{
  const t = computeTotals(ROWS);
  eq("10 lignes affichées", t.rows, 10);
  eq("7 comptées", t.counted, 7);
  eq("3 exclues", t.excluded, 3);
  eq("quarantaine non comptable", isCountable(ROWS[6]), false);
  eq("rejetée non comptable", isCountable(ROWS[7]), false);
  eq("source unknown non comptable", isCountable(ROWS[8]), false);
  eq("manuelle comptable", isCountable(ROWS[9]), true);
  // Le filet : un statut jamais vu doit être exclu, pas inclus par défaut.
  eq("statut inconnu exclu (fail-closed)",
    isCountable({ source: "sync", status: "un_statut_futur" }), false);
  eq("status NULL toléré (lignes d'avant la migration)",
    isCountable({ source: "sync", status: null }), true);
  // Sans la garde, les 250 000 + 999 999 entreraient dans le total.
  eq("le total ignore bien les montants aberrants", Math.round(t.deposited), 4414);
}

// ── 3. Filtres ───────────────────────────────────────────────────────────────
console.log("\n3. Filtres période / type / statut");
{
  const lifetime: PlayersPeriod = { key: "lifetime", kind: "lifetime" };
  eq("lifetime = tout", filterHistory(ROWS, lifetime, "all", "all").length, 10);
  eq("dépôts seuls", filterHistory(ROWS, lifetime, "deposit", "all").length, 6);
  eq("retraits seuls", filterHistory(ROWS, lifetime, "withdrawal", "all").length, 4);
  eq("réglées", filterHistory(ROWS, lifetime, "all", "settled").length, 5);
  // id 9 est `source=unknown` : non réglée au sens brut, mais NON comptable —
  // elle sort donc de « non réglées » et tombe dans « hors totaux ».
  eq("non réglées (comptables uniquement)", filterHistory(ROWS, lifetime, "all", "unsettled").length, 2);
  eq("hors totaux", filterHistory(ROWS, lifetime, "all", "quarantined").length, 3);
  // réglées + non réglées + hors totaux doit couvrir exactement l'ensemble.
  const s1 = ROWS.filter(r => matchesStatus(r, "settled")).length;
  const s2 = ROWS.filter(r => matchesStatus(r, "unsettled")).length;
  const s3 = ROWS.filter(r => matchesStatus(r, "quarantined")).length;
  eq("les 3 statuts partitionnent l'ensemble", s1 + s2 + s3, ROWS.length);

  const window: PlayersPeriod = { key: "custom", kind: "custom", from: "2026-08-13", to: "2026-08-16" };
  eq("fenêtre 13→16 août", filterHistory(ROWS, window, "all", "all").map(r => r.id), [1, 2, 3, 4, 5]);
  const oneDay: PlayersPeriod = { key: "custom", kind: "custom", from: "2026-08-11", to: "2026-08-11" };
  eq("journée entière incluse (bornes 00:00→23:59 UTC)",
    filterHistory(ROWS, oneDay, "all", "all").map(r => r.id), [6]);

  // Les totaux suivent bien les filtres.
  eq("net des dépôts seuls", Math.round(computeTotals(filterHistory(ROWS, lifetime, "deposit", "all")).net * 100) / 100, -4414.30);
}

// ── 4. Badges ────────────────────────────────────────────────────────────────
console.log("\n4. Badges de statut");
{
  eq("quarantaine", statusBadge(ROWS[6]).label, "quarantaine");
  eq("rejetée", statusBadge(ROWS[7]).label, "rejetée");
  eq("source inconnue", statusBadge(ROWS[8]).label, "source inconnue");
  eq("non réglée", statusBadge(ROWS[0]).label, "non réglée");
  eq("réglée à payer", statusBadge(ROWS[1]).label, "réglée · à payer");
  eq("réglée payée", statusBadge({ ...ROWS[1], settlement_paid_at: "2026-08-16 10:00:00" }).label, "réglée · payé");
}

// ── 5. CSV ───────────────────────────────────────────────────────────────────
console.log("\n5. Export CSV");
{
  const csv = historyToCsv(ROWS.slice(0, 2));
  const lines = csv.split("\n");
  eq("BOM UTF-8 (ouverture directe dans Excel FR)", csv.charCodeAt(0), 0xfeff);
  eq("1 en-tête + 2 lignes", lines.length, 3);
  eq("séparateur point-virgule", lines[0].split(";").length, 17);
  eq("colonne comptee_dans_les_totaux présente", lines[0].includes("comptee_dans_les_totaux"), true);
  eq("montant en point décimal", lines[1].split(";")[4], "1919");
  // Une note contenant un `;` ne doit pas décaler les colonnes.
  const tricky = historyToCsv([{ ...ROWS[0], note: 'a;b"c' }]).split("\n")[1];
  eq("échappement du séparateur et du guillemet", tricky.includes('"a;b""c"'), true);
}

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertion(s) OK, ${failures.length} échec(s)`);
if (failures.length > 0) { console.log("Échecs :", failures.join(" · ")); process.exit(1); }
