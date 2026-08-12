// Lectures de l'écran back-office dzpk — base temporaire, SQL des migrations.
// Run: npx tsx scripts/dzpk-dashboard.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ `data/lecercle.db` ne s'initialise pas hors Railway : sans ce harnais, le   │
// │ SQL de la page serait exécuté pour la PREMIÈRE fois en production. Et une   │
// │ colonne « Matching » qui se trompe est pire qu'absente — elle affirme       │
// │ qu'un rattachement est certain là où il attend encore une décision.         │
// │                                                                            │
// │ Propriétés vérifiées :                                                     │
// │  1. L'étape affichée descend bien des faits (deriveState), banni compris.  │
// │  2. `pending` prime sur `manual`/`auto` : le travail restant ne se cache   │
// │     jamais derrière un rattachement déjà acquis.                          │
// │  3. Une notification sans candidat est COMPTÉE (orphans) — elle n'a pas de │
// │     ligne dans le tableau, elle doit donc s'annoncer ailleurs.             │
// │  4. Les commissions restent ventilées par devise (invariant #3).          │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import { getDzpkDashboard, sourceLabel } from "../lib/funnels/dzpk/dashboard";
import { runMatching, resolveManually } from "../lib/funnels/dzpk/matcher";
import {
  DZPK_SCHEMA_SQL, DZPK_INGEST_SCHEMA_SQL,
  DZPK_MATCH_SCHEMA_SQL, DZPK_MATCH_SCHEMA_SQL_2, DZPK_MATCH_SCHEMA_SQL_3,
} from "../lib/funnels/dzpk/schema";
import { nameKey } from "../lib/funnels/dzpk/name-key";
import type { DbLike } from "../lib/funnels/dzpk/leads";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

function freshDb(): DbLike & { prepare(s: string): any } {
  const db = new Database(":memory:");
  db.exec(DZPK_SCHEMA_SQL);
  db.exec(DZPK_INGEST_SCHEMA_SQL);
  db.exec(DZPK_MATCH_SCHEMA_SQL);
  db.exec(DZPK_MATCH_SCHEMA_SQL_2);
  db.exec(DZPK_MATCH_SCHEMA_SQL_3);
  return db as any;
}

