// Hot wallet de room vs mère opérateur — règle de classement du Pass 1 du sync.
// Run: npx tsx scripts/room-hot-wallet.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ Le 2026-09-22, cinq dépôts du joueur Raph (2 525 USDT) ne sont jamais      │
// │ entrés en base. Le Pass 1 refusait tout entrant venant d'une adresse       │
// │ présente dans wallet_meres — et le hot wallet de la room OkPay y est       │
// │ enregistré, parce que sur AKS et OKPOKER c'est la room qui paie les        │
// │ cashouts (116 retraits réels importés par le Pass 2).                      │
// │                                                                            │
// │ Une adresse, deux rôles selon la room. La garde n'en voyait qu'un. Le P&L  │
// │ affichait net 3 856,85 au lieu de 1 331,85 : 1 262,50 USDT sur le point    │
// │ d'être versés en trop sur un deal à 50 %.                                  │
// │                                                                            │
// │ Cinq propriétés, sur de VRAIES transactions on-chain :                     │
// │  1. Les 5 dépôts de Raph remontent en 'deposit'.                           │
// │  2. CONTREFACTUEL — le bug remis, ils repartent en 'skip'. Sans ça le      │
// │     test ne prouverait rien.                                               │
// │  3. Un vrai retrait AKS payé par ce même hot wallet reste un 'withdrawal'  │
// │     — avant ET après le correctif.                                         │
// │  4. Les 16 lignes de Maxime (mères QQPK, argent opérateur) restent 'skip'  │
// │     — le correctif ne les débloque pas, leur nature n'est pas tranchée.    │
// │  5. Le SQL réel : la migration classe UNE adresse, et la requête           │
// │     opérateur n'exclut qu'elle.                                            │
// └────────────────────────────────────────────────────────────────────────────┘
// ┌─ CE QU'IL NE PROUVE PAS ───────────────────────────────────────────────────┐
// │ • Rien sur le Pass 2, ni sur l'écriture en base (insertWalletTransaction-  │
// │   ByHash, dédup, quarantaine) : la règle testée ici est le CLASSEMENT.     │
// │ • Rien sur le montant final d'un règlement : le moteur est ailleurs.       │
// │ • Les adresses de Maxime restent 'skip' PAR CONSTRUCTION (mères QQPK non   │
// │   reclassées). Le jour où l'une d'elles serait classée room_hot, ce test   │
// │   basculerait — c'est voulu, il doit alors être relu.                      │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import { classifyIncomingOnGameWallet } from "../lib/wallet-sync-rules";

let passed = 0;
const failures: string[] = [];

function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

const lower = (s: string) => s.toLowerCase();
const set = (...a: string[]) => new Set(a.map(lower));

// ── Adresses RÉELLES (prod, lues le 2026-09-23) ──────────────────────────────
const HOT_OKPAY   = "TYCBsKvJSrLoj6pudJCLFNFYdBcntNP1gU"; // mère ACTIVE AKS (id 12) + OKPOKER (id 14)
const A5_MERE_1   = "TVGMzHejH9pbgREEQxCCDK7EzexDCvAKpB"; // mère active A5POKER (id 10)
const A5_MERE_2   = "TRNCKKw4Do1GWPw6wbJqpd6LNSr8BBjUFj"; // mère active A5POKER (id 21), créée le 2026-09-23
const QQPK_MERE_1 = "TCAafeU9EipnA21r9KwscLtWP5vd3fpTab"; // mère active QQPK (id 13)
const QQPK_MERE_2 = "TXynrsKXHpLcyCsQWaC4eir8vWR1UkC4uf"; // mère active QQPK (id 18)
const KK_MERE_RET = "TJLBqAyVm1uXycwE39HRPhyR8s7NXPjTpv"; // mère KKPOKER RETIRÉE (id 4) = cashout de Max
const RAPH_SOURCE_HISTO = "TXLbbSZe3Zteoj"; // source habituelle des dépôts de Raph jusqu'au 2026-08-12

// Jeux d'adresses tels que le sync les construit, game par game.
const A5_ACTIVE_MERES  = set(A5_MERE_1, A5_MERE_2);
const AKS_ACTIVE_MERES = set(HOT_OKPAY);
const NO_CASHOUT       = new Set<string>();

