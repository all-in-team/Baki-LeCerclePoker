// Relance J+1 et rapport hebdo — sélection, verrou, exclusions, cohortes.
// Run: npx tsx scripts/dzpk-followup.test.ts
//
// ┌─ CE QUI COÛTE CHER SI ÇA TOMBE ────────────────────────────────────────────┐
// │ • une relance en DOUBLE, ou envoyée à un lead bloqué/rejoint/banni : c'est │
// │   du spam sur un canal où le spam se paie en blocages définitifs ;         │
// │ • une relance à 4 h du matin locale — même prix ;                          │
// │ • un rapport qui compte un join dans la mauvaise cohorte : les taux        │
// │   par source deviennent faux, et c'est sur eux qu'on achète du trafic.    │
// └────────────────────────────────────────────────────────────────────────────┘

import Database from "better-sqlite3";
import {
  runFollowupD1, FOLLOWUP_UTC_HOUR_MIN,
  type FollowupSender,
} from "../lib/funnels/dzpk/followup";
import { getDzpkWeeklyReport, getWelcomeAbStats } from "../lib/funnels/dzpk/report";
import { pickWelcomeVariant, buildWelcome } from "../lib/funnels/dzpk/welcome";
import { WELCOME, WELCOME_B, JOIN_BUTTON, JOIN_BUTTON_B } from "../lib/funnels/dzpk/copy";
import {
  DZPK_SCHEMA_SQL,
  DZPK_MATCH_SCHEMA_SQL, DZPK_MATCH_SCHEMA_SQL_2, DZPK_MATCH_SCHEMA_SQL_3,
  DZPK_TAKEOVER_SCHEMA_SQL, DZPK_TAKEOVER_ALTER_READ, DZPK_TAKEOVER_ALTER_RELAY,
  DZPK_POSTBACK_ALTER_CLICK, DZPK_POSTBACK_ALTER_SENT, DZPK_POSTBACK_ALTER_RESULT,
  DZPK_POSTBACK_ALTER_JOIN_SENT, DZPK_POSTBACK_ALTER_JOIN_RESULT,
  DZPK_WELCOME_AB_ALTER,
  DZPK_INGEST_SCHEMA_SQL,
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
  db.exec(DZPK_TAKEOVER_SCHEMA_SQL);
  db.exec(DZPK_TAKEOVER_ALTER_READ);
  db.exec(DZPK_TAKEOVER_ALTER_RELAY);
  db.exec(DZPK_POSTBACK_ALTER_CLICK);
  db.exec(DZPK_POSTBACK_ALTER_SENT);
  db.exec(DZPK_POSTBACK_ALTER_RESULT);
  db.exec(DZPK_POSTBACK_ALTER_JOIN_SENT);
  db.exec(DZPK_POSTBACK_ALTER_JOIN_RESULT);
  db.exec(DZPK_WELCOME_AB_ALTER);
  db.exec(DZPK_INGEST_SCHEMA_SQL);
  // Copie locale du DDL richads_clicks — même précédent que richads-burst.test.ts
  // (le DDL vit inline dans lib/db.ts, non exporté).
  db.exec(`
    CREATE TABLE richads_clicks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      clicked_at  TEXT NOT NULL DEFAULT (datetime('now')),
      source      TEXT NOT NULL,
      cre         TEXT NOT NULL,
      cid         TEXT, sid TEXT, app TEXT, geo TEXT, cost REAL, user_type TEXT,
      click_id    TEXT, ip_hash TEXT, user_agent TEXT,
      flags       TEXT NOT NULL DEFAULT '',
      is_unique   INTEGER NOT NULL DEFAULT 1
    );
  `);
  return db as any;
}

/** Lead inséré directement, avec un /start daté d'il y a `hoursAgo` heures. */
function seedLead(db: any, tgId: number, hoursAgo: number, extra: Record<string, unknown> = {}): number {
  const cols: Record<string, unknown> = {
    telegram_id: tgId,
    source: "tgads_26845720",
    started_at: `datetime('now', '-${hoursAgo} hours')`,
    ...extra,
  };
  const names = Object.keys(cols);
  const lit = (v: unknown): string => {
    if (typeof v === "number") return String(v);
    const s = String(v);
    if (s.startsWith("datetime(")) return s; // expression SQL, pas un littéral
    return `'${s.replace(/'/g, "''")}'`;
  };
  db.exec(`INSERT INTO dzpk_leads (${names.join(", ")}) VALUES (${names.map(n => lit(cols[n])).join(", ")})`);
  return Number(db.prepare(`SELECT id FROM dzpk_leads WHERE telegram_id = ?`).get(tgId).id);
}

