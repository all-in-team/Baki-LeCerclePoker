// Postbacks S2S de conversion — décision, unicité, transport.
// Run: npx tsx scripts/dzpk-postback.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ Un postback est un appel sortant vers un tiers : rien de ce qu'il produit  │
// │ n'est observable depuis le back-office. Ses deux échecs sont donc muets    │
// │ tous les deux, mais pas au même prix :                                     │
// │                                                                            │
// │  • ne pas envoyer  → le réseau optimise à l'aveugle sur notre budget ;     │
// │  • envoyer DEUX FOIS → le réseau compte deux conversions pour un joueur,   │
// │    et c'est ce chiffre-là qui décide de la suite des achats.               │
// │                                                                            │
// │ Les quatre propriétés vérifiées ici :                                      │
// │  1. Le click id traverse /go → Telegram → lead sans être altéré.           │
// │  2. Le réseau est déduit de la source, et JAMAIS deviné pour l'organique.  │
// │  3. Un lead ne poste qu'une fois — verrou posé avant l'appel réseau.       │
// │  4. Un échec réseau ne casse rien en amont et reste lisible en base.       │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import {
  buildStartParam, splitStartParam, cleanClickId, creToStartParam,
  CLICK_SEP, START_PARAM_MAX,
} from "../lib/richads";
import {
  resolveNetwork, buildPostbackUrl, sendConversionPostback, retryPostback,
  sendTestPostback, CB_PLACEHOLDER, type Fetcher,
} from "../lib/funnels/dzpk/postback";
import { recordStart } from "../lib/funnels/dzpk/leads";
import {
  DZPK_SCHEMA_SQL,
  DZPK_MATCH_SCHEMA_SQL, DZPK_MATCH_SCHEMA_SQL_2, DZPK_MATCH_SCHEMA_SQL_3,
  DZPK_POSTBACK_ALTER_CLICK, DZPK_POSTBACK_ALTER_SENT, DZPK_POSTBACK_ALTER_RESULT,
} from "../lib/funnels/dzpk/schema";
import type { DbLike } from "../lib/funnels/dzpk/leads";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

function freshDb(): DbLike & { exec(s: string): void; close(): void; prepare(s: string): any } {
  const db = new Database(":memory:");
  db.exec(DZPK_SCHEMA_SQL);
  db.exec(DZPK_MATCH_SCHEMA_SQL);
  db.exec(DZPK_MATCH_SCHEMA_SQL_2);
  db.exec(DZPK_MATCH_SCHEMA_SQL_3);
  db.exec(DZPK_POSTBACK_ALTER_CLICK);
  db.exec(DZPK_POSTBACK_ALTER_SENT);
  db.exec(DZPK_POSTBACK_ALTER_RESULT);
  return db as any;
}

/** Client HTTP de test : mémorise les URL appelées, rend le statut demandé. */
function stubFetcher(status = 200) {
  const calls: string[] = [];
  const f: Fetcher = async (url) => { calls.push(url); return { status }; };
  return { f, calls };
}

const PROPELLER = "https://ad.propellerads.com/conversion.php?aid=3918067&pid=&tid=158518&visitor_id={CB}";
const RICHADS = "https://us.ahows.co/log?action=conversion&key={CB}";

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nstart param — le click id voyage entier, la source cède en premier");

eq("cas nominal", buildStartParam("tgads-26845722", "A1b2C3d4"), "tgads_26845722--A1b2C3d4");
eq("sans cb : inchangé", buildStartParam("tgads-26845722", null), "tgads_26845722");
eq("sans cre : source direct", buildStartParam(null, "A1b2C3"), "direct--A1b2C3");
eq("casse du cb PRÉSERVÉE", buildStartParam("richads-4001300", "aB-cD_eF"), "richads_4001300--aB-cD_eF");

{
  // Le seul arbitrage qui coûte de l'argent : quand ça ne tient pas, c'est la
  // source qui est rognée. Un click id amputé produit un postback ignoré en
  // silence par le réseau.
  const cre = "a".repeat(32);
  const cb = "K".repeat(40);
  const out = buildStartParam(cre, cb);
  eq("dépassement : longueur bornée", out.length <= START_PARAM_MAX, true);
  eq("dépassement : le click id est INTACT", splitStartParam(out).clickId, cb);
  eq("dépassement : la source est tronquée", splitStartParam(out).source, "a".repeat(START_PARAM_MAX - CLICK_SEP.length - cb.length));
}

