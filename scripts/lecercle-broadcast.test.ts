// Diffusions @LeCercle_Lebot — envoi, reprise, dédoublonnage, exclusions, clics, réponses.
// Run: npx tsx scripts/lecercle-broadcast.test.ts
//
// ┌─ CE QUE CE FICHIER PROUVE ─────────────────────────────────────────────────┐
// │  1. Personne ne reçoit deux fois la même diffusion : verrou de drain EN    │
// │     BASE (deux copies du module = deux drains), réservation exclusive,     │
// │     UNIQUE. Un envoi à l'issue inconnue (crash, panne) n'est JAMAIS renvoyé│
// │     et la reprise ne perd personne d'autre.                                │
// │  2. Un 429 ne consomme pas le destinataire ; un 403 « blocked » exclut le │
// │     compte des diffusions suivantes ; « can't initiate » n'est PAS bloqué. │
// │  3. Les exclusions d'office (opérateur, bloqué, relances coupées, takeover)│
// │     sont appliquées à la création ET relues juste avant l'envoi.           │
// │  4. Un clic n'est compté que pour un humain, sur un jeton connu, et ne     │
// │     redirige que vers l'URL stockée. « Test à moi » n'écrit rien.          │
// │  5. Une réponse va à la diffusion la plus récente des 72 h, et à elle seule.│
// │  6. L'initialisation de l'audience est rejouable sans doublon ni écrasement.│
// │                                                                            │
// │ Tables lecercle_* : le SQL de la migration lui-même. Tables sources        │
// │ (onboarding_leads, nexa_leads…) : réduites aux colonnes lues ici — leur    │
// │ vrai DDL est éclaté sur des dizaines de migrations de lib/db.ts.           │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import { LECERCLE_BROADCAST_SCHEMA_SQL, LECERCLE_DM_RELAY_SCHEMA_SQL, LECERCLE_DM_RELAY_ALTERS } from "../lib/funnels/lecercle/schema";
import {
  resolveAudience, countAudience, backfillBotUsers, currentExclusion, DEFAULT_SEGMENT,
  type LecercleSegment, type DbLike,
} from "../lib/funnels/lecercle/audience";
import {
  createBroadcast, startBroadcast, scheduleBroadcast, pauseBroadcast, cancelBroadcast,
  runBroadcastDrain, getStats, listTargets, promoteDueScheduled, sendTest, utc8ToSqlUtc,
  contentError, trackedUrl, MAX_ATTEMPTS, type SendFn,
} from "../lib/funnels/lecercle/broadcast";
import {
  resolveClickToken, recordClick, isBotUserAgent, attributeReply, recordInboundForBroadcast,
} from "../lib/funnels/lecercle/tracking";
import { checkTelegramHtml } from "../lib/funnels/lecercle/html";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got) ?? "undefined", w = JSON.stringify(want) ?? "undefined";
  if (g === w) { passed++; console.log("   ✔", label, "→", g); }
  else { failures.push(label); console.log("   ✘", label, `attendu ${w}, obtenu ${g}`); }
}

const OWNER = 1486389037;
const OWNERS = { owners: [OWNER] };

const SOURCES_SQL = `
  CREATE TABLE onboarding_leads (id INTEGER PRIMARY KEY, telegram_id INTEGER NOT NULL UNIQUE,
    telegram_username TEXT, first_name TEXT, stage TEXT NOT NULL DEFAULT 'welcome',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT, last_player_activity_at TEXT);
  CREATE TABLE nexa_leads (id INTEGER PRIMARY KEY, tg_user_id INTEGER NOT NULL UNIQUE, tg_username TEXT,
    first_name TEXT, source TEXT NOT NULL DEFAULT 'direct', stage TEXT NOT NULL DEFAULT 'started',
    started_at TEXT, created_at TEXT, last_interaction_at TEXT, last_lead_msg_at TEXT,
    blocked INTEGER NOT NULL DEFAULT 0, relances_off INTEGER NOT NULL DEFAULT 0,
    takeover_until TEXT, awaiting_human_since TEXT);
  CREATE TABLE qqpk_funnel_leads (id INTEGER PRIMARY KEY, telegram_id INTEGER NOT NULL UNIQUE,
    username TEXT, first_name TEXT, stage INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);
  CREATE TABLE affiliate_leads (id INTEGER PRIMARY KEY, referred_handle TEXT NOT NULL,
    referred_telegram_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, telegram_handle TEXT, telegram_id INTEGER,
    telegram_chat_id TEXT, created_at TEXT);
`;

type TestDb = DbLike;

function freshDb(): TestDb {
  const db = new Database(":memory:");
  db.exec(SOURCES_SQL);
  db.exec(LECERCLE_BROADCAST_SCHEMA_SQL);
  // Migration suivante (relais des réponses) : la réservation écrit claimed_at.
  db.exec(LECERCLE_DM_RELAY_SCHEMA_SQL);
  for (const sql of LECERCLE_DM_RELAY_ALTERS) db.exec(sql);
  return db;
}

function user(db: TestDb, id: number, extra: { username?: string; first_name?: string; blocked?: boolean } = {}) {
  db.prepare(`INSERT INTO lecercle_bot_users (telegram_id, username, first_name, first_seen_at, last_seen_at, blocked_at, origin)
              VALUES (?, ?, ?, datetime('now','-10 days'), datetime('now','-1 days'), ?, 'webhook')`)
    .run(id, extra.username ?? null, extra.first_name ?? null, extra.blocked ? "2026-09-01 00:00:00" : null);
}

