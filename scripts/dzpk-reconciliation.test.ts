// Écran de réconciliation dzpk + failles de l'audit du 2026-08-12 (F1, F3).
// Run: npx tsx scripts/dzpk-reconciliation.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ L'audit a relevé que les trois fonctions de l'écran (file, recherche,      │
// │ compteurs) n'avaient AUCUN test, et que deux chemins menaient encore à un  │
// │ crédit sur le mauvais lead. Un rattachement faux ne change pas le revenu   │
// │ total : il déplace le crédit d'une source de pub vers une autre. Rien dans │
// │ les totaux ne cloche ensuite.                                              │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import {
  resolveMatch, runMatching, resolveManually,
  getReconciliationQueue, getReconciliationStats, searchLeads, getObservedMatches,
} from "../lib/funnels/dzpk/matcher";
import { persistClubMessages } from "../lib/funnels/dzpk/ingest";
import { getDzpkDashboard } from "../lib/funnels/dzpk/dashboard";
import {
  DZPK_SCHEMA_SQL, DZPK_INGEST_SCHEMA_SQL,
  DZPK_MATCH_SCHEMA_SQL, DZPK_MATCH_SCHEMA_SQL_2, DZPK_MATCH_SCHEMA_SQL_3,
  DZPK_TAKEOVER_SCHEMA_SQL, DZPK_TAKEOVER_ALTER_READ, DZPK_TAKEOVER_ALTER_RELAY,
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
  for (const sql of [DZPK_SCHEMA_SQL, DZPK_INGEST_SCHEMA_SQL,
    DZPK_MATCH_SCHEMA_SQL, DZPK_MATCH_SCHEMA_SQL_2, DZPK_MATCH_SCHEMA_SQL_3,
    // Le tableau lit les compteurs du fil de conversation depuis la phase 3b.
    DZPK_TAKEOVER_SCHEMA_SQL, DZPK_TAKEOVER_ALTER_READ, DZPK_TAKEOVER_ALTER_RELAY]) db.exec(sql);
  return db as any;
}
function seedLead(db: any, tgId: number, display: string, source: string, startedAt: string) {
  db.prepare(
    `INSERT INTO dzpk_leads (telegram_id, display_name, display_name_key, source, started_at, username)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(tgId, display, nameKey(display), source, startedAt, display.toLowerCase().replace(/\s+/g, ""));
  return db.prepare(`SELECT id FROM dzpk_leads WHERE telegram_id = ?`).get(tgId).id as number;
}
const bound = (n: string) =>
  `玩家 ${n} 从 德州扑克 ♠️❤️ @dzpk 俱乐部 首次进入俱乐部游戏，已绑定为代理 🍓 的推广！`;

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nF1 — un lien ne sert que si AUCUN AUTRE lead ne porte le nom");
{
  const db = freshDb();
  // Le lead 1 s'est renommé « Twin » ; le lead 2 s'appelle vraiment « Twin ».
  const renomme = seedLead(db, 1, "Ancien Pseudo", "tgads", "2026-08-01 09:00:00");
  const vraiTwin = seedLead(db, 2, "Twin", "richads", "2026-08-05 09:00:00");

  persistClubMessages(PEER, [{ id: 1, date: "2026-08-10 12:00:00", text: bound("Twin") }], CFG, db);
  runMatching({ apply: true }, db);
  // Baki sait que cette notification-là concerne le lead renommé : il corrige.
  resolveManually(1, renomme, "baki", db);
  eq("le lien manuel existe",
    db.prepare(`SELECT lead_id FROM dzpk_name_links WHERE name_key='twin'`).get().lead_id, renomme);

  // LA propriété : le VRAI Twin est rattaché à son tour. Sa notification ne doit
  // PAS être absorbée par le lien pointant vers le lead renommé.
  persistClubMessages(PEER, [{ id: 2, date: "2026-08-12 12:00:00", text: bound("Twin") }], CFG, db);
  runMatching({ apply: true }, db);

  const m2 = db.prepare(`SELECT status, lead_id, method FROM dzpk_club_matches WHERE club_message_id = 2`).get();
  eq("2e notif NON absorbée par le lien", m2.method === "link", false);
  eq("elle part en réconciliation", m2.status, "ambiguous");
  eq("aucun crédit automatique", m2.lead_id, null);
  eq("le vrai Twin n'a PAS été volé",
    db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id = ?`).get(vraiTwin).bound_at, null);
  eq("motif explicite", resolveMatch("Twin", "2026-08-12 12:00:00", db).note.includes("autre(s) lead(s)"), true);
  db.close();
}

