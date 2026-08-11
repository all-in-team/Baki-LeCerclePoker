// Persistance de l'ingestion dzpk — base temporaire, SQL de la migration.
// Run: npx tsx scripts/dzpk-ingest.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ Le parseur est testé ailleurs. Ici on vérifie ce que la BASE retient, et   │
// │ quatre propriétés qui touchent directement à l'argent :                    │
// │                                                                            │
// │  1. Dédup par identifiant de message, JAMAIS par contenu. Deux commissions │
// │     du même montant sont deux paiements ; un rejeu du même message n'en    │
// │     est qu'un.                                                             │
// │  2. Une commission d'un AUTRE agent n'entre jamais dans dzpk_commissions.  │
// │  3. Le curseur ne recule jamais et n'avance qu'après écriture.             │
// │  4. Aucune écriture sur dzpk_leads — l'appariement est manuel, il n'existe │
// │     pas encore, donc rien ne peut être mal attribué.                       │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import {
  persistClubMessages, getIngestState, advanceCursor, recordIngestError,
  isIngestStale, normalizePeer, getCommissionTotals, type RawClubMessage,
} from "../lib/funnels/dzpk/ingest";
import { DZPK_SCHEMA_SQL, DZPK_INGEST_SCHEMA_SQL } from "../lib/funnels/dzpk/schema";
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

function freshDb(): DbLike & { exec(s: string): void; close(): void } {
  const db = new Database(":memory:");
  db.exec(DZPK_SCHEMA_SQL);
  db.exec(DZPK_INGEST_SCHEMA_SQL);
  return db as any;
}

const F_JOIN = "玩家 FUN SEONG 已进群 德州扑克 ♠️❤️ @dzpk 俱乐部，该玩家进入游戏即可绑定推广关系！";
const F_BOUND = "玩家 FUN SEONG 从 德州扑克 ♠️❤️ @dzpk 俱乐部 首次进入俱乐部游戏，已绑定为代理 🍓 的推广！";
const F_COMM = "代理 🍓 申请的分佣 811.62896 USDT，俱乐部已实际支付 811.62 USDT，请进入游戏核对明细！";
const F_BAN = "代理 🍓 推广的用户 Arnold Poteque 已被封号/冻结，无法正常游戏！";

const msg = (id: number, text: string, date = "2026-08-12 10:00:00"): RawClubMessage => ({ id, date, text });

// ─────────────────────────────────────────────────────────────────────────────
console.log("\ningestion des 4 gabarits");
{
  const db = freshDb();
  const r = persistClubMessages(PEER, [
    msg(101, F_JOIN), msg(102, F_BOUND), msg(103, F_COMM), msg(104, F_BAN),
  ], CFG, db);

  eq("4 insérés", r.inserted, 4);
  eq("aucun doublon", r.duplicates, 0);
  eq("répartition", r.byKind, { join: 1, bound: 1, commission: 1, banned: 1 });
  eq("1 commission retenue", r.commissions, 1);
  eq("curseur max", r.maxMsgId, 104);

  eq("brut conservé intact",
    db.prepare(`SELECT raw_text FROM dzpk_club_messages WHERE src_msg_id = 102`).get().raw_text, F_BOUND);
  eq("nom de joueur stocké entier",
    db.prepare(`SELECT player_name_raw FROM dzpk_club_messages WHERE src_msg_id = 102`).get().player_name_raw,
    "FUN SEONG");
  eq("join : agent indéterminable (NULL, pas 0)",
    db.prepare(`SELECT agent_is_mine FROM dzpk_club_messages WHERE src_msg_id = 101`).get().agent_is_mine, null);
  eq("bound : agent reconnu",
    db.prepare(`SELECT agent_is_mine FROM dzpk_club_messages WHERE src_msg_id = 102`).get().agent_is_mine, 1);
  db.close();
}

console.log("\ncommission — les deux montants ET leurs bruts");
{
  const db = freshDb();
  persistClubMessages(PEER, [msg(200, F_COMM)], CFG, db);
  const c = db.prepare(`SELECT * FROM dzpk_commissions`).get();
  eq("demandé (REAL)", c.requested_amount, 811.62896);
  eq("demandé (brut)", c.requested_raw, "811.62896");
  eq("payé (REAL)", c.paid_amount, 811.62);
  eq("payé (brut)", c.paid_raw, "811.62");
  eq("devise", c.currency, "USDT");
  eq("horodatage = heure Telegram", c.posted_at, "2026-08-12 10:00:00");
  eq("aucun écart stocké (calculé à la lecture)",
    Object.keys(c).some(k => k.includes("delta") || k.includes("ecart")), false);
  db.close();
}

