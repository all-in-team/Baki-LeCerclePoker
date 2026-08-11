// Appariement nom-de-club ↔ lead — base temporaire, SQL des migrations.
// Run: npx tsx scripts/dzpk-matcher.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ Un rattachement FAUX ne change pas le revenu total : il déplace le crédit  │
// │ d'une source de pub vers une autre. C'est pire qu'une erreur bruyante —    │
// │ le budget d'acquisition se pilote ensuite sur des chiffres faux, sans      │
// │ qu'aucun total ne cloche.                                                  │
// │                                                                            │
// │ Les quatre propriétés vérifiées ici :                                      │
// │  1. Exact normalisé uniquement — aucun rapprochement approximatif.         │
// │  2. Homonymes : jamais d'arbitrage au hasard. Causalité d'abord, marge     │
// │     temporelle ensuite, humain sinon.                                      │
// │  3. Un lien validé à la main est mémorisé ET réutilisé (self-learning).    │
// │  4. Idempotence : rejouer n'écrase ni ne recule aucune date.               │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import {
  resolveMatch, runMatching, resolveManually, flagContestedLinks,
  listPendingReconciliation, checkMatchCoherence, DATE_TIEBREAK_MARGIN_HOURS,
} from "../lib/funnels/dzpk/matcher";
import { persistClubMessages } from "../lib/funnels/dzpk/ingest";
import {
  DZPK_SCHEMA_SQL, DZPK_INGEST_SCHEMA_SQL,
  DZPK_MATCH_SCHEMA_SQL, DZPK_MATCH_SCHEMA_SQL_2, DZPK_MATCH_SCHEMA_SQL_3,
} from "../lib/funnels/dzpk/schema";
import { nameKey } from "../lib/funnels/dzpk/name-key";
import type { ParserConfig } from "../lib/funnels/dzpk/club-parser";
import type { DbLike } from "../lib/funnels/dzpk/leads";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

const CFG: ParserConfig = { agentName: "🍓", clubLabel: "德州扑克 ♠️❤️ @dzpk" };
const PEER = "@dp_bot";

function freshDb(): DbLike & { exec(s: string): void; close(): void; prepare(s: string): any } {
  const db = new Database(":memory:");
  db.exec(DZPK_SCHEMA_SQL);
  db.exec(DZPK_INGEST_SCHEMA_SQL);
  db.exec(DZPK_MATCH_SCHEMA_SQL);
  db.exec(DZPK_MATCH_SCHEMA_SQL_2);
  db.exec(DZPK_MATCH_SCHEMA_SQL_3);
  return db as any;
}