{
  // Charset Telegram (Bot API : A-Z a-z 0-9 _ -). Un start param hors charset
  // est rejeté par Telegram : le lead arriverait sans rien.
  const TELEGRAM_START = /^[A-Za-z0-9_-]{1,64}$/;
  eq("format valide, avec cb", TELEGRAM_START.test(buildStartParam("tgads-123", "aB-9_x")), true);
  eq("format valide, sans cb", TELEGRAM_START.test(buildStartParam("tgads-123", null)), true);
  eq("cb hors charset ⇒ ignoré", buildStartParam("tgads-123", "abc.def:ghi"), "tgads_123");
  eq("cb avec espace ⇒ ignoré", buildStartParam("tgads-123", "abc def"), "tgads_123");
  eq("macro non substituée ⇒ ignorée", buildStartParam("tgads-123", "[CLICK_ID]"), "tgads_123");
  eq("cb de 65 caractères ⇒ ignoré", cleanClickId("z".repeat(65)), null);
}

console.log("\ndécoupe — l'inverse exact, et les liens écrits à la main survivent");
eq("aller-retour", splitStartParam(buildStartParam("tgads-26845722", "A1b2C3")), { source: "tgads_26845722", clickId: "A1b2C3" });
eq("lien manuel sans séparateur", splitStartParam("tgads_cn_video3"), { source: "tgads_cn_video3", clickId: null });
eq("lien manuel avec UN tiret", splitStartParam("tgads-cn-video3"), { source: "tgads-cn-video3", clickId: null });
eq("payload absent", splitStartParam(null), { source: null, clickId: null });
eq("click id contenant le séparateur", splitStartParam("tgads_1--a--b"), { source: "tgads_1", clickId: "a--b" });
{
  // La garantie qui rend `--` sûr : la conversion de créative n'émet aucun tiret.
  const cres = ["tgads-1", "prop-cn-99", "TgAds--123", "a-b-c-d"];
  eq("creToStartParam n'émet jamais de tiret", cres.every(c => !creToStartParam(c).includes("-")), true);
}

console.log("\nréseau — déduit de la source, jamais deviné");
eq("tgads- → propeller", resolveNetwork("tgads-26845722"), "propeller");
eq("tgads_ (converti par /go) → propeller", resolveNetwork("tgads_26845722"), "propeller");
eq("richads- → richads", resolveNetwork("richads-4001300"), "richads");
eq("richads_ → richads", resolveNetwork("richads_4001300"), "richads");
eq("casse pliée", resolveNetwork("TgAds_123"), "propeller");
eq("organic → aucun", resolveNetwork("organic"), null);
eq("direct → aucun", resolveNetwork("direct"), null);
eq("unknown → aucun", resolveNetwork("unknown"), null);
eq("source inventée → aucun", resolveNetwork("bouche_a_oreille"), null);
eq("null → aucun", resolveNetwork(null), null);
// Le préfixe doit être un PRÉFIXE : une source qui contient « tgads » ailleurs
// n'est pas une campagne Propeller.
eq("sous-chaîne ≠ préfixe", resolveNetwork("promo_tgads_2026"), null);

console.log("\nURL — substitution de {CB}");
eq("propeller", buildPostbackUrl(PROPELLER, "A1b2C3"), "https://ad.propellerads.com/conversion.php?aid=3918067&pid=&tid=158518&visitor_id=A1b2C3");
eq("richads", buildPostbackUrl(RICHADS, "A1b2C3"), "https://us.ahows.co/log?action=conversion&key=A1b2C3");
eq("gabarit sans {CB} ⇒ null", buildPostbackUrl("https://x.test/conv?id=42", "A1b2C3"), null);
eq("placeholder répété", buildPostbackUrl(`https://x.test/?a=${CB_PLACEHOLDER}&b=${CB_PLACEHOLDER}`, "zz"), "https://x.test/?a=zz&b=zz");

