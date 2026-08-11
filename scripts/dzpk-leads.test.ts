// Funnel dzpk — phase 1 : capture du /start, source, journal, idempotence.
// Run: npx tsx scripts/dzpk-leads.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ Trois propriétés de la phase 1 sont invisibles à l'œil et coûteuses à      │
// │ découvrir en prod :                                                        │
// │                                                                            │
// │  1. FIRST-TOUCH. Un re-/start venu d'une autre pub ne doit PAS réécrire la │
// │     source. Si la règle casse, l'attribution part au dernier clic et le    │
// │     budget pub est piloté sur des chiffres faux — sans aucune erreur.      │
// │  2. IDEMPOTENCE. Telegram rejoue les updates. Un /start rejoué ne doit ni  │
// │     créer un doublon ni gonfler les compteurs.                             │
// │  3. HISTORIQUE D'IDENTITÉ. Le club ne renvoie qu'un nom libre : si un lead │
// │     renomme son compte, l'ancien nom doit rester dans le journal, sinon la │
// │     phase 2 ne pourra jamais le rattacher.                                 │
// │                                                                            │
// │ Le test tourne sur une base TEMPORAIRE, avec le SQL de la migration lui-   │
// │ même (DZPK_SCHEMA_SQL) — pas une recopie. Et les trois propriétés ci-      │
// │ dessus sont vérifiées PAR CONTREFACTUEL : on remet le bug, on constate que │
// │ le test tombe. Un test vert qui n'a jamais su rougir ne prouve rien.       │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import {
  normalizeSource, recordStart, recordLeadMessage, markBlocked,
  isDuplicateDzpkUpdate, getLeadByTelegramId, deriveState, getStatsBySource,
  type DbLike,
} from "../lib/funnels/dzpk/leads";
import {
  DZPK_SCHEMA_SQL,
  DZPK_MATCH_SCHEMA_SQL, DZPK_MATCH_SCHEMA_SQL_2, DZPK_MATCH_SCHEMA_SQL_3,
} from "../lib/funnels/dzpk/schema";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

function freshDb(): DbLike & { exec(s: string): void; close(): void } {
  const db = new Database(":memory:");
  db.exec(DZPK_SCHEMA_SQL);
  // display_name / display_name_key sont ajoutées par la migration de matching :
  // le /start les renseigne, donc la base de test doit les avoir.
  db.exec(DZPK_MATCH_SCHEMA_SQL);
  db.exec(DZPK_MATCH_SCHEMA_SQL_2);
  db.exec(DZPK_MATCH_SCHEMA_SQL_3);
  return db as any;
}

const tg = (id: number, extra: Record<string, unknown> = {}) => ({ telegram_id: id, ...extra });

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nnormalizeSource — texte libre, aucune liste blanche");
eq("source de pub", normalizeSource("tgads"), "tgads");
eq("source jamais vue", normalizeSource("un_canal_inedit"), "un_canal_inedit");
eq("casse pliée", normalizeSource("TgAds"), "tgads");
eq("espaces rognés", normalizeSource("  tgads  "), "tgads");
eq("tirets et underscores", normalizeSource("tg-ads_2026"), "tg-ads_2026");
eq("source en chinois conservée", normalizeSource("推广渠道"), "推广渠道");

console.log("\nnormalizeSource — 'organic' UNIQUEMENT quand il n'y a rien");
eq("null", normalizeSource(null), "organic");
eq("undefined", normalizeSource(undefined), "organic");
eq("chaîne vide", normalizeSource(""), "organic");
eq("espaces seuls", normalizeSource("   "), "organic");
eq("controles seuls (NUL, SOH, DEL)", normalizeSource("\u0000\u0001\u007f"), "organic");

console.log("\nnormalizeSource — bornes et hygiène");
eq("controle retire, texte garde", normalizeSource("tg\u0001ads"), "tgads");
eq("tabulation réduite", normalizeSource("tg\tads"), "tg ads");
eq("64 caractères acceptés", normalizeSource("x".repeat(64)).length, 64);
eq("65 → tronqué à 64", normalizeSource("x".repeat(65)).length, 64);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nrecordStart — création");
{
  const db = freshDb();
  const r = recordStart(tg(1001, { username: "wang", first_name: "小王" }), "tgads", db);
  eq("lead créé", r.created, true);
  eq("source capturée", r.lead.source, "tgads");
  eq("payload brut conservé", r.lead.source_raw, "tgads");
  eq("pseudo capturé", r.lead.username, "wang");
  eq("prénom chinois intact", r.lead.first_name, "小王");
  eq("start_count initial", r.lead.start_count, 1);
  // LA clé d'appariement du funnel : le club reprendra ce nom tel quel.
  eq("display_name capturé", (r.lead as any).display_name, "小王");
  eq("clé normalisée stockée", (r.lead as any).display_name_key, "小王");
  eq("aucune date de club", [r.lead.club_joined_at, r.lead.bound_at], [null, null]);

  const ev = db.prepare(`SELECT kind, source FROM dzpk_lead_events WHERE lead_id = ?`).all(r.lead.id);
  eq("un événement 'start'", ev, [{ kind: "start", source: "tgads" }]);
  db.close();
}

