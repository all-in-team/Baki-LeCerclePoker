// Sujets de forum du chat admin — un topic Telegram par lead.
//
// Avant : tous les leads dans un flux plat, résolus par « Répondre » (relay_map).
// Maintenant : chaque lead a son topic, et TOUT message d'opérateur posté dedans
// lui est relayé — sans « Répondre », sans commande. Le routage est
// `message_thread_id -> lead_id` ; relay_map reste le filet pour les leads créés
// avant cette bascule et pour les médias copiés.
//
// Ce module ne connaît que les topics : il n'envoie jamais rien AU lead (c'est
// `replyToLead()` dans live-takeover.ts) et n'importe pas live-takeover — d'où la
// couche partagée `telegram-api.ts`.
//
// Trois invariants :
//   1. Le topic « General » n'accueille JAMAIS un message de lead. Il est réservé
//      aux alertes système (§3 du brief) : erreurs d'envoi, config manquante.
//   2. Aucun message de lead n'est perdu. Le curseur `last_relayed_msg_id` n'avance
//      qu'après un post réussi ; un rate limit ou un topic supprimé laisse le
//      travail en attente, repris par le drain périodique.
//   3. Si Topics n'est pas activé sur le chat, tout retombe sur le mode plat sans
//      lever d'exception.
import { getDb } from "@/lib/db";
import { adminChatId, tg, tgRetrying, esc, sleep, makeSerialQueue, type TgResult } from "@/lib/funnels/telegram-api";
import { NEXA_STAGES } from "@/lib/funnels/nexa/config";

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL?.trim() || "https://lecerclepoker-production.up.railway.app";

/** Un topic sans message depuis ce délai est fermé (rouvert si le lead réécrit). */
export const TOPIC_IDLE_CLOSE_DAYS = 30;
/** Longueur max d'un nom de topic côté Telegram. */
const TOPIC_NAME_MAX = 128;
/** Au-delà, on rend la main au webhook et le drain périodique reprend le relais. */
const TOPIC_CREATE_BUDGET_MS = 8_000;

export type TopicLead = {
  id: number;
  tg_user_id: number;
  tg_username: string | null;
  first_name: string | null;
  source: string;
  stage: string;
  member_id: string | null;
  admin_topic_chat_id: string | null;
  admin_thread_id: number | null;
  admin_topic_name: string | null;
  admin_card_message_id: number | null;
  admin_topic_closed: number;
  admin_topic_last_at: string | null;
};

export const TOPIC_LEAD_COLS = `id, tg_user_id, tg_username, first_name, source, stage, member_id,
  admin_topic_chat_id, admin_thread_id, admin_topic_name, admin_card_message_id,
  admin_topic_closed, admin_topic_last_at`;

export function getTopicLead(leadId: number): TopicLead | undefined {
  return getDb().prepare(`SELECT ${TOPIC_LEAD_COLS} FROM nexa_leads WHERE id = ?`).get(leadId) as TopicLead | undefined;
}

// ── Détection du mode forum ───────────────────────────────

type ForumProbe = { chatId: string; isForum: boolean; at: number };
let forumProbe: ForumProbe | null = null;
const FORUM_TTL_MS = 10 * 60_000;
let forumWarned = false;

/**
 * Le chat admin a-t-il les Sujets activés ? `null` = on ne sait pas (getChat en
 * échec, et aucune réponse antérieure en cache).
 *
 * La tri-valeur n'est pas un raffinement : répondre `false` sur un échec réseau
 * revient à dire « ce n'est pas un forum », donc à poster le message du lead SANS
 * message_thread_id — c'est-à-dire dans « General », que le §3 du brief réserve aux
 * alertes système. Un incident réseau d'une seconde suffisait à y déverser une
 * conversation. `null` fait au contraire différer le relais : le message attend le
 * drain, et rien ne fuit.
 *
 * Le résultat est mis en cache : appelé à chaque message de lead, alors que
 * `is_forum` ne change qu'à la main. Un échec ne poisonne PAS le cache — la sonde
 * est simplement retentée au prochain appel.
 */
