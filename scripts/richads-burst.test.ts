// Seuil de rafale par IP de logRichAdsClick, sur base SQLite temporaire.
// Run: npx tsx scripts/richads-burst.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ Le seuil (10 clics/IP/heure) est du SQL à l'intérieur de logRichAdsClick :  │
// │ ni les tests de fonctions pures, ni le run prod ne l'exerçaient. Il n'a     │
// │ JAMAIS été observé se déclencher sélectivement — et c'est lui qui décide    │
// │ si un clic compte dans « clics uniques », le chiffre qui sert à classer     │
// │ les créas. Un seuil trop bas exclut du trafic sain, un seuil mort laisse    │
// │ passer les rafales.                                                        │
// │                                                                            │
// │ On appelle la VRAIE fonction avec une base injectée. Répliquer son SQL      │
// │ dans le test ne prouverait rien sur le code exécuté en prod — erreur déjà   │
// │ commise sur cleanGeoName, qui passait au vert avec le bug en place parce    │
// │ que le test contournait le câblage.                                        │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { logRichAdsClick, IP_BURST_THRESHOLD, hashIp } from "../lib/richads";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148";

// Forme courante de la table en prod. Si l'INSERT de logRichAdsClick gagne une
// colonne sans qu'elle soit ajoutée ici, l'insertion échoue → les compteurs
// tombent à 0 et les tests passent au rouge. Pas d'échec silencieux possible :
// logRichAdsClick avale ses erreurs, donc c'est le comptage qui fait foi.
const DDL = `
  CREATE TABLE richads_clicks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    clicked_at  TEXT NOT NULL DEFAULT (datetime('now')),
    source      TEXT NOT NULL,
    cre         TEXT NOT NULL,
    cid         TEXT,
    sid         TEXT,
    app         TEXT,
    geo         TEXT,
    cost        REAL,
    user_type   TEXT,
    click_id    TEXT,
    ip_hash     TEXT,
    ip_source   TEXT,
    ip_hops     INTEGER,
    user_agent  TEXT,
    flags       TEXT NOT NULL DEFAULT '',
    is_unique   INTEGER NOT NULL DEFAULT 1
  );
`;

const tmp = path.join(os.tmpdir(), `richads-burst-${process.pid}.db`);
fs.rmSync(tmp, { force: true });
const db = new Database(tmp);
db.exec(DDL);

/** Un clic depuis `ip`, click_id unique — isole le flag suspect_ip. */
function click(ip: string | null, tag: string) {
  logRichAdsClick(
    { cre: "48211", cid: "T", cb: `CB-${tag}`, ip, userAgent: UA, cost: "0.02" },
    db,
  );
}

function flagsOf(tag: string): string {
  const row = db.prepare(`SELECT flags FROM richads_clicks WHERE click_id = ?`).get(`CB-${tag}`) as { flags: string } | undefined;
  return row ? row.flags : "LIGNE ABSENTE";
}

const IP_A = "198.51.100.77";
const IP_B = "203.0.113.5";

console.log("\nFrontière du seuil — le (N+1)-ième clic est le premier flagué");
for (let i = 1; i <= IP_BURST_THRESHOLD; i++) click(IP_A, `a${i}`);
eq(`${IP_BURST_THRESHOLD} clics insérés`,
  (db.prepare(`SELECT COUNT(*) AS n FROM richads_clicks`).get() as any).n, IP_BURST_THRESHOLD);
eq(`clic 1 propre`, flagsOf("a1"), "");
eq(`clic ${IP_BURST_THRESHOLD} (dernier sous le seuil) propre`, flagsOf(`a${IP_BURST_THRESHOLD}`), "");

click(IP_A, "a11");
eq(`clic ${IP_BURST_THRESHOLD + 1} flagué`, flagsOf("a11"), "suspect_ip");
click(IP_A, "a12");
eq(`clic ${IP_BURST_THRESHOLD + 2} flagué aussi`, flagsOf("a12"), "suspect_ip");

console.log("\nis_unique suit le flag");
eq("clic propre → is_unique=1",
  (db.prepare(`SELECT is_unique FROM richads_clicks WHERE click_id='CB-a1'`).get() as any).is_unique, 1);
eq("clic flagué → is_unique=0",
  (db.prepare(`SELECT is_unique FROM richads_clicks WHERE click_id='CB-a11'`).get() as any).is_unique, 0);

console.log("\nLe compteur est cloisonné par IP");
click(IP_B, "b1");
eq("une autre IP repart de zéro", flagsOf("b1"), "");
eq("ip_hash distincts", hashIp(IP_A) === hashIp(IP_B), false);

console.log("\nFenêtre glissante — les clics anciens ne comptent plus");
// 20 clics de la même IP, mais vieux de 90 minutes : hors fenêtre de 60 min.
const oldIp = "192.0.2.50";
const ins = db.prepare(
  `INSERT INTO richads_clicks (clicked_at, source, cre, click_id, ip_hash, flags, is_unique)
   VALUES (datetime('now','-90 minutes'), 'richads/48211', '48211', ?, ?, '', 1)`
);
for (let i = 1; i <= 20; i++) ins.run(`CB-old${i}`, hashIp(oldIp));
click(oldIp, "fresh1");
eq("20 clics vieux de 90 min → clic neuf propre", flagsOf("fresh1"), "");

// Contre-épreuve : les mêmes 20 clics DANS la fenêtre doivent bien flaguer.
const recentIp = "192.0.2.51";
const insRecent = db.prepare(
  `INSERT INTO richads_clicks (clicked_at, source, cre, click_id, ip_hash, flags, is_unique)
   VALUES (datetime('now','-5 minutes'), 'richads/48211', '48211', ?, ?, '', 1)`
);
for (let i = 1; i <= 20; i++) insRecent.run(`CB-rec${i}`, hashIp(recentIp));
click(recentIp, "fresh2");
eq("20 clics vieux de 5 min → clic neuf flagué", flagsOf("fresh2"), "suspect_ip");

console.log("\nSans IP, pas de flag de rafale (le clic est loggé quand même)");
for (let i = 1; i <= 15; i++) click(null, `noip${i}`);
eq("clic sans IP non flagué", flagsOf("noip15"), "");
eq("clic sans IP bien présent en base",
  (db.prepare(`SELECT COUNT(*) AS n FROM richads_clicks WHERE ip_hash IS NULL`).get() as any).n, 15);

console.log("\nCumul avec duplicate");
logRichAdsClick({ cre: "48211", cid: "T", cb: "CB-a1", ip: IP_A, userAgent: UA }, db);
const dupRow = db.prepare(
  `SELECT flags FROM richads_clicks WHERE click_id='CB-a1' ORDER BY id DESC LIMIT 1`
).get() as { flags: string };
eq("click_id rejoué depuis une IP en rafale → les deux flags", dupRow.flags, "duplicate,suspect_ip");

db.close();
fs.rmSync(tmp, { force: true });

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertions passées, ${failures.length} échec(s)`);
if (failures.length > 0) { failures.forEach(f => console.log("   -", f)); process.exit(1); }