// Après correctif : le hot wallet n'est plus dans le jeu 'operator'.
const OPERATOR_MERES_FIXED = set(A5_MERE_1, A5_MERE_2, QQPK_MERE_1, QQPK_MERE_2, KK_MERE_RET);
// Avant correctif (bug) : toutes les mères, hot wallet compris.
const OPERATOR_MERES_BUGGY = set(A5_MERE_1, A5_MERE_2, QQPK_MERE_1, QQPK_MERE_2, KK_MERE_RET, HOT_OKPAY);

// ── 1. Les 5 dépôts RÉELS de Raph (A5POKER, 2026-09-22) ──────────────────────
// Wallet de dépôt TX4pmGfFVG1nXmMjmUtJSggSDowHJnBSnF (player_wallet_games id 989,
// joueur Raph pid 16, game A5POKER). Hashes relevés sur TronGrid.
const RAPH_DEPOSITS = [
  { hash: "de9ec91d711153e56a4cfc6f8f24494420ea3ef4da15ef529d92ae6e91ff6abd", amount: 799, when: "2026-09-22T19:45:12Z" },
  { hash: "8464052b739d548fa92b5b2e91c0ccadbf46e7f48bbf3594ef907a3f93b79c54", amount: 799, when: "2026-09-22T19:50:24Z" },
  { hash: "0fd182ef9a40ec3bad2fa2b187b534566230ec1289514342e43fe1d1cb302c58", amount:  29, when: "2026-09-22T20:00:15Z" },
  { hash: "3b815d79653312bf84102d76690f8260f745f108b694f77081b8000d99240161", amount: 399, when: "2026-09-22T20:46:15Z" },
  { hash: "0cd80f8bb3d440d5307382dbef905f5da200ca77a30e6d99481ca1d317b74386", amount: 499, when: "2026-09-22T22:02:45Z" },
];

console.log("\n1. Les 5 dépôts réels de Raph (A5POKER ← hot wallet OkPay)");
for (const d of RAPH_DEPOSITS) {
  const v = classifyIncomingOnGameWallet({
    from: HOT_OKPAY,
    gameMereAddrs: A5_ACTIVE_MERES,
    operatorMereAddrs: OPERATOR_MERES_FIXED,
    ownCashoutAddrs: NO_CASHOUT,
  });
  eq(`${d.amount} USDT (${d.hash.slice(0, 8)}…)`, v, { action: "deposit", reason: "player_funds" });
}
eq("total remonté", RAPH_DEPOSITS.reduce((s, d) => s + d.amount, 0), 2525);

// ── 2. CONTREFACTUEL — le bug remis ──────────────────────────────────────────
// Sans ce bloc, le test n°1 ne prouverait rien : il faut le voir échouer.
console.log("\n2. Contrefactuel — hot wallet remis dans le jeu 'operator' (= le bug)");
for (const d of RAPH_DEPOSITS) {
  const v = classifyIncomingOnGameWallet({
    from: HOT_OKPAY,
    gameMereAddrs: A5_ACTIVE_MERES,
    operatorMereAddrs: OPERATOR_MERES_BUGGY,
    ownCashoutAddrs: NO_CASHOUT,
  });
  eq(`${d.amount} USDT écarté par le bug`, v, { action: "skip", reason: "operator_mere" });
}

// ── 3. Un vrai retrait AKS payé par le MÊME hot wallet ───────────────────────
// wallet_transactions id 75928 : Hugo Roine (pid 1), AKS, 2 527,37 USDT,
// 2026-07-09T17:20:33Z, hash 0afd6fda…, counterparty = HOT_OKPAY.
// Sur AKS le hot wallet EST mère active → 'withdrawal', et ça ne doit pas bouger.
console.log("\n3. Retrait AKS réel (id 75928, 2 527,37 USDT) — doit rester un retrait");
for (const [label, operators] of [["après correctif", OPERATOR_MERES_FIXED], ["avant correctif", OPERATOR_MERES_BUGGY]] as const) {
  const v = classifyIncomingOnGameWallet({
    from: HOT_OKPAY,
    gameMereAddrs: AKS_ACTIVE_MERES,
    operatorMereAddrs: operators,
    ownCashoutAddrs: NO_CASHOUT,
  });
  eq(`retrait AKS ${label}`, v, { action: "withdrawal", reason: "from_game_mere" });
}