export async function adminChatIsForum(chatId: string): Promise<boolean | null> {
  const now = Date.now();
  if (forumProbe && forumProbe.chatId === chatId && now - forumProbe.at < FORUM_TTL_MS) {
    return forumProbe.isForum;
  }

  const res = await tg<{ is_forum?: boolean }>("getChat", { chat_id: chatId });
  if (!res.ok) {
    console.error(`[TOPICS] getChat(${chatId}) a échoué (${res.description}) — état des Sujets inconnu, relais différé`);
    // On garde une réponse ANTÉRIEURE si on en a une : elle reste plus fiable qu'un
    // échec de transport ponctuel.
    return forumProbe?.chatId === chatId ? forumProbe.isForum : null;
  }

  const isForum = res.result?.is_forum === true;
  if (!isForum && !forumWarned) {
    forumWarned = true;
    console.warn(
      `[TOPICS] Les Sujets ne sont PAS activés sur ${chatId} — relais en mode plat (comportement d'avant). ` +
      `Active « Sujets » dans les réglages du groupe et donne « Gérer les sujets » au bot. Voir docs/LIVE_TAKEOVER.md`
    );
  }
  if (isForum) forumWarned = false;
  forumProbe = { chatId, isForum, at: now };
  return isForum;
}

/**
 * Sonde au démarrage — le diagnostic doit sortir avant le premier lead, pas après.
 *
 * Retentée : sur Railway, `instrumentation.register()` s'exécute avant que le réseau
 * sortant du conteneur soit prêt, et la première tentative échoue par `fetch failed`.
 * Sans ces reprises, le log annonçait « Sujets NON activés » sur un groupe
 * parfaitement configuré — un faux diagnostic est pire que pas de diagnostic.
 */
export async function probeForumAtStartup(chatId: string): Promise<void> {
  const delaysMs = [2_000, 8_000, 20_000];
  for (let i = 0; i < delaysMs.length; i++) {
    await sleep(delaysMs[i]);
    const state = await adminChatIsForum(chatId).catch(() => null);
    if (state === true) {
      console.log(`[TOPICS] chat admin ${chatId} — Sujets activés`);
      return;
    }
    if (state === false) {
      console.warn(`[TOPICS] chat admin ${chatId} — Sujets NON activés, relais en mode plat`);
      return;
    }
  }
  console.warn(
    `[TOPICS] chat admin ${chatId} — sonde impossible (réseau) après ${delaysMs.length} tentatives. ` +
    `Ce n'est PAS un diagnostic de configuration : l'état sera resondé au premier message de lead.`
  );
}

// ── Nom, icône et carte contexte ──────────────────────────

/** Suffixe d'étape affiché dans le nom du topic — court, le nom est tronqué à 128. */
const STAGE_SUFFIX: Record<string, string> = {
  started: "Nouveau",
  app_installed: "App",
  account_created: "Compte",
  deposit_done: "Déposé",
  room_verified: "Vérifié",
  played: "Joue",
};

/**
 * Couleur d'icône du topic. Telegram n'accepte QUE ces six valeurs, et seulement
 * à la création (`editForumTopic` ne prend pas `icon_color`) — le changement
 * d'étape passe donc par l'emoji d'icône, cf. STAGE_ICON_EMOJI.
 *
 * Le vert démarre à « Dépôt » : c'est le palier qui compte, il doit se repérer
 * dans la liste des sujets sans lire les noms.
 */
const STAGE_COLOR: Record<string, number> = {
  started: 0x6fb9f0,        // bleu
  app_installed: 0xcb86db,  // violet
  account_created: 0xffd67e,// jaune
  deposit_done: 0x8eee98,   // vert — le palier qui compte
  room_verified: 0x8eee98,
  played: 0x8eee98,
};

/** Emoji d'icône visé par étape — résolu en custom_emoji_id via getForumTopicIconStickers. */
const STAGE_ICON_EMOJI: Record<string, string> = {
  started: "🚀",
  app_installed: "📲",
  account_created: "📝",
  deposit_done: "💰",
  room_verified: "✅",
  played: "♠️",
};

type IconCache = { map: Map<string, string>; at: number };
let iconCache: IconCache | null = null;
const ICON_TTL_MS = 60 * 60_000;

