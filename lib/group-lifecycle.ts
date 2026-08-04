/**
 * Cycle de vie des groupes d'onboarding — création idempotente + nettoyage des fantômes.
 *
 * Contexte (audit Hugo 2026-07-25) :
 *  • DOUBLONS : la création de groupe n'était tracée nulle part avant le join du joueur
 *    (`players` naît AU join). Deux /start, ou un webhook rejoué par Telegram parce que
 *    createPlayerGroup dépasse son délai (CreateChat + MigrateChat + 5 topics + invite
 *    ≈ 10-20 s), créaient deux groupes. Cas réel : M K (tg 7041662947), 2 groupes la
 *    même minute. Le verrou existait déjà côté Nexa (`group_claimed_at`), jamais côté
 *    funnel joueur.
 *  • FANTÔMES : 16 groupes morts trouvés vivants sur le compte userbot, dont 15 protégés
 *    à vie du purge hebdo par le keep-guard (`players.telegram_group_id` renseigné).
 *
 * Ce module apporte les deux briques manquantes :
 *  1. `group_creations` = LE registre, écrit AVANT que le joueur rejoigne. C'est la clé
 *     d'idempotence (owner_key = tg_user_id) et la source du job de nettoyage.
 *  2. `markGroupJoined` (event Telegram `chat_member`) + `runGhostGroupCleanup` : pas de
 *     join dans les 24 h ⇒ le groupe est nettoyé et le lead redevient relançable.
 *
 * GARDE-FOUS DURS du nettoyage (jamais contournés par le job automatique) :
 *  • on relit les membres AVANT de purger : un humain hors équipe présent ⇒ on ne purge
 *    pas, on répare `joined_at` (l'event a été manqué) ;
 *  • membres illisibles ⇒ skip (jamais de purge à l'aveugle) ;
 *  • joueur avec des mouvements wallet ⇒ skip (argent en jeu) ;
 *  • lead Nexa au-delà de `account_created` ⇒ skip (dépôt constaté) ;
 *  • cap par run (throttle Telegram).
 */

import { getDb } from "@/lib/db";
import {
  getChatMembers, getUserbotMe, kickFromChannel, leaveUserbotChannels,
  renamePlayerGroup, getInviteLink,
} from "@/lib/telegram-userbot";
import { sendMsg, AGENT_CHAT_ID } from "@/lib/telegram-commands/helpers";

export type GroupOwnerKind = "player" | "nexa_lead";

const TEAM_USERNAMES = new Set(["hugoroine", "baki77777"]);
const BOT_USERNAME = "lecercle_lebot";
const DEFAULT_MAX_AGE_H = 24;
const DEFAULT_CAP = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type GroupCreationRow = {
  id: number;
  chat_id: string;
  owner_kind: GroupOwnerKind;
  owner_key: number;
  owner_label: string | null;
  title: string | null;
  invite_link: string | null;
  topic_ids: string | null;
  created_at: string;
  joined_at: string | null;
  joined_by: number | null;
  cleaned_at: string | null;
  cleanup_reason: string | null;
};

// ── Registre ──────────────────────────────────────────────

/**
 * Trace la création. Appelé juste après createPlayerGroup, AVANT tout join possible :
 * c'est ce qui permet à un second clic de retrouver le groupe au lieu d'en créer un.
 */
export function recordGroupCreation(o: {
  chatId: string | number;
  ownerKind: GroupOwnerKind;
  ownerKey: number;
  ownerLabel?: string | null;
  title?: string | null;
  inviteLink?: string | null;
  topicIds?: Record<string, number | undefined> | null;
}) {
  try {
    getDb().prepare(`
      INSERT INTO group_creations (chat_id, owner_kind, owner_key, owner_label, title, invite_link, topic_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        owner_kind  = excluded.owner_kind,
        owner_key   = excluded.owner_key,
        owner_label = COALESCE(excluded.owner_label, owner_label),
        title       = COALESCE(excluded.title, title),
        invite_link = COALESCE(excluded.invite_link, invite_link),
        topic_ids   = COALESCE(excluded.topic_ids, topic_ids)
    `).run(
      String(o.chatId), o.ownerKind, o.ownerKey, o.ownerLabel ?? null, o.title ?? null,
      o.inviteLink ?? null, o.topicIds ? JSON.stringify(o.topicIds) : null,
    );
  } catch (e: any) {
    console.error(`[GROUPS] recordGroupCreation(${o.chatId}) failed:`, e?.message ?? e);
  }
}

