// Quarantaine × règlement — la faille F1, et ce qui la referme.
// Run: npx tsx scripts/quarantine-settlement-guard.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ La quarantaine (add_wallet_tx_quarantine_v1) a été livrée en filtrant 30    │
// │ requêtes de LECTURE et AUCUNE du chemin d'écriture des règlements. Une      │
// │ ligne mise de côté par le scanner était donc exclue de la carte de solde,   │
// │ mais proposée au règlement comme une ligne normale : cochée puis            │
// │ verrouillée, elle produisait une facture figée et immuable. Le seuil de     │
// │ vraisemblance était contourné de bout en bout.                             │
// │ (Faille F1, audit money-auditor du 17/08/2026.)                            │
// │                                                                            │
// │ Ce que ce fichier verrouille :                                             │
// │  1. Les 4 requêtes du chemin règlement portent le prédicat `status`.        │
// │     Vérifié en LISANT LE FICHIER SOURCE, pas une copie du prédicat — un     │
// │     test qui recopie la règle valide sa copie, pas le code livré.           │
// │  2. Sémantiquement : une ligne en quarantaine n'est ni proposée, ni réglée, │
// │     ni comptée en impayé — et le lock avorte si elle l'atteignait quand     │
// │     même.                                                                  │
// │  3. Une ligne déjà réglée ne peut plus être répudiée par l'arbitrage.       │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join } from "path";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

const ROOT = join(__dirname, "..");
const ENGINE = readFileSync(join(ROOT, "lib/manual-settlement-engine.ts"), "utf8");
const QUERIES = readFileSync(join(ROOT, "lib/queries.ts"), "utf8");

/**
 * Corps d'UNE fonction, extrait du source réel par comptage d'accolades.
 *
 * La 1re version coupait au prochain `\nexport ` : sur ce fichier,
 * `getAvailableTransactions` (l.139) s'étendait alors jusqu'à
 * `previewSettlement` (l.251) et avalait `loadSelection` — l'assertion pouvait
 * donc passer grâce au prédicat d'une AUTRE fonction. Un test qui ne sait pas ce
 * qu'il lit ne prouve rien. (2e passe money-auditor du 17/08/2026, réserve R2.)
 *
 * Ignore accolades en commentaire et en littéral de chaîne. Saute la signature
 * avant de compter : plusieurs fonctions d'ici retournent un type objet littéral
 * (`): { ok: boolean; error?: string } {`) dont les accolades s'ouvrent et se
 * referment — les compter arrêtait l'extraction sur la signature.
 * Vérifie enfin qu'aucune autre déclaration de fonction n'a été happée —
 * auto-contrôle de l'extracteur lui-même.
 */
function body(src: string, name: string): string {
  const decl = new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "m");
  const m = decl.exec(src);
  if (!m) throw new Error(`fonction ${name} introuvable — le test doit être mis à jour`);
  const start = m.index;

  // 1. Sauter la liste de paramètres, par appariement de parenthèses.
  let i = src.indexOf("(", start);
  if (i < 0) throw new Error(`signature de ${name} illisible`);
  for (let paren = 0; i < src.length; i++) {
    if (src[i] === "(") paren++;
    else if (src[i] === ")" && --paren === 0) { i++; break; }
  }

  // 2. Le `{` du corps est le premier suivi d'une fin de ligne (les accolades de
  //    type littéral portent du contenu après elles, sur la même ligne).
  while (i < src.length && !(src[i] === "{" && /^[ \t]*\r?\n/.test(src.slice(i + 1, i + 4)))) i++;
  if (i >= src.length) throw new Error(`corps de ${name} introuvable — extracteur à revoir`);

  // 3. Compter jusqu'à l'accolade fermante appariée.
  let depth = 0;
  let mode: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") { mode = "line"; continue; }
      if (c === "/" && n === "*") { mode = "block"; i++; continue; }
      if (c === "'" || c === '"' || c === "`") { mode = c; continue; }
      if (c === "{") { depth++; continue; }
      if (c === "}") { if (--depth === 0) { i++; break; } continue; }
    } else if (mode === "line") {
      if (c === "\n") mode = "code";
    } else if (mode === "block") {
      if (c === "*" && n === "/") { mode = "code"; i++; }
    } else {
      if (c === "\\") { i++; continue; }
      if (c === mode) mode = "code";
    }
  }
  if (depth !== 0) throw new Error(`corps de ${name} non délimité — extracteur à revoir`);

  const out = src.slice(start, i);
  const strays = out.slice(m[0].length).match(/^(?:export )?(?:async )?function \w+/gm);
  if (strays) throw new Error(`l'extraction de ${name} a happé ${strays.join(", ")} — extracteur à revoir`);
  return out;
}

