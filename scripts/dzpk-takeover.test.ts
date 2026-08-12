// Fil de conversation dzpk — capture, ordre, idempotence, curseurs, envoi.
// Run: npx tsx scripts/dzpk-takeover.test.ts
//
// ┌─ POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────┐
// │ Quatre propriétés se cassent sans rien afficher d'anormal :                │
// │                                                                            │
// │  1. IDEMPOTENCE. Telegram rejoue un update quand le webhook tarde. Sans    │
// │     l'index UNIQUE, le même message du lead apparaîtrait deux fois dans    │
// │     le fil — et, le jour du relais, partirait deux fois dans le chat admin.│
// │  2. ORDRE. Deux messages écrits dans la même seconde doivent rester dans   │
// │     l'ordre d'arrivée. Un tri à la seconde les mélangerait, et le fil      │
// │     montrerait la réponse avant la question.                               │
// │  3. CURSEUR DE RELAIS. Il doit suivre les messages tant qu'aucun chat      │
// │     admin n'est configuré. S'il reste à 0, le jour où le relais s'allume   │
// │     l'historique entier part dans le chat admin — le piège que NEXA a      │
// │     dû désamorcer par un backfill.                                         │
// │  4. PASTILLE NON-LU. Le curseur de lecture se pose sur le dernier entrant  │
// │     EXISTANT, pas sur l'horloge : un message arrivé pendant l'ouverture du │
// │     panneau doit rester non lu, pas être avalé.                            │
// │                                                                            │
// │ Base TEMPORAIRE montée avec le SQL des migrations, pas une recopie.        │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import {
  logMessage, captureInbound, describeIncoming, getConversation,
  markConversationRead, getUnreadCounts, getAwaitingReply, getConversationHead,
} from "../lib/funnels/dzpk/takeover";
import type { DbLike } from "../lib/funnels/dzpk/leads";
import {
  DZPK_SCHEMA_SQL,
  DZPK_MATCH_SCHEMA_SQL, DZPK_MATCH_SCHEMA_SQL_2, DZPK_MATCH_SCHEMA_SQL_3,
  DZPK_TAKEOVER_SCHEMA_SQL, DZPK_TAKEOVER_ALTER_READ, DZPK_TAKEOVER_ALTER_RELAY,
} from "../lib/funnels/dzpk/schema";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

type TestDb = DbLike & { exec(s: string): void; close(): void };

function freshDb(): TestDb {
  const db = new Database(":memory:");
  db.exec(DZPK_SCHEMA_SQL);
  db.exec(DZPK_MATCH_SCHEMA_SQL);
  db.exec(DZPK_MATCH_SCHEMA_SQL_2);
  db.exec(DZPK_MATCH_SCHEMA_SQL_3);
  db.exec(DZPK_TAKEOVER_SCHEMA_SQL);
  db.exec(DZPK_TAKEOVER_ALTER_READ);
  db.exec(DZPK_TAKEOVER_ALTER_RELAY);
  return db as any;
}

function addLead(db: TestDb, tg: number, username: string | null = null): number {
  const info = db.prepare(
    `INSERT INTO dzpk_leads (telegram_id, source, username, display_name) VALUES (?, 'tgads', ?, ?)`
  ).run(tg, username, username ? null : "Sans Pseudo");
  return Number(info.lastInsertRowid);
}

/** Message Telegram minimal. */
const tgMsg = (messageId: number, extra: Record<string, unknown> = {}) =>
  ({ message_id: messageId, from: { id: 999 }, chat: { id: 999, type: "private" }, ...extra });

const relayCursor = (db: TestDb, leadId: number): number =>
  (db.prepare(`SELECT last_relayed_msg_id AS c FROM dzpk_leads WHERE id = ?`).get(leadId) as any).c;

// L'environnement décide du comportement du curseur : on le maîtrise ici.
delete process.env.DZPK_ADMIN_CHAT_ID;