console.log("\nF1b — le lien reste utilisable quand le nom n'appartient à personne d'autre");
{
  const db = freshDb();
  const id = seedLead(db, 1, "Ancien Pseudo", "tgads", "2026-08-01 09:00:00");
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-10 12:00:00", text: bound("Nouveau Nom") }], CFG, db);
  runMatching({ apply: true }, db);
  resolveManually(1, id, "baki", db);

  // Aucun lead ne porte « Nouveau Nom » : le self-learning doit fonctionner.
  persistClubMessages(PEER, [{ id: 2, date: "2026-08-11 12:00:00", text: bound("Nouveau Nom") }], CFG, db);
  runMatching({ apply: true }, db);
  eq("rattaché par le lien",
    db.prepare(`SELECT method FROM dzpk_club_matches WHERE club_message_id = 2`).get().method, "link");
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nF3 — une recherche qui se normalise à vide ne rend RIEN");
{
  const db = freshDb();
  seedLead(db, 1, "Alice", "tgads", "2026-08-01 09:00:00");
  seedLead(db, 2, "Bob", "richads", "2026-08-02 09:00:00");
  seedLead(db, 3, "Carol", "organic", "2026-08-03 09:00:00");

  eq("emoji seul", searchLeads("🍓", 25, db).length, 0);
  eq("emojis multiples", searchLeads("✅✅", 25, db).length, 0);
  eq("joker %", searchLeads("%", 25, db).length, 0);
  eq("joker _", searchLeads("_", 25, db).length, 0);
  eq("chaîne vide", searchLeads("", 25, db).length, 0);
  eq("espaces", searchLeads("   ", 25, db).length, 0);

  eq("joker au milieu n'élargit pas", searchLeads("A_ice", 25, db).length, 0);
  eq("recherche par nom", searchLeads("alice", 25, db).map(r => r.display_name), ["Alice"]);
  eq("recherche par @handle", searchLeads("@bob", 25, db).map(r => r.display_name), ["Bob"]);
  eq("recherche par telegram_id", searchLeads("3", 25, db).map(r => r.display_name), ["Carol"]);
  eq("fragment de nom", searchLeads("car", 25, db).map(r => r.display_name), ["Carol"]);
  db.close();
}

console.log("\nrecherche — noms chinois retrouvables");
{
  const db = freshDb();
  seedLead(db, 1, "豪豪 黄", "tgads", "2026-08-01 09:00:00");
  seedLead(db, 2, "张伟", "richads", "2026-08-02 09:00:00");
  eq("nom complet", searchLeads("豪豪 黄", 25, db).map(r => r.display_name), ["豪豪 黄"]);
  eq("fragment", searchLeads("张", 25, db).map(r => r.display_name), ["张伟"]);
  eq("l'un ne remonte pas l'autre", searchLeads("张伟", 25, db).length, 1);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nfile de réconciliation — ce qui attend vraiment une décision");
{
  const db = freshDb();
  seedLead(db, 1, "Connu", "tgads", "2026-08-09 09:00:00");
  persistClubMessages(PEER, [
    { id: 1, date: "2026-08-10 12:00:00", text: bound("Connu") },      // → auto
    { id: 2, date: "2026-08-10 13:00:00", text: bound("Inconnu") },    // → unmatched
  ], CFG, db);
  runMatching({ apply: true }, db);

  const q = getReconciliationQueue(50, db);
  eq("un seul item en attente", q.length, 1);
  eq("c'est bien l'inconnu", q[0].player_name_raw, "Inconnu");
  eq("le brut est fourni à l'écran", q[0].raw_text.includes("Inconnu"), true);
  eq("motif affiché", q[0].note, "aucun lead ne porte ce nom");

  const s = getReconciliationStats(db);
  eq("2 examinés", s.total, 2);
  eq("1 auto", s.auto, 1);
  eq("1 en attente", s.pending, 1);
  eq("taux calculé", s.auto_rate_pct, 50);
  db.close();
}

console.log("\ncompteurs — aucun examen ⇒ taux NULL, jamais 0 %");
{
  const db = freshDb();
  const s = getReconciliationStats(db);
  eq("total", s.total, 0);
  eq("taux null et non zéro", s.auto_rate_pct, null);
  eq("file vide", getReconciliationQueue(50, db).length, 0);
  db.close();
}

console.log("\nfile — les candidats sont RECALCULÉS, pas figés");
{
  const db = freshDb();
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-10 12:00:00", text: bound("Tardif") }], CFG, db);
  runMatching({ apply: true }, db);
  eq("aucun candidat au moment du match", getReconciliationQueue(50, db)[0].candidates.length, 0);

  // Le lead fait son /start APRÈS coup : l'écran doit le proposer.
  seedLead(db, 1, "Tardif", "tgads", "2026-08-09 09:00:00");
  const q = getReconciliationQueue(50, db);
  eq("le nouveau lead apparaît comme candidat", q[0].candidates.length, 1);
  eq("avec son écart temporel", q[0].candidates[0].hours_before, 27);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nresolveManually — refuse ce qui n'est pas rattachable");
{
  const db = freshDb();
  const id = seedLead(db, 1, "Qui", "tgads", "2026-08-01 09:00:00");
  persistClubMessages(PEER, [
    { id: 1, date: "2026-08-10 12:00:00", text: "俱乐部公告：今晚有活动！" },                        // unparsed
    { id: 2, date: "2026-08-10 13:00:00", text: "代理 🍓 申请的分佣 100 USDT，俱乐部已实际支付 99 USDT，" }, // commission
    { id: 3, date: "2026-08-10 14:00:00", text: bound("Qui").replace("代理 🍓 的推广", "代理 🍔 的推广") }, // autre agent
  ], CFG, db);

  const r1 = resolveManually(1, id, "baki", db);
  eq("unparsed refusé", r1.ok, false);
  eq("motif", (r1.error ?? "").includes("non rattachable"), true);

  const r2 = resolveManually(2, id, "baki", db);
  eq("commission refusée", r2.ok, false);

  const r3 = resolveManually(3, id, "baki", db);
  eq("notif d'un autre agent refusée", r3.ok, false);
  eq("motif", (r3.error ?? "").includes("autre agent"), true);

  eq("aucun lien mémorisé à tort",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_name_links`).get().n, 0);
  eq("aucun crédit posé",
    db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id = ?`).get(id).bound_at, null);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// DRAPEAU D'OBSERVATION (arbitrage Baki) : le cron résout et AFFICHE, il ne
// crédite pas. Baki valide un lot sur ses vraies données, puis lève le drapeau.
console.log("\nobservation — le match certain est ENREGISTRÉ mais ne crédite personne");
{
  const db = freshDb();
  const id = seedLead(db, 1, "Certain", "tgads", "2026-08-09 09:00:00");
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-10 12:00:00", text: bound("Certain") }], CFG, db);

  const obs = runMatching({ apply: false }, db);
  eq("le match est jugé certain", obs.auto, 1);
  eq("mais NON appliqué", obs.applied, 0);
  eq("compté comme observé", obs.observed, 1);
  eq("le mode est rapporté", obs.applying, false);

  const m = db.prepare(`SELECT status, lead_id, applied FROM dzpk_club_matches WHERE club_message_id = 1`).get();
  eq("ligne écrite, visible à l'écran", m.status, "auto");
  eq("lead identifié", m.lead_id, id);
  eq("marquée non appliquée", m.applied, 0);
  eq("AUCUN crédit posé", db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id = ?`).get(id).bound_at, null);
  eq("aucun lien appris pendant l'observation",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_name_links`).get().n, 0);

  // Baki a regardé, il lève le drapeau : la passe suivante applique le backlog.
  const app = runMatching({ apply: true }, db);
  eq("le match observé est REPRIS", app.examined, 1);
  eq("et appliqué", app.applied, 1);
  eq("crédit posé", db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id = ?`).get(id).bound_at, "2026-08-10 12:00:00");
  eq("lien appris à ce moment-là",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_name_links`).get().n, 1);

  eq("idempotent ensuite", runMatching({ apply: true }, db).examined, 0);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Failles résiduelles du 2e audit — toutes dans la branche « lien mémorisé »,
// qui court-circuitait les gardes du chemin nominal.
console.log("\nR7 — un lien ne rattache pas une notification SANS DATE");
{
  const db = freshDb();
  const id = seedLead(db, 1, "Lien", "tgads", "2026-08-01 09:00:00");
  db.prepare(`INSERT INTO dzpk_name_links (name_key, lead_id, origin) VALUES ('lien', ?, 'manual')`).run(id);

  const r = resolveMatch("Lien", null, db);
  eq("refusé", r.status, "ambiguous");
  eq("aucun lead", r.leadId, null);
  eq("motif explicite", r.note.includes("sans date"), true);

  persistClubMessages(PEER, [{ id: 1, date: null, text: bound("Lien") }], CFG, db);
  runMatching({ apply: true }, db);
  eq("aucun match appliqué à vide",
    db.prepare(`SELECT applied FROM dzpk_club_matches WHERE club_message_id = 1`).get().applied, 0);
  eq("l'item RESTE dans la file", getReconciliationQueue(50, db).length, 1);
  db.close();
}

console.log("\nR6 — un lien ne fait pas reculer bound_at avant le /start");
{
  const db = freshDb();
  const id = seedLead(db, 1, "Chrono", "tgads", "2026-08-01 09:00:00");
  db.prepare(`INSERT INTO dzpk_name_links (name_key, lead_id, origin) VALUES ('chrono', ?, 'manual')`).run(id);

  // Rejeu d'historique : une notification ANTÉRIEURE au /start du lead.
  const r = resolveMatch("Chrono", "2025-01-01 12:00:00", db);
  eq("refusé", r.status, "ambiguous");
  eq("motif chiffré", r.note.includes("précède le /start"), true);

  persistClubMessages(PEER, [{ id: 1, date: "2025-01-01 12:00:00", text: bound("Chrono") }], CFG, db);
  runMatching({ apply: true }, db);
  eq("bound_at ne recule pas avant le /start",
    db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id = ?`).get(id).bound_at, null);
  db.close();
}

console.log("\nR9 — un nom illisible reste VISIBLE dans la file");
{
  const db = freshDb();
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-10 12:00:00", text: bound("🐉🐉") }], CFG, db);
  eq("le parseur a bien lu le nom brut",
    db.prepare(`SELECT player_name_raw FROM dzpk_club_messages WHERE src_msg_id = 1`).get().player_name_raw, "🐉🐉");
  eq("mais sa clé est vide",
    db.prepare(`SELECT name_key FROM dzpk_club_messages WHERE src_msg_id = 1`).get().name_key, "");

  const r = runMatching({ apply: true }, db);
  eq("il est tout de même examiné", r.examined, 1);
  eq("classé sans correspondance", r.unmatched, 1);

  const q = getReconciliationQueue(50, db);
  eq("PRÉSENT dans la file", q.length, 1);
  eq("avec son nom brut pour identification", q[0].player_name_raw, "🐉🐉");
  eq("et un motif honnête", q[0].note.includes("illisible"), true);
  eq("compté dans les stats", getReconciliationStats(db).pending, 1);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// ÉTANCHÉITÉ DU DRAPEAU — asservie par un test, pas seulement vérifiée à la main.
// Toutes les autres suites passent `apply` explicitement : une régression sur
// `dzpkAutoMatchEnabled()` ou sur le `??` de runMatching passerait au vert
// partout. Ici on manipule la VRAIE variable d'environnement.
console.log("\nétanchéité du drapeau — l'ENV décide, et rien d'autre");
{
  const avant = process.env.DZPK_AUTO_MATCH;
  const db = freshDb();
  const id = seedLead(db, 1, "Flag", "tgads", "2026-08-09 09:00:00");
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-10 12:00:00", text: bound("Flag") }], CFG, db);

  // ── Variable absente : aucun crédit, quoi qu'il arrive.
  delete process.env.DZPK_AUTO_MATCH;
  const r1 = runMatching({}, db);
  eq("env absente ⇒ mode observation", r1.applying, false);
  eq("certain détecté", r1.auto, 1);
  eq("mais AUCUN crédit", r1.applied, 0);
  eq("bound_at reste nul", db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id=?`).get(id).bound_at, null);

  // Le certain est VISIBLE, item par item — c'est tout l'objet du 3e état.
  const obs = getObservedMatches(50, db);
  eq("listé dans les observés", obs.length, 1);
  eq("avec le lead visé", obs[0].lead_id, id);
  eq("et sa source", obs[0].lead_source, "tgads");
  eq("et l'écart temporel", Math.round(obs[0].hours_before!), 27);

  // ── Valeurs qui ne veulent pas dire « on » : toujours pas de crédit.
  for (const v of ["", "off", "false", "0", "no", "oui", "enabled"]) {
    process.env.DZPK_AUTO_MATCH = v;
    eq(`"${v}" n'active pas`, runMatching({}, db).applying, false);
  }
  eq("toujours aucun crédit", db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id=?`).get(id).bound_at, null);
  eq("toujours visible dans les observés", getObservedMatches(50, db).length, 1);

  // ── Levée du drapeau : le backlog s'applique EXACTEMENT une fois.
  process.env.DZPK_AUTO_MATCH = "on";
  const r2 = runMatching({}, db);
  eq("env=on ⇒ application", r2.applying, true);
  eq("le backlog observé est repris", r2.examined, 1);
  eq("et appliqué une fois", r2.applied, 1);
  eq("crédit posé", db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id=?`).get(id).bound_at, "2026-08-10 12:00:00");
  eq("sorti des observés", getObservedMatches(50, db).length, 0);

  const r3 = runMatching({}, db);
  eq("2e passe : rien à reprendre", r3.examined, 0);
  eq("pas de second crédit", r3.applied, 0);
  eq("un seul lead crédité",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_leads WHERE bound_at IS NOT NULL`).get().n, 1);

  if (avant === undefined) delete process.env.DZPK_AUTO_MATCH;
  else process.env.DZPK_AUTO_MATCH = avant;
  db.close();
}

console.log("\nF2 — la fenêtre de certitude s'applique AUSSI au lien appris");
{
  const db = freshDb();
  const id = seedLead(db, 1, "bob", "tgads", "2026-01-01 09:00:00");
  db.prepare(`INSERT INTO dzpk_name_links (name_key, lead_id, origin) VALUES ('bob', ?, 'auto')`).run(id);

  // 7 mois après le /start : un autre « bob » peut être entré par le lien
  // d'invitation partagé du club sans jamais passer par le bot.
  const r = resolveMatch("bob", "2026-08-01 12:00:00", db);
  eq("refusé malgré le lien", r.status, "ambiguous");
  eq("aucun crédit", r.leadId, null);
  eq("motif chiffré", r.note.includes("vieux de"), true);

  // Dans la fenêtre, le lien fonctionne toujours.
  const proche = resolveMatch("bob", "2026-01-15 12:00:00", db);
  eq("dans la fenêtre : le lien sert", proche.status, "auto");
  eq("via le lien", proche.method, "link");
  db.close();
}

console.log("\nR1 — le rattachement manuel refuse aussi l'anti-chronologie");
{
  const db = freshDb();
  const id = seedLead(db, 1, "Tardif", "tgads", "2026-09-01 09:00:00");
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-01 12:00:00", text: bound("Tardif") }], CFG, db);
  runMatching({ apply: true }, db);

  const res = resolveManually(1, id, "baki", db);
  eq("refusé", res.ok, false);
  eq("motif chiffré", (res.error ?? "").includes("précède le /start"), true);
  eq("aucun crédit anti-chronologique",
    db.prepare(`SELECT bound_at FROM dzpk_leads WHERE id=?`).get(id).bound_at, null);
  eq("aucun lien appris sur un refus",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_name_links`).get().n, 0);
  db.close();
}