// ── 4. Les 16 lignes de Maxime (pid 181, AKS) — nature NON tranchée ──────────
// Expéditeurs = mères QQPK, qui restent 'operator'. Elles doivent rester écartées
// avant ET après : le correctif ne doit pas décider à la place de Baki.
console.log("\n4. Les 16 lignes de Maxime (mères QQPK → wallet AKS) — restent écartées");
const MAXIME_LINES = [
  { from: QQPK_MERE_1, amount: 100, hash: "a3ba14e7ce2319f1" },
  { from: QQPK_MERE_2, amount: 330, hash: "6f0a9c432b2147df" },
  { from: QQPK_MERE_2, amount:  23, hash: "98db711fdc99b486" },
];
for (const [label, operators] of [["après correctif", OPERATOR_MERES_FIXED], ["avant correctif", OPERATOR_MERES_BUGGY]] as const) {
  for (const m of MAXIME_LINES) {
    const v = classifyIncomingOnGameWallet({
      from: m.from,
      gameMereAddrs: AKS_ACTIVE_MERES,
      operatorMereAddrs: operators,
      ownCashoutAddrs: NO_CASHOUT,
    });
    eq(`${m.amount} USDT ${label}`, v, { action: "skip", reason: "operator_mere" });
  }
}

// ── 5. Cas de bord hérités, qui ne doivent pas régresser ─────────────────────
console.log("\n5. Cas de bord");
// 5a. TJLB…/Max (2026-07-15) : adresse à la fois mère RETIRÉE d'un autre game ET
//     wallet de cashout du joueur → réinjection de ses fonds = vrai buy-in.
eq("réinjection depuis sa propre wallet de cashout", classifyIncomingOnGameWallet({
  from: KK_MERE_RET,
  gameMereAddrs: set("TAKSmereInexistantePourCeTest000000"),
  operatorMereAddrs: OPERATOR_MERES_FIXED,
  ownCashoutAddrs: set(KK_MERE_RET),
}), { action: "deposit", reason: "own_cashout" });
// 5b. « An active mère of THIS game still wins » : mère active du game scannée,
//     même si elle est aussi enregistrée comme cashout du joueur → retrait.
eq("mère active du game gagne sur le cashout", classifyIncomingOnGameWallet({
  from: A5_MERE_1,
  gameMereAddrs: A5_ACTIVE_MERES,
  operatorMereAddrs: OPERATOR_MERES_FIXED,
  ownCashoutAddrs: set(A5_MERE_1),
}), { action: "withdrawal", reason: "from_game_mere" });
// 5c. La source historique des dépôts de Raph (aucune mère) → dépôt, inchangé.
eq("source ordinaire", classifyIncomingOnGameWallet({
  from: RAPH_SOURCE_HISTO,
  gameMereAddrs: A5_ACTIVE_MERES,
  operatorMereAddrs: OPERATOR_MERES_FIXED,
  ownCashoutAddrs: NO_CASHOUT,
}), { action: "deposit", reason: "player_funds" });
// 5d. Casse : TronGrid rend du base58 sensible à la casse, la comparaison non.
eq("casse indifférente", classifyIncomingOnGameWallet({
  from: HOT_OKPAY.toUpperCase(),
  gameMereAddrs: AKS_ACTIVE_MERES,
  operatorMereAddrs: OPERATOR_MERES_FIXED,
  ownCashoutAddrs: NO_CASHOUT,
}), { action: "withdrawal", reason: "from_game_mere" });
// 5e. Expéditeur absent : ne doit pas lever, et n'est pas de l'argent opérateur.
eq("expéditeur vide", classifyIncomingOnGameWallet({
  from: "",
  gameMereAddrs: A5_ACTIVE_MERES,
  operatorMereAddrs: OPERATOR_MERES_FIXED,
  ownCashoutAddrs: NO_CASHOUT,
}), { action: "deposit", reason: "player_funds" });