// ─────────────────────────────────────────────────────────────────────────────
// Envoi. Les variables d'env sont posées ici et lues À CHAQUE appel par
// postback.ts (jamais mises en cache) : c'est ce qui rend ce test possible.
process.env.PROPELLER_POSTBACK_URL = PROPELLER;
process.env.RICHADS_POSTBACK_URL = RICHADS;

/** Crée un lead par le VRAI chemin : /start avec le payload que /go construit. */
function startedLead(db: any, tgId: number, cre: string | null, cb: string | null) {
  const payload = cre === null && cb === null ? null : buildStartParam(cre, cb);
  return recordStart({ telegram_id: tgId, first_name: `L${tgId}` }, payload, db).lead;
}

async function run() {
  console.log("\nenvoi — le chemin nominal");
  {
    const db = freshDb();
    const lead = startedLead(db, 5001, "tgads-26845722", "CB-TEST-1");
    eq("click id capté au /start", lead.click_id, "CB-TEST-1");
    eq("source first-touch", lead.source, "tgads_26845722");

    const { f, calls } = stubFetcher(200);
    const out = await sendConversionPostback(lead.id, { dbOverride: db, fetcher: f });
    eq("envoyé", out.sent, true);
    eq("réseau retenu", out.network, "propeller");
    eq("statut", out.status, 200);
    eq("URL appelée", calls[0], "https://ad.propellerads.com/conversion.php?aid=3918067&pid=&tid=158518&visitor_id=CB-TEST-1");

    const row = db.prepare(`SELECT postback_sent_at, postback_result FROM dzpk_leads WHERE id = ?`).get(lead.id);
    eq("verrou posé", row.postback_sent_at !== null, true);
    eq("résultat tracé", row.postback_result, "propeller 200");
    db.close();
  }

  console.log("\nunicité — la propriété qui coûte le plus cher si elle tombe");
  {
    const db = freshDb();
    const lead = startedLead(db, 5002, "richads-4001300", "CB-UNIQ");
    const { f, calls } = stubFetcher(200);

    await sendConversionPostback(lead.id, { dbOverride: db, fetcher: f });
    const second = await sendConversionPostback(lead.id, { dbOverride: db, fetcher: f });
    eq("second appel : rien envoyé", second.sent, false);
    eq("second appel : motif", second.skipped, "already_sent");
    eq("un seul appel réseau", calls.length, 1);

    // Le cas réel : deux passes du cron sur le même join, en parallèle.
    const db2 = freshDb();
    const lead2 = startedLead(db2, 5003, "tgads-1", "CB-RACE");
    const s = stubFetcher(200);
    const [a, b] = await Promise.all([
      sendConversionPostback(lead2.id, { dbOverride: db2, fetcher: s.f }),
      sendConversionPostback(lead2.id, { dbOverride: db2, fetcher: s.f }),
    ]);
    eq("concurrence : un seul envoi", [a.sent, b.sent].filter(Boolean).length, 1);
    eq("concurrence : un seul appel réseau", s.calls.length, 1);
    db.close(); db2.close();
  }

  console.log("\nrefus — les leads qui ne doivent RIEN déclencher");
  {
    const db = freshDb();
    const { f, calls } = stubFetcher(200);

    const organique = startedLead(db, 5010, null, null);
    eq("organique : source", organique.source, "organic");
    const o = await sendConversionPostback(organique.id, { dbOverride: db, fetcher: f });
    eq("organique : rien", [o.sent, o.skipped], [false, "no_click_id"]);

    // Lead venu d'une pub mais sans click id : c'est le cas de tout lead créé
    // avant la mise en service. Silencieux et normal.
    const sansCb = startedLead(db, 5011, "tgads-999", null);
    const s = await sendConversionPostback(sansCb.id, { dbOverride: db, fetcher: f });
    eq("pub sans click id : rien", s.skipped, "no_click_id");

    // Click id présent, mais source non achetée (achat direct, bouche-à-oreille).
    const direct = startedLead(db, 5012, null, "CB-DIRECT");
    eq("achat direct : source", direct.source, "direct");
    const d = await sendConversionPostback(direct.id, { dbOverride: db, fetcher: f });
    eq("achat direct : rien", d.skipped, "no_network");

    const inconnu = await sendConversionPostback(999999, { dbOverride: db, fetcher: f });
    eq("lead inexistant", inconnu.skipped, "lead_not_found");

    eq("aucun appel réseau du tout", calls.length, 0);
    db.close();
  }

  console.log("\néchec réseau — rien ne casse, tout reste lisible");
  {
    const db = freshDb();
    const lead = startedLead(db, 5020, "tgads-42", "CB-KO");
    const boom: Fetcher = async () => { throw new Error("ECONNRESET"); };
    const out = await sendConversionPostback(lead.id, { dbOverride: db, fetcher: boom });
    eq("tentative enregistrée", out.sent, true);
    eq("erreur remontée", out.error, "ECONNRESET");
    const row = db.prepare(`SELECT postback_sent_at, postback_result FROM dzpk_leads WHERE id = ?`).get(lead.id);
    eq("verrou posé malgré l'échec", row.postback_sent_at !== null, true);
    eq("échec lisible en base", row.postback_result, "propeller échec: ECONNRESET");

    // Le timeout est un échec comme un autre — il ne rejoue pas tout seul.
    const db2 = freshDb();
    const lead2 = startedLead(db2, 5021, "tgads-42", "CB-TO");
    const slow: Fetcher = async () => { const e: any = new Error("aborted"); e.name = "TimeoutError"; throw e; };
    await sendConversionPostback(lead2.id, { dbOverride: db2, fetcher: slow });
    const row2 = db2.prepare(`SELECT postback_result FROM dzpk_leads WHERE id = ?`).get(lead2.id);
    eq("timeout tracé", row2.postback_result, "propeller échec: timeout 5000 ms");

    // 4xx/5xx : l'appel a abouti, le réseau a refusé. Distinct d'une panne.
    const db3 = freshDb();
    const lead3 = startedLead(db3, 5022, "richads-7", "CB-500");
    await sendConversionPostback(lead3.id, { dbOverride: db3, fetcher: stubFetcher(500).f });
    const row3 = db3.prepare(`SELECT postback_result FROM dzpk_leads WHERE id = ?`).get(lead3.id);
    eq("statut d'erreur tracé", row3.postback_result, "richads 500");
    db.close(); db2.close(); db3.close();
  }

  console.log("\nrejeu — explicite, et lui seul lève le verrou");
  {
    const db = freshDb();
    const lead = startedLead(db, 5030, "tgads-42", "CB-RETRY");
    const { f, calls } = stubFetcher(500);
    await sendConversionPostback(lead.id, { dbOverride: db, fetcher: f });
    eq("premier envoi tenté", calls.length, 1);

    const ok = stubFetcher(200);
    const out = await retryPostback(lead.id, { dbOverride: db, fetcher: ok.f });
    eq("rejeu : envoyé", out.sent, true);
    eq("rejeu : statut", out.status, 200);
    eq("rejeu : un appel de plus", ok.calls.length, 1);
    const row = db.prepare(`SELECT postback_result FROM dzpk_leads WHERE id = ?`).get(lead.id);
    eq("résultat écrasé par le rejeu", row.postback_result, "propeller 200");
    db.close();
  }

  console.log("\nenvoi de test — ne touche à aucun lead");
  {
    const db = freshDb();
    const lead = startedLead(db, 5040, "tgads-42", "CB-REEL");
    const { f, calls } = stubFetcher(200);
    const out = await sendTestPostback("propeller", "TEST-CONV-1", f);
    eq("test : ok", out.ok, true);
    eq("test : cb factice dans l'URL", calls[0].endsWith("visitor_id=TEST-CONV-1"), true);
    const row = db.prepare(`SELECT postback_sent_at FROM dzpk_leads WHERE id = ?`).get(lead.id);
    eq("aucun verrou consommé sur un lead réel", row.postback_sent_at, null);
    db.close();
  }

  console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertions passées, ${failures.length} échec(s)`);
  if (failures.length) { failures.forEach(f => console.log("   -", f)); process.exit(1); }
}

run();