console.log("\nR2 — le dry-run rapporte enfin les observés");
{
  const db = freshDb();
  seedLead(db, 1, "Dry", "tgads", "2026-08-09 09:00:00");
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-10 12:00:00", text: bound("Dry") }], CFG, db);
  const r = runMatching({ dryRun: true, apply: false }, db);
  eq("compté comme observé", r.observed, 1);
  eq("rien écrit", db.prepare(`SELECT COUNT(*) AS n FROM dzpk_club_matches`).get().n, 0);
  db.close();
}

console.log("\nF2bis — un refus de la branche « lien » PROPOSE quand même des candidats");
{
  const db = freshDb();
  // Le cas pour lequel le self-learning existe : lead renommé, plus aucun lead
  // ne porte le nom du club. Sans la cible du lien dans les candidats,
  // l'opérateur n'a AUCUN chemin de la notification vers le lead.
  const renomme = seedLead(db, 1, "Nouveau Pseudo", "tgads", "2026-01-01 09:00:00");
  db.prepare(`INSERT INTO dzpk_name_links (name_key, lead_id, origin) VALUES ('ancien', ?, 'manual')`).run(renomme);

  const r = resolveMatch("Ancien", "2026-08-01 12:00:00", db); // hors fenêtre
  eq("refusé (fenêtre)", r.status, "ambiguous");
  eq("MAIS la cible du lien est proposée", r.candidates.map(c => c.id), [renomme]);
  eq("avec sa source", r.candidates[0].source, "tgads");
  eq("et son écart temporel", r.candidates[0].hours_before !== null, true);

  // Et le funnel ne doit PAS le compter comme orphelin.
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-01 12:00:00", text: bound("Ancien") }], CFG, db);
  runMatching({ apply: true }, db);
  const q = getReconciliationQueue(50, db);
  eq("présent dans la file", q.length, 1);
  eq("avec un candidat cliquable", q[0].candidates.length, 1);
  db.close();
}