console.log("\ncommission d'un AUTRE agent — tracée, jamais comptée");
{
  const db = freshDb();
  const autre = F_COMM.replace("代理 🍓", "代理 🍔");
  const r = persistClubMessages(PEER, [msg(300, autre)], CFG, db);

  eq("message stocké", r.inserted, 1);
  eq("commission écartée", r.commissions, 0);
  eq("comptée comme étrangère", r.commissionsForeign, 1);
  eq("AUCUNE ligne dans dzpk_commissions",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_commissions`).get().n, 0);
  eq("mais le brut reste consultable",
    db.prepare(`SELECT agent_name_raw FROM dzpk_club_messages WHERE src_msg_id = 300`).get().agent_name_raw, "🍔");
  db.close();
}

console.log("\ndédup — par id de message, pas par contenu");
{
  const db = freshDb();
  persistClubMessages(PEER, [msg(400, F_COMM)], CFG, db);
  const rejeu = persistClubMessages(PEER, [msg(400, F_COMM)], CFG, db);
  eq("rejeu du MÊME message ignoré", rejeu.inserted, 0);
  eq("compté comme doublon", rejeu.duplicates, 1);
  eq("toujours une seule commission",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_commissions`).get().n, 1);

  // Deux paiements distincts du même montant : ce sont DEUX commissions.
  const autre = persistClubMessages(PEER, [msg(401, F_COMM)], CFG, db);
  eq("montant identique, id différent ⇒ inséré", autre.inserted, 1);
  eq("deux commissions",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_commissions`).get().n, 2);
  eq("somme payée",
    db.prepare(`SELECT SUM(paid_amount) AS s FROM dzpk_commissions`).get().s, 1623.24);
  db.close();
}

console.log("\nunparsed — stocké avec son motif, jamais jeté");
{
  const db = freshDb();
  const r = persistClubMessages(PEER, [
    msg(500, "俱乐部公告：今晚有活动！"),
    msg(501, "代理 🍓 申请的分佣 8ll.62 USDT，俱乐部已实际支付 8 USDT，"),
  ], CFG, db);
  eq("2 insérés", r.inserted, 2);
  eq("classés unparsed", r.byKind.unparsed, 2);
  eq("aucune commission fabriquée",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_commissions`).get().n, 0);
  const rows = db.prepare(`SELECT unparsed_reason FROM dzpk_club_messages WHERE parsed_kind='unparsed'`).all();
  eq("chaque non-parsé porte un motif", rows.every((x: any) => Boolean(x.unparsed_reason)), true);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Correctifs de l'audit money du 2026-08-12. Aucun n'était couvert : la suite
// était verte et ne prouvait rien sur eux.
console.log("\nF3 — le peer est normalisé : une arobase oubliée ne double rien");
{
  const db = freshDb();
  persistClubMessages("@dp_bot", [msg(800, F_COMM)], CFG, db);
  const r2 = persistClubMessages("dp_bot", [msg(800, F_COMM)], CFG, db);
  const r3 = persistClubMessages("@DP_bot", [msg(800, F_COMM)], CFG, db);
  eq("2e écriture vue comme doublon", r2.duplicates, 1);
  eq("3e aussi (casse différente)", r3.duplicates, 1);
  eq("une seule commission", db.prepare(`SELECT COUNT(*) AS n FROM dzpk_commissions`).get().n, 1);
  eq("un seul peer en base",
    db.prepare(`SELECT DISTINCT peer FROM dzpk_club_messages`).all(), [{ peer: "dp_bot" }]);
  eq("normalizePeer", [normalizePeer("@dp_bot"), normalizePeer("DP_bot"), normalizePeer(" @dp_bot ")],
    ["dp_bot", "dp_bot", "dp_bot"]);
  db.close();
}