export type ExistingGroup = {
  chatId: string;
  inviteLink: string | null;
  topicIds: Record<string, number> | null;
  source: "registry" | "player" | "nexa_lead" | "onboarding_lead" | "affiliate_lead";
  /** Label lisible du propriétaire trouvé — sert aux traces et à l'aperçu du bouton. */
  ownerLabel: string | null;
  /** Date de création connue, si la source la porte (registre / lead affilié). */
  createdAt: string | null;
};

/**
 * Le groupe déjà existant pour ce tg_user_id, toutes provenances confondues — c'est LE
 * point d'idempotence : tant que ça renvoie quelque chose, on ne crée jamais de groupe.
 * Le registre passe en premier (il connaît le lien + les topics), puis les liaisons
 * historiques (players / nexa_leads / onboarding_leads / affiliate_leads) pour les
 * groupes d'avant ce module.
 *
 * TOUTES les branches exigent une correspondance sur l'IDENTITÉ TELEGRAM. Un groupe
 * qu'on ne relie à ce tg_user_id que par un handle ou un nom n'est PAS retourné ici :
 * c'est un cas ambigu, traité par `findAmbiguousGroupCandidates` (aucune fusion
 * automatique par approximation).
 */
export function findExistingGroupForTgUser(tgId: number): ExistingGroup | null {
  const db = getDb();
  if (!tgId || tgId <= 0) return null; // pas d'identité fiable ⇒ jamais de match exact

  const reg = db.prepare(
    `SELECT chat_id, invite_link, topic_ids, owner_label, created_at FROM group_creations
     WHERE owner_key = ? AND cleaned_at IS NULL ORDER BY id DESC LIMIT 1`
  ).get(tgId) as {
    chat_id: string; invite_link: string | null; topic_ids: string | null;
    owner_label: string | null; created_at: string;
  } | undefined;
  if (reg) {
    let topics: Record<string, number> | null = null;
    try { topics = reg.topic_ids ? JSON.parse(reg.topic_ids) : null; } catch { topics = null; }
    return {
      chatId: reg.chat_id, inviteLink: reg.invite_link, topicIds: topics,
      source: "registry", ownerLabel: reg.owner_label, createdAt: reg.created_at,
    };
  }

  const player = db.prepare(
    `SELECT name, telegram_group_id, alertes_topic_id, liveplay_topic_id FROM players
     WHERE telegram_id = ? AND telegram_group_id IS NOT NULL AND telegram_group_id != ''`
  ).get(tgId) as {
    name: string; telegram_group_id: string;
    alertes_topic_id: number | null; liveplay_topic_id: number | null;
  } | undefined;
  if (player) {
    const topics: Record<string, number> = {};
    if (player.alertes_topic_id) topics.alertes = player.alertes_topic_id;
    if (player.liveplay_topic_id) topics.liveplay = player.liveplay_topic_id;
    return {
      chatId: String(player.telegram_group_id), inviteLink: null, topicIds: topics,
      source: "player", ownerLabel: player.name, createdAt: null,
    };
  }

  try {
    const nexa = db.prepare(
      `SELECT group_chat_id, group_invite_link, COALESCE(first_name, tg_username) AS label, created_at
       FROM nexa_leads
       WHERE tg_user_id = ? AND group_chat_id IS NOT NULL AND group_chat_id != ''`
    ).get(tgId) as {
      group_chat_id: string; group_invite_link: string | null; label: string | null; created_at: string;
    } | undefined;
    if (nexa) {
      return {
        chatId: String(nexa.group_chat_id), inviteLink: nexa.group_invite_link, topicIds: null,
        source: "nexa_lead", ownerLabel: nexa.label, createdAt: nexa.created_at,
      };
    }
  } catch { /* table absente (dev) */ }

  const lead = db.prepare(
    `SELECT group_chat_id, group_invite_link, COALESCE(first_name, telegram_username) AS label
     FROM onboarding_leads
     WHERE telegram_id = ? AND group_chat_id IS NOT NULL AND group_chat_id != ''`
  ).get(tgId) as { group_chat_id: string; group_invite_link: string | null; label: string | null } | undefined;
  if (lead) {
    return {
      chatId: String(lead.group_chat_id), inviteLink: lead.group_invite_link, topicIds: null,
      source: "onboarding_lead", ownerLabel: lead.label, createdAt: null,
    };
  }

  // Parrainage affilié : `affiliate_leads` ne porte AUCUN identifiant Telegram (clé =
  // `referred_handle`, du texte). Le seul lien fiable vers une identité Telegram passe
  // par le joueur converti. Sans conversion, le rapprochement ne peut se faire que par
  // handle ⇒ cas ambigu, pas un match (cf. findAmbiguousGroupCandidates).
  try {
    const aff = db.prepare(
      `SELECT al.kickoff_group_id AS chat_id, al.kickoff_invite_link AS invite_link,
              al.referred_handle AS label, al.created_at
       FROM affiliate_leads al
       JOIN players p ON p.id = al.converted_player_id
       WHERE p.telegram_id = ? AND al.kickoff_group_id IS NOT NULL AND al.kickoff_group_id != ''
       ORDER BY al.id DESC LIMIT 1`
    ).get(tgId) as { chat_id: string; invite_link: string | null; label: string; created_at: string } | undefined;
    if (aff) {
      return {
        chatId: String(aff.chat_id), inviteLink: aff.invite_link, topicIds: null,
        source: "affiliate_lead", ownerLabel: `@${aff.label}`, createdAt: aff.created_at,
      };
    }
  } catch { /* table absente (dev) */ }

  return null;
}