/**
 * `editForumTopic` ne peut changer l'icône que via un `icon_custom_emoji_id`, pris
 * dans la liste autorisée par Telegram. Si l'emoji visé n'y est pas (la liste
 * évolue), on renomme sans toucher à l'icône — jamais d'échec bloquant pour une
 * pastille de couleur.
 */
async function iconIdFor(stage: string): Promise<string | undefined> {
  const emoji = STAGE_ICON_EMOJI[stage];
  if (!emoji) return undefined;
  const now = Date.now();
  if (!iconCache || now - iconCache.at > ICON_TTL_MS) {
    const res = await tg<Array<{ emoji?: string; custom_emoji_id?: string }>>("getForumTopicIconStickers", {});
    const map = new Map<string, string>();
    if (res.ok && Array.isArray(res.result)) {
      for (const s of res.result) if (s.emoji && s.custom_emoji_id) map.set(s.emoji, s.custom_emoji_id);
    }
    iconCache = { map, at: now };
  }
  return iconCache.map.get(emoji);
}

/** « Prénom · @handle · Déposé » — repli sur l'id Telegram quand il n'y a pas de handle. */
export function topicNameFor(lead: Pick<TopicLead, "first_name" | "tg_username" | "tg_user_id" | "stage">): string {
  const handle = lead.tg_username ? `@${lead.tg_username}` : `tg:${lead.tg_user_id}`;
  const base = [lead.first_name?.trim(), handle].filter(Boolean).join(" · ");
  const suffix = STAGE_SUFFIX[lead.stage];
  const full = suffix ? `${base} · ${suffix}` : base;
  if (full.length <= TOPIC_NAME_MAX) return full;
  // On tronque le nom, jamais le suffixe d'étape : c'est lui qui porte l'info.
  const room = TOPIC_NAME_MAX - (suffix ? suffix.length + 3 : 0) - 1;
  return `${base.slice(0, Math.max(1, room))}…${suffix ? ` · ${suffix}` : ""}`;
}

function stageLabel(stage: string): string {
  return NEXA_STAGES.find(s => s.key === stage)?.label ?? stage;
}

/** Carte contexte épinglée en tête de topic — éditée à chaque changement d'étape. */
export function buildContextCard(lead: TopicLead): string {
  const handle = lead.tg_username ? `@${lead.tg_username}` : "—";
  return [
    `<b>${esc(lead.first_name ?? "Lead")}</b> · ${esc(handle)}`,
    `Étape : <b>${esc(stageLabel(lead.stage))}</b>`,
    `Source : <code>${esc(lead.source)}</code>`,
    `ID joueur : <code>${esc(lead.member_id ?? "—")}</code>`,
    `tg_id : <code>${lead.tg_user_id}</code>`,
    ``,
    `🔗 <a href="${BASE_URL}/nexa-funnel?lead=${lead.id}">Fiche dans le back-office</a>`,
    `<i>Écris ici : le lead reçoit ton message du bot. /bot · /stop · /note</i>`,
  ].join("\n");
}

// ── Création du topic ─────────────────────────────────────

const createQueue = makeSerialQueue();
/** Une seule création en vol par lead — deux messages simultanés partagent la même. */
const inFlight = new Map<number, Promise<number | null>>();

/**
 * Trois issues, mutuellement exclusives — et c'est le point important :
 *   • `flat`     → le chat n'est pas un forum, poster sans thread est CORRECT ;
 *   • `deferred` → rien à faire maintenant, ne surtout PAS poster ;
 *   • sinon      → `threadId` est utilisable.
 *
 * Sans cette distinction, un échec de création se confondait avec le mode plat et
 * le message du lead atterrissait dans « General » — que le §3 du brief réserve aux
 * alertes système.
 */
export type EnsureResult = { threadId: number | null; deferred: boolean; flat: boolean };

const DEFER: EnsureResult = { threadId: null, deferred: true, flat: false };
const FLAT: EnsureResult = { threadId: null, deferred: false, flat: true };

/**
 * Retourne le topic du lead, en le créant au besoin.
 *
 * Sur `deferred`, l'appelant ne doit PAS avancer son curseur de relais : le message
 * reste en attente et sera repris par le drain. C'est la garantie « aucun message
 * perdu ».
 */