console.log("\nrecordStart — deep link nu");
{
  const db = freshDb();
  const r = recordStart(tg(1002), null, db);
  eq("source = organic", r.lead.source, "organic");
  eq("source_raw null", r.lead.source_raw, null);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nre-/start — FIRST-TOUCH : la source ne bouge jamais");
{
  const db = freshDb();
  const first = recordStart(tg(1003, { username: "a", first_name: "Ann" }), "tgads", db);
  const again = recordStart(tg(1003, { username: "b", first_name: "Bob" }), "richads", db);

  eq("aucun doublon créé", again.created, false);
  eq("même lead", again.lead.id, first.lead.id);
  eq("SOURCE CONSERVÉE (first-touch)", again.lead.source, "tgads");
  eq("source du 2e contact rapportée à part", again.observedSource, "richads");
  eq("start_count incrémenté", again.lead.start_count, 2);
  eq("un seul lead en base",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_leads`).get().n, 1);

  eq("identité rafraîchie", [again.lead.username, again.lead.first_name], ["b", "Bob"]);

  // L'ancienne identité DOIT survivre : c'est la matière première de la phase 2.
  const noms = db.prepare(
    `SELECT username, first_name FROM dzpk_lead_events WHERE lead_id = ? ORDER BY id`
  ).all(first.lead.id);
  eq("historique des identités conservé", noms,
    [{ username: "a", first_name: "Ann" }, { username: "b", first_name: "Bob" }]);

  const restart = db.prepare(
    `SELECT kind, source FROM dzpk_lead_events WHERE lead_id = ? AND kind = 'restart'`
  ).get(first.lead.id);
  eq("événement 'restart' avec la source vue", restart, { kind: "restart", source: "richads" });
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nisDuplicateDzpkUpdate — rejeu Telegram");
{
  const db = freshDb();
  eq("1er passage", isDuplicateDzpkUpdate(4242, db), false);
  eq("rejeu détecté", isDuplicateDzpkUpdate(4242, db), true);
  eq("autre update passe", isDuplicateDzpkUpdate(4243, db), false);
  eq("update_id non numérique ignoré", isDuplicateDzpkUpdate("abc", db), false);
  eq("update_id absent ignoré", isDuplicateDzpkUpdate(undefined, db), false);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nrecordLeadMessage — trace du message, sans réponse (phase 1)");
{
  const db = freshDb();
  const { lead } = recordStart(tg(1004, { first_name: "Zhu" }), "tgads", db);

  const after = recordLeadMessage(tg(1004, { first_name: "Zhu" }), "怎么上分？", "message", db)!;
  eq("first_reply_at posé", after.first_reply_at !== null, true);
  eq("last_message_at posé", after.last_message_at !== null, true);

  const payload = db.prepare(
    `SELECT payload FROM dzpk_lead_events WHERE lead_id = ? AND kind = 'message'`
  ).get(lead.id).payload;
  eq("TEXTE du message conservé", JSON.parse(payload).text, "怎么上分？");

  const firstReply = after.first_reply_at;
  const second = recordLeadMessage(tg(1004), "还在吗", "message", db)!;
  eq("first_reply_at NON réécrit", second.first_reply_at, firstReply);
  db.close();
}

console.log("\nrecordLeadMessage — inconnu : aucun lead fabriqué");
{
  const db = freshDb();
  const r = recordLeadMessage(tg(9999), "salut", "message", db);
  eq("retourne null", r, null);
  eq("aucun lead créé", db.prepare(`SELECT COUNT(*) AS n FROM dzpk_leads`).get().n, 0);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nmarkBlocked — idempotent");
{
  const db = freshDb();
  const { lead } = recordStart(tg(1005), "tgads", db);
  markBlocked(lead.id, db);
  markBlocked(lead.id, db);
  eq("flag posé", getLeadByTelegramId(1005, db)!.blocked, 1);
  eq("un seul événement 'blocked'",
    db.prepare(`SELECT COUNT(*) AS n FROM dzpk_lead_events WHERE lead_id = ? AND kind = 'blocked'`)
      .get(lead.id).n, 1);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nderiveState — priorité, sans supposer de séquence");
const S = (o: Partial<Record<"converted_at" | "bound_at" | "club_joined_at" | "first_reply_at", string>>) =>
  deriveState({ converted_at: null, bound_at: null, club_joined_at: null, first_reply_at: null, ...o } as any);
eq("rien", S({}), "started");
eq("a écrit", S({ first_reply_at: "t" }), "replied");
eq("a rejoint", S({ club_joined_at: "t" }), "joined");
eq("rattaché", S({ bound_at: "t" }), "bound");
eq("converti", S({ converted_at: "t" }), "converted");
eq("rattaché SANS join (notif de join ratée)", S({ bound_at: "t" }), "bound");
eq("a écrit sans rejoindre", S({ first_reply_at: "t" }), "replied");
eq("rattaché prime sur a-écrit", S({ bound_at: "t", first_reply_at: "t" }), "bound");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\ngetStatsBySource — compteurs cumulatifs, pas exclusifs");
{
  const db = freshDb();
  recordStart(tg(2001), "tgads", db);
  recordStart(tg(2002), "tgads", db);
  recordStart(tg(2003), "richads", db);
  recordStart(tg(2004), null, db);
  // 2001 : a écrit, a rejoint, rattaché. 2002 : a rejoint seulement.
  recordLeadMessage(tg(2001), "hi", "message", db);
  db.prepare(`UPDATE dzpk_leads SET club_joined_at='t', bound_at='t' WHERE telegram_id=2001`).run();
  db.prepare(`UPDATE dzpk_leads SET club_joined_at='t' WHERE telegram_id=2002`).run();

  const rows = getStatsBySource(db);
  const tgads = rows.find(r => r.source === "tgads")!;
  eq("starts tgads", tgads.starts, 2);
  eq("joined tgads", tgads.joined, 2);
  eq("bound tgads", tgads.bound, 1);
  eq("replied tgads (compté EN PLUS de bound)", tgads.replied, 1);
  eq("organic présent comme vraie source",
    rows.find(r => r.source === "organic")?.starts, 1);
  eq("3 sources distinctes", rows.length, 3);
  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTREFACTUELS — on remet chaque bug et on exige que le test tombe.
// Sans ça, on ne saurait pas si les assertions ci-dessus sont capables d'échouer.
console.log("\ncontrefactuels — les gardes savent-ils rougir ?");
{
  const db = freshDb();

  // Bug 1 : last-touch au lieu de first-touch.
  recordStart(tg(3001), "tgads", db);
  db.prepare(`UPDATE dzpk_leads SET source = ? WHERE telegram_id = 3001`).run("richads");
  eq("BUG last-touch → la source aurait changé",
    getLeadByTelegramId(3001, db)!.source === "tgads", false);

  // Bug 2 : dedup partagé entre les deux bots. On simule le bot principal ayant
  // déjà consommé l'update_id 7777 dans SA table ; la table dzpk étant distincte,
  // le /start dzpk doit quand même passer.
  db.prepare(`CREATE TABLE IF NOT EXISTS telegram_updates (update_id INTEGER PRIMARY KEY)`).run();
  db.prepare(`INSERT INTO telegram_updates (update_id) VALUES (7777)`).run();
  eq("update dzpk NON avalé par la table du bot principal",
    isDuplicateDzpkUpdate(7777, db), false);

  // Bug 3 : identité écrasée sans historique.
  const { lead } = recordStart(tg(3002, { first_name: "Ancien" }), "tgads", db);
  recordStart(tg(3002, { first_name: "Nouveau" }), "tgads", db);
  db.prepare(`UPDATE dzpk_lead_events SET first_name = 'Nouveau' WHERE lead_id = ?`).run(lead.id);
  const noms = db.prepare(`SELECT DISTINCT first_name FROM dzpk_lead_events WHERE lead_id = ?`)
    .all(lead.id).map((r: any) => r.first_name);
  eq("BUG écrasement → l'ancien nom aurait disparu", noms.includes("Ancien"), false);

  db.close();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertions passées, ${failures.length} échec(s)`);
if (failures.length) { failures.forEach(f => console.log("   -", f)); process.exit(1); }
