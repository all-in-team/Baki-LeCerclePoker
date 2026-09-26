// Relais des réponses aux diffusions vers le groupe Support — fenêtre, capture,
// sujets, réponses de l'opérateur, silence Nexa.
// Run: npx tsx scripts/lecercle-relay.test.ts
//
// ┌─ CE QUE CE FICHIER PROUVE ─────────────────────────────────────────────────┐
// │  1. La fenêtre : 72 h après le plus tardif de (diffusion reçue, dernière   │
// │     réponse de l'opérateur), close par /bot, rouverte par une nouvelle     │
// │     diffusion ou une réponse de l'opérateur.                               │
// │  2. Un message hors Nexa dans la fenêtre est PRIS (le webhook s'arrête :   │
// │     plus de « Envoie /start »), stocké, relayé une seule fois, tous types. │
// │     Hors fenêtre, commande, lead Nexa : pas touché.                        │
// │  3. Jamais de post « à plat » (General) ; un échec laisse le message en    │
// │     attente et le cron le reprend sans doublon.                            │
// │  4. L'opérateur répond depuis le sujet : texte simple, médias, /bot, /note.│
// │  5. Lead Nexa : silence armé dans la fenêtre, et ce silence échappe à      │
// │     l'expiration de 90 min (clause lue par listExpiredAwaiting).           │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import {
  LECERCLE_BROADCAST_SCHEMA_SQL, LECERCLE_DM_RELAY_SCHEMA_SQL, LECERCLE_DM_RELAY_ALTERS, LECERCLE_HOLD_EXCLUSION_SQL,
} from "../lib/funnels/lecercle/schema";
import {
  relayWindow, captureBroadcastReply, handleBroadcastTopicMessage, armNexaHoldIfBroadcastReply,
  drainPendingDmRelays, relayPending, contextFor, type RelayDeps,
} from "../lib/funnels/lecercle/relay";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

const ADMIN = "-1001234567890";

const SOURCES_SQL = `
  CREATE TABLE onboarding_leads (id INTEGER PRIMARY KEY, telegram_id INTEGER NOT NULL UNIQUE, stage TEXT);
  CREATE TABLE nexa_leads (id INTEGER PRIMARY KEY, tg_user_id INTEGER NOT NULL UNIQUE,
    stage TEXT NOT NULL DEFAULT 'started', member_id TEXT,
    awaiting_human_since TEXT, first_operator_reply_at TEXT, blocked INTEGER NOT NULL DEFAULT 0,
    relances_off INTEGER NOT NULL DEFAULT 0, admin_topic_chat_id TEXT, admin_thread_id INTEGER);
  CREATE TABLE qqpk_funnel_leads (id INTEGER PRIMARY KEY, telegram_id INTEGER NOT NULL UNIQUE, stage INTEGER);
  CREATE TABLE affiliate_leads (id INTEGER PRIMARY KEY, referred_handle TEXT, referred_telegram_id INTEGER);
  CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, telegram_handle TEXT, telegram_id INTEGER, telegram_chat_id TEXT);
`;

function freshDb() {
  const db = new Database(":memory:");
  db.exec(SOURCES_SQL);
  db.exec(LECERCLE_BROADCAST_SCHEMA_SQL);
  db.exec(LECERCLE_DM_RELAY_SCHEMA_SQL);
  for (const sql of LECERCLE_DM_RELAY_ALTERS) db.exec(sql);
  return db;
}