// ── 6. Le SQL réel : migration + requête opérateur ───────────────────────────
// Table wallet_meres reconstruite à l'identique du DDL de prod, garnie des 19
// lignes réelles, puis migrée. On vérifie ce que la requête du Pass 1 rend.
console.log("\n6. Migration add_wallet_mere_kind_v1 sur les 19 mères réelles");
const db = new Database(":memory:");
db.exec(`CREATE TABLE wallet_meres (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), game_id INTEGER, status TEXT NOT NULL DEFAULT 'active',
  retired_at TEXT, UNIQUE(address, game_id))`);
const REAL_MERES: [number, string, string, number][] = [
  [1, "TUidVgaToQB9AxGdBsVzAwGQRkuqBW98Wr", "active", 1],
  [2, A5_MERE_1, "active", 1], [3, "TRWyGmpLeJAH8TSUr8WzA2KRuNUUaTMAdA", "active", 5],
  [4, KK_MERE_RET, "retired", 5], [5, A5_MERE_1, "retired", 5],
  [7, "TTxsvGS9tc38bn4SHNnW6agAcxSZMFXmuQ", "active", 5], [8, "TUidVgaToQB9AxGdBsVzAwGQRkuqBW98Wr", "active", 5],
  [10, A5_MERE_1, "active", 6], [11, "TKEMznWYfooD9o2CbajAMsd2Syg28gvR8S", "active", 5],
  [12, HOT_OKPAY, "active", 7], [13, QQPK_MERE_1, "active", 8], [14, HOT_OKPAY, "active", 10],
  [15, "TKtLFAJ6wWSHZmQNgZfUGbxFRK5wf8jEzJ", "active", 11], [16, "TDMm86DeHb4wqvoghxMS2oipt8MDu418Ma", "active", 12],
  [17, "TTwzh8oewEtpeG9W6qgJ524M4L2GsQJ9fP", "active", 5], [18, QQPK_MERE_2, "active", 8],
  [19, A5_MERE_1, "active", 13], [20, "TKpKE2y9VU8ZPALpWFt7UaQgfJRuVUhC4y", "active", 5],
  [21, A5_MERE_2, "active", 6],
];
const ins = db.prepare(`INSERT INTO wallet_meres (id, address, status, game_id) VALUES (?, ?, ?, ?)`);
for (const r of REAL_MERES) ins.run(...r);
eq("19 mères chargées", (db.prepare(`SELECT COUNT(*) AS n FROM wallet_meres`).get() as any).n, 19);

// La migration, telle qu'écrite dans lib/db.ts.
db.exec(`ALTER TABLE wallet_meres ADD COLUMN kind TEXT NOT NULL DEFAULT 'operator'`);
const changed = db.prepare(`UPDATE wallet_meres SET kind = 'room_hot' WHERE address = ?`).run(HOT_OKPAY);
eq("lignes reclassées room_hot", changed.changes, 2); // AKS + OKPOKER, la même adresse

const operatorRows = db.prepare(
  `SELECT address FROM wallet_meres WHERE COALESCE(kind, 'operator') = 'operator'`
).all() as { address: string }[];
const operatorSet = new Set(operatorRows.map(r => r.address.toLowerCase()));
eq("le hot wallet est HORS du jeu opérateur", operatorSet.has(lower(HOT_OKPAY)), false);
eq("les mères A5POKER y restent", operatorSet.has(lower(A5_MERE_1)) && operatorSet.has(lower(A5_MERE_2)), true);
eq("les mères QQPK y restent (Maxime non débloqué)", operatorSet.has(lower(QQPK_MERE_1)) && operatorSet.has(lower(QQPK_MERE_2)), true);
eq("la mère KK retirée y reste", operatorSet.has(lower(KK_MERE_RET)), true);
eq("adresses opérateur distinctes", operatorSet.size, 13); // 14 adresses en base − le hot wallet