/** Crée un lead comme le ferait le /start, display_name_key compris. */
function seedLead(db: any, tgId: number, display: string, source: string, startedAt: string) {
  db.prepare(
    `INSERT INTO dzpk_leads (telegram_id, display_name, display_name_key, source, started_at, first_name)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(tgId, display, nameKey(display), source, startedAt, display);
  return db.prepare(`SELECT id FROM dzpk_leads WHERE telegram_id = ?`).get(tgId).id as number;
}

const bound = (name: string) =>
  `玩家 ${name} 从 德州扑克 ♠️❤️ @dzpk 俱乐部 首次进入俱乐部游戏，已绑定为代理 🍓 的推广！`;
const join = (name: string) =>
  `玩家 ${name} 已进群 德州扑克 ♠️❤️ @dzpk 俱乐部，该玩家进入游戏即可绑定推广关系！`;

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nnom unique — auto sur display_name");
{
  const db = freshDb();
  const id = seedLead(db, 1, "FUN SEONG", "tgads", "2026-08-10 09:00:00");
  const r = resolveMatch("FUN SEONG", "2026-08-11 12:00:00", db);
  eq("statut", r.status, "auto");
  eq("méthode", r.method, "display_name");
  eq("lead visé", r.leadId, id);
  db.close();
}

console.log("\ncasse, espaces et pleine chasse ne cassent pas l'égalité");
{
  const db = freshDb();
  const id = seedLead(db, 1, "FUN SEONG", "tgads", "2026-08-10 09:00:00");
  for (const variante of ["fun seong", "FUN  SEONG", "  FUN SEONG  ", "ＦＵＮ ＳＥＯＮＧ"]) {
    eq(`"${variante}"`, resolveMatch(variante, "2026-08-11 12:00:00", db).leadId, id);
  }
  db.close();
}

console.log("\nnoms chinois — appariés, et jamais confondus entre eux");
{
  const db = freshDb();
  const a = seedLead(db, 1, "豪豪 黄", "tgads", "2026-08-10 09:00:00");
  const b = seedLead(db, 2, "张伟", "richads", "2026-08-10 09:00:00");
  eq("豪豪 黄", resolveMatch("豪豪 黄", "2026-08-11 12:00:00", db).leadId, a);
  eq("张伟", resolveMatch("张伟", "2026-08-11 12:00:00", db).leadId, b);
  eq("李娜 inconnu ⇒ unmatched", resolveMatch("李娜", "2026-08-11 12:00:00", db).status, "unmatched");
  db.close();
}

console.log("\nAUCUN rapprochement approximatif");
{
  const db = freshDb();
  seedLead(db, 1, "FUN SEONG", "tgads", "2026-08-10 09:00:00");
  for (const proche of ["FUN", "SEONG", "FUNSEONG", "FUN SEONGG", "FUN SEON"]) {
    eq(`"${proche}" ne matche PAS`, resolveMatch(proche, "2026-08-11 12:00:00", db).status, "unmatched");
  }
  db.close();
}

console.log("\nrenommage entre /start et join ⇒ réconciliation, jamais de devinette");
{
  const db = freshDb();
  seedLead(db, 1, "Ancien Nom", "tgads", "2026-08-10 09:00:00");
  const r = resolveMatch("Nouveau Nom", "2026-08-11 12:00:00", db);
  eq("statut", r.status, "unmatched");
  eq("aucun lead choisi", r.leadId, null);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nhomonymes — causalité d'abord : un /start postérieur est irrecevable");
{
  const db = freshDb();
  const avant = seedLead(db, 1, "mark", "tgads", "2026-08-01 09:00:00");
  seedLead(db, 2, "mark", "richads", "2026-08-20 09:00:00"); // après la notif
  const r = resolveMatch("mark", "2026-08-10 12:00:00", db);
  eq("statut", r.status, "auto");
  eq("méthode datée", r.method, "display_name_dated");
  eq("le lead ANTÉRIEUR est retenu", r.leadId, avant);
  eq("les deux candidats restent affichés", r.candidates.length, 2);
  db.close();
}

console.log("\nhomonymes — départage par la date seulement si l'écart est net");
{
  const db = freshDb();
  const proche = seedLead(db, 1, "Rom", "tgads", "2026-08-10 10:00:00");
  seedLead(db, 2, "Rom", "richads", "2026-08-01 10:00:00"); // 9 jours plus tôt
  const r = resolveMatch("Rom", "2026-08-10 12:00:00", db);
  eq("écart largement supérieur à la marge", r.status, "auto");
  eq("le plus proche l'emporte", r.leadId, proche);
  db.close();
}
{
  const db = freshDb();
  seedLead(db, 1, "Rom", "tgads", "2026-08-10 10:00:00");
  seedLead(db, 2, "Rom", "richads", "2026-08-10 09:00:00"); // 1 h d'écart
  const r = resolveMatch("Rom", "2026-08-10 12:00:00", db);
  eq("1 h d'écart : la date ne tranche RIEN", r.status, "ambiguous");
  eq("aucun lead choisi", r.leadId, null);
  eq("les deux sont proposés à l'humain", r.candidates.length, 2);
  db.close();
}
eq("marge documentée", DATE_TIEBREAK_MARGIN_HOURS, 24);

console.log("\nhomonymes — tous postérieurs ⇒ humain");
{
  const db = freshDb();
  seedLead(db, 1, "mark", "tgads", "2026-08-20 09:00:00");
  seedLead(db, 2, "mark", "richads", "2026-08-21 09:00:00");
  eq("statut", resolveMatch("mark", "2026-08-10 12:00:00", db).status, "ambiguous");
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nrunMatching — application des effets sur le lead");
{
  const db = freshDb();
  const id = seedLead(db, 1, "FUN SEONG", "tgads", "2026-08-10 09:00:00");
  persistClubMessages(PEER, [
    { id: 1, date: "2026-08-11 10:00:00", text: join("FUN SEONG") },
    { id: 2, date: "2026-08-11 12:00:00", text: bound("FUN SEONG") },
  ], CFG, db);

  const r = runMatching({}, db);
  eq("2 messages examinés", r.examined, 2);
  eq("2 auto", r.auto, 2);
  eq("2 appliqués", r.applied, 2);

  const lead = db.prepare(`SELECT * FROM dzpk_leads WHERE id = ?`).get(id);
  eq("club_joined_at posé", lead.club_joined_at, "2026-08-11 10:00:00");
  eq("bound_at posé = REVENU", lead.bound_at, "2026-08-11 12:00:00");
  eq("lien appris automatiquement",
    db.prepare(`SELECT lead_id, origin FROM dzpk_name_links WHERE name_key = 'fun seong'`).get(),
    { lead_id: id, origin: "auto" });
  db.close();
}

console.log("\nrunMatching — idempotent, et les dates ne reculent jamais");
{
  const db = freshDb();
  const id = seedLead(db, 1, "FUN SEONG", "tgads", "2026-08-10 09:00:00");
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-11 12:00:00", text: bound("FUN SEONG") }], CFG, db);
  runMatching({}, db);
  const apres1 = db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id = ?`).get(id).bound_at;

  const r2 = runMatching({}, db);
  eq("rien de neuf au 2e passage", r2.examined, 0);

  // Une seconde notification du même type, plus tardive, ne repousse pas la date.
  persistClubMessages(PEER, [{ id: 2, date: "2026-08-15 12:00:00", text: bound("FUN SEONG") }], CFG, db);
  runMatching({}, db);
  eq("bound_at inchangé (première date observée)",
    db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id = ?`).get(id).bound_at, apres1);
  db.close();
}

console.log("\ndryRun — mesure le taux sans rien écrire");
{
  const db = freshDb();
  seedLead(db, 1, "FUN SEONG", "tgads", "2026-08-10 09:00:00");
  persistClubMessages(PEER, [
    { id: 1, date: "2026-08-11 12:00:00", text: bound("FUN SEONG") },
    { id: 2, date: "2026-08-11 13:00:00", text: bound("Inconnu Total") },
  ], CFG, db);

  const r = runMatching({ dryRun: true }, db);
  eq("2 examinés", r.examined, 2);
  eq("1 auto", r.auto, 1);
  eq("1 non apparié", r.unmatched, 1);
  eq("0 appliqué", r.applied, 0);
  eq("AUCUNE ligne de match écrite",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_club_matches`).get().n, 0);
  eq("AUCUN effet sur le lead",
    db.prepare(`SELECT bound_at FROM dzpk_leads WHERE telegram_id = 1`).get().bound_at, null);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nself-learning — un lien validé à la main sert la fois suivante");
{
  const db = freshDb();
  const id = seedLead(db, 1, "Ancien Nom", "tgads", "2026-08-10 09:00:00");
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-11 12:00:00", text: bound("Nouveau Nom") }], CFG, db);
  runMatching({}, db);
  eq("d'abord non apparié",
    db.prepare(`SELECT status FROM dzpk_club_matches WHERE club_message_id = 1`).get().status, "unmatched");
  eq("présent dans la file de réconciliation", listPendingReconciliation(10, db).length, 1);

  const res = resolveManually(1, id, "baki", db);
  eq("résolution manuelle acceptée", res.ok, true);
  eq("bound_at posé", db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id = ?`).get(id).bound_at, "2026-08-11 12:00:00");
  eq("file vidée", listPendingReconciliation(10, db).length, 0);

  // LA propriété qui compte : la prochaine notification du même nom se rattache seule.
  persistClubMessages(PEER, [{ id: 2, date: "2026-08-12 12:00:00", text: join("Nouveau Nom") }], CFG, db);
  const r2 = runMatching({}, db);
  eq("auto grâce au lien mémorisé", r2.auto, 1);
  eq("méthode = lien",
    db.prepare(`SELECT method FROM dzpk_club_matches WHERE club_message_id = 2`).get().method, "link");
  eq("club_joined_at posé sans intervention",
    db.prepare(`SELECT club_joined_at FROM dzpk_leads WHERE id = ?`).get(id).club_joined_at, "2026-08-12 12:00:00");
  db.close();
}

console.log("\nlien devenu ambigu — signalé, pas conservé en silence");
{
  const db = freshDb();
  const a = seedLead(db, 1, "mark", "tgads", "2026-08-01 09:00:00");
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-05 12:00:00", text: bound("mark") }], CFG, db);
  runMatching({}, db);
  eq("lien auto créé", db.prepare(`SELECT lead_id FROM dzpk_name_links WHERE name_key='mark'`).get().lead_id, a);

  // Un second lead homonyme arrive.
  seedLead(db, 2, "mark", "richads", "2026-08-06 09:00:00");
  eq("lien marqué contesté", flagContestedLinks(db).contested, 1);
  eq("le lien ne sert plus d'auto", resolveMatch("mark", "2026-08-10 12:00:00", db).status, "ambiguous");
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nétanchéité — un message d'un AUTRE agent n'est jamais apparié");
{
  const db = freshDb();
  const id = seedLead(db, 1, "FUN SEONG", "tgads", "2026-08-10 09:00:00");
  const autre = bound("FUN SEONG").replace("已绑定为代理 🍓 的推广", "已绑定为代理 🍔 的推广");
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-11 12:00:00", text: autre }], CFG, db);
  const r = runMatching({}, db);
  eq("aucun message examiné", r.examined, 0);
  eq("bound_at reste nul", db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id = ?`).get(id).bound_at, null);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Les quatre failles trouvées par l'audit money du 2026-08-12. Chacune était un
