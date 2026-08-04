/**
 * Harnais SQLite de la porte unique de création de groupe.
 * Run: npx tsx scripts/group-provisioning.test.ts
 *
 * Base RÉELLE (better-sqlite3) dans un dossier temporaire — pas de mock : le schéma et
 * les migrations exercés sont ceux de la prod. `process.chdir` AVANT le premier import
 * de lib/db, car DB_PATH y est calculé depuis `process.cwd()` au chargement du module.
 *
 * Telegram est le seul élément stubbé (createPlayerGroup, sendMsg, getInviteLink) : les
 * tests portent sur la DÉCISION — réutiliser / créer / ne rien faire — pas sur le réseau.
 *
 * Cas couverts (incident Alexis 2026-08-04) :
 *   1. groupe existant → réutilisé, aucune création
 *   2. lien d'invitation introuvable → réutilisé QUAND MÊME (le bug d'Alexis)
 *   3. deux rooms, un seul groupe
 *   4. ambigu (handle seul) → aucun groupe créé, cas remonté
 *   5. chemin C sans tg_user_id → aucun groupe créé, cas remonté
 *   6. groupe legacy réutilisé → ligne de registre écrite
 *   7. verrou par tg_user_id → une seule création malgré deux chemins concurrents
 *   8. les topics admin du live takeover ne sont pas touchés
 */

import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lecercle-grouptest-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

// ── Stubs Telegram ────────────────────────────────────────
// Enregistrés dans le cache de modules AVANT que quoi que ce soit n'importe les vrais.

let createdGroups = 0;
let nextChatId = -1009000000001;
let inviteLinkAvailable = true;
const sentMessages: { chatId: number; text: string }[] = [];

const userbotStub = {
  createPlayerGroup: async (tgId: number, name: string) => {
    createdGroups++;
    const chatId = nextChatId--;
    return {
      chatId, inviteLink: inviteLinkAvailable ? `https://t.me/+stub${-chatId}` : "",
      topicIds: { accounting: 11, depot: 12, liveplay: 13, onboarding: 14, alertes: 15 },
      status: "full_success" as const, failedSteps: [], errors: [], botPromoted: true,
    };
  },
  getInviteLink: async (chatId: number) =>
    inviteLinkAvailable ? { ok: true, link: `https://t.me/+stub${-chatId}` } : { ok: false, link: null, error: "USERBOT_DOWN" },
  isUserbotConfigured: () => true,
  resolveUsername: async () => null,
  inviteUserToGroup: async () => ({ ok: true }),
  getChatMembers: async () => [],
  getUserbotMe: async () => null,
  kickFromChannel: async () => ({ ok: true }),
  leaveUserbotChannels: async () => ({ left: [], failed: [] }),
  renamePlayerGroup: async () => ({ ok: true }),
  checkUserbotHealth: async () => ({ session_valid: true }),
  syncGroupStructure: async () => ({ topic_ids: {}, bot_invited: true, bot_promoted: true, topics_created: [], errors: [] }),
};

const helpersStub = {
  sendMsg: async (chatId: number, text: string) => { sentMessages.push({ chatId, text }); return { ok: true }; },
  AGENT_CHAT_ID: -100999,
};

// tsx/CJS : on injecte dans le require cache sous les chemins résolus.
const Module = require("module");
const originalResolve = Module._resolveFilename;
const REPO = path.resolve(__dirname, "..");
const ALIASES: Record<string, any> = {
  [path.join(REPO, "lib/telegram-userbot.ts")]: userbotStub,
  [path.join(REPO, "lib/telegram-commands/helpers.ts")]: helpersStub,
};
Module._resolveFilename = function (request: string, ...rest: any[]) {
  if (request === "@/lib/telegram-userbot") return path.join(REPO, "lib/telegram-userbot.ts");
  if (request === "@/lib/telegram-commands/helpers") return path.join(REPO, "lib/telegram-commands/helpers.ts");
  if (request.startsWith("@/")) return originalResolve.call(this, path.join(REPO, request.slice(2)), ...rest);
  return originalResolve.call(this, request, ...rest);
};
for (const [file, exports] of Object.entries(ALIASES)) {
  require.cache[file] = { id: file, filename: file, loaded: true, exports } as any;
}