function seedLead(db: any, tgId: number, display: string, source: string, startedAt: string): number {
  db.prepare(
    `INSERT INTO dzpk_leads (telegram_id, username, first_name, display_name, display_name_key, source, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(tgId, `u${tgId}`, display, display, nameKey(display), source, startedAt);
  return db.prepare(`SELECT id FROM dzpk_leads WHERE telegram_id = ?`).get(tgId).id as number;
}

/** Notification du club, écrite comme le ferait l'ingestion (parsing déjà fait). */
function seedMessage(db: any, msgId: number, kind: string, name: string, postedAt: string | null): number {
  db.prepare(
    `INSERT INTO dzpk_club_messages
       (peer, src_msg_id, posted_at, raw_text, parsed_kind, parser_version,
        player_name_raw, name_key, name_key_tight, agent_is_mine)
     VALUES ('@dp_bot', ?, ?, ?, ?, 1, ?, ?, ?, 1)`
  ).run(msgId, postedAt, `notif ${kind} ${name}`, kind, name, nameKey(name), nameKey(name).replace(/\s+/g, ""));
  return db.prepare(`SELECT id FROM dzpk_club_messages WHERE src_msg_id = ?`).get(msgId).id as number;
}

console.log("\n1. Mise en forme de la source");
{
  eq("richads + créa connue", sourceLabel("richads_4001300"), "richads/instant");
  eq("richads + créa inconnue", sourceLabel("richads_999"), "richads/999");
  eq("séparateur tiret", sourceLabel("richads-4001301"), "richads/usdt");
  eq("source libre intouchée", sourceLabel("tgads_cn_video3"), "tgads_cn_video3");
  eq("organic intouché", sourceLabel("organic"), "organic");
  // Le préfixe seul n'est pas une créa : rien à mettre après la barre oblique.
  eq("préfixe nu intouché", sourceLabel("richads"), "richads");
}

console.log("\n2. Étapes dérivées + attribut banni");
{
  const db = freshDb() as any;
  const start = seedLead(db, 1, "Alice", "richads_4001300", "2026-08-01 10:00:00");
  const joined = seedLead(db, 2, "Bob", "organic", "2026-08-01 11:00:00");
  const bound = seedLead(db, 3, "Carol", "tgads", "2026-08-01 12:00:00");
  const banned = seedLead(db, 4, "Dave", "organic", "2026-08-01 13:00:00");

  db.prepare(`UPDATE dzpk_leads SET club_joined_at = '2026-08-02 09:00:00' WHERE id = ?`).run(joined);
  db.prepare(`UPDATE dzpk_leads SET club_joined_at = '2026-08-02 09:00:00', bound_at = '2026-08-03 09:00:00' WHERE id = ?`).run(bound);
  db.prepare(`UPDATE dzpk_leads SET bound_at = '2026-08-03 10:00:00', banned_at = '2026-08-05 10:00:00' WHERE id = ?`).run(banned);

  const d = getDzpkDashboard(db);
  const byId = Object.fromEntries(d.leads.map(l => [l.id, l]));

  eq("ordre : le plus récent d'abord", d.leads.map(l => l.id), [banned, bound, joined, start]);
  eq("started", byId[start].state, "started");
  eq("joined", byId[joined].state, "joined");
  eq("bound", byId[bound].state, "bound");
  // Un banni RESTE rattaché : son étape ne recule pas, sinon le taux de
  // conversion de sa source baisserait à cause d'un bannissement postérieur.
  eq("banni : étape conservée", byId[banned].state, "bound");
  eq("banni : attribut porté", byId[banned].banned_at !== null, true);
  eq("source mise en forme", byId[start].source_label, "richads/instant");
  eq("source brute conservée", byId[start].source, "richads_4001300");
}

// NB : `runMatching({ apply: true })` est explicite depuis l'ajout du drapeau
// d'observation — par défaut, le matching n'applique plus ses effets.
console.log("\n3. Statut de matching");
{
  const db = freshDb() as any;
  const alice = seedLead(db, 10, "Alice", "organic", "2026-08-01 10:00:00");
  const bob = seedLead(db, 11, "Bob", "organic", "2026-08-01 10:00:00");

  // (a) nom unique + /start antérieur ⇒ auto
  seedMessage(db, 100, "bound", "Alice", "2026-08-02 10:00:00");
  // (b) nom inconnu du funnel ⇒ unmatched, aucun candidat
  seedMessage(db, 101, "bound", "Zoe", "2026-08-02 11:00:00");
  runMatching({ apply: true }, db);

  let d = getDzpkDashboard(db);
  let byId = Object.fromEntries(d.leads.map(l => [l.id, l]));
  eq("auto-certain", byId[alice].match, "auto");
  eq("aucun signal club", byId[bob].match, "none");
  eq("notif sans candidat comptée", d.orphans, 1);
  eq("file de réconciliation", d.pending.length, 1);
  eq("file : le nom brut est repris", d.pending[0].player_name_raw, "Zoe");

  // (c) la notif inconnue est tranchée à la main sur Bob ⇒ « lié à la main »
  eq("résolution manuelle acceptée", resolveManually(
    db.prepare(`SELECT id FROM dzpk_club_messages WHERE src_msg_id = 101`).get().id, bob, "test", db,
  ).ok, true);

  d = getDzpkDashboard(db);
  byId = Object.fromEntries(d.leads.map(l => [l.id, l]));
  eq("lié à la main", byId[bob].match, "manual");
  eq("file vidée", d.pending.length, 0);
  eq("plus d'orpheline", d.orphans, 0);

  // (d) un homonyme d'Alice apparaît, une nouvelle notif « Alice » arrive :
  //     elle ne peut plus être tranchée seule → Alice repasse « à réconcilier »
  //     ALORS QU'ELLE EST DÉJÀ RATTACHÉE. C'est tout l'objet de la priorité.
  const alice2 = seedLead(db, 12, "Alice", "richads_4001300", "2026-08-02 09:00:00");
  seedMessage(db, 102, "bound", "Alice", "2026-08-03 10:00:00");
  runMatching({ apply: true }, db);

  d = getDzpkDashboard(db);
  byId = Object.fromEntries(d.leads.map(l => [l.id, l]));
  eq("pending prime sur auto", byId[alice].match, "pending");
  eq("l'homonyme aussi est cité", byId[alice2].match, "pending");
  eq("notif à trancher, pas orpheline", [d.pending.length, d.orphans], [1, 0]);
  eq("candidats exposés", d.pending[0].candidates.map(c => c.id).sort(), [alice, alice2].sort());
  eq("motif repris", d.pending[0].note.length > 0, true);
}

console.log("\n4. Commissions — ventilées par devise, jamais additionnées");
{
  const db = freshDb() as any;
  const ins = db.prepare(
    `INSERT INTO dzpk_club_messages (peer, src_msg_id, raw_text, parsed_kind, parser_version, agent_is_mine)
     VALUES ('@dp_bot', ?, 'x', 'commission', 1, 1)`
  );
  const insC = db.prepare(
    `INSERT INTO dzpk_commissions
       (club_message_id, posted_at, requested_amount, requested_raw, paid_amount, paid_raw, currency, parser_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
  );
  ins.run(200); insC.run(1, "2026-08-01 10:00:00", 100.5, "100.5", 99.5, "99.5", "USDT");
  ins.run(201); insC.run(2, "2026-08-02 10:00:00", 50, "50", 50, "50", "USDT");
  ins.run(202); insC.run(3, "2026-08-03 10:00:00", 30, "30", 30, "30", "CNY");

  const d = getDzpkDashboard(db);
  eq("deux devises, deux lignes", d.commissions.map(c => c.currency), ["CNY", "USDT"]);
  eq("total payé USDT", d.commissions.find(c => c.currency === "USDT")!.total_paid, 149.5);
  eq("total payé CNY", d.commissions.find(c => c.currency === "CNY")!.total_paid, 30);
  eq("écart demandé/payé USDT", d.commissions.find(c => c.currency === "USDT")!.total_gap, 1);
}

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertions OK, ${failures.length} échec(s)`);
if (failures.length) { console.log(failures.map(f => `   - ${f}`).join("\n")); process.exit(1); }
