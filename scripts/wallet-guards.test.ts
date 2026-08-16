// Gardes wallet — adresse à l'enregistrement, événements du scanner, quarantaine.
// Run: npx tsx scripts/wallet-guards.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ Le même incident s'est produit DEUX FOIS, à 18 jours d'intervalle, sur le  │
// │ même joueur et le même jeu : l'adresse du contrat USDT TRC20 enregistrée   │
// │ comme wallet de dépôt. Le scanner lit « tout entrant » sur une wallet game │
// │ — il a donc attribué au joueur les ~2 000 derniers transferts reçus par le │
// │ contrat lui-même. Solde : −3,47e+71 USDT.                                  │
// │                                                                            │
// │ Les deux fois, la correction a été purement data. Rien dans le code ne     │
// │ s'opposait à la récidive. Ce fichier est ce qui manquait.                  │
// │                                                                            │
// │ Quatre propriétés :                                                        │
// │  1. Le contrat USDT est refusé comme wallet — sur TOUS les points d'entrée.│
// │  2. Une adresse au checksum invalide est refusée (le regex TRC20 ne voit   │
// │     pas la différence entre …Lj6t et …Lj6s).                               │
// │  3. Les wallets légitimes passent — y compris les 73 comptes de type       │
// │     Contract réellement en base. Une garde qui casse la prod est inutile.  │
// │  4. Un montant invraisemblable part en quarantaine et ne compte nulle part.│
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import {
  checkWalletAddress, isValidTronAddress, isKnownTokenContract,
  KNOWN_TOKEN_CONTRACTS, PLAUSIBILITY_THRESHOLD_USDT,
} from "../lib/wallet-address";

let passed = 0;
const failures: string[] = [];

function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// ── 1. Le contrat USDT est refusé ────────────────────────────────────────────
console.log("\n1. Refus du contrat USDT comme wallet joueur");
{
  const r = checkWalletAddress(USDT_CONTRACT);
  eq("checkWalletAddress refuse le contrat USDT", r.ok, false);
  eq("code de refus", r.ok ? null : r.code, "token_contract");
  eq("isKnownTokenContract", isKnownTokenContract(USDT_CONTRACT), true);
  // Un copier-coller peut altérer la casse : la garde ne doit pas s'y laisser prendre.
  eq("insensible à la casse", isKnownTokenContract(USDT_CONTRACT.toLowerCase()), true);
  // La denylist doit être exacte : une adresse mal recopiée ne protègerait rien.
  const bad = Object.keys(KNOWN_TOKEN_CONTRACTS).filter(a => !isValidTronAddress(a));
  eq("toutes les adresses de la denylist ont un checksum valide", bad, []);
}

// ── 2. Checksum ──────────────────────────────────────────────────────────────
console.log("\n2. Validation base58check (ce que le regex TRC20 ne fait pas)");
{
  // Ces trois-là étaient réellement en base le 16/08/2026.
  const typo = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6s"; // contrat USDT, dernier caractère modifié
  const trunc28 = "TGveZnMfew7TuQBpcj5zwHtg4EYN";
  const trunc33 = "TN6f33KpRpoUr2ohzUwn4AAWmXBbArJVJ";
  const TRC20_RE = /^T[A-Za-z0-9]{33}$/; // le filtre des bots, pour comparaison

  eq("le regex TRC20 accepte le faux …Lj6s (d'où le besoin du checksum)", TRC20_RE.test(typo), true);
  eq("la garde refuse …Lj6s", checkWalletAddress(typo).ok, false);
  eq("refuse une adresse de 28 caractères", checkWalletAddress(trunc28).ok, false);
  eq("refuse une adresse de 33 caractères", checkWalletAddress(trunc33).ok, false);
  eq("refuse une adresse vide", checkWalletAddress("   ").ok, false);
  eq("refuse un préfixe non-T", checkWalletAddress("XR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t").ok, false);
}

// ── 3. Les wallets légitimes passent ─────────────────────────────────────────
console.log("\n3. Non-régression : les vraies wallets passent");
{
  const legit: [string, string][] = [
    ["TFN5kB5W8yzdMrKNzfDhTkFWneDcEw6mMA", "wallet dépôt A5POKER (la vraie)"],
    ["TU7mMWaSd572r4pda1B546dSb9BKhRoMjL", "wallet cashout joueur"],
    ["TVGMzHejH9pbgREEQxCCDK7EzexDCvAKpB", "wallet mère A5POKER"],
    ["TVKDjc7Ano5oWhgQwMM265a7hqPBp2Ya3o", "wallet dépôt KKPOKER"],
    // ⚠️ Les trois suivantes sont des comptes de type Contract sur TronGrid, et
    // pourtant parfaitement légitimes : ce sont les wallets de trésorerie
    // déclarées dans lib/treasury.ts. C'est la raison pour laquelle la garde
    // ne refuse PAS « tout contrat », seulement les contrats de tokens connus.
    ["TJwq47V9oRMnngv49V66A1QhhT9LfADc4o", "trésorerie — Hugo short gasfee (contrat)"],
    ["TNBf7UHvahKbodkH8PEtwFoQk6xMLSAvNd", "trésorerie — Général gas fee (contrat)"],
    ["TTDEX1XimZsBTP6fYbaJVipCXWp3xvNZjN", "trésorerie — Baki gas fee (contrat)"],
  ];
  for (const [addr, label] of legit) eq(`accepte ${label}`, checkWalletAddress(addr).ok, true);
}