// Le Pass 2 ne change pas : il lit les mères ACTIVES du game, kind confondu.
const aksActive = db.prepare(`SELECT address FROM wallet_meres WHERE game_id = 7 AND status = 'active'`).all() as { address: string }[];
eq("Pass 2 AKS voit toujours le hot wallet", aksActive.map(r => r.address), [HOT_OKPAY]);
const okActive = db.prepare(`SELECT address FROM wallet_meres WHERE game_id = 10 AND status = 'active'`).all() as { address: string }[];
eq("Pass 2 OKPOKER voit toujours le hot wallet", okActive.map(r => r.address), [HOT_OKPAY]);

// Idempotence : rejouer l'UPDATE ne déplace rien de plus.
const again = db.prepare(`UPDATE wallet_meres SET kind = 'room_hot' WHERE address = ?`).run(HOT_OKPAY);
eq("rejouable sans effet de bord", again.changes, 2);
eq("aucune autre ligne touchée", (db.prepare(`SELECT COUNT(*) AS n FROM wallet_meres WHERE kind = 'room_hot'`).get() as any).n, 2);

// ── 7. Durcissements issus de l'audit money-auditor ──────────────────────────
// F1 : la nature appartient à l'ADRESSE. Un ré-enregistrement de la mère (retrait
// puis ré-ajout, ou une 3e room) ne doit pas la faire retomber dans le jeu
// opérateur — ce serait le retour silencieux du bug.
console.log("\n7. Durcissements (audit)");
const operatorByAddress = () => new Set((db.prepare(`
  SELECT address FROM wallet_meres
  WHERE LOWER(address) NOT IN (SELECT LOWER(address) FROM wallet_meres WHERE kind = 'room_hot')
`).all() as { address: string }[]).map(r => r.address.toLowerCase()));

db.prepare(`INSERT INTO wallet_meres (address, label, game_id, status, kind) VALUES (?, 'ré-ajout 3e room', 99, 'active', 'operator')`).run(HOT_OKPAY);
eq("F1 — ré-ajout en 'operator' : l'adresse reste hors du jeu opérateur", operatorByAddress().has(lower(HOT_OKPAY)), false);
eq("F1 — les mères QQPK n'en sortent pas pour autant", operatorByAddress().has(lower(QQPK_MERE_1)), true);

// Contrefactuel F1 : avec le filtre ligne-à-ligne d'origine, ce même ré-ajout
// ramène l'adresse dans le jeu opérateur → le bug revient. Sans ça, le test
// ci-dessus ne prouverait pas que le durcissement sert à quelque chose.
const operatorByRow = new Set((db.prepare(
  `SELECT address FROM wallet_meres WHERE COALESCE(kind, 'operator') = 'operator'`
).all() as { address: string }[]).map(r => r.address.toLowerCase()));
eq("F1 contrefactuel — le filtre ligne-à-ligne, lui, ramène le bug", operatorByRow.has(lower(HOT_OKPAY)), true);

// Et la conséquence concrète, sur les 5 dépôts de Raph : le durcissement les garde.
eq("F1 — Raph reste importé après ré-ajout", classifyIncomingOnGameWallet({
  from: HOT_OKPAY, gameMereAddrs: A5_ACTIVE_MERES,
  operatorMereAddrs: operatorByAddress(), ownCashoutAddrs: NO_CASHOUT,
}), { action: "deposit", reason: "player_funds" });

// F2 : l'UPDATE de migration doit matcher quelle que soit la casse stockée.
const db2 = new Database(":memory:");
db2.exec(`CREATE TABLE wallet_meres (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, game_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active', kind TEXT NOT NULL DEFAULT 'operator', UNIQUE(address, game_id))`);
db2.prepare(`INSERT INTO wallet_meres (address, game_id) VALUES (?, 7)`).run(HOT_OKPAY.toLowerCase());
eq("F2 — casse-sensible : l'ancien `address = ?` rate la ligne",
  db2.prepare(`UPDATE wallet_meres SET kind='room_hot' WHERE address = ?`).run(HOT_OKPAY).changes, 0);
eq("F2 — `LOWER(address) = LOWER(?)` la trouve",
  db2.prepare(`UPDATE wallet_meres SET kind='room_hot' WHERE LOWER(address) = LOWER(?)`).run(HOT_OKPAY).changes, 1);

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertion(s) OK, ${failures.length} échec(s)`);
if (failures.length) {
  for (const f of failures) console.log("   -", f);
  process.exit(1);
}