export async function ensureLeadTopic(leadId: number): Promise<EnsureResult> {
  const chat = adminChatId();

  const lead = getTopicLead(leadId);
  // Lead inconnu : on ne poste nulle part. Surtout pas à plat — dans un forum, ça
  // reviendrait à déverser un message de lead dans General.
  if (!lead) return DEFER;

  const forum = await adminChatIsForum(chat);
  // Inconnu (getChat en échec) : on DIFFÈRE. Poster à plat ici enverrait le message
  // dans General si le chat est bien un forum — exactement ce qu'on s'interdit.
  if (forum === null) return DEFER;
  if (forum === false) return FLAT;

  // Topic déjà connu POUR CE CHAT. Un thread_id venu d'un autre chat admin ne veut
  // rien dire : on en recrée un plutôt que de poster dans le vide.
  if (lead.admin_thread_id && String(lead.admin_topic_chat_id) === String(chat)) {
    return { threadId: lead.admin_thread_id, deferred: false, flat: false };
  }

  // Une création déjà en vol pour ce lead : on l'attend au lieu d'en lancer une
  // seconde, sous le même budget de temps.
  const pending = inFlight.get(leadId);
  if (pending) return settle(leadId, pending);

  const task = createQueue(async () => {
    // Re-lecture dans la file : un autre appel a pu créer le topic entre-temps.
    const fresh = getTopicLead(leadId);
    if (fresh?.admin_thread_id && String(fresh.admin_topic_chat_id) === String(chat)) return fresh.admin_thread_id;
    return createTopicFor(fresh ?? lead, chat);
  }).finally(() => inFlight.delete(leadId));

  inFlight.set(leadId, task);
  return settle(leadId, task);
}

/**
 * Attend une création sous budget de temps.
 *
 * La création est sérialisée et peut attendre un `retry_after` : dix leads
 * simultanés mettraient le webhook à genoux, et Telegram rejouerait l'update — que
 * le dédoublonnage écarterait. Passé le budget on rend la main en `deferred` ; la
 * création CONTINUE en tâche de fond et le drain postera dès qu'elle aura abouti.
 * Rien n'est perdu, seul le délai s'allonge.
 */
async function settle(leadId: number, task: Promise<number | null>): Promise<EnsureResult> {
  const threadId = await Promise.race([task, sleep(TOPIC_CREATE_BUDGET_MS).then(() => undefined)]);
  if (threadId === undefined) {
    console.warn(`[TOPICS] création lead ${leadId} au-delà de ${TOPIC_CREATE_BUDGET_MS}ms — relais différé`);
    return DEFER;
  }
  // `null` = la création a échoué (rate limit épuisé, droits manquants…). C'est un
  // report, pas un mode plat : on ne poste rien.
  if (threadId === null) return DEFER;
  return { threadId, deferred: false, flat: false };
}