export type AmbiguousCandidate = {
  chatId: string;
  source: "affiliate_lead" | "player_no_tg" | "registry_no_owner";
  label: string;
  matchedOn: "handle" | "name";
  createdAt: string | null;
};

/**
 * Les groupes qu'on ne rapproche de cette personne que par le HANDLE ou le NOM — donc
 * sans preuve d'identité Telegram. Aucun de ces groupes n'est réutilisable
 * automatiquement : deux `@alexis` différents existent, et fusionner à tort mélange les
 * conversations de deux joueurs. Un résultat non vide ⇒ on ne crée rien et on remonte
 * le cas (règle Hugo 2026-08-04 : jamais de fusion automatique par approximation).
 *
 * Les trois trous couverts ici sont exactement ceux de l'audit :
 *   • `affiliate_leads` non converti (créé par /affi, clé handle, tg_user_id = 0) ;
 *   • un joueur dont `telegram_id` est NULL (groupe lié à la main par /linkgroup) ;
 *   • une ligne de registre sans propriétaire Telegram (owner_key = 0).
 */
export function findAmbiguousGroupCandidates(o: {
  handle?: string | null;
  displayName?: string | null;
  excludeChatId?: string | null;
}): AmbiguousCandidate[] {
  const db = getDb();
  const handle = (o.handle ?? "").trim().replace(/^@/, "").toLowerCase();
  const name = (o.displayName ?? "").trim().toLowerCase();
  const out: AmbiguousCandidate[] = [];
  if (!handle && !name) return out;

  const push = (c: AmbiguousCandidate) => {
    if (!c.chatId) return;
    if (o.excludeChatId && String(c.chatId) === String(o.excludeChatId)) return;
    if (out.some((x) => String(x.chatId) === String(c.chatId))) return;
    out.push(c);
  };

  if (handle) {
    try {
      const rows = db.prepare(
        `SELECT kickoff_group_id AS chat_id, referred_handle, created_at, status
         FROM affiliate_leads
         WHERE LOWER(referred_handle) = ? AND kickoff_group_id IS NOT NULL AND kickoff_group_id != ''
           AND status IN ('pending','converted')`
      ).all(handle) as { chat_id: string; referred_handle: string; created_at: string }[];
      for (const r of rows) {
        push({
          chatId: String(r.chat_id), source: "affiliate_lead",
          label: `@${r.referred_handle} (parrainage)`, matchedOn: "handle", createdAt: r.created_at,
        });
      }
    } catch { /* table absente (dev) */ }
  }

  // Joueur sans telegram_id : le groupe existe, l'identité Telegram manque.
  // `telegram_handle` est stocké tantôt « @x » tantôt « x » selon l'époque de saisie —
  // d'où le REPLACE, sans quoi la moitié des lignes échapperait au rapprochement.
  const players = db.prepare(
    `SELECT id, name, telegram_group_id FROM players
     WHERE telegram_id IS NULL AND telegram_group_id IS NOT NULL AND telegram_group_id != ''
       AND (( ? != '' AND LOWER(REPLACE(COALESCE(telegram_handle,''), '@', '')) = ? )
         OR ( ? != '' AND LOWER(name) = ? ))`
  ).all(handle, handle, name, name) as { id: number; name: string; telegram_group_id: string }[];
  for (const p of players) {
    push({
      chatId: String(p.telegram_group_id), source: "player_no_tg",
      label: `${p.name} (#${p.id}, sans telegram_id)`,
      matchedOn: handle && name ? "handle" : (handle ? "handle" : "name"), createdAt: null,
    });
  }

  const orphans = db.prepare(
    `SELECT chat_id, COALESCE(owner_label, title) AS label, created_at FROM group_creations
     WHERE owner_key = 0 AND cleaned_at IS NULL
       AND (( ? != '' AND LOWER(COALESCE(owner_label,'')) LIKE '%' || ? || '%' )
         OR ( ? != '' AND LOWER(COALESCE(title,'')) LIKE '%' || ? || '%' ))`
  ).all(handle, handle, name, name) as { chat_id: string; label: string | null; createdAt?: string; created_at: string }[];
  for (const r of orphans) {
    push({
      chatId: String(r.chat_id), source: "registry_no_owner",
      label: r.label ?? String(r.chat_id), matchedOn: handle ? "handle" : "name", createdAt: r.created_at,
    });
  }

  return out;
}