// chemin CERTAIN vers un crédit sur le mauvais lead.
console.log("\nMA1 — un lead sans display_name_key ne doit pas fabriquer un faux « nom unique »");
{
  const db = freshDb();
  // Lead « backfillé » : display_name rempli, clé laissée nulle (l'ancien bug).
  db.prepare(`INSERT INTO dzpk_leads (telegram_id, display_name, display_name_key, source, started_at)
              VALUES (1, 'Marc', NULL, 'tgads', '2026-01-01 09:00:00')`).run();
  const recent = seedLead(db, 2, "Marc", "richads", "2026-08-20 09:00:00");

  const avant = resolveMatch("Marc", "2026-08-25 12:00:00", db);
  eq("AVEC la clé manquante : un seul candidat, crédit sur richads", avant.leadId, recent);
  eq("et annoncé comme « nom unique »", avant.note, "nom unique");

  // La migration backfille désormais la clé en TS : on reproduit son effet.
  db.prepare(`UPDATE dzpk_leads SET display_name_key = ? WHERE telegram_id = 1`).run(nameKey("Marc"));
  const apres = resolveMatch("Marc", "2026-08-25 12:00:00", db);
  eq("APRÈS backfill : deux candidats", apres.candidates.length, 2);
  eq("l'écart de date les départage (7 mois)", apres.status, "auto");
  eq("mais plus par ignorance d'un homonyme", apres.method, "display_name_dated");
  eq("aucun lien permanent n'est appris d'un départage", apres.method === "display_name", false);
  db.close();
}