/** Le prédicat de quarantaine, sous ses deux formes d'alias. */
const GUARD_RE = /\((?:wt\.)?status IS NULL OR (?:wt\.)?status = 'active'\)/;

// ── 1. Les 4 portes du chemin règlement, lues dans le source livré ───────────
console.log("\n1. Le prédicat `status` est présent dans les 4 requêtes du chemin règlement");
{
  eq("getAvailableTransactions (ce qui est PROPOSÉ au règlement)",
    GUARD_RE.test(body(ENGINE, "getAvailableTransactions")), true);
  eq("getOverdueBuckets (pas d'impayé inextinguible)",
    GUARD_RE.test(body(ENGINE, "getOverdueBuckets")), true);

  // loadSelection n'est pas exportée : c'est la porte bloquante.
  const sel = body(ENGINE, "loadSelection");
  eq("loadSelection ramène la colonne status", /SELECT[^`]*\bstatus\b/.test(sel), true);
  eq("loadSelection REFUSE (return error) au lieu de filtrer",
    /status !== "active"[\s\S]{0,220}return \{ error:/.test(sel), true);

  // Cette assertion regexait le FICHIER entier, qui contient deux
  // `UPDATE wallet_transactions` — celui du lock et celui de l'unlock. Elle ne
  // pouvait donc pas distinguer les deux. (Réserve R3 du 2e audit.)
  const lock = body(ENGINE, "lockSettlement");
  eq("l'UPDATE de lockSettlement porte le prédicat (3e ligne de défense)",
    /UPDATE wallet_transactions[\s\S]{0,220}AND \(status IS NULL OR status = 'active'\)/.test(lock), true);
  eq("lockSettlement avorte sur compte partiel (pas de règlement bancal)",
    /changes !== \w+\.length/.test(lock), true);
  // Symétrie voulue : l'unlock REMET à 0 des lignes déjà réglées, y compris si
  // elles ont été mises en quarantaine entre-temps. Le filtrer y laisserait des
  // lignes settled=1 orphelines d'un règlement supprimé.
  eq("unlockSettlement ne porte PAS le prédicat (volontaire)",
    GUARD_RE.test(body(ENGINE, "unlockSettlement")), false);

  const arb = body(QUERIES, "arbitrateQuarantinedTransaction");
  eq("le rejet exige settled = 0",
    /decision === "reject" \? "AND settled = 0"/.test(arb), true);
  eq("le verrou settled est interpolé dans l'UPDATE",
    /UPDATE wallet_transactions SET status = \? WHERE id = \? AND status = 'quarantined' \$\{settledGuard\}/.test(arb), true);
  eq("l'approbation n'est PAS verrouillée par settled (chemin de réparation)",
    /AND settled = 0`/.test(arb), false);
}

// ── 2. Sémantique, sur des lignes réelles ────────────────────────────────────
console.log("\n2. Comportement : une ligne en quarantaine n'entre nulle part");
{
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE wallet_transactions (
      id INTEGER PRIMARY KEY, player_id INTEGER, game_id INTEGER,
      type TEXT, amount REAL, currency TEXT DEFAULT 'USDT', source TEXT,
      settled INTEGER DEFAULT 0, settlement_id INTEGER, status TEXT DEFAULT 'active',
      tx_datetime TEXT, tx_date TEXT);
  `);
  const ins = db.prepare(`INSERT INTO wallet_transactions
    (id, player_id, game_id, type, amount, source, settled, status, tx_datetime, tx_date)
    VALUES (?,?,6,?,?,'sync',?,?,?,?)`);
  //   id, player, type,          montant, settled, status
  ins.run(1, 42, "deposit",     1000,   0, "active",      "2026-08-10T10:00:00Z", "2026-08-10");
  ins.run(2, 42, "withdrawal",  1500,   0, "active",      "2026-08-11T10:00:00Z", "2026-08-11");
  ins.run(3, 42, "deposit",   250000,   0, "quarantined", "2026-08-12T10:00:00Z", "2026-08-12"); // le cas F1
  ins.run(4, 42, "deposit",     9999,   0, "rejected",    "2026-08-13T10:00:00Z", "2026-08-13");

  const GUARD = `(status IS NULL OR status = 'active')`;

  // (a) ce qui est proposé au règlement
  const avail = db.prepare(`
    SELECT id FROM wallet_transactions
    WHERE game_id = 6 AND player_id = 42 AND settled = 0
      AND source IN ('sync','manual') AND ${GUARD}
    ORDER BY id`).all() as { id: number }[];
  eq("seules les 2 lignes actives sont proposées", avail.map(r => r.id), [1, 2]);
  eq("la ligne de 250 000 n'est PAS proposée", avail.some(r => r.id === 3), false);

  // (b) le montant qu'un règlement de toute la sélection proposée produirait
  const t = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type='withdrawal' THEN amount ELSE -amount END),0) AS net
    FROM wallet_transactions WHERE id IN (1,2)`).get() as { net: number };
  eq("net réglable = 1500 − 1000", t.net, 500);
  eq("dû opérateur à 50% = 250", t.net * 50 / 100, 250);
  // Sans la garde, la ligne 3 entrait : net = 500 − 250 000 → facture de −124 750.
  const sansGarde = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type='withdrawal' THEN amount ELSE -amount END),0) AS net
    FROM wallet_transactions WHERE id IN (1,2,3)`).get() as { net: number };
  eq("ce que la faille produisait (pour mémoire)", sansGarde.net * 50 / 100, -124750);

  // (c) l'UPDATE du lock : si la ligne 3 atteignait le lock, le compte ne tombe pas juste
  //     et lockSettlement annule TOUTE la transaction.
  const ids = [1, 2, 3];
  const upd = db.prepare(`
    UPDATE wallet_transactions SET settled = 1, settlement_id = 99
    WHERE id IN (1,2,3) AND settled = 0 AND ${GUARD}`).run();
  eq("le lock ne marque que 2 lignes sur 3 demandées", upd.changes, 2);
  eq("→ upd.changes !== ids.length déclenche l'avortement", upd.changes !== ids.length, true);

  // (d) impayés : une ligne en quarantaine ne peut pas devenir un impayé éternel
  const overdue = db.prepare(`
    SELECT id FROM wallet_transactions
    WHERE game_id = 6 AND settled = 0 AND source IN ('sync','manual') AND ${GUARD}`).all() as { id: number }[];
  eq("aucune ligne non arbitrée en impayé", overdue.some(r => [3, 4].includes(r.id)), false);

  db.close();
}

// ── 3. Arbitrage : le rejet est verrouillé, l'approbation reste ouverte ───────
console.log("\n3. Arbitrage : pas de RÉPUDIATION d'une ligne qui adosse un règlement");
{
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE wallet_transactions (
    id INTEGER PRIMARY KEY, settled INTEGER, settlement_id INTEGER, status TEXT)`);
  const ins = db.prepare(`INSERT INTO wallet_transactions VALUES (?,?,?,?)`);
  ins.run(1, 0, null, "quarantined");  // arbitrable
  ins.run(2, 1, 176, "quarantined");   // le cas F1 : réglée ET encore en quarantaine
  ins.run(3, 0, null, "active");       // déjà arbitrée
  ins.run(4, 1, 177, "quarantined");   // idem 2, pour tester l'autre décision

  // Reproduit exactement la construction de arbitrateQuarantinedTransaction :
  // le verrou `settled = 0` ne s'applique qu'au rejet.
  const arb = (id: number, decision: "approve" | "reject") => db.prepare(
    `UPDATE wallet_transactions SET status = ? WHERE id = ? AND status = 'quarantined' ` +
    (decision === "reject" ? "AND settled = 0" : "")
  ).run(decision === "approve" ? "active" : "rejected", id).changes;

  eq("une ligne en quarantaine non réglée est rejetable", arb(1, "reject"), 1);
  eq("une ligne en quarantaine DÉJÀ RÉGLÉE ne peut PAS être rejetée", arb(2, "reject"), 0);
  eq("une ligne déjà arbitrée est refusée", arb(3, "reject"), 0);
  eq("la ligne 2 garde son statut après rejet refusé",
    (db.prepare(`SELECT status FROM wallet_transactions WHERE id=2`).get() as any).status, "quarantined");

  // L'autre moitié de la règle : approuver une ligne réglée DOIT rester possible.
  // Sinon, un règlement payé (que unlockSettlement refuse de délocker) enferme la
  // ligne hors de tous les soldes, définitivement.
  eq("une ligne réglée peut être APPROUVÉE (seul chemin de réparation)", arb(4, "approve"), 1);
  eq("→ elle rejoint les agrégats, cohérente avec le montant déjà facturé",
    (db.prepare(`SELECT status FROM wallet_transactions WHERE id=4`).get() as any).status, "active");
  eq("son rattachement au règlement est intact",
    (db.prepare(`SELECT settled, settlement_id FROM wallet_transactions WHERE id=4`).get() as any).settlement_id, 177);
  eq("approuver deux fois ne fait rien (verrou status)", arb(4, "approve"), 0);
  db.close();
}

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertion(s) OK, ${failures.length} échec(s)`);
if (failures.length > 0) { console.log("Échecs :", failures.join(" · ")); process.exit(1); }