/** Lien d'invitation d'un groupe existant : cache du registre, sinon userbot (et on cache). */
export async function ensureInviteLink(chatId: string, known?: string | null): Promise<string | null> {
  if (known) return known;
  const cached = getDb().prepare(`SELECT invite_link FROM group_creations WHERE chat_id = ?`)
    .get(String(chatId)) as { invite_link: string | null } | undefined;
  if (cached?.invite_link) return cached.invite_link;

  const res = await getInviteLink(Number(chatId));
  if (res.ok && res.link) {
    getDb().prepare(`UPDATE group_creations SET invite_link = ? WHERE chat_id = ?`).run(res.link, String(chatId));
    return res.link;
  }
  return null;
}

// ── Verrou de création ────────────────────────────────────
// Clé = tg_user_id, PAS le lead ni la room (incident Alexis 2026-08-04). Les verrous
// d'avant vivaient dans `nexa_leads.group_claimed_at` et `onboarding_leads.group_claimed_at`
// et ne se voyaient donc PAS entre eux : le funnel joueur et le funnel Nexa pouvaient
// créer en parallèle pour le même utilisateur Telegram. Expire après 5 min pour ne pas
// bloquer un retry après un vrai crash.

const CLAIM_TTL_MIN = 5;

/** true = ce process a le droit de créer. false = une création est déjà en vol. */
export function claimGroupCreation(tgId: number, context: string): boolean {
  if (!tgId || tgId <= 0) return false; // sans identité Telegram, aucune création possible
  const r = getDb().prepare(`
    INSERT INTO group_claims (tg_user_id, claimed_at, context) VALUES (?, datetime('now'), ?)
    ON CONFLICT(tg_user_id) DO UPDATE SET claimed_at = datetime('now'), context = excluded.context
    WHERE (julianday('now') - julianday(group_claims.claimed_at)) * 1440 > ?
  `).run(tgId, context, CLAIM_TTL_MIN);
  return r.changes > 0;
}

/** Échec de création → on relâche le verrou pour qu'un prochain essai reparte tout de suite. */
export function releaseGroupClaim(tgId: number) {
  try { getDb().prepare(`DELETE FROM group_claims WHERE tg_user_id = ?`).run(tgId); } catch { /* best-effort */ }
}

/**
 * Un groupe trouvé hors registre (players / leads / parrainage) y entre ici, au moment
 * où on le réutilise : sans ça il resterait invisible aux vérifications suivantes et
 * chaque nouveau chemin recommencerait à zéro. `joined_at` est posé — ce groupe existe
 * depuis longtemps, il ne doit jamais devenir candidat au nettoyage 24 h.
 */
export function backfillRegistryForExistingGroup(o: {
  chatId: string | number;
  ownerKind: GroupOwnerKind;
  ownerKey: number;
  ownerLabel?: string | null;
  inviteLink?: string | null;
  topicIds?: Record<string, number> | null;
}): boolean {
  try {
    const r = getDb().prepare(`
      INSERT INTO group_creations
        (chat_id, owner_kind, owner_key, owner_label, title, invite_link, topic_ids, joined_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(chat_id) DO UPDATE SET
        owner_key   = CASE WHEN group_creations.owner_key = 0 THEN excluded.owner_key ELSE group_creations.owner_key END,
        owner_label = COALESCE(group_creations.owner_label, excluded.owner_label),
        invite_link = COALESCE(excluded.invite_link, group_creations.invite_link),
        topic_ids   = COALESCE(group_creations.topic_ids, excluded.topic_ids)
    `).run(
      String(o.chatId), o.ownerKind, o.ownerKey, o.ownerLabel ?? null, o.ownerLabel ?? null,
      o.inviteLink ?? null, o.topicIds && Object.keys(o.topicIds).length ? JSON.stringify(o.topicIds) : null,
    );
    return r.changes > 0;
  } catch (e: any) {
    console.error(`[GROUPS] backfillRegistry(${o.chatId}) failed:`, e?.message ?? e);
    return false;
  }
}

export function bindPlayerGroupToLead(tgId: number, chatId: string | number, inviteLink: string | null) {
  getDb().prepare(
    `UPDATE onboarding_leads SET group_chat_id = ?, group_invite_link = ?, group_not_joined = 0 WHERE telegram_id = ?`
  ).run(String(chatId), inviteLink, tgId);
}