console.log("\nF2 — un état mi-écrit se RÉPARE au rejeu, il ne se fige pas");
{
  const db = freshDb();
  // Simule un crash entre l'insert du message et celui de la commission :
  // la ligne message existe seule.
  db.prepare(
    `INSERT INTO dzpk_club_messages (peer, src_msg_id, posted_at, raw_text, parsed_kind, parser_version)
     VALUES ('dp_bot', 900, '2026-08-12 10:00:00', ?, 'commission', 1)`
  ).run(F_COMM);
  eq("commission manquante avant rejeu",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_commissions`).get().n, 0);

  const r = persistClubMessages(PEER, [msg(900, F_COMM)], CFG, db);
  eq("message vu comme doublon", r.duplicates, 1);
  eq("mais la commission est CRÉÉE", r.commissions, 1);
  eq("le trou est réparé", db.prepare(`SELECT COUNT(*) AS n FROM dzpk_commissions`).get().n, 1);

  const r2 = persistClubMessages(PEER, [msg(900, F_COMM)], CFG, db);
  eq("un 3e passage ne duplique pas", r2.commissions, 0);
  eq("toujours une seule", db.prepare(`SELECT COUNT(*) AS n FROM dzpk_commissions`).get().n, 1);
  db.close();
}

console.log("\nF6 — agrégats par devise, arrondis en sortie seulement");
{
  const db = freshDb();
  persistClubMessages(PEER, [msg(1000, F_COMM), msg(1001, F_COMM)], CFG, db);
  const t = getCommissionTotals(db);
  eq("une seule devise", t.length, 1);
  eq("devise", t[0].currency, "USDT");
  eq("nombre de paiements", t[0].n, 2);
  eq("demandé arrondi à 2", t[0].total_requested, 1623.26);
  eq("payé arrondi à 2", t[0].total_paid, 1623.24);
  eq("écart calculé, jamais stocké", t[0].total_gap, 0.01792);
  eq("aucune colonne d'écart en base",
    db.prepare(`SELECT name FROM pragma_table_info('dzpk_commissions')`).all()
      .some((c: any) => /gap|delta|ecart/.test(c.name)), false);
  db.close();
}

console.log("\nMA5 — une date absente ne crédite personne");
{
  const db = freshDb();
  persistClubMessages(PEER, [{ id: 1100, date: null, text: F_BOUND }], CFG, db);
  eq("posted_at stocké NULL, pas chaîne vide",
    db.prepare(`SELECT posted_at FROM dzpk_club_messages WHERE src_msg_id = 1100`).get().posted_at, null);
  db.close();
}

console.log("\ncurseur — n'avance qu'après écriture, ne recule jamais");
{
  const db = freshDb();
  eq("état initial", getIngestState(PEER, db).last_msg_id, 0);
  eq("jamais tourné ⇒ périmé", isIngestStale(getIngestState(PEER, db)), true);

  advanceCursor(PEER, 104, 4, db);
  const s1 = getIngestState(PEER, db);
  eq("curseur avancé", s1.last_msg_id, 104);
  eq("compteur cumulé", s1.messages_seen, 4);
  eq("succès horodaté", Boolean(s1.last_success_at), true);
  eq("plus périmé", isIngestStale(s1), false);

  advanceCursor(PEER, 50, 0, db);
  eq("un id plus petit NE FAIT PAS reculer le curseur", getIngestState(PEER, db).last_msg_id, 104);

  recordIngestError(PEER, "session invalidée", db);
  const s2 = getIngestState(PEER, db);
  eq("erreur enregistrée", s2.last_error, "session invalidée");
  eq("le curseur survit à l'erreur", s2.last_msg_id, 104);
  db.close();
}

console.log("\nfraîcheur — la panne silencieuse doit crier");
{
  const t0 = Date.parse("2026-08-12T12:00:00Z");
  eq("succès il y a 1 h", isIngestStale({ last_success_at: "2026-08-12 11:00:00" }, t0), false);
  eq("succès il y a 5 h", isIngestStale({ last_success_at: "2026-08-12 07:00:00" }, t0), false);
  eq("succès il y a 7 h ⇒ ALARME", isIngestStale({ last_success_at: "2026-08-12 05:00:00" }, t0), true);
  eq("jamais de succès ⇒ ALARME", isIngestStale({ last_success_at: null }, t0), true);
  eq("horodatage illisible ⇒ ALARME", isIngestStale({ last_success_at: "n'importe quoi" }, t0), true);
}

console.log("\nÉTANCHÉITÉ — l'ingestion n'écrit RIEN sur les leads");
{
  const db = freshDb();
  db.prepare(`INSERT INTO dzpk_leads (telegram_id, username, first_name, source)
              VALUES (777, 'funseong', 'FUN SEONG', 'tgads')`).run();
  const avant = db.prepare(`SELECT * FROM dzpk_leads WHERE telegram_id = 777`).get();

  persistClubMessages(PEER, [msg(600, F_JOIN), msg(601, F_BOUND), msg(602, F_BAN)], CFG, db);

  const apres = db.prepare(`SELECT * FROM dzpk_leads WHERE telegram_id = 777`).get();
  eq("le lead est INCHANGÉ malgré un nom identique", JSON.stringify(apres), JSON.stringify(avant));
  eq("club_joined_at toujours nul", apres.club_joined_at, null);
  eq("bound_at toujours nul (aucune attribution automatique)", apres.bound_at, null);
  eq("aucun événement de lead créé",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_lead_events`).get().n, 0);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\ncontrefactuels — les gardes savent-ils rougir ?");
{
  const db = freshDb();

  // Bug 1 : dédup par contenu au lieu de l'id ⇒ le 2e paiement disparaîtrait.
  persistClubMessages(PEER, [msg(700, F_COMM), msg(701, F_COMM)], CFG, db);
  const parContenu = db.prepare(`SELECT COUNT(DISTINCT raw_text) AS n FROM dzpk_club_messages`).get().n;
  eq("BUG dédup par contenu : n'aurait gardé qu'une ligne", parContenu, 1);
  eq("la dédup par id en garde bien deux",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_club_messages`).get().n, 2);

  // Bug 2 : commission d'un autre agent comptée ⇒ revenu gonflé.
  const autre = F_COMM.replace("代理 🍓", "代理 🍔");
  persistClubMessages(PEER, [msg(702, autre)], CFG, db);
  const totalReel = db.prepare(`SELECT SUM(paid_amount) AS s FROM dzpk_commissions`).get().s;
  const totalSiBug = db.prepare(
    `SELECT COUNT(*) AS n FROM dzpk_club_messages WHERE parsed_kind = 'commission'`
  ).get().n;
  eq("3 commissions dans le brut", totalSiBug, 3);
  eq("mais seulement 2 comptées (2 × 811.62)", totalReel, 1623.24);
  db.close();
}

console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertions passées, ${failures.length} échec(s)`);
if (failures.length) { failures.forEach(f => console.log("   -", f)); process.exit(1); }