function stubSender(opts: { blockedFor?: number[]; failFor?: number[] } = {}) {
  const calls: Array<{ tgId: number; variant: string }> = [];
  const f: FollowupSender = async (tgId, variant) => {
    calls.push({ tgId, variant });
    if (opts.blockedFor?.includes(tgId)) return { ok: false, blocked: true, error: "Forbidden: bot was blocked" };
    if (opts.failFor?.includes(tgId)) return { ok: false, blocked: false, error: "500" };
    return { ok: true, blocked: false, messageId: 1000 + tgId, text: "relance" };
  };
  return { f, calls };
}

const SEND_HOUR = FOLLOWUP_UTC_HOUR_MIN; // dans la fenêtre d'envoi

async function run() {
  console.log("\nvariante d'accueil — déterministe, et le texte suit");
  // Test A/B gelé le 20/08/2026 : 100 % des nouveaux leads reçoivent A
  // (A joignait à 19 % contre 11 % pour B sur 73 leads). Les assertions
  // reflètent l'état gelé ; reprendre la parité si le test est relancé.
  eq("id impair → A", pickWelcomeVariant(1), "A");
  eq("id pair → A (test gelé)", pickWelcomeVariant(2), "A");
  {
    process.env.DZPK_CLUB_INVITE_URL = "https://t.me/+club";
    const a = buildWelcome("A");
    const b = buildWelcome("B");
    eq("texte A", a.text.startsWith(WELCOME), true);
    eq("texte B", b.text.startsWith(WELCOME_B), true);
    eq("bouton A", a.keyboard?.inline_keyboard[0][0].text, JOIN_BUTTON);
    eq("bouton B", b.keyboard?.inline_keyboard[0][0].text, JOIN_BUTTON_B);
    delete process.env.DZPK_CLUB_INVITE_URL;
  }

  console.log("\nsélection — la fenêtre 20–72 h, et rien d'autre");
  {
    const db = freshDb();
    const tooYoung = seedLead(db, 1, 5);
    const eligible = seedLead(db, 2, 24);
    const eligibleOld = seedLead(db, 3, 70);
    const expired = seedLead(db, 4, 80);
    void tooYoung; void expired;

    const { f, calls } = stubSender();
    const r = await runFollowupD1({ dbOverride: db, sender: f, nowUtcHour: SEND_HOUR });
    eq("2 éligibles", r.examined, 2);
    eq("2 envoyés", r.sent, 2);
    eq("destinataires", calls.map(c => c.tgId).sort(), [2, 3]);
    const l2 = db.prepare(`SELECT last_followup_at FROM dzpk_leads WHERE id = ?`).get(eligible);
    eq("verrou posé", l2.last_followup_at !== null, true);
    const ev = db.prepare(`SELECT COUNT(*) AS n FROM dzpk_lead_events WHERE kind = 'followup_d1'`).get();
    eq("événements journalisés", ev.n, 2);
    const fil = db.prepare(`SELECT COUNT(*) AS n FROM dzpk_bot_messages WHERE direction = 'out'`).get();
    eq("fil de conversation alimenté", fil.n, 2);

    // Seconde passe : plus personne — le verrou est le critère de sélection.
    const again = await runFollowupD1({ dbOverride: db, sender: f, nowUtcHour: SEND_HOUR });
    eq("seconde passe : personne", again.examined, 0);
    eq("aucun envoi en double", calls.length, 2);
    void eligibleOld;
    db.close();
  }

  console.log("\nexclusions — joints, rattachés, bannis, bloqués, déjà relancés");
  {
    const db = freshDb();
    seedLead(db, 11, 24, { club_joined_at: "2026-08-13 10:00:00" });
    seedLead(db, 12, 24, { bound_at: "2026-08-13 10:00:00" });
    seedLead(db, 13, 24, { banned_at: "2026-08-13 10:00:00" });
    seedLead(db, 14, 24, { blocked: 1 });
    seedLead(db, 15, 24, { last_followup_at: "2026-08-13 10:00:00" });

    const { f, calls } = stubSender();
    const r = await runFollowupD1({ dbOverride: db, sender: f, nowUtcHour: SEND_HOUR });
    eq("aucun éligible", r.examined, 0);
    eq("aucun appel", calls.length, 0);
    db.close();
  }

  console.log("\nheures de silence — la passe ne fait RIEN hors 10h–22h locales");
  {
    const db = freshDb();
    seedLead(db, 21, 24);
    const { f, calls } = stubSender();
    const night = await runFollowupD1({ dbOverride: db, sender: f, nowUtcHour: 20 }); // 04:00 UTC+8
    eq("passe silencieuse", night.quiet, true);
    eq("aucun envoi de nuit", calls.length, 0);
    const lead = db.prepare(`SELECT last_followup_at FROM dzpk_leads WHERE telegram_id = 21`).get();
    eq("aucun verrou consommé", lead.last_followup_at, null);
    db.close();
  }

  console.log("\nblocage et échec — marqués, jamais rejoués");
  {
    const db = freshDb();
    const blocked = seedLead(db, 31, 24);
    const failed = seedLead(db, 32, 24);
    const { f } = stubSender({ blockedFor: [31], failFor: [32] });
    const r = await runFollowupD1({ dbOverride: db, sender: f, nowUtcHour: SEND_HOUR });
    eq("résultat", [r.sent, r.blocked, r.failed], [0, 1, 1]);
    const b = db.prepare(`SELECT blocked, last_followup_at FROM dzpk_leads WHERE id = ?`).get(blocked);
    eq("bloqué marqué", b.blocked, 1);
    const x = db.prepare(`SELECT last_followup_at FROM dzpk_leads WHERE id = ?`).get(failed);
    eq("échec : verrou posé (pas de rejeu auto)", x.last_followup_at !== null, true);
    const ev = db.prepare(`SELECT COUNT(*) AS n FROM dzpk_lead_events WHERE kind = 'followup_failed'`).get();
    eq("échec journalisé", ev.n, 1);
    db.close();
  }

  console.log("\nvariante suivie — la relance reprend le bouton vu à l'accueil");
  {
    const db = freshDb();
    seedLead(db, 41, 24, { welcome_variant: "B" });
    seedLead(db, 42, 24, { welcome_variant: "A" });
    seedLead(db, 43, 24); // pré-test : NULL → A
    const { f, calls } = stubSender();
    await runFollowupD1({ dbOverride: db, sender: f, nowUtcHour: SEND_HOUR });
    const byId = new Map(calls.map(c => [c.tgId, c.variant]));
    eq("lead B relancé en B", byId.get(41), "B");
    eq("lead A relancé en A", byId.get(42), "A");
    eq("lead pré-test relancé en A", byId.get(43), "A");
    db.close();
  }

  console.log("\nrapport hebdo — cohortes par semaine de /start, clics rapprochés");
  {
    const db = freshDb();
    // Cohorte de la semaine courante : 2 starts dont 1 join.
    seedLead(db, 51, 2);
    seedLead(db, 52, 4, { club_joined_at: "2026-08-14 10:00:00" });
    // Cohorte vieille de 2 semaines : 1 start rattaché (le join peut dater d'après).
    seedLead(db, 53, 24 * 15, { bound_at: "2026-08-13 10:00:00", club_joined_at: "2026-08-13 09:00:00" });
    // Clics : 3 cette semaine sur la même créative, 1 non-unique (ignoré).
    db.exec(`INSERT INTO richads_clicks (source, cre, click_id, is_unique) VALUES
      ('richads/tgads-26845720', 'tgads-26845720', 'CB1', 1),
      ('richads/tgads-26845720', 'tgads-26845720', 'CB2', 1),
      ('richads/tgads-26845720', 'tgads-26845720', 'CB2', 0),
      ('richads/tgads-26845720', 'tgads-26845720', 'CB3', 1)`);

    const rows = getDzpkWeeklyReport(db, 6);
    const current = rows.filter(r => r.source === "tgads_26845720" && r.starts === 2);
    eq("cohorte courante trouvée", current.length, 1);
    eq("clics uniques rapprochés", current[0]?.clicks, 3);
    eq("joins de la cohorte", current[0]?.joined, 1);
    const old = rows.find(r => r.starts === 1 && r.bound === 1);
    eq("vieille cohorte : rattaché compté chez elle", !!old, true);
    eq("semaines distinctes", old?.week !== current[0]?.week, true);
    db.close();
  }

  console.log("\nstats A/B — seuls les leads exposés comptent");
  {
    const db = freshDb();
    seedLead(db, 61, 2, { welcome_variant: "A", blocked: 1 });
    seedLead(db, 62, 2, { welcome_variant: "B", club_joined_at: "2026-08-14 10:00:00" });
    seedLead(db, 63, 2, { welcome_variant: "B" });
    seedLead(db, 64, 200); // pré-test — exclu
    const stats = getWelcomeAbStats(db);
    eq("deux variantes", stats.map(s => s.variant), ["A", "B"]);
    eq("A : 1 lead 1 bloqué", [stats[0].leads, stats[0].blocked], [1, 1]);
    eq("B : 2 leads 1 join", [stats[1].leads, stats[1].joined], [2, 1]);
    db.close();
  }

  console.log(`\n${failures.length === 0 ? "✅" : "❌"} ${passed} assertions passées, ${failures.length} échec(s)`);
  if (failures.length) { failures.forEach(f => console.log("   -", f)); process.exit(1); }
}

run();