// ── Détection du join ─────────────────────────────────────

/**
 * Le joueur a rejoint : on horodate partout. Appelé depuis le webhook sur `chat_member`
 * ET `new_chat_members` (Telegram livre parfois les deux — tout est en COALESCE, donc
 * rejouer est sans effet).
 *
 * Bonus : si `handleNewMembers` a perdu sa Map mémoire (redeploy entre la création et le
 * join), le registre sait à qui appartient le groupe → on répare la liaison. C'est la
 * classe de bug « groupe rejoint mais non lié en base » vue à l'audit (Luna, Elie, …).
 */
export function markGroupJoined(chatId: number | string | undefined, userId: number | undefined) {
  if (!chatId || !userId) return;
  const cid = String(chatId);
  const db = getDb();
  try {
    const reg = db.prepare(`SELECT owner_kind, owner_key, topic_ids FROM group_creations WHERE chat_id = ?`)
      .get(cid) as { owner_kind: GroupOwnerKind; owner_key: number; topic_ids: string | null } | undefined;

    db.prepare(
      `UPDATE group_creations SET joined_at = COALESCE(joined_at, datetime('now')), joined_by = COALESCE(joined_by, ?)
       WHERE chat_id = ?`
    ).run(userId, cid);

    // Réparation de la liaison perdue (Map mémoire évaporée par un redeploy).
    if (reg?.owner_kind === "player" && reg.owner_key === userId) {
      let topics: Record<string, number> = {};
      try { topics = reg.topic_ids ? JSON.parse(reg.topic_ids) : {}; } catch { topics = {}; }
      db.prepare(`
        UPDATE players SET
          telegram_group_id = ?,
          alertes_topic_id  = COALESCE(alertes_topic_id, ?),
          liveplay_topic_id = COALESCE(liveplay_topic_id, ?)
        WHERE telegram_id = ? AND (telegram_group_id IS NULL OR telegram_group_id = '')
      `).run(cid, topics.alertes ?? null, topics.liveplay ?? null, userId);
    }

    db.prepare(
      `UPDATE players SET group_joined_at = COALESCE(group_joined_at, datetime('now')), group_not_joined = 0
       WHERE telegram_id = ? AND telegram_group_id = ?`
    ).run(userId, cid);

    db.prepare(
      `UPDATE onboarding_leads SET group_joined_at = COALESCE(group_joined_at, datetime('now')), group_not_joined = 0
       WHERE telegram_id = ? AND group_chat_id = ?`
    ).run(userId, cid);

    try {
      db.prepare(
        `UPDATE nexa_leads SET group_joined_at = COALESCE(group_joined_at, datetime('now')), group_not_joined = 0,
           updated_at = datetime('now')
         WHERE tg_user_id = ? AND group_chat_id = ?`
      ).run(userId, cid);
    } catch { /* table absente (dev) */ }
  } catch (e: any) {
    console.error(`[GROUPS] markGroupJoined(${cid}, ${userId}) failed:`, e?.message ?? e);
  }
}

// ── Nettoyage des groupes non rejoints ────────────────────

export interface GhostCleanupResult {
  ok: boolean;
  dry_run: boolean;
  candidates: number;
  scanned: number;
  purged: { chat_id: string; label: string }[];
  tagged: { chat_id: string; label: string; reason: string }[];
  self_healed: { chat_id: string; label: string; human: string }[];
  skipped: { chat_id: string; label: string; reason: string }[];
  regressed: { kind: GroupOwnerKind; key: number; label: string }[];
  remaining: number;
  error: string | null;
}

function emptyResult(dryRun: boolean): GhostCleanupResult {
  return {
    ok: false, dry_run: dryRun, candidates: 0, scanned: 0, purged: [], tagged: [],
    self_healed: [], skipped: [], regressed: [], remaining: 0, error: null,
  };
}

function labelOf(row: GroupCreationRow): string {
  return row.title || row.owner_label || `${row.owner_kind} ${row.owner_key}`;
}

/** Raison de NE PAS toucher ce groupe (argent en jeu / dépôt constaté), sinon null. */
function businessGuard(row: GroupCreationRow): string | null {
  const db = getDb();
  if (row.owner_kind === "player") {
    const p = db.prepare(
      `SELECT id, (SELECT COUNT(*) FROM wallet_transactions w WHERE w.player_id = players.id) AS txs
       FROM players WHERE telegram_id = ?`
    ).get(row.owner_key) as { id: number; txs: number } | undefined;
    if (p && p.txs > 0) return `joueur #${p.id} avec ${p.txs} mouvement(s) wallet`;
    return null;
  }
  try {
    const lead = db.prepare(`SELECT id, stage FROM nexa_leads WHERE tg_user_id = ?`)
      .get(row.owner_key) as { id: number; stage: string } | undefined;
    if (lead && !["started", "app_installed", "account_created"].includes(lead.stage)) {
      return `lead Nexa #${lead.id} au stade ${lead.stage} (dépôt constaté)`;
    }
  } catch { /* table absente */ }
  return null;
}