console.log("\nMA2 — un départage par date ne devient JAMAIS un lien permanent");
{
  const db = freshDb();
  const a = seedLead(db, 1, "mark", "tgads", "2026-08-01 09:00:00");
  const b = seedLead(db, 2, "mark", "richads", "2026-08-09 09:00:00");
  persistClubMessages(PEER, [
    { id: 1, date: "2026-08-10 12:00:00", text: bound("mark") },
    { id: 2, date: "2026-08-10 18:00:00", text: bound("mark") },
  ], CFG, db);
  runMatching({}, db);

  eq("AUCUN lien appris depuis un départage",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_name_links`).get().n, 0);
  const m2 = db.prepare(`SELECT status, method FROM dzpk_club_matches WHERE club_message_id = 2`).get();
  eq("le 2e message n'est PAS absorbé par un lien", m2.method === "link", false);
  void a; void b;
  db.close();
}

console.log("\nMA2b — un lien auto cesse de servir dès qu'un homonyme apparaît, sans attendre le job");
{
  const db = freshDb();
  const a = seedLead(db, 1, "solo", "tgads", "2026-08-01 09:00:00");
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-05 12:00:00", text: bound("solo") }], CFG, db);
  runMatching({}, db);
  eq("lien auto créé sur nom réellement unique",
    db.prepare(`SELECT lead_id FROM dzpk_name_links WHERE name_key='solo'`).get().lead_id, a);

  seedLead(db, 2, "solo", "richads", "2026-08-06 09:00:00");
  // Sans appeler flagContestedLinks : la lecture doit suffire.
  const r = resolveMatch("solo", "2026-08-10 12:00:00", db);
  eq("le lien n'est plus utilisable", r.status, "ambiguous");
  eq("motif explicite", r.note.includes("homonyme"), true);
  db.close();
}

console.log("\nMA2c — la souveraineté du lien manuel s'arrête à l'homonymie");
{
  // Ce test verrouillait d'abord l'inverse (« le manuel prime toujours »).
  // L'audit a montré que, couplé à la reprise des `ambiguous`, ça transformait
  // une décision prise sur UN message en décision implicite sur LE NOM. La
  // souveraineté du manuel est donc désormais bornée au cas où le nom ne
  // désigne qu'un seul lead — cf. R2 et R2b plus bas.
  const db = freshDb();
  const a = seedLead(db, 1, "duo", "tgads", "2026-08-01 09:00:00");
  seedLead(db, 2, "duo", "richads", "2026-08-02 09:00:00");
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-10 12:00:00", text: bound("duo") }], CFG, db);
  resolveManually(1, a, "baki", db);

  eq("le message tranché reste attribué au lead choisi",
    db.prepare(`SELECT lead_id FROM dzpk_club_matches WHERE club_message_id = 1`).get().lead_id, a);
  eq("et son crédit est posé",
    db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id = ?`).get(a).bound_at, "2026-08-10 12:00:00");

  const r = resolveMatch("duo", "2026-08-11 12:00:00", db);
  eq("mais une NOUVELLE notif du même nom repasse par l'humain", r.status, "ambiguous");
  eq("aucun lead présumé", r.leadId, null);
  db.close();
}