const SEG: LecercleSegment = { ...DEFAULT_SEGMENT };
const DRAFT = { title: "rappel", body: "🃏 Tournoi <b>dimanche</b> 20h", buttonLabel: "Je viens", buttonUrl: "https://example.com/t?x=1" };

type Call = { chatId: number; token: string };
function okSender(log: Call[]): SendFn {
  return async (chatId, _bc, t) => { log.push({ chatId, token: t.click_token }); return { ok: true, result: { message_id: 7 } }; };
}

function create(db: TestDb, seg: LecercleSegment = SEG) {
  const r = createBroadcast({ ...DRAFT, segment: seg }, OWNERS, db);
  if (!r.ok) throw new Error(`create: ${r.error}`);
  return r;
}

(async () => {
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nValidation HTML Telegram");
  {
    eq("texte + balises admises", checkTelegramHtml("<b>a</b> <i>b</i> <a href=\"https://x.y\">l</a> &lt;3").ok, true);
    eq("longueur visible = texte sans balises, entités décodées", checkTelegramHtml("<b>ab</b>&amp;").visibleLength, 3);
    eq("« < » nu refusé", checkTelegramHtml("1 < 2").ok, false);
    eq("« & » et « > » isolés acceptés, comme Telegram", [checkTelegramHtml("Q&A · 5 > 3").ok, checkTelegramHtml("Q&A").visibleLength], [true, 3]);
    eq("« > » dans un attribut entre guillemets", checkTelegramHtml("<a href=\"https://x.y/?a>b\">l</a>").ok, true);
    eq("message d'erreur lisible (&lt; affiché tel quel)", checkTelegramHtml("1 < 2").errors[0].includes("écris &lt;"), true);
    eq("balise inconnue refusée", checkTelegramHtml("<div>x</div>").ok, false);
    eq("balises croisées refusées", checkTelegramHtml("<b><i>x</b></i>").ok, false);
    eq("balise jamais fermée refusée", checkTelegramHtml("<b>x").ok, false);
    eq("lien javascript: refusé", checkTelegramHtml("<a href=\"javascript:alert(1)\">x</a>").ok, false);
    eq("span sans tg-spoiler refusé", checkTelegramHtml("<span style=\"x\">x</span>").ok, false);
    eq("spoiler admis", checkTelegramHtml("<span class=\"tg-spoiler\">x</span><tg-spoiler>y</tg-spoiler>").ok, true);
    eq("pre > code.language admis", checkTelegramHtml("<pre><code class=\"language-js\">x</code></pre>").ok, true);
    eq("gras dans pre refusé", checkTelegramHtml("<pre><b>x</b></pre>").ok, false);
    eq("> 4096 visibles refusé", checkTelegramHtml("x".repeat(4097)).ok, false);
    eq("4096 visibles admis même avec balises", checkTelegramHtml(`<b>${"x".repeat(4096)}</b>`).ok, true);
    eq("vide refusé", checkTelegramHtml("<b> </b>").ok, false);
    eq("bouton tg:// refusé (passe par /b)", contentError({ body: "x", buttonLabel: "a", buttonUrl: "tg://resolve" }) !== null, true);
    eq("bouton libellé sans URL refusé", contentError({ body: "x", buttonLabel: "a", buttonUrl: "" }) !== null, true);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nInitialisation de l'audience — idempotente, sans écrasement");
  {
    const db = freshDb();
    db.exec(`
      INSERT INTO onboarding_leads (telegram_id, telegram_username, first_name, stage, created_at, last_seen)
        VALUES (1, 'alice', 'Alice', 'joined', '2026-06-01 10:00:00', '2026-09-01 10:00:00'),
               (2, NULL, 'Bob', 'discovered', '2026-07-01 10:00:00', '2026-07-01 10:00:00');
      INSERT INTO nexa_leads (tg_user_id, tg_username, first_name, started_at, created_at, last_interaction_at)
        VALUES (1, 'alice_nexa', 'Alice', '2026-05-01 10:00:00', '2026-05-01 10:00:00', '2026-09-10 10:00:00'),
               (3, 'carol', 'Carol', '2026-08-01 10:00:00', '2026-08-01 10:00:00', NULL);
      INSERT INTO qqpk_funnel_leads (telegram_id, username, first_name, created_at) VALUES (4, 'dan', 'Dan', '2026-07-22 07:00:00');
      INSERT INTO affiliate_leads (referred_handle, referred_telegram_id, created_at) VALUES ('tg:5', 5, '2026-08-05 00:00:00');
      INSERT INTO players (name, telegram_handle, telegram_id, telegram_chat_id) VALUES
        ('Eve', 'eve', 6, '6'),        -- chat privé connu : preuve de /start
        ('Frank', 'frank', 7, '-100123'), -- seulement un groupe : pas de preuve
        ('Alice', 'alice', 1, '1');
    `);
    const added1 = backfillBotUsers(db);
    eq("6 comptes distincts ajoutés (1 présent dans 3 sources, 7 sans preuve exclu)", added1, 6);
    eq("dernière activité = la plus récente des sources (nexa 10/09 > onboarding 01/09)",
      (db.prepare(`SELECT last_seen_at FROM lecercle_bot_users WHERE telegram_id = 1`).get() as any).last_seen_at, "2026-09-10 10:00:00");

    // Faits observés APRÈS l'initialisation : ils ne doivent jamais être écrasés.
    db.exec(`UPDATE lecercle_bot_users SET last_seen_at = '2026-09-20 00:00:00', blocked_at = '2026-09-21 00:00:00',
             block_reason = 'x', username = 'alice_live' WHERE telegram_id = 1`);
    const snapshot = () => db.prepare(`SELECT * FROM lecercle_bot_users ORDER BY telegram_id`).all();
    const before = JSON.stringify(snapshot());
    const added2 = backfillBotUsers(db);
    eq("rejouée : aucun ajout", added2, 0);
    eq("rejouée : aucune ligne modifiée", JSON.stringify(snapshot()) === before, true);
    const a = db.prepare(`SELECT * FROM lecercle_bot_users WHERE telegram_id = 1`).get() as any;
    eq("first_seen = la plus ancienne des sources (nexa)", a.first_seen_at, "2026-05-01 10:00:00");
    eq("last_seen / blocked_at / username non écrasés", [a.last_seen_at, a.blocked_at, a.username], ["2026-09-20 00:00:00", "2026-09-21 00:00:00", "alice_live"]);
    const e = db.prepare(`SELECT username FROM lecercle_bot_users WHERE telegram_id = 5`).get() as any;
    eq("« tg:<id> » n'est pas pris pour un @handle", e.username, null);

    // Une source plus ancienne apparue après coup fait reculer first_seen, rien d'autre.
    db.exec(`INSERT INTO qqpk_funnel_leads (telegram_id, username, first_name, created_at) VALUES (1, 'zzz', 'Z', '2026-04-01 00:00:00')`);
    backfillBotUsers(db);
    const a2 = db.prepare(`SELECT first_seen_at, username, last_seen_at FROM lecercle_bot_users WHERE telegram_id = 1`).get() as any;
    eq("first_seen recule, username et last_seen intacts", [a2.first_seen_at, a2.username, a2.last_seen_at], ["2026-04-01 00:00:00", "alice_live", "2026-09-20 00:00:00"]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nAudience — sources, étapes, exclusions d'office avec motif");
  {
    const db = freshDb();
    for (const id of [10, 11, 12, 13, 14, 15, 16, 17, OWNER]) user(db, id);
    user(db, 18, { blocked: true });
    db.exec(`
      INSERT INTO onboarding_leads (telegram_id, stage) VALUES (10, 'joined'), (11, 'discovered');
      INSERT INTO nexa_leads (tg_user_id, stage, source, blocked, relances_off, takeover_until, awaiting_human_since) VALUES
        (12, 'played', 'ig', 0, 0, NULL, NULL),
        (13, 'started', 'tg', 1, 0, NULL, NULL),
        (14, 'started', 'tg', 0, 1, NULL, NULL),
        (15, 'started', 'tg', 0, 0, datetime('now', '+2 hours'), NULL),
        (16, 'started', 'tg', 0, 0, datetime('now', '-2 hours'), NULL),
        (17, 'started', 'tg', 0, 0, NULL, datetime('now', '-5 minutes'));
      INSERT INTO players (name, telegram_handle, telegram_id, telegram_chat_id) VALUES ('Joueur sans preuve', 'nopre', 99, NULL);
    `);
    const s = countAudience(SEG, OWNERS, db);
    eq("destinataires : 10, 11, 12, 16 (takeover expiré) + 'other' aucun", s.recipients, 4);
    // Clés triées : l'ordre d'insertion dépend de l'ordre des lignes, pas du sens.
    eq("exclus par motif", Object.fromEntries(Object.entries(s.excluded).sort()), { blocked: 2, owner: 1, relances_off: 1, takeover: 2 });
    eq("joueur sans preuve absent par défaut", resolveAudience(SEG, OWNERS, db).some(r => r.telegram_id === 99), false);
    eq("joueur sans preuve présent si coché", countAudience({ ...SEG, includeUnproven: true }, OWNERS, db).unproven, 1);
    eq("source onboarding + étape joined", resolveAudience({ ...SEG, sources: ["onboarding"], onboardingStages: ["joined"] }, OWNERS, db).map(r => r.telegram_id), [10]);
    eq("source nexa + canal ig", resolveAudience({ ...SEG, sources: ["nexa"], nexaSources: ["ig"] }, OWNERS, db).map(r => r.telegram_id), [12]);
    eq("source 'other' = vu par le webhook, dans aucune table", resolveAudience({ ...SEG, sources: ["other"] }, OWNERS, db).map(r => r.telegram_id), [18, OWNER].sort((a, b) => a - b));
    eq("motif relu à l'unité : takeover actif", currentExclusion(15, OWNERS, db), "takeover");
    eq("motif relu à l'unité : takeover expiré", currentExclusion(16, OWNERS, db), null);

    // Borne de date en UTC+8 : 2026-09-25 00:30 heure de Pékin = 2026-09-24 16:30 UTC.
    db.exec(`UPDATE lecercle_bot_users SET first_seen_at = '2026-09-24 16:30:00' WHERE telegram_id = 10`);
    db.exec(`UPDATE lecercle_bot_users SET first_seen_at = '2026-09-24 15:59:59' WHERE telegram_id = 11`);
    eq("« à partir du 25/09 » (UTC+8) garde 16:30 UTC la veille, pas 15:59",
      resolveAudience({ ...SEG, startedFrom: "2026-09-25", startedTo: "2026-09-25" }, OWNERS, db).map(r => r.telegram_id), [10]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nCréation — brouillon figé, jetons, confirmation du total");
  {
    const db = freshDb();
    for (const id of [1, 2, 3]) user(db, id);
    const r = create(db);
    eq("brouillon, 3 destinataires", [getStats(r.id!, db).total, r.total], [3, 3]);
    const tokens = (db.prepare(`SELECT click_token FROM lecercle_broadcast_targets`).all() as any[]).map(x => x.click_token);
    eq("jetons : 22 caractères base64url (128 bits), tous différents",
      [tokens.every(t => /^[A-Za-z0-9_-]{22}$/.test(t)), new Set(tokens).size], [true, 3]);
    let dupRefused = false;
    try {
      db.prepare(`INSERT INTO lecercle_broadcast_targets (broadcast_id, telegram_id, click_token) VALUES (?, 1, 'x')`).run(r.id);
    } catch { dupRefused = true; }
    eq("UNIQUE(broadcast_id, telegram_id) refuse un second envoi au même compte", dupRefused, true);

    eq("démarrage sans confirmation refusé", startBroadcast(r.id!, undefined, db).ok, false);
    eq("démarrage avec un mauvais total refusé", startBroadcast(r.id!, 4, db).ok, false);
    eq("rien ne part d'un brouillon", getStats(r.id!, db).sent, 0);
    eq("démarrage avec le total exact", startBroadcast(r.id!, 3, db).ok, true);
    const r2 = create(db);
    eq("une seule diffusion à la fois", startBroadcast(r2.id!, 3, db).ok, false);

    eq("HTML invalide refusé à la création", createBroadcast({ ...DRAFT, body: "a < b", segment: SEG }, OWNERS, db).ok, false);
    const empty = freshDb();
    eq("aucun destinataire refusé", createBroadcast({ ...DRAFT, segment: SEG }, OWNERS, empty).ok, false);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nEnvoi — chacun une fois, bouton tracké, reprise après coupure");
  {
    const db = freshDb();
    for (let id = 1; id <= 6; id++) user(db, id);
    const r = create(db);
    startBroadcast(r.id!, 6, db);

    // Coupure : le process meurt pendant le 4e envoi (exception non rattrapée).
    const log: Call[] = [];
    let n = 0;
    const crashing: SendFn = async (chatId, bc, t) => {
      n++;
      if (n === 4) throw new Error("process tué");
      return okSender(log)(chatId, bc, t);
    };
    let crashed = false;
    try { await runBroadcastDrain({ sendFn: crashing, spacing: 0, owners: [OWNER] }, db); } catch { crashed = true; }
    eq("le drain a bien été interrompu", crashed, true);
    const mid = getStats(r.id!, db);
    eq("3 envoyés, 1 en vol au moment du crash, 2 en attente", [mid.sent, mid.sending, mid.pending], [3, 1, 2]);

    const resumed = await runBroadcastDrain({ sendFn: okSender(log), spacing: 0, owners: [OWNER] }, db);
    const ids = log.map(c => c.chatId).sort((a, b) => a - b);
    eq("reprise : l'envoi en vol passe en issue inconnue, sans renvoi", [resumed.recovered, getStats(r.id!, db).unknown], [1, 1]);
    eq("reprise : les 5 autres servis, chacun une fois", ids, [1, 2, 3, 5, 6]);
    eq("diffusion terminée", (db.prepare(`SELECT status FROM lecercle_broadcasts WHERE id = ?`).get(r.id) as any).status, "done");

    const stored = new Map((db.prepare(`SELECT telegram_id, click_token FROM lecercle_broadcast_targets`).all() as any[]).map(x => [x.telegram_id, x.click_token]));
    eq("chaque envoi porte le jeton de SON destinataire", log.every(c => stored.get(c.chatId) === c.token), true);
    eq("URL du bouton = /b/<jeton>", /\/b\/[A-Za-z0-9_-]{22}$/.test(trackedUrl(log[0].token)), true);

    // Deux drains lancés en même temps : le second rend la main sans rien envoyer.
    const db2 = freshDb();
    for (let id = 1; id <= 3; id++) user(db2, id);
    const r2 = create(db2);
    startBroadcast(r2.id!, 3, db2);
    const log2: Call[] = [];
    const slow: SendFn = async (c, bc, t) => { await new Promise(res => setTimeout(res, 5)); return okSender(log2)(c, bc, t); };
    // Deux identités de verrou = deux copies du module (cron + route API) :
    // le cas réel que le drapeau en mémoire ne couvrait pas (audit, finding 1).
    const [a, b] = await Promise.all([
      runBroadcastDrain({ sendFn: slow, spacing: 0, owners: [OWNER], lockOwner: "cron" }, db2),
      runBroadcastDrain({ sendFn: slow, spacing: 0, owners: [OWNER], lockOwner: "api" }, db2),
    ]);
    eq("deux drains concurrents : 3 envois, 3 comptes distincts, un seul a eu le verrou",
      [log2.length, new Set(log2.map(c => c.chatId)).size, [a.locked, b.locked].filter(Boolean).length], [3, 3, 1]);

    // Scénario exact de l'audit : B démarre PENDANT que A envoie au premier.
    const db4 = freshDb();
    for (let id = 11; id <= 15; id++) user(db4, id);
    const r4 = create(db4);
    startBroadcast(r4.id!, 5, db4);
    const log4: Call[] = [];
    let second: Promise<any> | null = null;
    const sendA: SendFn = async (c, bc, t) => {
      if (!second) second = runBroadcastDrain({ sendFn: okSender(log4), spacing: 0, owners: [OWNER], lockOwner: "B" }, db4);
      await second;
      return okSender(log4)(c, bc, t);
    };
    await runBroadcastDrain({ sendFn: sendA, spacing: 0, owners: [OWNER], lockOwner: "A" }, db4);
    const ids4 = log4.map(c => c.chatId);
    eq("B lancé pendant l'envoi de A : aucun doublon", [ids4.length, new Set(ids4).size], [5, 5]);

    // Bail expiré (process mort) : repris par le suivant.
    db4.exec(`UPDATE lecercle_broadcast_lock SET owner = 'mort', until = datetime('now', '-1 second')`);
    eq("bail expiré : repris", (await runBroadcastDrain({ sendFn: okSender([]), spacing: 0, owners: [OWNER], lockOwner: "C" }, db4)).locked, true);
    db4.exec(`UPDATE lecercle_broadcast_lock SET owner = 'vivant', until = datetime('now', '+60 seconds')`);
    eq("bail vivant d'un autre : ce drain ne fait rien", (await runBroadcastDrain({ sendFn: okSender([]), spacing: 0, owners: [OWNER], lockOwner: "D" }, db4)).locked, false);

    // Réservation : une ligne déjà réclamée par un autre drain n'est pas renvoyée.
    const db3 = freshDb();
    user(db3, 1); user(db3, 2);
    const r3 = create(db3);
    startBroadcast(r3.id!, 2, db3);
    const log3: Call[] = [];
    const racing: SendFn = async (c, bc, t) => {
      // Pendant l'envoi au 1er, un « autre process » réserve le 2e.
      if (c === 1) db3.prepare(`UPDATE lecercle_broadcast_targets SET status = 'sending' WHERE telegram_id = 2`).run();
      return okSender(log3)(c, bc, t);
    };
    await runBroadcastDrain({ sendFn: racing, spacing: 0, owners: [OWNER] }, db3);
    eq("ligne réclamée ailleurs entre-temps : pas envoyée par ce drain", log3.map(c => c.chatId), [1]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nErreurs Telegram — 429, 403 bloqué, 403 jamais démarré, format, pause");
  {
    const db = freshDb();
    for (let id = 1; id <= 4; id++) user(db, id);
    const r = create(db);
    startBroadcast(r.id!, 4, db);
    const sender: SendFn = async (c) => {
      if (c === 1) return { ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } };
      return { ok: true, result: { message_id: 1 } };
    };
    const res = await runBroadcastDrain({ sendFn: sender, spacing: 0, owners: [OWNER] }, db);
    const t1 = db.prepare(`SELECT status, attempts FROM lecercle_broadcast_targets WHERE telegram_id = 1`).get() as any;
    eq("429 : destinataire gardé en attente, tentative rendue", [t1.status, t1.attempts, res.sent], ["pending", 0, 0]);
    const early: Call[] = [];
    await runBroadcastDrain({ sendFn: okSender(early), spacing: 0, owners: [OWNER] }, db);
    eq("429 : rien n'est envoyé avant retry_after, même au tick suivant", early.length, 0);
    db.exec(`UPDATE lecercle_broadcasts SET resume_after = datetime('now', '-1 second') WHERE id = ${r.id}`);
    await runBroadcastDrain({ sendFn: okSender([]), spacing: 0, owners: [OWNER] }, db);
    eq("après retry_after : tous envoyés", getStats(r.id!, db).sent, 4);

    const dbB = freshDb();
    for (let id = 1; id <= 3; id++) user(dbB, id);
    const rb = create(dbB);
    startBroadcast(rb.id!, 3, dbB);
    await runBroadcastDrain({
      spacing: 0, owners: [OWNER],
      sendFn: async (c) => c === 1 ? { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }
        : c === 2 ? { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" }
        : { ok: true, result: { message_id: 1 } },
    }, dbB);
    const st = (id: number) => dbB.prepare(`SELECT status, error_code FROM lecercle_broadcast_targets WHERE telegram_id = ?`).get(id) as any;
    eq("403 blocked → bloqué", st(1), { status: "blocked", error_code: 403 });
    eq("403 can't initiate → échec immédiat, PAS bloqué", st(2), { status: "failed", error_code: 403 });
    const bu = (id: number) => (dbB.prepare(`SELECT blocked_at FROM lecercle_bot_users WHERE telegram_id = ?`).get(id) as any).blocked_at;
    eq("403 blocked marque le compte, can't initiate non", [bu(1) !== null, bu(2)], [true, null]);
    const next = countAudience(SEG, OWNERS, dbB);
    eq("diffusion suivante : le bloqué est exclu d'office", [next.recipients, next.excluded.blocked], [2, 1]);

    const dbF = freshDb();
    for (let id = 1; id <= 3; id++) user(dbF, id);
    const rf = create(dbF);
    startBroadcast(rf.id!, 3, dbF);
    const resF = await runBroadcastDrain({
      spacing: 0, owners: [OWNER],
      sendFn: async () => ({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: unclosed tag" }),
    }, dbF);
    const bcF = dbF.prepare(`SELECT status FROM lecercle_broadcasts WHERE id = ?`).get(rf.id) as any;
    eq("erreur de format : pause au 1er, personne consommé", [bcF.status, resF.deferred, getStats(rf.id!, dbF).failed], ["paused", 3, 0]);

    const dbE = freshDb();
    user(dbE, 1);
    const re = create(dbE);
    startBroadcast(re.id!, 1, dbE);
    const refused: SendFn = async () => ({ ok: false, error_code: 400, description: "Bad Request: something odd" });
    for (let i = 0; i < MAX_ATTEMPTS; i++) await runBroadcastDrain({ sendFn: refused, spacing: 0, owners: [OWNER] }, dbE);
    eq(`refus 4xx explicite : échec définitif après ${MAX_ATTEMPTS} tentatives`, getStats(re.id!, dbE).failed, 1);

    // Pannes systémiques (audit, finding 2) : pause, personne marqué en échec.
    const systemic = async (label: string, reply: any, want: { unknown: number; pending: number; calls?: number }) => {
      const d = freshDb();
      for (let id = 1; id <= 3; id++) user(d, id);
      const rr = create(d);
      startBroadcast(rr.id!, 3, d);
      const calls: number[] = [];
      await runBroadcastDrain({ spacing: 0, owners: [OWNER], sendFn: async (c) => { calls.push(c); return reply; } }, d);
      const s = getStats(rr.id!, d);
      const status = (d.prepare(`SELECT status FROM lecercle_broadcasts WHERE id = ?`).get(rr.id) as any).status;
      const attempts = (d.prepare(`SELECT SUM(attempts) AS n FROM lecercle_broadcast_targets WHERE status = 'pending'`).get() as any).n ?? 0;
      eq(`${label} : pause, aucun échec, aucune tentative consommée`, [status, calls.length, s.failed, s.unknown, s.pending, attempts],
        ["paused", want.calls ?? 1, 0, want.unknown, want.pending, 0]);
    };
    await systemic("token absent (rien parti)", { ok: false, notSent: true, description: "TELEGRAM_BOT_TOKEN absent" }, { unknown: 0, pending: 3 });
    await systemic("token refusé 401", { ok: false, error_code: 401, description: "Unauthorized" }, { unknown: 0, pending: 3 });
    await systemic("URL de bouton refusée", { ok: false, error_code: 400, description: "Bad Request: wrong HTTP URL" }, { unknown: 0, pending: 3 });
    await systemic("réseau / timeout (issue inconnue)", { ok: false, description: "The operation was aborted due to timeout" }, { unknown: 1, pending: 2 });
    await systemic("400 inconnu répété (précaution après 3)", { ok: false, error_code: 400, description: "Bad Request: brand new error" }, { unknown: 0, pending: 3, calls: 3 });
    await systemic("5xx Telegram (issue inconnue)", { ok: false, error_code: 502, description: "Bad Gateway" }, { unknown: 1, pending: 2 });

    // Pause pendant le tour : aucun envoi après la pause.
    const dbP = freshDb();
    for (let id = 1; id <= 4; id++) user(dbP, id);
    const rp = create(dbP);
    startBroadcast(rp.id!, 4, dbP);
    const logP: Call[] = [];
    await runBroadcastDrain({
      spacing: 0, owners: [OWNER],
      sendFn: async (c, bc, t) => { if (c === 2) pauseBroadcast(rp.id!, "manuel", dbP); return okSender(logP)(c, bc, t); },
    }, dbP);
    eq("pause en cours de tour : arrêt avant l'envoi suivant", logP.map(c => c.chatId), [1, 2]);

    // Pause tombée juste avant la clôture (audit, finding 4) : « Reprendre » clôt.
    const dbZ = freshDb();
    user(dbZ, 1);
    const rz = create(dbZ);
    startBroadcast(rz.id!, 1, dbZ);
    dbZ.exec(`UPDATE lecercle_broadcast_targets SET status = 'sent', sent_at = datetime('now')`);
    pauseBroadcast(rz.id!, "tardive", dbZ);
    startBroadcast(rz.id!, undefined, dbZ);
    eq("en pause sans rien à envoyer : reprendre la clôt", (dbZ.prepare(`SELECT status FROM lecercle_broadcasts WHERE id = ?`).get(rz.id) as any).status, "done");
    eq("annulation", cancelBroadcast(rp.id!, dbP).ok, true);
    eq("annulation : les restants sont soldés en « écartés »", [getStats(rp.id!, dbP).pending, getStats(rp.id!, dbP).skipped], [0, 2]);
    eq("diffusion annulée non redémarrable", startBroadcast(rp.id!, undefined, dbP).ok, false);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nExclusion relue à l'envoi");
  {
    const db = freshDb();
    for (let id = 1; id <= 3; id++) user(db, id);
    db.exec(`INSERT INTO nexa_leads (tg_user_id) VALUES (2), (3)`);
    const r = create(db);
    startBroadcast(r.id!, 3, db);
    // Après la création : 2 passe en takeover, 3 bloque le bot.
    db.exec(`UPDATE nexa_leads SET takeover_until = datetime('now', '+1 hour') WHERE tg_user_id = 2`);
    recordInboundForBroadcast({ my_chat_member: { chat: { type: "private", id: 3 }, from: { id: 3 }, date: 1, new_chat_member: { status: "kicked" } } }, db);
    const log: Call[] = [];
    await runBroadcastDrain({ sendFn: okSender(log), spacing: 0, owners: [OWNER] }, db);
    eq("seul 1 reçoit ; 2 et 3 écartés avec motif", [log.map(c => c.chatId), getStats(r.id!, db).skipped], [[1], 2]);
    const errs = (db.prepare(`SELECT error FROM lecercle_broadcast_targets WHERE status = 'skipped' ORDER BY telegram_id`).all() as any[]).map(x => x.error);
    eq("motifs visibles", errs, ["exclu à l'envoi : takeover", "exclu à l'envoi : blocked"]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n« Test à moi » — autorisé à un seul compte, n'écrit rien");
  {
    const calls: any[] = [];
    const fake = async (_m: string, body: any) => { calls.push(body); return { ok: true }; };
    process.env.LECERCLE_BROADCAST_TEST_IDS = "12345"; // sans effet : la liste est en dur
    eq("compte autorisé : 1486389037", (await sendTest(OWNER, DRAFT, fake)).ok, true);
    eq("tout autre compte refusé, sans appel Telegram", [(await sendTest(12345, DRAFT, fake)).ok, calls.length], [false, 1]);
    eq("bouton du test = URL finale directe, aucun jeton", calls[0].reply_markup.inline_keyboard[0][0].url, DRAFT.buttonUrl);
    eq("HTML invalide refusé avant tout appel", [(await sendTest(OWNER, { body: "a < b" }, fake)).ok, calls.length], [false, 1]);
    // sendTest ne reçoit aucune base : il ne peut rien écrire, par construction.
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nClics — jeton, robots, URL stockée uniquement");
  {
    const db = freshDb();
    user(db, 1);
    const r = create(db);
    const token = (db.prepare(`SELECT click_token FROM lecercle_broadcast_targets WHERE broadcast_id = ?`).get(r.id) as any).click_token;
    eq("jeton inconnu → null", resolveClickToken("AAAAAAAAAAAAAAAAAAAAAA", db), null);
    eq("jeton malformé → null sans requête", resolveClickToken("../../etc", db), null);
    const tgt = resolveClickToken(token, db)!;
    eq("jeton connu → URL stockée de la diffusion", tgt.destination, DRAFT.buttonUrl);

    const HUMAN = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Telegram-iOS/11.0";
    eq("TelegramBot ignoré", recordClick(tgt.targetId, "TelegramBot (like TwitterBot)", db), false);
    eq("user-agent vide ignoré", recordClick(tgt.targetId, "", db), false);
    eq("curl ignoré", recordClick(tgt.targetId, "curl/8.4.0", db), false);
    eq("rien compté après les robots", getStats(r.id!, db).clicked, 0);
    eq("« CUBOT X30 » (téléphone) n'est pas un robot", isBotUserAgent("Mozilla/5.0 (Linux; Android 12; CUBOT X30) Chrome/120 Mobile"), false);
    eq("Googlebot est un robot", isBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)"), true);

    recordClick(tgt.targetId, HUMAN, db);
    const first = (db.prepare(`SELECT first_click_at FROM lecercle_broadcast_targets WHERE id = ?`).get(tgt.targetId) as any).first_click_at;
    db.exec(`UPDATE lecercle_broadcast_targets SET first_click_at = '2026-01-01 00:00:00' WHERE id = ${tgt.targetId}`);
    recordClick(tgt.targetId, HUMAN, db);
    const row = db.prepare(`SELECT first_click_at, click_count FROM lecercle_broadcast_targets WHERE id = ?`).get(tgt.targetId) as any;
    eq("clic humain compté, premier clic figé, compteur incrémenté", [first !== null, row.first_click_at, row.click_count], [true, "2026-01-01 00:00:00", 2]);
    const uas = (db.prepare(`SELECT user_agent FROM lecercle_broadcast_clicks`).all() as any[]).map(x => x.user_agent);
    eq("user-agent journalisé pour chaque clic compté, et seulement ceux-là", uas, [HUMAN, HUMAN]);
    eq("stats : 1 destinataire a cliqué", getStats(r.id!, db).clicked, 1);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nRéponses — la plus récente des 72 h, et elle seule");
  {
    const db = freshDb();
    user(db, 1);
    const a = create(db);
    const b = create(db);
    db.exec(`UPDATE lecercle_broadcast_targets SET status = 'sent', sent_at = '2026-09-20 10:00:00' WHERE broadcast_id = ${a.id}`);
    db.exec(`UPDATE lecercle_broadcast_targets SET status = 'sent', sent_at = '2026-09-21 10:00:00' WHERE broadcast_id = ${b.id}`);
    const replied = () => (db.prepare(`SELECT broadcast_id, replied_at FROM lecercle_broadcast_targets ORDER BY broadcast_id`).all() as any[]).map(x => x.replied_at);

    eq("message AVANT les deux envois : rien", [attributeReply(1, "2026-09-20 09:00:00", db), replied()], [false, [null, null]]);
    eq("message entre les deux : va à la 1re", [attributeReply(1, "2026-09-20 12:00:00", db), replied()], [true, ["2026-09-20 12:00:00", null]]);
    eq("message après la 2e : va à la 2e seulement", [attributeReply(1, "2026-09-21 11:00:00", db), replied()], [true, ["2026-09-20 12:00:00", "2026-09-21 11:00:00"]]);
    eq("second message : ne se reporte pas sur l'ancienne", [attributeReply(1, "2026-09-21 12:00:00", db), replied()[1]], [false, "2026-09-21 11:00:00"]);

    const db2 = freshDb();
    user(db2, 1);
    const c = create(db2);
    db2.exec(`UPDATE lecercle_broadcast_targets SET status = 'sent', sent_at = '2026-09-20 10:00:00' WHERE broadcast_id = ${c.id}`);
    eq("au-delà de 72 h : rien", attributeReply(1, "2026-09-23 10:00:01", db2), false);
    eq("à 72 h pile : compté", attributeReply(1, "2026-09-23 10:00:00", db2), true);

    // Issue inconnue : la réponse est comptée comme pour un envoi, datée à la réservation.
    const db4 = freshDb();
    user(db4, 1);
    const u = create(db4);
    db4.exec(`UPDATE lecercle_broadcast_targets SET status = 'unknown', claimed_at = '2026-09-20 10:00:00' WHERE broadcast_id = ${u.id}`);
    eq("réponse à un envoi « issue inconnue » : comptée", attributeReply(1, "2026-09-20 11:00:00", db4), true);
    // Réponse datée entre la réservation et sent_at : comptée.
    const db5 = freshDb();
    user(db5, 1);
    const v = create(db5);
    db5.exec(`UPDATE lecercle_broadcast_targets SET status = 'sent', claimed_at = '2026-09-20 10:00:00', sent_at = '2026-09-20 10:00:05' WHERE broadcast_id = ${v.id}`);
    eq("réponse datée avant sent_at mais après la réservation : comptée", attributeReply(1, "2026-09-20 10:00:02", db5), true);

  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nWebhook — audience, déblocage, réponses, groupes ignorés");
  {
    const db = freshDb();
    const at = Math.floor(Date.parse("2026-09-21T11:00:00Z") / 1000);
    recordInboundForBroadcast({ message: { chat: { type: "private", id: 50 }, from: { id: 50, username: "neo", first_name: "Neo" }, date: at, text: "/start" } }, db);
    const u = db.prepare(`SELECT username, first_seen_at, last_seen_at, origin FROM lecercle_bot_users WHERE telegram_id = 50`).get() as any;
    eq("/start privé : compte créé, daté de l'heure du message", u, { username: "neo", first_seen_at: "2026-09-21 11:00:00", last_seen_at: "2026-09-21 11:00:00", origin: "webhook" });

    recordInboundForBroadcast({ message: { chat: { type: "supergroup", id: -100 }, from: { id: 51 }, date: at, text: "hello" } }, db);
    eq("message de groupe ignoré", db.prepare(`SELECT 1 FROM lecercle_bot_users WHERE telegram_id = 51`).get() ?? null, null);

    recordInboundForBroadcast({ my_chat_member: { chat: { type: "private", id: 50 }, from: { id: 50 }, date: at, new_chat_member: { status: "kicked" } } }, db);
    eq("my_chat_member kicked → bloqué", (db.prepare(`SELECT block_reason FROM lecercle_bot_users WHERE telegram_id = 50`).get() as any).block_reason, "my_chat_member:kicked");
    recordInboundForBroadcast({ message: { chat: { type: "private", id: 50 }, from: { id: 50 }, date: at + 60, text: "re" } }, db);
    const u2 = db.prepare(`SELECT blocked_at, username, first_seen_at FROM lecercle_bot_users WHERE telegram_id = 50`).get() as any;
    eq("message entrant → débloqué, handle et 1er contact conservés", u2, { blocked_at: null, username: "neo", first_seen_at: "2026-09-21 11:00:00" });

    const r = create(db);
    db.exec(`UPDATE lecercle_broadcast_targets SET status = 'sent', sent_at = '2026-09-21 12:00:00' WHERE broadcast_id = ${r.id}`);
    recordInboundForBroadcast({ callback_query: { from: { id: 50 }, message: { chat: { type: "private", id: 50 } } } }, db);
    eq("clic sur un bouton callback : PAS une réponse", getStats(r.id!, db).replied, 0);
    recordInboundForBroadcast({ message: { chat: { type: "private", id: 50 }, from: { id: 50 }, date: Math.floor(Date.parse("2026-09-21T13:00:00Z") / 1000), text: "ok" } }, db);
    eq("message privé après l'envoi : réponse", getStats(r.id!, db).replied, 1);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\nProgrammation — UTC+8, échéance, une à la fois");
  {
    eq("UTC+8 → UTC", utc8ToSqlUtc("2026-09-26T21:30"), "2026-09-26 13:30:00");
    eq("format illisible refusé", utc8ToSqlUtc("26/09/2026 21:30"), null);
    const db = freshDb();
    user(db, 1); user(db, 2);
    const r = create(db);
    eq("programmation dans le passé refusée", scheduleBroadcast(r.id!, "2020-01-01T10:00", 2, db).ok, false);
    const future = new Date(Date.now() + 8 * 3600_000 + 3600_000).toISOString().slice(0, 16);
    eq("programmation sans le bon total refusée", scheduleBroadcast(r.id!, future, 3, db).ok, false);
    eq("programmation valide", scheduleBroadcast(r.id!, future, 2, db).ok, true);
    eq("pas encore l'heure : rien ne démarre", promoteDueScheduled(db), null);
    db.exec(`UPDATE lecercle_broadcasts SET scheduled_at = datetime('now', '-1 minute') WHERE id = ${r.id}`);
    const other = create(db);
    startBroadcast(other.id!, 2, db);
    eq("échue mais une autre tourne : attend", promoteDueScheduled(db), null);
    cancelBroadcast(other.id!, db);
    const log: Call[] = [];
    const res = await runBroadcastDrain({ sendFn: okSender(log), spacing: 0, owners: [OWNER] }, db);
    eq("tick suivant : démarrée et envoyée", [res.promoted, log.length], [r.id, 2]);
  }

  console.log("\nMigration du relais absente : la diffusion part quand même");
  {
    const db = new Database(":memory:");
    db.exec(SOURCES_SQL);
    db.exec(LECERCLE_BROADCAST_SCHEMA_SQL); // sans claimed_at
    user(db, 1); user(db, 2);
    const r = create(db);
    startBroadcast(r.id!, 2, db);
    const log: Call[] = [];
    await runBroadcastDrain({ sendFn: okSender(log), spacing: 0, owners: [OWNER] }, db);
    eq("sans la colonne claimed_at : envoi normal", log.length, 2);
  }

  console.log("\nListe nominative");
  {
    const db = freshDb();
    user(db, 1, { username: "alice" }); user(db, 2, { first_name: "Bob" });
    const r = create(db);
    eq("recherche par @handle", listTargets(r.id!, "all", "@ali", 100, db).map(x => x.telegram_id), [1]);
    eq("recherche par prénom", listTargets(r.id!, "all", "bob", 100, db).map(x => x.telegram_id), [2]);
    eq("filtre en attente", listTargets(r.id!, "pending", "", 100, db).length, 2);
  }

  console.log(`\n${passed} assertions OK, ${failures.length} en échec`);
  if (failures.length) {
    for (const f of failures) console.log("  ✘", f);
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