/**
 * Le lead repasse à l'étape précédente avec le flag « groupe non rejoint », pour qu'on
 * puisse le relancer au lieu de le perdre (règle Hugo 2026-07-25). Le lien mort est
 * effacé ⇒ il disparaît de la vue CRM.
 */
export function regressOwnerByChatId(chatId: string): { kind: string; label: string }[] {
  const db = getDb();
  const out: { kind: string; label: string }[] = [];
  const cid = String(chatId);

  // Joueur : on délie le groupe mort. Sans ça le keep-guard le protège à vie (c'est
  // exactement pourquoi 15 des 16 fantômes de l'audit avaient survécu au purge hebdo)
  // et le CRM continue de pointer vers un groupe inexistant.
  const players = db.prepare(`SELECT id, name, telegram_id FROM players WHERE telegram_group_id = ?`)
    .all(cid) as { id: number; name: string; telegram_id: number | null }[];
  if (players.length) {
    db.prepare(`
      UPDATE players SET
        telegram_group_id = NULL, alertes_topic_id = NULL, liveplay_topic_id = NULL,
        accounting_topic_id = NULL, deals_topic_id = NULL, clubs_topic_id = NULL,
        depot_topic_id = NULL, onboarding_topic_id = NULL, group_not_joined = 1
      WHERE telegram_group_id = ?
    `).run(cid);
    for (const p of players) out.push({ kind: "player", label: `${p.name} (#${p.id})` });
  }

  const leads = db.prepare(`SELECT telegram_id, first_name FROM onboarding_leads WHERE group_chat_id = ?`)
    .all(cid) as { telegram_id: number; first_name: string | null }[];
  if (leads.length) {
    db.prepare(`
      UPDATE onboarding_leads SET
        group_chat_id = NULL, group_invite_link = NULL, group_claimed_at = NULL, group_not_joined = 1,
        stage = CASE WHEN stage = 'joined' THEN 'discovered' ELSE stage END
      WHERE group_chat_id = ?
    `).run(cid);
    for (const l of leads) out.push({ kind: "onboarding_lead", label: l.first_name ?? `tg:${l.telegram_id}` });
  }

  try {
    const nexa = db.prepare(
      `SELECT id, stage, COALESCE(first_name, tg_username, 'lead #' || id) AS label
       FROM nexa_leads WHERE group_chat_id = ?`
    ).all(cid) as { id: number; stage: string; label: string }[];
    for (const lead of nexa) {
      // Groupe effacé + compteurs de relance remis à zéro (un lead `cold` ne serait plus
      // jamais relancé par le cron) ⇒ il repart dans le cycle de relance à son étape.
      db.prepare(`
        UPDATE nexa_leads SET
          group_chat_id = NULL, group_invite_link = NULL, group_claimed_at = NULL,
          group_announced_at = NULL, group_not_joined = 1,
          relances_count = 0, last_reminder_at = NULL, cold = 0,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(lead.id);
      // Journal Nexa écrit en SQL direct : importer nexa-funnel ici créerait un cycle
      // (nexa-funnel importe group-lifecycle pour l'idempotence).
      try {
        db.prepare(
          `INSERT INTO nexa_lead_events (lead_id, kind, stage, payload, actor) VALUES (?, 'admin', ?, ?, 'admin')`
        ).run(lead.id, lead.stage, `groupe ${cid} non rejoint → nettoyé, lead relançable`);
      } catch { /* log best-effort */ }
      out.push({ kind: "nexa_lead", label: lead.label });
    }
  } catch { /* table absente (dev) */ }

  return out;
}

/**
 * Marque le groupe nettoyé dans le registre. Upsert : la purge de rattrapage porte sur
 * des groupes créés AVANT l'existence du registre, ils n'y ont pas de ligne. `joined_at`
 * est posé pour que la ligne créée ici ne soit jamais candidate au job 24 h.
 */
function markCleaned(chatId: string, reason: string, backfill?: { ownerKind: GroupOwnerKind; ownerKey: number; label: string }) {
  const db = getDb();
  const r = db.prepare(`UPDATE group_creations SET cleaned_at = datetime('now'), cleanup_reason = ? WHERE chat_id = ?`)
    .run(reason, String(chatId));
  if (r.changes === 0 && backfill) {
    db.prepare(`
      INSERT OR IGNORE INTO group_creations
        (chat_id, owner_kind, owner_key, owner_label, title, joined_at, cleaned_at, cleanup_reason)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
    `).run(String(chatId), backfill.ownerKind, backfill.ownerKey, backfill.label, backfill.label, reason);
  }
}

export type PurgeOutcome = {
  chat_id: string;
  label: string;
  outcome: "purged" | "tagged" | "has_human" | "skipped";
  detail: string;
  regressed: { kind: string; label: string }[];
};

/**
 * Purge un groupe précis, avec les MÊMES garde-fous que le job automatique : on relit
 * les membres juste avant, un humain hors équipe présent ⇒ on ne touche à rien (on
 * répare `joined_at`). Utilisé par le job 24 h et par la purge de rattrapage des
 * fantômes de l'audit.
 */
export async function purgeGroupById(
  chatId: string,
  o: { reason: string; label?: string; dryRun?: boolean; backfillOwner?: { ownerKind: GroupOwnerKind; ownerKey: number } },
): Promise<PurgeOutcome> {
  const cid = String(chatId);
  const reg = getDb().prepare(`SELECT title, owner_label FROM group_creations WHERE chat_id = ?`)
    .get(cid) as { title: string | null; owner_label: string | null } | undefined;
  const label = o.label ?? reg?.title ?? reg?.owner_label ?? cid;

  const me = await getUserbotMe();
  if (!me) return { chat_id: cid, label, outcome: "skipped", detail: "userbot non connecté", regressed: [] };

  const members = await getChatMembers(cid);
  await sleep(600);
  if (members.length === 0) {
    return { chat_id: cid, label, outcome: "skipped", detail: "membres illisibles — jamais de purge à l'aveugle", regressed: [] };
  }
  const strangers = members.filter((m) => {
    if (m.id === me.id) return false;
    const uname = (m.username ?? "").toLowerCase();
    if (m.bot) return uname !== BOT_USERNAME;
    return !TEAM_USERNAMES.has(uname);
  });
  if (strangers.length > 0) {
    const human = strangers[0].username ?? strangers[0].first_name ?? String(strangers[0].id);
    if (!o.dryRun) markGroupJoined(cid, strangers[0].id);
    return { chat_id: cid, label, outcome: "has_human", detail: `${human} est dedans — join réparé, rien purgé`, regressed: [] };
  }

  if (o.dryRun) {
    return {
      chat_id: cid, label, outcome: "purged",
      detail: `dry-run — ${members.length} membre(s), équipe uniquement`, regressed: [],
    };
  }

  const out = await purgeOrTag(cid, reg?.title ?? o.label ?? null, members, me.id);
  markCleaned(cid, out.outcome === "purged" ? o.reason : `abandoned_tagged (${o.reason}): ${out.reason}`,
    o.backfillOwner ? { ...o.backfillOwner, label } : undefined);
  const regressed = regressOwnerByChatId(cid);
  return { chat_id: cid, label, outcome: out.outcome, detail: out.reason, regressed };
}

/**
 * Purge effective d'un groupe : kick l'équipe un par un, le userbot (créateur) sort en
 * dernier ⇒ le groupe disparaît de tous les Telegram. L'API Telegram ne sait PAS
 * supprimer un supergroupe autrement. Si un kick échoue (bot non admin), on ne laisse
 * pas un groupe à moitié vidé : on le tague « abandonné » pour le sortir de la vue.
 */
async function purgeOrTag(
  chatId: string, title: string | null, members: { id: number; username?: string }[], meId: number,
): Promise<{ outcome: "purged" | "tagged"; reason: string }> {
  for (const m of members) {
    if (m.id === meId) continue;
    const k = await kickFromChannel(chatId, m.id);
    await sleep(900);
    if (!k.ok) {
      const tag = `⚰️ Abandonné — ${title ?? chatId}`.slice(0, 128);
      await renamePlayerGroup(chatId, tag).catch(() => {});
      await sendMsg(Number(chatId),
        `⚰️ <b>Groupe abandonné</b>\n\nLe joueur n'a jamais rejoint ce canal dans les 24 h. ` +
        `Il est retiré du suivi — plus rien ne sera posté ici.`
      ).catch(() => {});
      return { outcome: "tagged", reason: `kick impossible (${k.error ?? "?"})` };
    }
  }
  const leave = await leaveUserbotChannels([chatId]);
  if (leave.left.includes(chatId)) return { outcome: "purged", reason: "not_joined_24h" };
  const tag = `⚰️ Abandonné — ${title ?? chatId}`.slice(0, 128);
  await renamePlayerGroup(chatId, tag).catch(() => {});
  return { outcome: "tagged", reason: `leave échoué (${leave.failed[0]?.error ?? "?"})` };
}