/** Diffusion reçue par `tg`, `hoursAgo` heures avant maintenant. */
function received(db: any, tg: number, hoursAgo: number, opts: { status?: string; title?: string; clicked?: boolean } = {}) {
  const b = db.prepare(`INSERT INTO lecercle_broadcasts (title, body, segment, status, total) VALUES (?, 'x', '{}', 'done', 1)`)
    .run(opts.title ?? "rappel dimanche");
  const at = db.prepare(`SELECT datetime('now', ?) AS t`).get(`-${hoursAgo * 3600} seconds`).t;
  const status = opts.status ?? "sent";
  db.prepare(
    `INSERT INTO lecercle_broadcast_targets (broadcast_id, telegram_id, username, first_name, status, sent_at, claimed_at, click_token, first_click_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(b.lastInsertRowid, tg, `user${tg}`, `Prénom${tg}`, status,
        status === "sent" ? at : null, at, `tok${tg}_${b.lastInsertRowid}`.padEnd(22, "x").slice(0, 22), opts.clicked ? at : null);
  return Number(b.lastInsertRowid);
}

type Call = { method: string; body: any };
function fakeTg(calls: Call[], override: (method: string, body: any) => any = () => undefined) {
  let n = 100;
  let thread = 77; // un numéro DISTINCT par sujet créé, comme Telegram
  return async (method: string, body: any) => {
    calls.push({ method, body });
    const o = override(method, body);
    if (o) return o;
    if (method === "createForumTopic") return { ok: true, result: { message_thread_id: thread++ } };
    if (method === "sendMessage" || method === "copyMessage") return { ok: true, result: { message_id: n++ } };
    return { ok: true, result: true };
  };
}

function deps(db: any, calls: Call[], extra: Partial<RelayDeps> = {}): RelayDeps {
  return {
    db, adminChat: ADMIN, tg: fakeTg(calls), isForum: async () => true,
    armNexa: () => { throw new Error("armNexa inattendu"); }, ...extra,
  };
}

const nowUnix = () => Math.floor(Date.now() / 1000);
let mid = 1;
const pm = (tg: number, extra: any = {}) => ({
  message_id: mid++, date: nowUnix(), chat: { type: "private", id: tg }, from: { id: tg, first_name: "P" },
  ...(extra.text === undefined && !extra.photo && !extra.voice && !extra.sticker ? { text: "salut" } : {}), ...extra,
});
const adminMsg = (thread: number, extra: any = {}) => ({
  message_id: mid++, chat: { id: Number(ADMIN), type: "supergroup" }, from: { id: 1486389037, username: "hugoroine" },
  is_topic_message: true, message_thread_id: thread, ...extra,
});

(async () => {
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nFenêtre de relais");
  {
    const db = freshDb();
    const at = (db.prepare(`SELECT datetime('now') AS t`).get() as any).t;
    received(db, 1, 71);
    received(db, 2, 73);
    received(db, 3, 10, { status: "unknown" });
    received(db, 4, 1, { status: "pending" });
    eq("reçue il y a 71 h : ouverte", relayWindow(1, at, db).open, true);
    eq("reçue il y a 73 h : fermée", relayWindow(2, at, db).open, false);
    eq("issue inconnue (réservée il y a 10 h) : ouverte", relayWindow(3, at, db).open, true);
    eq("jamais envoyée (pending) : fermée", relayWindow(4, at, db).open, false);
    eq("jamais reçue : fermée", relayWindow(5, at, db).open, false);

    db.exec(`INSERT INTO lecercle_dm_threads (telegram_id, last_operator_reply_at) VALUES (2, datetime('now', '-1 hour'))`);
    eq("réponse de l'opérateur il y a 1 h : la fenêtre repart", relayWindow(2, at, db).open, true);
    eq("… mais pas pour un lead Nexa (seule la diffusion compte)", relayWindow(2, at, db, false).open, false);
    db.exec(`UPDATE lecercle_dm_threads SET closed_at = datetime('now', '-30 minutes') WHERE telegram_id = 2`);
    eq("/bot après la dernière ancre : fermée", relayWindow(2, at, db).open, false);
    received(db, 2, 0.1);
    eq("nouvelle diffusion reçue après /bot : rouverte", relayWindow(2, at, db).open, true);

    const at72 = (db.prepare(`SELECT datetime(sent_at, '+72 hours') AS t FROM lecercle_broadcast_targets WHERE telegram_id = 1`).get() as any).t;
    eq("à 72 h pile : ouverte", relayWindow(1, at72, db).open, true);
    const at72p = (db.prepare(`SELECT datetime(sent_at, '+72 hours', '+1 second') AS t FROM lecercle_broadcast_targets WHERE telegram_id = 1`).get() as any).t;
    eq("72 h + 1 s : fermée", relayWindow(1, at72p, db).open, false);
    const before = (db.prepare(`SELECT datetime(sent_at, '-1 second') AS t FROM lecercle_broadcast_targets WHERE telegram_id = 1`).get() as any).t;
    eq("message écrit AVANT la réception : fermée", relayWindow(1, before, db).open, false);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nCapture hors Nexa — prise en charge, sujet, carte, relais unique");
  {
    const db = freshDb();
    db.exec(`INSERT INTO onboarding_leads (telegram_id, stage) VALUES (10, 'joined')`);
    db.exec(`INSERT INTO lecercle_bot_users (telegram_id, username, first_name, origin) VALUES (10, 'alice', 'Alice', 'backfill')`);
    received(db, 10, 2, { title: "rappel tournoi", clicked: true });
    const calls: Call[] = [];
    const d = deps(db, calls);

    const m1 = pm(10, { text: "ok <b>je viens</b> & toi ?" });
    eq("message dans la fenêtre : pris en charge (le webhook s'arrête)", await captureBroadcastReply(m1, d), true);
    const created = calls.filter(c => c.method === "createForumTopic");
    eq("un sujet créé, nommé nom · source", created.map(c => c.body.name), ["📣 @alice · Onboarding"]);
    const card = calls.find(c => c.method === "sendMessage" && c.body.text.includes("Réponse à une diffusion"));
    eq("carte : nom, source, diffusion reçue, clic",
      [/@alice/.test(card?.body.text), /Onboarding \(joined\)/.test(card?.body.text), /rappel tournoi/.test(card?.body.text), /a cliqué/.test(card?.body.text)],
      [true, true, true, true]);
    eq("carte épinglée", calls.some(c => c.method === "pinChatMessage"), true);
    const relayed = calls.filter(c => c.method === "sendMessage" && c.body.message_thread_id === 77 && !c.body.text.includes("Réponse à une diffusion"));
    eq("texte relayé dans le sujet, échappé", relayed.map(c => c.body.text), ["ok &lt;b&gt;je viens&lt;/b&gt; &amp; toi ?"]);
    eq("jamais posté à plat (tout post porte le sujet)", calls.filter(c => ["sendMessage", "copyMessage"].includes(c.method)).every(c => c.body.message_thread_id === 77), true);

    calls.length = 0;
    eq("update rejoué (même message_id) : pris, rien reposté", [await captureBroadcastReply(m1, d), calls.filter(c => c.method !== "pinChatMessage").length], [true, 0]);

    for (const extra of [{ photo: [{ file_id: "p" }], caption: "regarde" }, { voice: { file_id: "v" } }, { sticker: { emoji: "👍" } }]) {
      await captureBroadcastReply(pm(10, extra), d);
    }
    const copies = calls.filter(c => c.method === "copyMessage");
    eq("photo, vocal, sticker : recopiés depuis sa conversation, dans le sujet",
      copies.map(c => [c.body.from_chat_id, c.body.message_thread_id]), [[10, 77], [10, 77], [10, 77]]);
    eq("pas de second sujet", calls.filter(c => c.method === "createForumTopic").length, 0);
    const kinds = (db.prepare(`SELECT kind FROM lecercle_dm_messages WHERE direction = 'in' ORDER BY id`).all() as any[]).map(r => r.kind);
    eq("tous les types stockés", kinds, ["text", "photo", "voice", "sticker"]);

    calls.length = 0;
    eq("commande /start : pas prise (exécutée normalement)", await captureBroadcastReply(pm(10, { text: "/start" }), d), false);
    eq("hors fenêtre : pas pris", await captureBroadcastReply(pm(11, { text: "hello" }), d), false);
    eq("message de groupe : pas pris", await captureBroadcastReply({ ...pm(10), chat: { type: "group", id: -5 } }, d), false);
    eq("rien envoyé pour ces trois-là", calls.length, 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nLead Nexa — pas de relais ici, silence armé, expiration 90 min neutralisée");
  {
    const db = freshDb();
    db.exec(`INSERT INTO nexa_leads (id, tg_user_id) VALUES (5, 20), (6, 21)`);
    received(db, 20, 5);
    const calls: Call[] = [];
    const armed: number[] = [];
    const d = deps(db, calls, { armNexa: (id) => { armed.push(id); db.prepare(`UPDATE nexa_leads SET awaiting_human_since = COALESCE(awaiting_human_since, datetime('now')) WHERE id = ?`).run(id); } });

    eq("capture hors Nexa : ignore un lead Nexa", await captureBroadcastReply(pm(20), d), false);
    eq("dans la fenêtre : silence armé", await armNexaHoldIfBroadcastReply(pm(20), d), true);
    eq("hors fenêtre (aucune diffusion) : rien", await armNexaHoldIfBroadcastReply(pm(21), d), false);
    eq("commande : rien", await armNexaHoldIfBroadcastReply(pm(20, { text: "/start" }), d), false);
    eq("setAwaitingHuman appelé pour le bon lead", armed, [5]);
    // /bot (ou réponse de l'opérateur) lève le silence : le message suivant ne doit PAS le ré-armer.
    db.exec(`UPDATE nexa_leads SET awaiting_human_since = NULL WHERE id = 5`);
    eq("après /bot, message suivant (même diffusion) : pas de ré-armement", [await armNexaHoldIfBroadcastReply(pm(20), d), armed], [false, [5]]);
    received(db, 20, 0.01);
    eq("nouvelle diffusion reçue : ré-armé", [await armNexaHoldIfBroadcastReply(pm(20), d), armed], [true, [5, 5]]);

    // La clause lue par listExpiredAwaiting, sur la même table.
    const expirable = () => (db.prepare(
      `SELECT id FROM nexa_leads WHERE awaiting_human_since IS NOT NULL AND ${LECERCLE_HOLD_EXCLUSION_SQL} ORDER BY id`
    ).all() as any[]).map(r => r.id);
    db.exec(`UPDATE nexa_leads SET awaiting_human_since = datetime('now', '-3 hours') WHERE id = 6`);
    eq("silence armé par une diffusion : exclu de l'expiration ; autre silence : expirable", expirable(), [6]);
    // Silence levé (réponse opérateur), puis ré-armé par autre chose plus tard : expirable à nouveau.
    db.exec(`UPDATE nexa_leads SET awaiting_human_since = datetime('now', '+1 minute') WHERE id = 5`);
    eq("silence ré-armé APRÈS la diffusion par autre chose : expirable", expirable(), [5, 6]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nÉchecs Telegram — jamais à plat, reprise sans doublon, verrou");
  {
    const db = freshDb();
    received(db, 30, 1);
    const calls: Call[] = [];
    const notForum = deps(db, calls, { isForum: async () => false });
    eq("groupe pas en mode Sujets : rendu au bot (pas avalé en silence)", await captureBroadcastReply(pm(30, { text: "zéro" }), notForum), false);
    eq("… et rien posté (surtout pas à plat)", calls.length, 0);
    const unknownForum = deps(db, calls, { isForum: async () => null });
    eq("statut du groupe inconnu : pris et stocké, relais différé", await captureBroadcastReply(pm(30, { text: "un" }), unknownForum), true);
    eq("… rien posté", calls.length, 0);

    const failing = deps(db, calls, { tg: fakeTg(calls, (m) => m === "createForumTopic" ? { ok: false, error_code: 429, description: "Too Many Requests" } : undefined) });
    await captureBroadcastReply(pm(30, { text: "deux" }), failing);
    eq("création refusée : rien posté", calls.filter(c => c.method === "sendMessage").length, 0);

    calls.length = 0;
    const ok = deps(db, calls);
    const r = await drainPendingDmRelays(ok);
    const texts = calls.filter(c => c.method === "sendMessage" && !c.body.text.includes("Réponse à une diffusion")).map(c => c.body.text);
    eq("cron : les deux messages en attente postés, dans l'ordre", [r.posted, texts], [2, ["un", "deux"]]);
    calls.length = 0;
    eq("cron rejoué : rien de plus", [(await drainPendingDmRelays(ok)).posted, calls.length], [0, 0]);

    // Verrou : un relais en cours bloque le second.
    db.exec(`INSERT INTO lecercle_dm_messages (telegram_id, direction, sender, kind, text) VALUES (30, 'in', 'user', 'text', 'trois')`);
    db.exec(`UPDATE lecercle_dm_threads SET relay_lock_until = datetime('now', '+30 seconds') WHERE telegram_id = 30`);
    eq("fil verrouillé par un autre relais : différé, rien posté", [(await relayPending(30, ok)).deferred, calls.length], [true, 0]);
    db.exec(`UPDATE lecercle_dm_threads SET relay_lock_until = datetime('now', '-1 second') WHERE telegram_id = 30`);
    eq("verrou expiré : repris", (await relayPending(30, ok)).posted, 1);

    // Sujet fermé : rouvert puis reposté. Sujet supprimé : oublié, recréé au passage suivant.
    db.exec(`INSERT INTO lecercle_dm_messages (telegram_id, direction, sender, kind, text) VALUES (30, 'in', 'user', 'text', 'quatre')`);
    let first = true;
    calls.length = 0;
    await relayPending(30, deps(db, calls, { tg: fakeTg(calls, (m) => m === "sendMessage" && first ? (first = false, { ok: false, error_code: 400, description: "Bad Request: TOPIC_CLOSED" }) : undefined) }));
    eq("sujet fermé : rouvert puis posté", [calls.some(c => c.method === "reopenForumTopic"), calls.filter(c => c.method === "sendMessage").length], [true, 2]);
    db.exec(`INSERT INTO lecercle_dm_messages (telegram_id, direction, sender, kind, text) VALUES (30, 'in', 'user', 'text', 'cinq')`);
    await relayPending(30, deps(db, calls, { tg: fakeTg(calls, (m) => m === "sendMessage" ? { ok: false, error_code: 400, description: "Bad Request: message thread not found" } : undefined) }));
    eq("sujet supprimé : oublié", (db.prepare(`SELECT thread_id FROM lecercle_dm_threads WHERE telegram_id = 30`).get() as any).thread_id, null);
    calls.length = 0;
    await drainPendingDmRelays(deps(db, calls));
    eq("… recréé au passage suivant, message posté", [calls.filter(c => c.method === "createForumTopic").length, calls.some(c => c.body.text === "cinq")], [1, true]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nRefus définitif, rafale, verrou d'un autre, emoji coupé");
  {
    const db = freshDb();
    received(db, 35, 1);
    const calls: Call[] = [];
    // La photo ne peut plus être recopiée (supprimée) : avis dans le sujet, et le texte suivant passe.
    const d = deps(db, calls, { tg: fakeTg(calls, (m) => m === "copyMessage" ? { ok: false, error_code: 400, description: "Bad Request: message to copy not found" } : undefined) });
    await captureBroadcastReply(pm(35, { photo: [{ file_id: "p" }], caption: "ma photo" }), d);
    await captureBroadcastReply(pm(35, { text: "hello ?" }), d);
    const posts = calls.filter(c => c.method === "sendMessage" && !c.body.text.includes("Réponse à une diffusion")).map(c => c.body.text);
    eq("média non recopiable : avis posté, puis le message suivant", [/Média non recopiable/.test(posts[0]), /ma photo/.test(posts[0]), posts[1]], [true, true, "hello ?"]);
    eq("… et plus rien en attente", (await drainPendingDmRelays(deps(db, []))).threads, 0);

    // Rafale : un message arrivé PENDANT le relais part dans la même passe.
    const db2 = freshDb();
    received(db2, 36, 1);
    const c2: Call[] = [];
    let injected = false;
    const burst = deps(db2, c2, { tg: fakeTg(c2, (m, b) => {
      if (m === "sendMessage" && b.text === "premier" && !injected) {
        injected = true;
        db2.prepare(`INSERT INTO lecercle_dm_messages (telegram_id, direction, sender, kind, text, telegram_message_id) VALUES (36, 'in', 'user', 'text', 'second', 999)`).run();
      }
      return undefined;
    }) });
    await captureBroadcastReply(pm(36, { text: "premier" }), burst);
    eq("rafale : les deux postés sans attendre le cron", c2.filter(c => c.method === "sendMessage" && !c.body.text.includes("Réponse")).map(c => c.body.text), ["premier", "second"]);

    // Le verrou d'un autre n'est jamais libéré par nous.
    db2.exec(`UPDATE lecercle_dm_threads SET relay_lock_until = datetime('now', '+60 seconds'), relay_lock_owner = 'autre' WHERE telegram_id = 36`);
    await relayPending(36, deps(db2, []));
    eq("verrou d'un autre relais : intact", (db2.prepare(`SELECT relay_lock_owner FROM lecercle_dm_threads WHERE telegram_id = 36`).get() as any).relay_lock_owner, "autre");

    // Emoji en fin de coupe : jamais un demi-caractère stocké.
    const db3 = freshDb();
    received(db3, 37, 1);
    await captureBroadcastReply(pm(37, { text: "a".repeat(3999) + "😀😀" }), deps(db3, []));
    const stored = (db3.prepare(`SELECT text FROM lecercle_dm_messages WHERE telegram_id = 37`).get() as any).text as string;
    eq("coupe à 4000 points de code, emoji entier", [Array.from(stored).length, stored.endsWith("😀")], [4000, true]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nCorrectifs 1-5 de la 3e contre-expertise");
  {
    // 1. Nom de sujet : coupé au point de code ; refus durable → UNE alerte dans General.
    const db = freshDb();
    db.exec(`INSERT INTO lecercle_bot_users (telegram_id, first_name, origin) VALUES (80, '${"🔥".repeat(64)}', 'webhook')`);
    received(db, 80, 1);
    const calls: Call[] = [];
    const refuse = deps(db, calls, { tg: fakeTg(calls, (m) => m === "createForumTopic" ? { ok: false, error_code: 400, description: "Bad Request: TOPIC_NAME_INVALID" } : undefined) });
    await captureBroadcastReply(pm(80, { text: "un" }), refuse);
    await captureBroadcastReply(pm(80, { text: "deux" }), refuse);
    const name = calls.find(c => c.method === "createForumTopic")!.body.name as string;
    eq("nom du sujet : jamais un demi-emoji", /[\uD800-\uDBFF]$/.test(name), false);
    const alerts = calls.filter(c => c.method === "sendMessage" && c.body.message_thread_id === undefined && /Relais des diffusions bloqué/.test(c.body.text));
    // L'alerte part au PREMIER refus (1 message en attente) ; le second refus n'en reposte pas.
    eq("refus durable : une seule alerte dans General, dès le 1er refus", [alerts.length, /1 message\(s\) en attente/.test(alerts[0]?.body.text ?? "")], [1, true]);
    calls.length = 0;
    await drainPendingDmRelays(deps(db, calls));
    eq("création enfin acceptée : messages postés, alerte réarmée",
      [calls.filter(c => c.body.text === "un" || c.body.text === "deux").length,
       (db.prepare(`SELECT topic_alert_at FROM lecercle_dm_threads WHERE telegram_id = 80`).get() as any).topic_alert_at], [2, null]);

    // 2. Verrou perdu PENDANT la création du sujet : sujet orphelin fermé, pas enregistré.
    const db2 = freshDb();
    received(db2, 81, 1);
    const c2: Call[] = [];
    const racing = deps(db2, c2, { tg: fakeTg(c2, (m) => {
      if (m === "createForumTopic") {
        db2.exec(`UPDATE lecercle_dm_threads SET relay_lock_owner = 'autre', relay_lock_until = datetime('now', '+60 seconds') WHERE telegram_id = 81`);
      }
      return undefined;
    }) });
    await captureBroadcastReply(pm(81, { text: "hello" }), racing);
    eq("verrou perdu pendant la création : sujet non enregistré, fermé, rien posté",
      [(db2.prepare(`SELECT thread_id FROM lecercle_dm_threads WHERE telegram_id = 81`).get() as any).thread_id,
       c2.some(c => c.method === "closeForumTopic"), c2.some(c => c.body.text === "hello")], [null, true, false]);

    // Verrou perdu entre deux appels d'un même post (sujet fermé → réouverture) : rien de plus envoyé.
    const db3 = freshDb();
    received(db3, 82, 1);
    await captureBroadcastReply(pm(82, { text: "avant" }), deps(db3, []));
    const c3: Call[] = [];
    await captureBroadcastReply(pm(82, { text: "fermé" }), deps(db3, c3, { tg: fakeTg(c3, (m) => {
      if (m === "sendMessage") {
        db3.exec(`UPDATE lecercle_dm_threads SET relay_lock_owner = 'autre', relay_lock_until = datetime('now', '+60 seconds') WHERE telegram_id = 82`);
        return { ok: false, error_code: 400, description: "Bad Request: TOPIC_CLOSED" };
      }
      return undefined;
    }) }));
    eq("verrou perdu après un refus : ni réouverture ni second envoi", [c3.some(c => c.method === "reopenForumTopic"), c3.filter(c => c.method === "sendMessage").length], [false, 1]);

    // 5. Message de l'opérateur dans un ancien sujet « 📣 » : prévenu, rien envoyé.
    const c5: Call[] = [];
    const stale = await handleBroadcastTopicMessage(adminMsg(4242, { text: "tu es là ?", reply_to_message: { forum_topic_created: { name: "📣 @vieux · Onboarding" } } }), deps(db3, c5));
    eq("ancien sujet 📣 : prévenu « sujet obsolète », rien envoyé à personne",
      [stale, c5.some(c => /Sujet obsolète/.test(c.body.text ?? "")), c5.filter(c => typeof c.body.chat_id === "number").length], [true, true, 0]);
    eq("autre sujet du groupe (pas 📣) : pas pour nous", await handleBroadcastTopicMessage(adminMsg(4243, { text: "note interne", reply_to_message: { forum_topic_created: { name: "Compta" } } }), deps(db3, [])), false);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nRéponses de l'opérateur depuis le sujet");
  {
    const db = freshDb();
    received(db, 40, 1);
    const calls: Call[] = [];
    const d = deps(db, calls);
    await captureBroadcastReply(pm(40, { text: "question" }), d);
    calls.length = 0;

    eq("message hors de nos sujets (General) : pas pour nous", await handleBroadcastTopicMessage(adminMsg(999, { text: "hello" }), d), false);
    eq("message d'un autre chat : pas pour nous", await handleBroadcastTopicMessage({ ...adminMsg(77, { text: "x" }), chat: { id: -1009, type: "supergroup" } }, d), false);
    eq("message du bot lui-même : ignoré", await handleBroadcastTopicMessage({ ...adminMsg(77, { text: "x" }), from: { id: 1, is_bot: true } }, d), false);
    eq("message de service (épinglage) : ignoré", await handleBroadcastTopicMessage(adminMsg(77, { pinned_message: {} }), d), false);
    eq("aucun envoi pour ces cas", calls.length, 0);

    eq("texte de l'opérateur : envoyé", await handleBroadcastTopicMessage(adminMsg(77, { text: "Salut <3 à dimanche" }), d), true);
    const sent = calls.find(c => c.method === "sendMessage" && c.body.chat_id === 40);
    eq("… à la bonne personne, en texte simple (pas de parse_mode)", [sent?.body.text, "parse_mode" in (sent?.body ?? {})], ["Salut <3 à dimanche", false]);
    eq("… confirmé par une réaction", calls.some(c => c.method === "setMessageReaction"), true);
    const th = db.prepare(`SELECT last_operator_reply_at IS NOT NULL AS r FROM lecercle_dm_threads WHERE telegram_id = 40`).get() as any;
    eq("… et la fenêtre repart (dernière réponse notée)", th.r, 1);

    calls.length = 0;
    await handleBroadcastTopicMessage(adminMsg(77, { photo: [{ file_id: "p" }], caption: "le plan" }), d);
    const cp = calls.find(c => c.method === "copyMessage");
    eq("média de l'opérateur : recopié vers la personne", [cp?.body.chat_id, cp?.body.from_chat_id], [40, ADMIN]);

    calls.length = 0;
    await handleBroadcastTopicMessage(adminMsg(77, { photo: [{ file_id: "p" }], caption: "/tmp/plan.png" }), d);
    eq("photo dont la légende commence par « / » : envoyée, pas prise pour une commande", calls.some(c => c.method === "copyMessage" && c.body.chat_id === 40), true);

    calls.length = 0;
    await handleBroadcastTopicMessage(adminMsg(77, { text: "/truc" }), d);
    eq("commande inconnue : rien envoyé à la personne", calls.filter(c => c.body.chat_id === 40).length, 0);
    await handleBroadcastTopicMessage(adminMsg(77, { text: "/note rappeler lundi" }), d);
    eq("/note : enregistrée", /rappeler lundi/.test((db.prepare(`SELECT notes FROM lecercle_dm_threads WHERE telegram_id = 40`).get() as any).notes), true);

    await handleBroadcastTopicMessage(adminMsg(77, { text: "/bot" }), d);
    eq("/bot : relais clos", (db.prepare(`SELECT closed_at IS NOT NULL AS c FROM lecercle_dm_threads WHERE telegram_id = 40`).get() as any).c, 1);
    eq("… son message suivant repart vers le bot (pas pris)", await captureBroadcastReply(pm(40, { text: "encore" }), d), false);
    await handleBroadcastTopicMessage(adminMsg(77, { text: "je reviens vers toi" }), d);
    eq("réponse de l'opérateur après /bot : relais rouvert", await captureBroadcastReply(pm(40, { text: "merci" }), d), true);

    calls.length = 0;
    const blockedDeps = deps(db, calls, { tg: fakeTg(calls, (m, b) => m === "sendMessage" && b.chat_id === 40 ? { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } : undefined) });
    await handleBroadcastTopicMessage(adminMsg(77, { text: "tu es là ?" }), blockedDeps);
    eq("403 bloqué : alerte dans le sujet, compte marqué bloqué",
      [calls.some(c => c.body.chat_id === ADMIN && /Non envoyé/.test(c.body.text ?? "")),
       (db.prepare(`SELECT blocked_at IS NOT NULL AS b FROM lecercle_bot_users WHERE telegram_id = 40`).get() as any)?.b], [true, 1]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nID joueur attendu par un parcours : seul l'ID va au parcours, le reste est relayé");
  {
    const db = freshDb();
    db.exec(`INSERT INTO qqpk_funnel_leads (telegram_id, stage) VALUES (60, 2), (61, 4), (62, 2)`);
    db.exec(`INSERT INTO nexa_leads (id, tg_user_id, stage, member_id) VALUES (9, 62, 'started', NULL), (10, 63, 'app_installed', NULL), (11, 64, 'app_installed', '555')`);
    received(db, 60, 1); received(db, 61, 1); received(db, 62, 1); received(db, 63, 1); received(db, 64, 1);
    const calls: Call[] = [];
    const armed: number[] = [];
    const d = deps(db, calls, { armNexa: (id) => { armed.push(id); } });
    eq("QQPK étape 2, envoie son ID : rendu au parcours QQPK", await captureBroadcastReply(pm(60, { text: " 12345678 " }), d), false);
    eq("QQPK étape 2, « je trouve pas mon ID » : relayé à l'opérateur", await captureBroadcastReply(pm(60, { text: "je trouve pas mon ID" }), d), true);
    eq("QQPK étape 2, photo : relayée", await captureBroadcastReply(pm(60, { photo: [{ file_id: "p" }] }), d), true);
    eq("QQPK étape 4 : relayé ET réellement posté dans son propre sujet",
      [await captureBroadcastReply(pm(61, { text: "merci" }), d),
       calls.some(c => c.method === "sendMessage" && c.body.text === "merci" && c.body.message_thread_id !== undefined),
       new Set(calls.filter(c => c.method === "createForumTopic").map((_, i) => i)).size],
      [true, true, 2]);
    eq("aucune erreur d'unicité : un sujet par personne",
      (db.prepare(`SELECT COUNT(DISTINCT thread_id) AS n FROM lecercle_dm_threads WHERE thread_id IS NOT NULL`).get() as any).n, 2);
    // Lead à la fois Nexa et QQPK : Nexa gagne toujours le répartiteur (capture Nexa) —
    // l'exception QQPK ne s'applique pas, son ID arrive dans son sujet Nexa.
    eq("QQPK étape 2 ET lead Nexa, envoie son ID QQPK : silence armé (relais Nexa)", [await armNexaHoldIfBroadcastReply(pm(62, { text: "12345678" }), d), armed], [true, [9]]);
    eq("Nexa à l'étape de l'ID, envoie des chiffres : pas de silence (le parcours Nexa le capte)", [await armNexaHoldIfBroadcastReply(pm(63, { text: "987654" }), d), armed], [false, [9]]);
    eq("Nexa à l'étape de l'ID, écrit du texte : silence armé", [await armNexaHoldIfBroadcastReply(pm(63, { text: "c'est quoi mon ID ?" }), d), armed], [true, [9, 10]]);
    eq("Nexa qui a déjà son ID, envoie des chiffres : silence armé", [await armNexaHoldIfBroadcastReply(pm(64, { text: "100" }), d), armed], [true, [9, 10, 11]]);
    eq("l'ID QQPK n'est pas stocké côté relais", (db.prepare(`SELECT COUNT(*) AS n FROM lecercle_dm_messages WHERE telegram_id = 60 AND text LIKE '%12345678%'`).get() as any).n, 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nCorrectifs mineurs — horloge, messages système, sujet supprimé, ordre de reprise, lead devenu Nexa");
  {
    // Réponse datée avant sent_at mais après la réservation : dans la fenêtre.
    const db = freshDb();
    received(db, 70, 0);
    db.exec(`UPDATE lecercle_broadcast_targets SET claimed_at = datetime('now', '-10 seconds'), sent_at = datetime('now', '+5 seconds') WHERE telegram_id = 70`);
    eq("réponse datée entre réservation et sent_at : relayée", await captureBroadcastReply(pm(70, { text: "déjà là" }), deps(db, [])), true);

    const calls: Call[] = [];
    eq("message système privé (minuterie) : ignoré",
      await captureBroadcastReply({ ...pm(70), text: undefined, message_auto_delete_timer_changed: { message_auto_delete_time: 86400 } }, deps(db, calls)), false);

    // Sujet supprimé : recréé dans la même passe, sans attendre le cron.
    const db2 = freshDb();
    received(db2, 71, 1);
    const c2: Call[] = [];
    let gone = true;
    await captureBroadcastReply(pm(71, { text: "avant" }), deps(db2, c2));
    c2.length = 0;
    await captureBroadcastReply(pm(71, { text: "après" }), deps(db2, c2, { tg: fakeTg(c2, (m) => {
      if (m === "sendMessage" && gone) { gone = false; return { ok: false, error_code: 400, description: "Bad Request: message thread not found" }; }
      return undefined;
    }) }));
    eq("sujet supprimé : recréé et message posté dans la même passe",
      [c2.filter(c => c.method === "createForumTopic").length, c2.some(c => c.body.text === "après"),
       (db2.prepare(`SELECT COUNT(*) AS n FROM lecercle_dm_messages m JOIN lecercle_dm_threads t USING (telegram_id) WHERE m.id > t.last_relayed_msg_id`).get() as any).n],
      [1, true, 0]);

    // Reprise : le message en attente le plus ancien passe en premier.
    const db3 = freshDb();
    db3.exec(`INSERT INTO lecercle_dm_threads (telegram_id) VALUES (900), (100)`);
    db3.exec(`INSERT INTO lecercle_dm_messages (telegram_id, direction, sender, kind, text) VALUES (900, 'in', 'user', 'text', 'vieux'), (100, 'in', 'user', 'text', 'récent')`);
    const c3: Call[] = [];
    await drainPendingDmRelays(deps(db3, c3), 1);
    eq("reprise bornée à 1 : le plus ancien en attente d'abord", c3.some(c => c.body.text === "vieux") && !c3.some(c => c.body.text === "récent"), true);

    // Compte devenu lead Nexa : l'opérateur est renvoyé vers le sujet Nexa, rien n'est envoyé.
    const db4 = freshDb();
    received(db4, 72, 1);
    await captureBroadcastReply(pm(72, { text: "bonjour" }), deps(db4, []));
    db4.exec(`INSERT INTO nexa_leads (id, tg_user_id, admin_topic_chat_id, admin_thread_id) VALUES (20, 72, '${ADMIN}', 555)`);
    const c4: Call[] = [];
    await handleBroadcastTopicMessage(adminMsg(77, { text: "tu es là ?" }), deps(db4, c4));
    eq("devenu lead Nexa : rien envoyé, renvoi vers son sujet Nexa",
      [c4.filter(c => c.body.chat_id === 72).length, c4.some(c => /lead Nexa/.test(c.body.text ?? "") && /t\.me\/c\/1234567890\/555/.test(c.body.text ?? ""))], [0, true]);
  }

  console.log("\nCarte contexte — sources");
  {
    const db = freshDb();
    db.exec(`INSERT INTO players (id, name, telegram_id) VALUES (7, 'Bob Joueur', 50)`);
    db.exec(`INSERT INTO affiliate_leads (referred_handle, referred_telegram_id) VALUES ('tg:51', 51)`);
    received(db, 50, 1); received(db, 51, 1); received(db, 52, 1, { status: "unknown" });
    eq("joueur rattaché", /Joueur « Bob Joueur » \(#7\)/.test(contextFor(50, db).card), true);
    eq("parrainage, nom de repli = @user de la diffusion", [contextFor(51, db).sourceShort, contextFor(51, db).name], ["Parrainage", "@user51"]);
    eq("aucune table : Autre ; issue d'envoi inconnue signalée", [contextFor(52, db).sourceShort, /issue d'envoi inconnue/.test(contextFor(52, db).card)], ["Autre", true]);
  }

  console.log(`\n${passed} assertions OK, ${failures.length} en échec`);
  if (failures.length) {
    for (const f of failures) console.log("  ✘", f);
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