// ── Migrations de DONNÉES pré-marquées appliquées ─────────
// Quelques migrations de `initSchema` corrigent des lignes de prod (ex. re-rattacher le
// wallet de cashout partagé au joueur #2) et échouent sur une base vierge : la ligne
// qu'elles réparent n'existe pas. On les marque appliquées AVANT le premier getDb() —
// elles n'ont rien à faire ici, alors que tout le reste du schéma doit bien se créer.
{
  const Database = require("better-sqlite3");
  const seed = new Database(path.join(TMP, "data", "lecercle.db"));
  seed.exec(`CREATE TABLE IF NOT EXISTS _applied_fixes (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  for (const name of ["shared_cashout_wallets_v1", "reassign_hugo_cashout_wallet_v2"]) {
    try { seed.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run(name); } catch {}
  }
  seed.close();
}

// ── Imports réels (après les stubs) ───────────────────────

const { getDb } = require(path.join(REPO, "lib/db.ts"));
const { provisionGroup } = require(path.join(REPO, "lib/group-provisioning.ts"));
const { findExistingGroupForTgUser } = require(path.join(REPO, "lib/group-lifecycle.ts"));

// ── Mini-framework ────────────────────────────────────────

let passed = 0, failed = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
function eq(label: string, actual: unknown, expected: unknown) {
  check(label, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const db = getDb();

function reset() {
  createdGroups = 0;
  inviteLinkAvailable = true;
  sentMessages.length = 0;
  for (const t of ["group_creations", "group_claims", "group_review_cases", "group_room_notices",
                   "players", "nexa_leads", "onboarding_leads", "affiliate_leads"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table absente */ }
  }
}

function seedPlayerWithGroup(o: { id: number; name: string; tgId: number | null; chatId: string; handle?: string }) {
  db.prepare(
    `INSERT INTO players (id, name, telegram_id, telegram_handle, telegram_group_id, accounting_topic_id, depot_topic_id)
     VALUES (?, ?, ?, ?, ?, 101, 102)`
  ).run(o.id, o.name, o.tgId, o.handle ?? null, o.chatId);
}

async function main() {
  // ── 1. Groupe existant → réutilisé, pas de création ───────

  console.log("\n1) Groupe existant pour ce tg_user_id → réutilisé, aucune création");
  {
    reset();
    seedPlayerWithGroup({ id: 34, name: "Alexis minsot", tgId: 8190586592, chatId: "-1003723869680" });

    const out = await provisionGroup({
      tgUserId: 8190586592, handle: "alexiscoursier", displayName: "Alexis",
      ownerKind: "nexa_lead", context: "nexa_lead:42", room: "nexa", lang: "fr",
    });

    eq("status", out.status, "reused");
    eq("chat_id réutilisé", (out as any).chatId, "-1003723869680");
    eq("aucun groupe créé", createdGroups, 0);
    check("message « NEXA ajouté à ton suivi » posté",
      sentMessages.some((m) => m.chatId === -1003723869680 && m.text.includes("NEXA")));
  }

  // ── 2. Le bug d'Alexis : pas de lien ⇒ on réutilise QUAND MÊME ──

  console.log("\n2) Lien d'invitation introuvable → réutilisation quand même (régression Alexis)");
  {
    reset();
    seedPlayerWithGroup({ id: 34, name: "Alexis minsot", tgId: 8190586592, chatId: "-1003723869680" });
    inviteLinkAvailable = false; // userbot HS / plus admin du vieux groupe

    const out = await provisionGroup({
      tgUserId: 8190586592, handle: "alexiscoursier", displayName: "Alexis",
      ownerKind: "nexa_lead", context: "nexa_lead:42",
    });

    eq("status", out.status, "reused");
    eq("AUCUN second groupe créé", createdGroups, 0);
    eq("lien null assumé", (out as any).inviteLink, null);
  }

  // ── 3. Deux rooms, un seul groupe ─────────────────────────

  console.log("\n3) Deux rooms rattachées → un seul groupe, un seul message d'ajout");
  {
    reset();
    seedPlayerWithGroup({ id: 34, name: "Alexis minsot", tgId: 8190586592, chatId: "-1003723869680" });

    const first = await provisionGroup({
      tgUserId: 8190586592, displayName: "Alexis", ownerKind: "nexa_lead",
      context: "nexa_lead:42", room: "nexa", lang: "fr",
    });
    const second = await provisionGroup({
      tgUserId: 8190586592, displayName: "Alexis", ownerKind: "nexa_lead",
      context: "nexa_lead:43", room: "nexa", lang: "fr",
    });

    eq("1re room → réutilisation", first.status, "reused");
    eq("2e room → réutilisation", second.status, "reused");
    eq("même groupe", (first as any).chatId, (second as any).chatId);
    eq("aucune création", createdGroups, 0);
    eq("message d'ajout posté UNE fois",
      sentMessages.filter((m) => m.text.includes("NEXA ajouté")).length, 1);
  }

  // ── 4. Ambigu (handle seul) → rien créé, cas remonté ──────

  console.log("\n4) Rapprochement par handle seul → aucun groupe créé, cas remonté");
  {
    reset();
    // Groupe de parrainage : clé = handle, aucune identité Telegram sur la ligne.
    db.prepare(`INSERT INTO players (id, name) VALUES (900, 'Parrain')`).run();
    db.prepare(
      `INSERT INTO affiliate_leads (affiliate_player_id, referred_handle, kickoff_group_id, kickoff_invite_link, status)
       VALUES (900, 'alexiscoursier', '-1003111111111', 'https://t.me/+old', 'pending')`
    ).run();

    const out = await provisionGroup({
      tgUserId: 8190586592, handle: "alexiscoursier", displayName: "Alexis",
      ownerKind: "nexa_lead", context: "nexa_lead:42",
    });

    eq("status", out.status, "ambiguous");
    eq("aucun groupe créé", createdGroups, 0);
    check("candidat listé", (out as any).candidates.some((c: any) => c.chatId === "-1003111111111"));
    const openCase = db.prepare(`SELECT * FROM group_review_cases WHERE status = 'open'`).get() as any;
    check("cas ouvert en base", !!openCase);
    eq("cas rattaché au bon contexte", openCase?.context, "nexa_lead:42");
    eq("aucune liaison écrite", db.prepare(`SELECT COUNT(*) AS n FROM group_creations`).get().n, 0);
  }

  // ── 5. Chemin C sans tg_user_id → rien créé ───────────────

  console.log("\n5) Parrainage sans tg_user_id résolu → aucun groupe créé, cas remonté");
  {
    reset();
    const out = await provisionGroup({
      tgUserId: null, handle: "inconnu_total", displayName: "@inconnu_total",
      ownerKind: "player", context: "affiliate:inconnu_total",
    });

    eq("status", out.status, "ambiguous");
    eq("aucun groupe créé", createdGroups, 0);
    const c = db.prepare(`SELECT * FROM group_review_cases WHERE context = 'affiliate:inconnu_total'`).get() as any;
    eq("cas typé no_tg_user_id", c?.kind, "no_tg_user_id");
  }

  // ── 6. Groupe legacy réutilisé → entre au registre ────────

  console.log("\n6) Groupe legacy réutilisé → ligne de registre écrite");
  {
    reset();
    seedPlayerWithGroup({ id: 34, name: "Alexis minsot", tgId: 8190586592, chatId: "-1003723869680" });
    eq("registre vide au départ", db.prepare(`SELECT COUNT(*) AS n FROM group_creations`).get().n, 0);

    const out = await provisionGroup({
      tgUserId: 8190586592, displayName: "Alexis", ownerKind: "nexa_lead", context: "nexa_lead:42",
    });
    eq("réutilisé depuis players", (out as any).source, "player");

    const reg = db.prepare(`SELECT * FROM group_creations WHERE chat_id = '-1003723869680'`).get() as any;
    check("ligne de registre créée", !!reg);
    eq("owner_key = tg_user_id", reg?.owner_key, 8190586592);
    check("joined_at posé (jamais candidat au nettoyage 24 h)", !!reg?.joined_at);

    // Et maintenant le registre suffit : la recherche le trouve du premier coup.
    const found = findExistingGroupForTgUser(8190586592);
    eq("trouvé via le registre", found?.source, "registry");
  }

  // ── 7. Verrou par tg_user_id, pas par lead/room ───────────

  console.log("\n7) Deux chemins concurrents, même tg_user_id → une seule création");
  {
    reset();
    const [a, b] = await Promise.all([
      provisionGroup({ tgUserId: 7777777001, displayName: "Neo", ownerKind: "player", context: "player_start:7777777001" }),
      provisionGroup({ tgUserId: 7777777001, displayName: "Neo", ownerKind: "nexa_lead", context: "nexa_lead:99" }),
    ]);

    const statuses = [a.status, b.status].sort().join("+");
    check("un créé, l'autre repoussé ou réutilisé",
      statuses === "created+pending" || statuses === "created+reused", `got ${statuses}`);
    eq("exactement 1 groupe créé", createdGroups, 1);
    eq("1 seule ligne de registre", db.prepare(`SELECT COUNT(*) AS n FROM group_creations`).get().n, 1);
  }

  // ── 8. Les topics admin du live takeover ne bougent pas ───

  console.log("\n8) Live takeover : les sujets admin par lead ne sont pas touchés");
  {
    reset();
    db.prepare(
      `INSERT INTO nexa_leads (id, tg_user_id, first_name, stage, admin_topic_chat_id, admin_thread_id, admin_topic_name)
       VALUES (42, 8190586592, 'Alexis', 'account_created', '-100555000', 777, 'Alexis · compte créé')`
    ).run();
    seedPlayerWithGroup({ id: 34, name: "Alexis minsot", tgId: 8190586592, chatId: "-1003723869680" });

    await provisionGroup({
      tgUserId: 8190586592, displayName: "Alexis", ownerKind: "nexa_lead",
      context: "nexa_lead:42", room: "nexa", lang: "fr",
    });

    const lead = db.prepare(`SELECT admin_topic_chat_id, admin_thread_id FROM nexa_leads WHERE id = 42`).get() as any;
    eq("chat du sujet admin intact", lead.admin_topic_chat_id, "-100555000");
    eq("thread admin intact", lead.admin_thread_id, 777);
    check("aucun message envoyé dans le chat admin des sujets",
      !sentMessages.some((m) => m.chatId === -100555000));
  }

  // ── Bilan ─────────────────────────────────────────────────

  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passés, ${failed} échoués`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(failed === 0 ? 0 : 1);

}

void main();