/**
 * Job 24 h. Un groupe créé sans join au-delà de `maxAgeHours` est nettoyé et son
 * propriétaire redevient relançable. `dryRun` ne touche NI Telegram NI la base.
 */
export async function runGhostGroupCleanup(opts?: {
  maxAgeHours?: number; cap?: number; dryRun?: boolean;
}): Promise<GhostCleanupResult> {
  const maxAgeHours = opts?.maxAgeHours ?? DEFAULT_MAX_AGE_H;
  const cap = Math.min(opts?.cap ?? DEFAULT_CAP, DEFAULT_CAP);
  const dryRun = !!opts?.dryRun;
  const res = emptyResult(dryRun);

  const rows = getDb().prepare(`
    SELECT * FROM group_creations
    WHERE joined_at IS NULL AND cleaned_at IS NULL
      AND (julianday('now') - julianday(created_at)) * 24 >= ?
    ORDER BY created_at
  `).all(maxAgeHours) as GroupCreationRow[];

  res.candidates = rows.length;
  const batch = rows.slice(0, cap);
  res.remaining = rows.length - batch.length;
  if (batch.length === 0) { res.ok = true; return res; }

  const me = await getUserbotMe();
  if (!me) { res.error = "userbot non connecté"; return res; }

  for (const row of batch) {
    res.scanned++;
    const label = labelOf(row);

    const guard = businessGuard(row);
    if (guard) { res.skipped.push({ chat_id: row.chat_id, label, reason: guard }); continue; }

    const out = await purgeGroupById(row.chat_id, { reason: "not_joined_24h", label, dryRun });
    if (out.outcome === "purged") res.purged.push({ chat_id: row.chat_id, label });
    else if (out.outcome === "tagged") res.tagged.push({ chat_id: row.chat_id, label, reason: out.detail });
    else if (out.outcome === "has_human") res.self_healed.push({ chat_id: row.chat_id, label, human: out.detail });
    else res.skipped.push({ chat_id: row.chat_id, label, reason: out.detail });

    for (const reg of out.regressed) {
      res.regressed.push({ kind: reg.kind as GroupOwnerKind, key: row.owner_key, label: reg.label });
    }
  }

  res.ok = true;
  return res;
}