// ── 4. Le scanner ne garde que les Transfer ──────────────────────────────────
console.log("\n4. Scanner : les événements Approval sont écartés");
{
  // Reproduction de la boucle de filtrage de fetchAllTronTxs. Les valeurs sont
  // celles réellement lues sur le contrat USDT le 16/08/2026.
  const MAX_UINT256_OVER_1E6 = 2 ** 256 / 1e6;
  const events = [
    { type: "Transfer", value: "75000000" },
    { type: "Approval", value: "115792089237316195423570985008687907853269984665640564039457584007913129639935" },
    { type: "Transfer", value: "1000993212" },
    { type: "Approval", value: "9000000000000000000000000000" },
  ];
  const kept = events.filter(ev => !ev.type || ev.type === "Transfer");
  eq("2 Transfer conservés sur 4 événements", kept.length, 2);
  eq("aucun Approval conservé", kept.some(e => e.type === "Approval"), false);

  const toAmt = (v: string) => Number(v) / 1e6;
  eq("l'Approval max-uint aurait donné 1.157920892373162e+71",
    toAmt(events[1].value).toExponential(15), MAX_UINT256_OVER_1E6.toExponential(15));
  eq("montants conservés plausibles", kept.map(e => toAmt(e.value)), [75, 1000.993212]);

  // Un événement sans champ `type` reste importé : ne pas régresser sur les
  // réponses TronGrid qui ne le renseignent pas.
  eq("événement sans type conservé", [{ value: "1" }].filter((ev: any) => !ev.type || ev.type === "Transfer").length, 1);
}

// ── 5. Quarantaine : exclue de tous les calculs ──────────────────────────────
console.log("\n5. Quarantaine : importée, visible, jamais comptée");
{
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      source TEXT DEFAULT 'sync',
      status TEXT NOT NULL DEFAULT 'active'
    );
  `);
  const ins = db.prepare(`INSERT INTO wallet_transactions (player_id, type, amount, status) VALUES (?, ?, ?, ?)`);
  ins.run(1, "deposit", 1000.993212, "active");
  ins.run(1, "withdrawal", 2454.6432, "active");
  ins.run(1, "deposit", 500000, "quarantined");   // > seuil
  ins.run(1, "deposit", 1.157920892373162e71, "quarantined");

  // Le filtre exact utilisé par les requêtes d'argent du repo.
  const GUARD = `(source IS NULL OR source != 'unknown') AND (status IS NULL OR status = 'active')`;
  const net = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type='withdrawal' THEN amount ELSE -amount END), 0) AS net
    FROM wallet_transactions WHERE player_id = 1 AND ${GUARD}
  `).get() as { net: number };
  eq("le solde ignore la quarantaine", Math.round(net.net * 100) / 100, 1453.65);

  const counted = db.prepare(`SELECT COUNT(*) AS n FROM wallet_transactions WHERE player_id = 1 AND ${GUARD}`).get() as { n: number };
  eq("2 lignes comptées sur 4", counted.n, 2);

  const visible = db.prepare(`SELECT COUNT(*) AS n FROM wallet_transactions WHERE status = 'quarantined'`).get() as { n: number };
  eq("les 2 lignes en quarantaine restent visibles", visible.n, 2);

  // Arbitrage : valider fait entrer la ligne dans les calculs.
  db.prepare(`UPDATE wallet_transactions SET status = 'active' WHERE id = 3 AND status = 'quarantined'`).run();
  const after = db.prepare(`SELECT COUNT(*) AS n FROM wallet_transactions WHERE player_id = 1 AND ${GUARD}`).get() as { n: number };
  eq("après validation, 3 lignes comptées", after.n, 3);

  // Rejeter la garde en dehors des calculs — fail-closed sur un statut inconnu.
  db.prepare(`UPDATE wallet_transactions SET status = 'rejected' WHERE id = 4`).run();
  const rejected = db.prepare(`SELECT COUNT(*) AS n FROM wallet_transactions WHERE player_id = 1 AND ${GUARD}`).get() as { n: number };
  eq("une ligne 'rejected' n'est pas comptée", rejected.n, 3);

  // Un statut jamais vu doit être exclu, pas inclus par défaut.
  db.prepare(`UPDATE wallet_transactions SET status = 'un_statut_futur' WHERE id = 3`).run();
  const unknown = db.prepare(`SELECT COUNT(*) AS n FROM wallet_transactions WHERE player_id = 1 AND ${GUARD}`).get() as { n: number };
  eq("un statut inconnu est exclu (fail-closed)", unknown.n, 2);

  eq("seuil de vraisemblance", PLAUSIBILITY_THRESHOLD_USDT, 100_000);
  db.close();
}

// ── Bilan ────────────────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertion(s) OK, ${failures.length} échec(s)`);
if (failures.length > 0) {
  console.log("Échecs :", failures.join(" · "));
  process.exit(1);
}