console.log("\nMA3 — la causalité s'applique AUSSI au candidat unique");
{
  const db = freshDb();
  seedLead(db, 1, "Marc", "richads", "2026-09-01 09:00:00"); // /start APRÈS la notif
  const r = resolveMatch("Marc", "2026-08-01 12:00:00", db);
  eq("statut", r.status, "ambiguous");
  eq("aucun crédit", r.leadId, null);
  eq("motif explicite", r.note.includes("POSTÉRIEUR"), true);

  // Et l'effet ne se pose pas non plus via runMatching.
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-01 12:00:00", text: bound("Marc") }], CFG, db);
  runMatching({}, db);
  eq("bound_at reste nul",
    db.prepare(`SELECT bound_at FROM dzpk_leads WHERE telegram_id = 1`).get().bound_at, null);
  db.close();
}

console.log("\nMA4 — corriger à la main RETIRE le crédit du mauvais lead");
{
  const db = freshDb();
  const bon = seedLead(db, 1, "Twin", "tgads", "2026-08-01 09:00:00");
  const faux = seedLead(db, 2, "Twin", "richads", "2026-08-08 09:00:00");
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-10 12:00:00", text: bound("Twin") }], CFG, db);
  runMatching({}, db);

  const auto = db.prepare(`SELECT lead_id FROM dzpk_club_matches WHERE club_message_id = 1`).get();
  eq("auto a crédité le plus proche", auto.lead_id, faux);
  eq("crédité", db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id = ?`).get(faux).bound_at, "2026-08-10 12:00:00");

  resolveManually(1, bon, "baki", db);
  eq("le bon lead est crédité",
    db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id = ?`).get(bon).bound_at, "2026-08-10 12:00:00");
  eq("le mauvais est DÉCRÉDITÉ",
    db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id = ?`).get(faux).bound_at, null);
  eq("une notification = UN lead crédité",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_leads WHERE bound_at IS NOT NULL`).get().n, 1);
  db.close();
}