async function createTopicFor(lead: TopicLead, chat: string): Promise<number | null> {
  const name = topicNameFor(lead);
  const iconId = await iconIdFor(lead.stage);

  const res = await tgRetrying<{ message_thread_id: number }>("createForumTopic", {
    chat_id: chat,
    name,
    icon_color: STAGE_COLOR[lead.stage] ?? STAGE_COLOR.started,
    ...(iconId ? { icon_custom_emoji_id: iconId } : {}),
  });

  if (!res.ok || !res.result?.message_thread_id) {
    console.error(`[TOPICS] création impossible pour lead ${lead.id}: ${res.description ?? "?"}`);
    return null;
  }

  const threadId = res.result.message_thread_id;
  getDb().prepare(`
    UPDATE nexa_leads
    SET admin_topic_chat_id = ?, admin_thread_id = ?, admin_topic_name = ?,
        admin_topic_closed = 0, admin_topic_last_at = datetime('now'),
        admin_card_message_id = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(chat, threadId, name, lead.id);

  await postContextCard({ ...lead, admin_thread_id: threadId, admin_topic_chat_id: chat }, chat);
  console.log(`[TOPICS] topic ${threadId} créé pour lead ${lead.id} (${name})`);
  return threadId;
}

/** Premier post du topic : la carte contexte, épinglée. */
async function postContextCard(lead: TopicLead, chat: string) {
  const res = await tg<{ message_id: number }>("sendMessage", {
    chat_id: chat,
    message_thread_id: lead.admin_thread_id,
    text: buildContextCard(lead),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  if (!res.ok || !res.result?.message_id) return;

  getDb().prepare(`UPDATE nexa_leads SET admin_card_message_id = ? WHERE id = ?`)
    .run(res.result.message_id, lead.id);

  // L'épinglage demande `can_pin_messages` ; s'il manque, la carte reste le premier
  // message du topic — dégradation acceptable, on ne bloque rien pour ça.
  await tg("pinChatMessage", {
    chat_id: chat, message_id: res.result.message_id, disable_notification: true,
  });
}

// ── Envoi dans le topic ───────────────────────────────────

const CLOSED_RE = /topic_closed|topic is closed/i;
const GONE_RE = /thread not found|topic_deleted|message thread not found/i;

/**
 * Poste dans le topic du lead, avec rattrapage des deux pannes réelles :
 * topic fermé (on rouvre) et topic supprimé côté Telegram (on recrée).
 *
 * `deferred` remonte à l'appelant qu'il ne faut pas considérer le message comme
 * relayé.
 */
export async function sendInTopic(
  leadId: number,
  method: "sendMessage" | "copyMessage" | "editMessageText",
  body: Record<string, any>,
): Promise<TgResult<{ message_id: number }> & { deferred?: boolean; threadId?: number | null }> {
  const chat = adminChatId();

  const ensured = await ensureLeadTopic(leadId);
  if (ensured.deferred) return { ok: false, deferred: true, description: "topic en attente de création" };

  // Mode plat ASSUMÉ (Sujets non activés) : aucun message_thread_id, comportement
  // d'avant la bascule. Jamais atteint quand le chat est un forum — sans quoi le
  // message tomberait dans General.
  if (ensured.flat) return { ...(await tg(method, { ...body, chat_id: chat })), threadId: null };

  const threadId = ensured.threadId;
  if (threadId === null) return { ok: false, deferred: true, description: "aucun sujet disponible" };

  const lead = getTopicLead(leadId);
  if (lead?.admin_topic_closed === 1) await reopenTopic(leadId, chat, threadId);

  // `editMessageText` cible un message précis : pas de message_thread_id à injecter.
  const withThread = method === "editMessageText" ? body : { ...body, message_thread_id: threadId };
  let res = await tg<{ message_id: number }>(method, { ...withThread, chat_id: chat });
  if (res.ok) { touchTopic(leadId); return { ...res, threadId }; }

  const desc = res.description ?? "";

  if (CLOSED_RE.test(desc)) {
    await reopenTopic(leadId, chat, threadId);
    res = await tg<{ message_id: number }>(method, { ...withThread, chat_id: chat });
    if (res.ok) { touchTopic(leadId); return { ...res, threadId }; }
  }

  if (GONE_RE.test(desc)) {
    console.warn(`[TOPICS] topic ${threadId} introuvable pour lead ${leadId} — recréation`);
    getDb().prepare(
      `UPDATE nexa_leads SET admin_thread_id = NULL, admin_card_message_id = NULL WHERE id = ?`
    ).run(leadId);
    const again = await ensureLeadTopic(leadId);
    if (again.deferred || again.threadId === null) {
      return { ok: false, deferred: again.deferred, description: "topic recréé indisponible" };
    }
    // Une édition ne survit pas à la recréation : le message visé n'existe plus.
    if (method === "editMessageText") return { ok: false, threadId: again.threadId, description: desc };
    res = await tg<{ message_id: number }>(method, { ...body, chat_id: chat, message_thread_id: again.threadId });
    if (res.ok) { touchTopic(leadId); return { ...res, threadId: again.threadId }; }
  }

  return { ...res, threadId };
}

async function reopenTopic(leadId: number, chat: string, threadId: number) {
  const res = await tg("reopenForumTopic", { chat_id: chat, message_thread_id: threadId });
  // « TOPIC_NOT_MODIFIED » = déjà ouvert : le flag DB était simplement en retard.
  if (res.ok || /not_modified/i.test(res.description ?? "")) {
    getDb().prepare(`UPDATE nexa_leads SET admin_topic_closed = 0 WHERE id = ?`).run(leadId);
  }
}

/** Marque le topic vivant — c'est ce qui décale la fermeture automatique à 30 j. */
export function touchTopic(leadId: number) {
  getDb().prepare(
    `UPDATE nexa_leads SET admin_topic_last_at = datetime('now') WHERE id = ?`
  ).run(leadId);
}

// ── Routage inverse : thread -> lead ──────────────────────

export function resolveLeadIdFromThread(chatId: string | number, threadId: number): number | null {
  const row = getDb().prepare(
    `SELECT id FROM nexa_leads WHERE admin_topic_chat_id = ? AND admin_thread_id = ?`
  ).get(String(chatId), threadId) as { id: number } | undefined;
  return row?.id ?? null;
}

// ── Synchronisation à l'avancement d'étape ────────────────

/**
 * Renomme le topic, met à jour son icône et rafraîchit la carte épinglée.
 * Appelé en « fire and forget » depuis recordMilestone() : un échec de cosmétique
 * ne doit jamais faire échouer une transition d'étape.
 */
export async function syncTopicForStage(leadId: number): Promise<void> {
  const lead = getTopicLead(leadId);
  if (!lead?.admin_thread_id) return;
  const chat = String(lead.admin_topic_chat_id ?? "");
  if (!chat) return;

  const name = topicNameFor(lead);
  if (name !== lead.admin_topic_name) {
    const iconId = await iconIdFor(lead.stage);
    const res = await tg("editForumTopic", {
      chat_id: chat, message_thread_id: lead.admin_thread_id, name,
      ...(iconId ? { icon_custom_emoji_id: iconId } : {}),
    });
    if (res.ok) {
      getDb().prepare(`UPDATE nexa_leads SET admin_topic_name = ? WHERE id = ?`).run(name, leadId);
    } else if (GONE_RE.test(res.description ?? "")) {
      // Topic supprimé : on oublie la référence, le prochain message en recréera un.
      getDb().prepare(
        `UPDATE nexa_leads SET admin_thread_id = NULL, admin_card_message_id = NULL WHERE id = ?`
      ).run(leadId);
      return;
    }
  }

  // La carte épinglée est ÉDITÉE, pas repostée : une carte obsolète en tête de
  // topic est pire que pas de carte, et un nouveau post ne serait pas épinglé.
  if (lead.admin_card_message_id) {
    await tg("editMessageText", {
      chat_id: chat, message_id: lead.admin_card_message_id,
      text: buildContextCard(lead), parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }
}

// ── Hygiène : fermeture des topics inactifs ───────────────

/**
 * Ferme les topics sans activité depuis 30 jours. Rien n'est supprimé : la
 * conversation reste consultable, et le premier message du lead rouvre le topic
 * (cf. sendInTopic).
 */
export async function closeIdleTopics(): Promise<{ closed: number; errors: number }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, admin_topic_chat_id AS chat, admin_thread_id AS thread
    FROM nexa_leads
    WHERE admin_thread_id IS NOT NULL
      AND admin_topic_closed = 0
      AND COALESCE(admin_topic_last_at, '') < datetime('now', ?)
  `).all(`-${TOPIC_IDLE_CLOSE_DAYS} days`) as Array<{ id: number; chat: string; thread: number }>;

  let closed = 0, errors = 0;
  for (const r of rows) {
    const res = await tg("closeForumTopic", { chat_id: r.chat, message_thread_id: r.thread });
    if (res.ok || /not_modified/i.test(res.description ?? "")) {
      db.prepare(`UPDATE nexa_leads SET admin_topic_closed = 1 WHERE id = ?`).run(r.id);
      closed++;
    } else if (GONE_RE.test(res.description ?? "")) {
      // Déjà supprimé côté Telegram : on nettoie la référence, ce n'est pas une erreur.
      db.prepare(`UPDATE nexa_leads SET admin_thread_id = NULL, admin_card_message_id = NULL WHERE id = ?`).run(r.id);
    } else {
      errors++;
    }
    await new Promise(r2 => setTimeout(r2, 120));
  }
  return { closed, errors };
}