console.log("\nF1bis — un certain non appliqué n'est jamais « aucune notification »");
{
  const db = freshDb();
  const id = seedLead(db, 1, "Phua", "tgads", "2026-08-12 07:26:35");
  persistClubMessages(PEER, [{ id: 1, date: "2026-08-12 07:28:10", text: bound("Phua") }], CFG, db);
  runMatching({ apply: false }, db);

  // Le statut du funnel doit distinguer « en observation » de « rien ».
  const d = getDzpkDashboard(db);
  const lead = d.leads.find(l => l.id === id)!;
  eq("statut dédié", lead.match, "observed");
  eq("compté à part", lead.match_observed, 1);
  eq("pas compté comme appliqué", lead.match_auto, 0);
  eq("aucun crédit", lead.bound_at, null);

  // Et il reste listé item par item, avec le lead visé.
  const obs = getObservedMatches(50, db);
  eq("visible dans la liste des observés", obs.length, 1);
  eq("le lead visé est nommé", obs[0].lead_display_name, "Phua");
  db.close();
}

console.log("\ncontrefactuel — le garde F1 sait-il rougir ?");
{
  // On reproduit la DÉCISION de l'ancien garde (compter les porteurs) et on
  // montre qu'elle diverge de celle du garde actuel sur la même fixture.
  const db = freshDb();
  const renomme = seedLead(db, 1, "Ancien", "tgads", "2026-08-01 09:00:00");
  seedLead(db, 2, "Twin", "richads", "2026-08-05 09:00:00");
  db.prepare(`INSERT INTO dzpk_name_links (name_key, lead_id, origin) VALUES ('twin', ?, 'manual')`).run(renomme);

  const ancienGarde = db.prepare(
    `SELECT COUNT(*) AS n FROM dzpk_leads WHERE display_name_key = 'twin'`).get().n <= 1;
  const nouveauGarde = db.prepare(
    `SELECT COUNT(*) AS n FROM dzpk_leads WHERE display_name_key = 'twin' AND id != ?`).get(renomme).n === 0;

  eq("ANCIEN garde : lien jugé utilisable", ancienGarde, true);
  eq("NOUVEAU garde : lien refusé", nouveauGarde, false);
  eq("les deux divergent bien sur cette fixture", ancienGarde !== nouveauGarde, true);
  eq("et le code suit le nouveau", resolveMatch("Twin", "2026-08-12 12:00:00", db).status, "ambiguous");
  db.close();
}

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertions passées, ${failures.length} échec(s)`);
if (failures.length) { failures.forEach(f => console.log("   -", f)); process.exit(1); }