// Un seul IIFE asynchrone : tsx compile ces scripts en CJS, où le top-level
// await n'existe pas. Même forme que scripts/nexa-extract-retry.test.ts.
(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\ndescribeIncoming — un média sans légende reste lisible dans le fil");
  eq("texte", describeIncoming({ text: "bonjour" }), { kind: "text", text: "bonjour" });
  eq("texte vide conservé", describeIncoming({ text: "" }), { kind: "text", text: "" });
  eq("photo nue", describeIncoming({ photo: [{}] }), { kind: "photo", text: "[photo]" });
  eq("photo légendée", describeIncoming({ photo: [{}], caption: "ma main" }), { kind: "photo", text: "ma main" });
  eq("vocal", describeIncoming({ voice: {} }), { kind: "voice", text: "[message vocal]" });
  eq("sticker avec emoji", describeIncoming({ sticker: { emoji: "🃏" } }), { kind: "sticker", text: "[sticker 🃏]" });
  eq("sticker sans emoji", describeIncoming({ sticker: {} }), { kind: "sticker", text: "[sticker]" });
  eq("document nommé", describeIncoming({ document: { file_name: "recu.pdf" } }),
    { kind: "document", text: "[document recu.pdf]" });
  eq("document anonyme", describeIncoming({ document: {} }), { kind: "document", text: "[document]" });
  eq("inconnu", describeIncoming({ location: {} }), { kind: "other", text: "[message non textuel]" });

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nIDEMPOTENCE — un update rejoué n'ajoute rien au fil");
  {
    const db = freshDb();
    const lead = addLead(db, 999);

    const a = captureInbound(tgMsg(10, { text: "salut" }), lead, db);
    eq("premier passage inséré", a.duplicate, false);

    const b = captureInbound(tgMsg(10, { text: "salut" }), lead, db);
    eq("rejeu détecté", b.duplicate, true);
    eq("aucun id rendu au rejeu", b.messageId, null);
    eq("un seul message dans le fil", getConversation(lead, 300, db).length, 1);

    // Contrefactuel : un AUTRE message du même lead entre normalement — la garde
    // porte sur l'identité du message, pas sur le lead.
    captureInbound(tgMsg(11, { text: "encore" }), lead, db);
    eq("un message distinct entre bien", getConversation(lead, 300, db).length, 2);

    // Deux leads peuvent porter le même message_id : les séquences Telegram sont
    // par conversation, pas globales. L'unicité est (lead_id, message_id).
    const autre = addLead(db, 1000);
    captureInbound(tgMsg(10, { text: "moi aussi" }), autre, db);
    eq("même message_id chez un autre lead : accepté", getConversation(autre, 300, db).length, 1);
    db.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nORDRE — le fil rend l'ancien puis le récent, à la milliseconde");
  {
    const db = freshDb();
    const lead = addLead(db, 999);
    for (let i = 1; i <= 5; i++) captureInbound(tgMsg(i, { text: `m${i}` }), lead, db);
    logMessage({ leadId: lead, direction: "out", sender: "operator:baki", text: "réponse" }, db);

    const fil = getConversation(lead, 300, db);
    eq("6 messages", fil.length, 6);
    eq("ordre chronologique", fil.map(m => m.text), ["m1", "m2", "m3", "m4", "m5", "réponse"]);
    eq("directions", fil.map(m => m.direction), ["in", "in", "in", "in", "in", "out"]);

    // L'horodatage porte les millisecondes : sans elles, cinq messages de la
    // même seconde seraient indiscernables et l'ordre dépendrait du hasard.
    eq("horodatage à la milliseconde", /\.\d{3}$/.test(fil[0].created_at), true);

    // La limite doit garder les PLUS RÉCENTS, pas les plus vieux.
    eq("limite = les plus récents", getConversation(lead, 2, db).map(m => m.text), ["m5", "réponse"]);
    db.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nCURSEUR DE RELAIS — suit les messages tant qu'aucun chat admin");
  {
    const db = freshDb();
    const lead = addLead(db, 999);
    eq("curseur à zéro au départ", relayCursor(db, lead), 0);

    const a = captureInbound(tgMsg(1, { text: "un" }), lead, db);
    eq("curseur suit le 1er message", relayCursor(db, lead), a.messageId);
    const b = captureInbound(tgMsg(2, { text: "deux" }), lead, db);
    eq("curseur suit le 2e", relayCursor(db, lead), b.messageId);

    // LA propriété : rien à relayer en retard le jour où le relais s'allume.
    const enRetard = (db.prepare(
      `SELECT COUNT(*) AS n FROM dzpk_bot_messages m JOIN dzpk_leads l ON l.id = m.lead_id
        WHERE m.direction = 'in' AND m.id > l.last_relayed_msg_id`
    ).get() as any).n;
    eq("aucun arriéré de relais", enRetard, 0);

    // Chat admin configuré ⇒ le curseur se fige : c'est le futur relais qui le
    // fera avancer, une fois le message réellement posté.
    process.env.DZPK_ADMIN_CHAT_ID = "-100123";
    const c = captureInbound(tgMsg(3, { text: "trois" }), lead, db);
    eq("curseur figé quand un chat admin existe", relayCursor(db, lead), b.messageId);
    eq("le message est bien stocké malgré tout", c.duplicate, false);
    eq("il devient donc un arriéré à relayer", (db.prepare(
      `SELECT COUNT(*) AS n FROM dzpk_bot_messages m JOIN dzpk_leads l ON l.id = m.lead_id
        WHERE m.direction = 'in' AND m.id > l.last_relayed_msg_id`
    ).get() as any).n, 1);
    delete process.env.DZPK_ADMIN_CHAT_ID;
    db.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nPASTILLE NON-LU");
  {
    const db = freshDb();
    const l1 = addLead(db, 999, "alice");
    const l2 = addLead(db, 1000, "bob");

    eq("rien de non lu au départ", getUnreadCounts(db).size, 0);

    captureInbound(tgMsg(1, { text: "a1" }), l1, db);
    captureInbound(tgMsg(2, { text: "a2" }), l1, db);
    captureInbound(tgMsg(1, { text: "b1" }), l2, db);
    eq("2 non lus chez alice", getUnreadCounts(db).get(l1), 2);
    eq("1 non lu chez bob", getUnreadCounts(db).get(l2), 1);

    markConversationRead(l1, db);
    eq("alice remise à zéro", getUnreadCounts(db).get(l1), undefined);
    eq("bob intact", getUnreadCounts(db).get(l2), 1);

    // Un message arrivé APRÈS la lecture doit rallumer la pastille.
    captureInbound(tgMsg(3, { text: "a3" }), l1, db);
    eq("un nouvel entrant rallume", getUnreadCounts(db).get(l1), 1);

    // Une réponse d'opérateur n'est pas un non-lu : on ne se notifie pas soi-même.
    logMessage({ leadId: l1, direction: "out", sender: "operator:baki", text: "ok" }, db);
    eq("un sortant ne compte pas", getUnreadCounts(db).get(l1), 1);
    db.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n« À RÉPONDRE » — survit à la lecture, ne tombe qu'à l'envoi");
  {
    const db = freshDb();
    const muet = addLead(db, 999, "jamais_ecrit");
    const bavard = addLead(db, 1000, "a_ecrit");

    eq("personne n'attend au départ", getAwaitingReply(db).size, 0);

    captureInbound(tgMsg(1, { text: "c'est quoi le rakeback ?" }), bavard, db);
    eq("le lead qui a écrit attend", getAwaitingReply(db).has(bavard), true);
    eq("celui qui n'a rien écrit n'attend pas", getAwaitingReply(db).has(muet), false);

    // LE point : lire ne répond pas. C'est exactement le cas « j'ouvre, je suis
    // occupé, je ferme » — le signal doit rester.
    markConversationRead(bavard, db);
    eq("non-lus éteints par la lecture", getUnreadCounts(db).get(bavard), undefined);
    eq("« à répondre » SURVIT à la lecture", getAwaitingReply(db).has(bavard), true);

    // Seul un message sortant l'éteint.
    logMessage({ leadId: bavard, direction: "out", sender: "operator:baki", text: "5% hebdo" }, db);
    eq("éteint par la réponse", getAwaitingReply(db).has(bavard), false);

    // Et se rallume si le lead relance.
    captureInbound(tgMsg(2, { text: "et l'assurance ?" }), bavard, db);
    eq("rallumé par une relance du lead", getAwaitingReply(db).has(bavard), true);
    db.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nINITIER un DM — écrire à un lead qui n'a jamais rien envoyé");
  {
    const db = freshDb();
    const jamais = addLead(db, 999, "silencieux");
    eq("fil vide", getConversation(jamais, 300, db).length, 0);

    // Rien dans le modèle n'exige un entrant préalable : un sortant s'écrit et
    // se relit seul. C'est ce qui permet de contacter n'importe quel lead.
    logMessage({ leadId: jamais, direction: "out", sender: "operator:baki", text: "salut, une question ?" }, db);
    const fil = getConversation(jamais, 300, db);
    eq("le fil contient le message initié", fil.length, 1);
    eq("direction sortante", fil[0].direction, "out");
    eq("attribué à l'opérateur", fil[0].sender, "operator:baki");
    // Écrire le premier ne crée évidemment aucune attente de réponse de MA part.
    eq("n'apparaît pas dans « à répondre »", getAwaitingReply(db).has(jamais), false);
    eq("ne crée aucun non-lu", getUnreadCounts(db).get(jamais), undefined);
    db.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nHISTORIQUE — les trois origines cohabitent dans le bon ordre");
  {
    const db = freshDb();
    const lead = addLead(db, 999, "alice");
    // Ce que produit un parcours réel : accueil du bot, question, réponse, merci.
    logMessage({ leadId: lead, direction: "out", sender: "bot", text: "欢迎！" }, db);
    captureInbound(tgMsg(1, { text: "comment je dépose ?" }), lead, db);
    logMessage({ leadId: lead, direction: "out", sender: "operator:baki", text: "en USDT TRC20" }, db);
    captureInbound(tgMsg(2, { text: "merci 🙏" }), lead, db);

    const fil = getConversation(lead, 300, db);
    eq("4 messages", fil.length, 4);
    eq("origines distinctes et ordonnées", fil.map(m => m.sender),
      ["bot", "lead", "operator:baki", "lead"]);
    eq("le texte est intact", fil.map(m => m.text),
      ["欢迎！", "comment je dépose ?", "en USDT TRC20", "merci 🙏"]);
    eq("le dernier mot est au lead : il attend", getAwaitingReply(db).has(lead), true);
    db.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\ncapture — effets de bord voulus");
  {
    const db = freshDb();
    const lead = addLead(db, 999);
    db.prepare(`UPDATE dzpk_leads SET blocked = 1 WHERE id = ?`).run(lead);

    captureInbound(tgMsg(1, { text: "je suis revenu" }), lead, db);
    // Un lead qui écrit n'a évidemment pas bloqué le bot. Le laisser marqué
    // l'exclurait de toutes les diffusions suivantes.
    eq("le drapeau bloqué est levé",
      (db.prepare(`SELECT blocked FROM dzpk_leads WHERE id = ?`).get(lead) as any).blocked, 0);

    eq("l'expéditeur est le lead", getConversation(lead, 300, db)[0].sender, "lead");
    eq("le message_id Telegram est conservé",
      getConversation(lead, 300, db)[0].telegram_message_id, 1);
    db.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nen-tête du panneau");
  {
    const db = freshDb();
    const avecPseudo = addLead(db, 999, "alice");
    const sansPseudo = addLead(db, 1000);
    eq("pseudo préfixé", getConversationHead(avecPseudo, db)?.label, "@alice");
    eq("repli sur le nom affiché", getConversationHead(sansPseudo, db)?.label, "Sans Pseudo");
    eq("lead inexistant", getConversationHead(4242, db), undefined);
    db.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nlogMessage — robustesse");
  {
    const db = freshDb();
    const lead = addLead(db, 999);

    // Deux sortants sans id Telegram : l'index UNIQUE ne porte QUE les entrants,
    // il ne doit pas fusionner deux réponses d'opérateur.
    logMessage({ leadId: lead, direction: "out", sender: "operator:baki", text: "un" }, db);
    logMessage({ leadId: lead, direction: "out", sender: "operator:baki", text: "deux" }, db);
    eq("deux sortants coexistent", getConversation(lead, 300, db).length, 2);

    // Deux entrants sans message_id ne sont pas fusionnés non plus : l'index est
    // partiel (WHERE telegram_message_id IS NOT NULL).
    logMessage({ leadId: lead, direction: "in", sender: "lead", text: "x" }, db);
    logMessage({ leadId: lead, direction: "in", sender: "lead", text: "y" }, db);
    eq("entrants sans id non fusionnés", getConversation(lead, 300, db).length, 4);

    // Un lead inexistant viole la clé étrangère : la fonction avale et rend null
    // plutôt que de faire répondre 500 au webhook, ce qui ferait rejouer l'update.
    const orphelin = logMessage({ leadId: 4242, direction: "in", sender: "lead", text: "?" }, db);
    eq("écriture orpheline : null, pas d'exception", orphelin, null);
    db.close();
  }

  console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertions passées, ${failures.length} échec(s)`);
  if (failures.length) { failures.forEach(f => console.log("   -", f)); process.exit(1); }
})();