console.log("\nMA4b — la date retenue est la PLUS ANCIENNE, pas la première écrite");
{
  const db = freshDb();
  const id = seedLead(db, 1, "Chrono", "tgads", "2026-08-01 09:00:00");
  // Le message le plus RÉCENT est ingéré en premier (rejeu d'historique).
  persistClubMessages(PEER, [{ id: 2, date: "2026-08-20 12:00:00", text: bound("Chrono") }], CFG, db);
  runMatching({}, db);
  eq("première date posée", db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id = ?`).get(id).bound_at, "2026-08-20 12:00:00");

  persistClubMessages(PEER, [{ id: 1, date: "2026-08-05 12:00:00", text: bound("Chrono") }], CFG, db);
  runMatching({}, db);
  eq("recalculée sur la plus ancienne",
    db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id = ?`).get(id).bound_at, "2026-08-05 12:00:00");
  db.close();
}

console.log("\nreprise — les non-appariés sont réévalués après apprentissage d'un lien");
{
  const db = freshDb();
  const id = seedLead(db, 1, "Ancien Nom", "tgads", "2026-08-01 09:00:00");
  persistClubMessages(PEER, [
    { id: 1, date: "2026-08-10 12:00:00", text: bound("Nouveau Nom") },
    { id: 2, date: "2026-08-11 12:00:00", text: join("Nouveau Nom") },
    { id: 3, date: "2026-08-12 12:00:00", text: join("Nouveau Nom") },
  ], CFG, db);
  runMatching({}, db);
  eq("les 3 en attente", listPendingReconciliation(10, db).length, 3);

  resolveManually(1, id, "baki", db);
  const r = runMatching({}, db);
  eq("les 2 restants sont REPRIS", r.examined, 2);
  eq("et rattachés par le lien appris", r.auto, 2);
  eq("file vidée", listPendingReconciliation(10, db).length, 0);
  eq("club_joined_at posé sur la plus ancienne",
    db.prepare(`SELECT club_joined_at FROM dzpk_leads WHERE id = ?`).get(id).club_joined_at, "2026-08-11 12:00:00");
  db.close();
}

console.log("\nR2 — un lien manuel n'absorbe PAS les notifications d'un homonyme");
{
  const db = freshDb();
  const a = seedLead(db, 1, "mark", "tgads", "2026-08-01 09:00:00");
  const b = seedLead(db, 2, "mark", "richads", "2026-08-01 11:00:00"); // 2 h d'écart
  persistClubMessages(PEER, [
    { id: 1, date: "2026-08-10 12:00:00", text: bound("mark") },
    { id: 2, date: "2026-08-10 18:00:00", text: bound("mark") },
  ], CFG, db);
  runMatching({}, db);
  eq("les deux sont ambigus (2 h d'écart < marge)", listPendingReconciliation(10, db).length, 2);

  // Baki tranche UN message, pas le nom.
  resolveManually(1, a, "baki", db);
  runMatching({}, db);

  const m2 = db.prepare(`SELECT status, lead_id FROM dzpk_club_matches WHERE club_message_id = 2`).get();
  eq("le 2e message N'EST PAS absorbé", m2.status, "ambiguous");
  eq("aucun lead ne lui est attribué", m2.lead_id, null);
  eq("il reste dans la file", listPendingReconciliation(10, db).length, 1);
  eq("seul le lead tranché est crédité",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_leads WHERE bound_at IS NOT NULL`).get().n, 1);

  // Le motif doit dire POURQUOI, sinon Baki cherche au mauvais endroit.
  const r = resolveMatch("mark", "2026-08-10 18:00:00", db);
  eq("motif explicite sur le lien manuel", r.note.includes("un humain a tranché UN message"), true);

  // Et le recours reste ouvert : trancher le 2e vers l'autre lead fonctionne.
  resolveManually(2, b, "baki", db);
  eq("les deux leads sont crédités séparément",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_leads WHERE bound_at IS NOT NULL`).get().n, 2);
  db.close();
}