/** Rapport dans le chat agent — ne throw jamais (un échec de report ne casse pas le cron). */
export async function reportGhostCleanup(r: GhostCleanupResult): Promise<void> {
  try {
    // Notif SEULEMENT si le run a réellement agi : ≥1 supprimé, tagué ou réparé.
    // `skipped` est volontairement exclu (Hugo 2026-07-29) : les groupes bloqués par
    // businessGuard sont rescannés à chaque passage et restaient donc dans le rapport
    // indéfiniment — c'était la cause du récap « 0 supprimé · 0 tagué » récurrent.
    // Un échec (`!r.ok`, ex. userbot non connecté) reste notifié : c'est une panne, pas un no-op.
    if (r.ok && r.purged.length === 0 && r.tagged.length === 0 && r.self_healed.length === 0) {
      return; // rien à dire — on ne spamme pas le chat agent
    }
    const lines: string[] = [`🧹 <b>Groupes non rejoints (24 h)</b>${r.dry_run ? " — <i>dry-run</i>" : ""}`];
    if (!r.ok) {
      lines.push(`❌ Échec : ${r.error}`);
    } else {
      lines.push(
        `${r.purged.length} supprimé(s) · ${r.tagged.length} tagué(s) abandonné · ` +
        `${r.self_healed.length} réparé(s) (join manqué) · ${r.skipped.length} ignoré(s)` +
        (r.remaining > 0 ? ` · ${r.remaining} pour le prochain run` : "")
      );
      for (const p of r.purged) lines.push(`  🗑 ${p.label}`);
      for (const t of r.tagged) lines.push(`  ⚰️ ${t.label} — ${t.reason}`);
      for (const h of r.self_healed) lines.push(`  ✅ ${h.label} — ${h.human} était dedans, join réparé`);
      for (const s of r.skipped) lines.push(`  ⏭ ${s.label} — ${s.reason}`);
      if (r.regressed.length) {
        lines.push(`👉 ${r.regressed.length} lead(s) remis en relance : ${r.regressed.map((x) => x.label).join(", ")}`);
      }
    }
    await sendMsg(AGENT_CHAT_ID, lines.join("\n"));
  } catch (e: any) {
    console.error("[GROUPS] reportGhostCleanup failed:", e?.message ?? e);
  }
}