console.log("\nR2b — sur un nom réellement unique, le lien manuel reste souverain");
{
  const db = freshDb();
  const id = seedLead(db, 1, "Renommé", "tgads", "2026-08-01 09:00:00");
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-10 12:00:00", text: bound("Autre Nom") }], CFG, db);
  runMatching({}, db);
  resolveManually(1, id, "baki", db);

  persistClubMessages(PEER, [{ id: 2, date: "2026-08-11 12:00:00", text: join("Autre Nom") }], CFG, db);
  const r = runMatching({}, db);
  eq("le renommage reste couvert par le self-learning", r.auto, 1);
  eq("via le lien", db.prepare(`SELECT method FROM dzpk_club_matches WHERE club_message_id = 2`).get().method, "link");
  db.close();
}

console.log("\nR3 — un message sans date ne produit jamais un match sans crédit");
{
  const db = freshDb();
  const id = seedLead(db, 1, "Sans Date", "tgads", "2026-08-01 09:00:00");
  persistClubMessages(PEER, [{ id: 1, date: null, text: bound("Sans Date") }], CFG, db);

  const r = resolveMatch("Sans Date", null, db);
  eq("ambigu", r.status, "ambiguous");
  eq("motif honnête (pas « /start postérieur »)", r.note.includes("sans date"), true);

  const res = resolveManually(1, id, "baki", db);
  eq("résolution manuelle REFUSÉE", res.ok, false);
  eq("motif explicite", (res.error ?? "").includes("sans date"), true);
  eq("aucun crédit fantôme", db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id = ?`).get(id).bound_at, null);
  db.close();
}

console.log("\ncohérence — une collision d'homonymes devient visible");
{
  const db = freshDb();
  seedLead(db, 1, "Twin", "tgads", "2026-08-01 09:00:00");
  seedLead(db, 2, "Twin", "richads", "2026-06-01 09:00:00"); // 2 mois : la date départage
  persistClubMessages(PEER, [
    { id: 1, date: "2026-08-10 12:00:00", text: bound("Twin") },
    { id: 2, date: "2026-08-11 12:00:00", text: bound("Twin") },
  ], CFG, db);
  runMatching({}, db);

  const c = checkMatchCoherence(db).find(x => x.kind === "bound")!;
  eq("2 notifications appliquées", c.applied_matches, 2);
  eq("mais 1 seul lead crédité", c.credited_leads, 1);
  eq("collision SIGNALÉE", c.collisions, 1);
  db.close();
}

console.log("\ncontrefactuels — les gardes savent-ils rougir ?");
{
  const db = freshDb();
  const a = seedLead(db, 1, "mark", "tgads", "2026-08-10 10:00:00");
  const b = seedLead(db, 2, "mark", "richads", "2026-08-10 09:00:00");

  // Bug : « prendre le premier candidat » au lieu de refuser l'ambiguïté.
  const naif = db.prepare(`SELECT id FROM dzpk_leads WHERE display_name_key='mark' ORDER BY started_at`).get().id;
  eq("BUG premier venu : aurait choisi un lead", naif, b);
  eq("le matcher, lui, refuse", resolveMatch("mark", "2026-08-10 12:00:00", db).leadId, null);

  // Ce refus a un coût visible : la source du revenu reste indéterminée tant
  // qu'un humain n'a pas tranché. C'est le compromis assumé.
  eq("les deux sources sont exposées",
    resolveMatch("mark", "2026-08-10 12:00:00", db).candidates.map(c => c.source).sort(),
    ["richads", "tgads"]);
  eq("aucun des deux n'est crédité",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_leads WHERE bound_at IS NOT NULL`).get().n, 0);
  void a;
  db.close();
}

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertions passées, ${failures.length} échec(s)`);
if (failures.length) { failures.forEach(f => console.log("   -", f)); process.exit(1); }
