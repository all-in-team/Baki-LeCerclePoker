// Reprise en main humaine du bot funnel — « live takeover ».
//
// Le bot Nexa est scripté : hors scénario, il répondait une phrase générique et
// la question du lead disparaissait. Ce module ajoute la couche manquante :
//
//   lead ──DM──> bot ──relais──> topic du chat admin ──> bot ──DM──> lead
//
// Côté lead c'est TOUJOURS le bot qui parle : jamais de forward, jamais de nom
// d'opérateur, jamais de mention du back-office. C'est la contrainte structurante
// de tout ce fichier — voir replyToLead().
//
// Depuis la bascule Sujets, chaque lead a son topic dans le chat admin (cf.
// lib/funnels/live-takeover-topics.ts). Écrire dans un topic suffit à répondre :
// plus besoin de « Répondre ». relay_map reste le filet pour les leads d'avant.
//
// Tables :
//   • bot_messages  — l'historique complet, entrant ET sortant, takeover ou pas.
//   • relay_map     — admin_message_id -> lead_id (fallback de résolution + salves).
//   • telegram_updates — dédoublonnage des updates rejoués par Telegram.
//
// Ce module ne dépend PAS de lib/nexa-funnel.ts (qui, lui, l'importe) : il lit
// `nexa_leads` en direct. Sans ça, cycle d'import à la compilation.
import { getDb } from "@/lib/db";
import {
  adminChatId, esc, isServiceMessage, tg, type TgResult,
} from "@/lib/funnels/telegram-api";
import {
  ensureLeadTopic, mentionPrefix, resolveLeadIdFromThread, sendInTopic, touchTopic,
} from "@/lib/funnels/live-takeover-topics";

export { adminChatId, esc };

// ── Paramètres ────────────────────────────────────────────

/** Toute réponse d'opérateur pousse le takeover à now + 6 h. */
export const TAKEOVER_HOURS = 6;
/** Salve : plusieurs messages du même lead dans cette fenêtre = UN seul post admin. */
export const RELAY_SALVE_SECONDS = 60;
/** Au-delà, plus personne ne répond à un vieux post : la ligne relay_map est purgée. */
export const RELAY_MAP_RETENTION_DAYS = 30;
/** Un update rejoué l'est dans la minute ; 24 h de mémoire est déjà très large. */
const UPDATE_DEDUP_RETENTION_HOURS = 24;
/** Leads traités par passe de drain — borne le temps d'un tick de cron. */
const DRAIN_BATCH = 50;
/**
 * Au-delà, le silence ne protège plus rien : le bot reprend la main.
 *
 * SAUF si un opérateur a déjà répondu au moins une fois (first_operator_reply_at) —
 * là une vraie conversation est en cours et le bot ne doit pas s'y inviter.
 */
export const AWAITING_EXPIRY_MINUTES = 90;
/**
 * Paliers de rappel opérateur, en minutes. UN rappel par palier, jamais un toutes
 * les N minutes : `question_nudge_level` mémorise le dernier palier franchi.
 */
export const QUESTION_NUDGE_MINUTES = [15, 60];
/** Au-delà, un récapitulatif est posté dans General en plus des rappels par sujet. */
export const QUESTION_RECAP_THRESHOLD = 3;

// ── Types ─────────────────────────────────────────────────

export type LeadLite = {
  id: number;
  tg_user_id: number;
  tg_username: string | null;
  first_name: string | null;
  source: string;
  stage: string;
  member_id: string | null;
  blocked: number;
  notes: string | null;
  takeover_until: string | null;
  takeover_by: string | null;
  relances_off: number;
  /** Non NULL = le bot se tait. EXPIRE à 90 min si aucun opérateur n'a jamais répondu. */
  awaiting_human_since: string | null;
  /** Non NULL = une question du lead reste sans réponse. N'expire pas. */
  question_open_since: string | null;
  /** Première réponse d'un opérateur — verrou anti-reprise du bot. */
  first_operator_reply_at: string | null;
  /** Dernier palier de rappel franchi (0 = aucun, 1 = 15 min, 2 = 60 min). */
  question_nudge_level: number;
  admin_topic_chat_id: string | null;
  admin_thread_id: number | null;
  last_relayed_msg_id: number;
};

export type MsgKind = "text" | "photo" | "document" | "voice" | "video" | "audio" | "sticker" | "other";

export type BotMessage = {
  id: number;
  lead_id: number;
  direction: "in" | "out";
  /** 'lead' | 'bot_auto' | 'operator:<nom>' */
  sender: string;
  kind: string;
  text: string | null;
  telegram_message_id: number | null;
  created_at: string;
};

const LEAD_COLS = `id, tg_user_id, tg_username, first_name, source, stage, member_id,
  blocked, notes, takeover_until, takeover_by, relances_off, awaiting_human_since,
  question_open_since, first_operator_reply_at, question_nudge_level,
  admin_topic_chat_id, admin_thread_id, last_relayed_msg_id`;

// ── Utilitaires ───────────────────────────────────────────

/** UTC au format SQLite — même référentiel que datetime('now'). */
function nowSql(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export function leadLabel(lead: Pick<LeadLite, "tg_username" | "first_name" | "tg_user_id">): string {
  const handle = lead.tg_username ? `@${lead.tg_username}` : null;
  if (lead.first_name && handle) return `${lead.first_name} / ${handle}`;
  return handle ?? lead.first_name ?? `tg:${lead.tg_user_id}`;
}

/**
 * Lien cliquable vers le sujet d'un lead — utilisé par les alertes de General et
 * par le panneau du back-office. `null` si le lead n'a pas (encore) de sujet.
 */
export function topicLink(lead: Pick<LeadLite, "admin_thread_id" | "admin_topic_chat_id">): string | null {
  if (!lead.admin_thread_id || !lead.admin_topic_chat_id) return null;
  const s = String(lead.admin_topic_chat_id);
  if (!s.startsWith("-100")) return null;
  return `https://t.me/c/${s.slice(4)}/${lead.admin_thread_id}`;
}

// ── Accès DB ──────────────────────────────────────────────

export function getLeadById(leadId: number): LeadLite | undefined {
  return getDb().prepare(`SELECT ${LEAD_COLS} FROM nexa_leads WHERE id = ?`).get(leadId) as LeadLite | undefined;
}

export function getLeadByTgId(tgId: number): LeadLite | undefined {
  return getDb().prepare(`SELECT ${LEAD_COLS} FROM nexa_leads WHERE tg_user_id = ?`).get(tgId) as LeadLite | undefined;
}

/** Takeover actif = un humain a RÉPONDU, il a la main sur ce lead pour 6 h. */
export function isTakeoverActive(lead: Pick<LeadLite, "takeover_until"> | undefined | null): boolean {
  if (!lead?.takeover_until) return false;
  return lead.takeover_until > nowSql();
}

export function isTakeoverActiveFor(leadId: number): boolean {
  const row = getDb().prepare(`SELECT takeover_until FROM nexa_leads WHERE id = ?`).get(leadId) as
    { takeover_until: string | null } | undefined;
  return isTakeoverActive(row);
}

/**
 * Le bot doit-il se taire sur ce lead ?
 *
 * DEUX raisons, et il fallait les deux. `takeover_until` ne couvre que l'après :
 * il n'est armé qu'à la première réponse d'opérateur. Sur le tout premier texte
 * libre d'un lead, il est donc encore NULL — et c'est exactement là que le bot
 * répondait par-dessus la conversation humaine (incident @jokerhehee du 04/08).
 * `awaiting_human_since`, posé dès que le lead réclame un humain, ferme ce trou.
 */
export function isLeadMuted(
  lead: Pick<LeadLite, "takeover_until" | "awaiting_human_since"> | undefined | null,
): boolean {
  if (!lead) return false;
  return isTakeoverActive(lead) || lead.awaiting_human_since !== null;
}

export function isLeadMutedFor(leadId: number): boolean {
  const row = getDb().prepare(
    `SELECT takeover_until, awaiting_human_since FROM nexa_leads WHERE id = ?`).get(leadId) as
    Pick<LeadLite, "takeover_until" | "awaiting_human_since"> | undefined;
  return isLeadMuted(row);
}

/** Idem à partir du telegram_id — utilisé par les boucles de relance. */
export function isLeadMutedForTgId(tgId: number): boolean {
  const row = getDb().prepare(
    `SELECT takeover_until, awaiting_human_since FROM nexa_leads WHERE tg_user_id = ?`).get(tgId) as
    Pick<LeadLite, "takeover_until" | "awaiting_human_since"> | undefined;
  return isLeadMuted(row);
}

/**
 * « Ce lead attend un humain » — le bot se tait jusqu'à ce qu'un opérateur réponde
 * ou lance /bot. N'arme PAS `takeover_until` : le lead n'a pas encore parlé, rien
 * ne justifie de bloquer les relances pour 6 h. Idempotent (le premier horodatage
 * fait foi, un second clic ne réinitialise pas l'attente).
 */
export function setAwaitingHuman(leadId: number): void {
  getDb().prepare(
    `UPDATE nexa_leads
     SET awaiting_human_since = COALESCE(awaiting_human_since, datetime('now')),
         question_open_since  = COALESCE(question_open_since, datetime('now')),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(leadId);
}

/** Réponse d'opérateur ou /bot : le lead n'attend plus rien, la question est close. */
export function clearAwaitingHuman(leadId: number): void {
  getDb().prepare(
    `UPDATE nexa_leads SET awaiting_human_since = NULL, question_open_since = NULL,
       question_nudge_level = 0, updated_at = datetime('now')
     WHERE id = ? AND (awaiting_human_since IS NOT NULL OR question_open_since IS NOT NULL)`
  ).run(leadId);
}

/**
 * Le bot reprend la main faute de réponse — mais la question, elle, RESTE ouverte :
 * `question_open_since` n'est pas touché. Qu'un scénario ait redémarré ne veut pas
 * dire que quelqu'un a répondu au lead ; il doit rester dans « À répondre ».
 */
function releaseAwaitingOnly(leadId: number): void {
  getDb().prepare(
    `UPDATE nexa_leads SET awaiting_human_since = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(leadId);
}

/**
 * Leads dont le silence a assez duré. Le filtre `first_operator_reply_at IS NULL`
 * est LE garde-fou : dès qu'un humain a répondu une fois, le bot ne reprend jamais
 * la main tout seul.
 */
export function listExpiredAwaiting(): Array<{ id: number; awaiting_human_since: string }> {
  return getDb().prepare(`
    SELECT id, awaiting_human_since
    FROM nexa_leads
    WHERE awaiting_human_since IS NOT NULL
      AND first_operator_reply_at IS NULL
      AND blocked = 0
      AND relances_off = 0
      AND awaiting_human_since <= datetime('now', ?)
    ORDER BY awaiting_human_since
    LIMIT 50
  `).all(`-${AWAITING_EXPIRY_MINUTES} minutes`) as Array<{ id: number; awaiting_human_since: string }>;
}

/**
 * Lève le silence et trace la reprise dans le sujet. L'ENVOI du message doux au
 * lead appartient au funnel (il connaît la copy et l'étape) — d'où le callback :
 * ce module ne parle jamais la langue du lead.
 */
export async function expireAwaitingHuman(
  leadId: number,
  resume: (leadId: number) => Promise<void>,
): Promise<boolean> {
  const lead = getLeadById(leadId);
  if (!lead || !lead.awaiting_human_since) return false;
  // Re-vérification au moment d'agir : entre la sélection et ici, un opérateur a pu
  // répondre. Le coût d'un doublon de lecture est nul face à celui d'une coupure.
  if (lead.first_operator_reply_at) return false;

  releaseAwaitingOnly(leadId);
  try {
    await resume(leadId);
  } catch (e: any) {
    console.error(`[TAKEOVER] reprise du bot échouée (lead=${leadId}):`, e?.message ?? e);
  }
  logEvent(leadId, `${AWAITING_EXPIRY_MINUTES} min sans réponse — le bot a repris la main`);
  await postAnchoredNotice(leadId,
    `🤖 <b>${AWAITING_EXPIRY_MINUTES} min sans réponse</b> — le bot a repris la main\n` +
    `<i>La question reste ouverte : le lead est toujours dans « À répondre ».</i>`,
  ).catch(() => {});
  return true;
}

/**
 * Journal du lead. Écrit en direct plutôt que via logNexaEvent() : ce module est
 * importé PAR nexa-funnel, l'importer en retour créerait un cycle.
 */
function logEvent(leadId: number, payload: string, kind: "admin" | "question" = "admin") {
  try {
    getDb().prepare(
      `INSERT INTO nexa_lead_events (lead_id, kind, stage, payload, actor)
       VALUES (?, ?, (SELECT stage FROM nexa_leads WHERE id = ?), ?, 'admin')`
    ).run(leadId, kind, leadId, payload);
  } catch (e: any) {
    console.error(`[TAKEOVER] logEvent failed (lead=${leadId}):`, e?.message ?? e);
  }
}

// ── Historique de conversation ────────────────────────────

/**
 * Persiste un message. `telegram_message_id` + direction 'in' est couvert par un
 * index UNIQUE partiel : un update rejoué n'insère rien et retourne null, ce qui
 * suffit à ne jamais relayer deux fois le même message lead.
 */
export function logBotMessage(m: {
  leadId: number;
  direction: "in" | "out";
  sender: string;
  text: string | null;
  kind?: MsgKind;
  telegramMessageId?: number | null;
}): number | null {
  try {
    const info = getDb().prepare(
      `INSERT OR IGNORE INTO bot_messages (lead_id, direction, sender, kind, text, telegram_message_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(m.leadId, m.direction, m.sender, m.kind ?? "text", m.text, m.telegramMessageId ?? null);
    return info.changes > 0 ? Number(info.lastInsertRowid) : null;
  } catch (e: any) {
    console.error(`[TAKEOVER] logBotMessage failed (lead=${m.leadId}):`, e?.message ?? e);
    return null;
  }
}

export function getConversation(leadId: number, limit = 300): BotMessage[] {
  const rows = getDb().prepare(
    `SELECT * FROM bot_messages WHERE lead_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
  ).all(leadId, limit) as BotMessage[];
  return rows.reverse();
}

/**
 * Éteint la pastille « non lu ». Le curseur est posé sur le DERNIER entrant existant
 * au moment de la lecture, pas sur l'horloge : un message qui arrive pendant que le
 * panneau s'ouvre reçoit un id supérieur et reste donc non lu.
 */
export function markConversationRead(leadId: number) {
  getDb().prepare(
    `UPDATE nexa_leads
     SET last_read_msg_id = (SELECT COALESCE(MAX(id), 0) FROM bot_messages
                             WHERE lead_id = ? AND direction = 'in')
     WHERE id = ?`
  ).run(leadId, leadId);
}

// ── Idempotence des updates Telegram ──────────────────────

/**
 * true = update déjà traité, l'appelant doit s'arrêter là.
 *
 * Telegram rejoue un update quand le webhook dépasse son délai de réponse — c'est
 * la cause documentée des doubles créations de groupe de ce repo. Le garde-fou est
 * ici global : aucun traitement n'a jamais besoin d'être rejoué à l'identique.
 */
export function isDuplicateUpdate(updateId: unknown): boolean {
  if (typeof updateId !== "number" || !Number.isFinite(updateId)) return false;
  try {
    const db = getDb();
    const info = db.prepare(`INSERT OR IGNORE INTO telegram_updates (update_id) VALUES (?)`).run(updateId);
    if (info.changes === 0) return true;
    // Purge opportuniste (1 chance sur 50) — pas de cron dédié pour une table jetable.
    if (updateId % 50 === 0) {
      db.prepare(
        `DELETE FROM telegram_updates WHERE created_at < datetime('now', ?)`
      ).run(`-${UPDATE_DEDUP_RETENTION_HOURS} hours`);
    }
    return false;
  } catch (e: any) {
    // Table absente / DB verrouillée : on préfère un doublon possible à un update perdu.
    console.error("[TAKEOVER] dedup update failed:", e?.message ?? e);
    return false;
  }
}

// ── Réactions ─────────────────────────────────────────────

/**
 * ✅ n'appartient pas au jeu de réactions gratuites de Telegram sur tous les chats ;
 * 👍 en fait toujours partie. On tente le vert demandé, on retombe sur le pouce
 * plutôt que de laisser l'opérateur sans accusé de réception.
 */
async function reactOk(chatId: string, messageId: number) {
  for (const emoji of ["✅", "👍"]) {
    const r = await tg("setMessageReaction", {
      chat_id: chatId, message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
    });
    if (r.ok) return;
  }
}

// ── Envoi vers le lead — LE chemin unique ─────────────────

export type ReplyResult = { ok: boolean; error?: string; messageId?: number };

/**
 * Envoie au lead et journalise. Utilisé par la réponse Telegram ET par le panneau
 * du back-office : même fonction, même effet sur takeover_until (§5 du brief).
 *
 * `copyFrom` relaie un média SANS en-tête « transféré de » — c'est ce qui permet
 * de renvoyer photo / document / voix en gardant l'illusion que le bot parle.
 * sendMessage pour le texte : copyMessage y ajouterait la mise en forme d'origine.
 */
export async function replyToLead(opts: {
  leadId: number;
  operator: string;
  text?: string;
  copyFrom?: { chatId: string | number; messageId: number; kind: MsgKind; caption?: string | null };
}): Promise<ReplyResult> {
  const lead = getLeadById(opts.leadId);
  if (!lead) return { ok: false, error: "Lead introuvable" };

  const sender = `operator:${opts.operator}`;
  let res: TgResult<{ message_id: number }>;
  let kind: MsgKind = "text";
  let logged: string | null;

  if (opts.copyFrom) {
    kind = opts.copyFrom.kind;
    logged = opts.copyFrom.caption?.trim() || `[${kind}]`;
    res = await tg("copyMessage", {
      chat_id: lead.tg_user_id,
      from_chat_id: opts.copyFrom.chatId,
      message_id: opts.copyFrom.messageId,
    });
  } else {
    const text = (opts.text ?? "").trim();
    if (!text) return { ok: false, error: "Message vide" };
    logged = text;
    res = await tg("sendMessage", { chat_id: lead.tg_user_id, text, parse_mode: "HTML" });
  }

  if (!res.ok) {
    // 403 = le lead a bloqué le bot. C'est le seul cas où l'opérateur doit changer
    // de canal, donc le seul qui mérite un message d'erreur explicite plutôt qu'un
    // code HTTP. Le flag `blocked` sort aussi le lead des relances.
    if (res.error_code === 403) {
      getDb().prepare(`UPDATE nexa_leads SET blocked = 1, updated_at = datetime('now') WHERE id = ?`).run(lead.id);
      return { ok: false, error: "Le lead a bloqué le bot — impossible de lui écrire. Il est flagué 🚫 dans le back-office." };
    }
    if (res.error_code === 400 && /chat not found/i.test(res.description ?? "")) {
      return { ok: false, error: "Chat introuvable — le lead n'a jamais démarré de conversation avec le bot." };
    }
    return { ok: false, error: `Telegram : ${res.description ?? "erreur inconnue"}` };
  }

  const messageId = res.result?.message_id;
  logBotMessage({
    leadId: lead.id, direction: "out", sender, kind,
    text: logged, telegramMessageId: messageId ?? null,
  });
  bumpTakeover(lead.id, opts.operator);
  // L'attente est levée : un humain vient de répondre, c'est précisément ce que le
  // lead attendait. Le silence scripté est désormais porté par takeover_until.
  clearAwaitingHuman(lead.id);
  return { ok: true, messageId };
}

/** Toute réponse d'opérateur repousse la main humaine à now + 6 h. */
export function bumpTakeover(leadId: number, operator: string) {
  getDb().prepare(
    `UPDATE nexa_leads
     SET takeover_until = datetime('now', ?), takeover_by = ?,
         -- Posé UNE fois, jamais réécrit : c'est la preuve qu'une vraie conversation
         -- humaine a eu lieu, et donc le verrou qui interdit au bot de reprendre la
         -- main tout seul sur ce lead.
         first_operator_reply_at = COALESCE(first_operator_reply_at, datetime('now')),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(`+${TAKEOVER_HOURS} hours`, operator, leadId);
}

// ── Relais lead → chat admin ──────────────────────────────

/** Nature d'un message entrant + le texte à afficher dans le post admin. */
export function describeIncoming(msg: any): { kind: MsgKind; text: string } {
  if (typeof msg?.text === "string") return { kind: "text", text: msg.text };
  const caption: string = msg?.caption ?? "";
  if (msg?.photo) return { kind: "photo", text: caption || "[photo]" };
  if (msg?.voice) return { kind: "voice", text: caption || "[message vocal]" };
  if (msg?.video || msg?.video_note) return { kind: "video", text: caption || "[vidéo]" };
  if (msg?.audio) return { kind: "audio", text: caption || "[audio]" };
  if (msg?.sticker) return { kind: "sticker", text: msg.sticker.emoji ? `[sticker ${msg.sticker.emoji}]` : "[sticker]" };
  if (msg?.document) return { kind: "document", text: caption || `[document ${msg.document.file_name ?? ""}`.trim() + "]" };
  return { kind: "other", text: caption || "[message non textuel]" };
}

function relayHeader(lead: LeadLite): string {
  const bits = [
    `<b>${esc(leadLabel(lead))}</b>`,
    `<code>${esc(lead.stage)}</code>`,
    `src <code>${esc(lead.source)}</code>`,
  ];
  if (lead.member_id) bits.push(`ID <code>${esc(lead.member_id)}</code>`);
  return bits.join(" · ");
}

/**
 * Corps d'un post de relais.
 *
 * Dans un topic, l'en-tête est déjà porté par la carte contexte épinglée : le
 * répéter à chaque message noierait la conversation. En mode plat (Sujets non
 * activés) il reste indispensable pour savoir de qui l'on parle.
 */
function relayBody(lead: LeadLite, texts: string[], withHeader: boolean): string {
  const body = texts.map(t => esc(t)).join("\n");
  return withHeader ? `${relayHeader(lead)}\n———\n${body}` : body;
}

/**
 * Capture d'un message entrant : persistance + relais.
 *
 * Retourne `takeoverActive` pour que l'appelant sache s'il doit couper le scénario
 * (le bot se tait pendant qu'un humain a la main) et `duplicate` si Telegram a
 * rejoué l'update — auquel cas rien n'est reposté.
 */
export async function captureLeadInbound(msg: any): Promise<
  { lead: LeadLite; muted: boolean; duplicate: boolean } | null
> {
  const fromId: number | undefined = msg?.from?.id;
  if (!fromId || msg?.from?.is_bot) return null;
  const lead = getLeadByTgId(fromId);
  if (!lead) return null;

  const muted = isLeadMuted(lead);
  const { kind, text } = describeIncoming(msg);

  const inserted = logBotMessage({
    leadId: lead.id, direction: "in", sender: "lead", kind, text,
    telegramMessageId: msg?.message_id ?? null,
  });
  if (inserted === null) return { lead, muted, duplicate: true };

  getDb().prepare(
    `UPDATE nexa_leads
     SET last_lead_msg_at = strftime('%Y-%m-%d %H:%M:%f','now'),
         last_interaction_at = datetime('now'), blocked = 0, updated_at = datetime('now')
     WHERE id = ?`
  ).run(lead.id);

  await relayPendingForLead(lead.id).catch(e =>
    console.error(`[TAKEOVER] relais admin échoué (lead=${lead.id}):`, e?.message ?? e));

  return { lead, muted, duplicate: false };
}

/** Un relais à la fois par lead — deux messages simultanés ne doivent pas se doubler. */
const leadRelayQueues = new Map<number, Promise<unknown>>();
function perLead<T>(leadId: number, fn: () => Promise<T>): Promise<T> {
  const prev = leadRelayQueues.get(leadId) ?? Promise.resolve();
  // `.then(fn, fn)` : un relais en échec ne doit pas bloquer les suivants.
  const next = prev.then(fn, fn);
  const tail = next.then(() => undefined, () => undefined);
  leadRelayQueues.set(leadId, tail);
  // L'entrée est libérée quand plus rien n'attend derrière — sinon la Map croîtrait
  // d'une entrée par lead pour la durée de vie du process.
  void tail.then(() => { if (leadRelayQueues.get(leadId) === tail) leadRelayQueues.delete(leadId); });
  return next;
}

export type RelayOutcome = { posted: number; deferred: boolean };

/**
 * Relaie tout ce qui n'a pas encore été posté pour ce lead.
 *
 * Le curseur `last_relayed_msg_id` n'avance qu'APRÈS un post réussi : c'est ce qui
 * rend la perte d'un message structurellement impossible. Un rate limit sur la
 * création du topic, un topic supprimé, une coupure réseau — dans tous les cas le
 * travail reste en attente et `drainPendingRelays()` le reprend au tick suivant.
 *
 * Regroupement par salve : si un post existe pour ce lead depuis moins de 60 s, on
 * l'ÉDITE avec l'ensemble des messages de la salve au lieu d'en créer un second.
 * La borne basse de la salve est un id de message (`relay_map.from_msg_id`), pas
 * une heure : reconstruire une salve ne dépend d'aucune horloge.
 */
export function relayPendingForLead(leadId: number): Promise<RelayOutcome> {
  return perLead(leadId, () => relayPendingInner(leadId));
}

async function relayPendingInner(leadId: number): Promise<RelayOutcome> {
  const db = getDb();
  const lead = getLeadById(leadId);
  if (!lead) return { posted: 0, deferred: false };

  const pending = db.prepare(
    `SELECT id, kind, text, telegram_message_id FROM bot_messages
     WHERE lead_id = ? AND direction = 'in' AND id > ?
     ORDER BY id`
  ).all(leadId, lead.last_relayed_msg_id ?? 0) as
    Array<{ id: number; kind: string; text: string | null; telegram_message_id: number | null }>;
  if (pending.length === 0) return { posted: 0, deferred: false };

  // Le topic est créé AVANT le post : si la création est différée (rate limit), on
  // sort sans toucher au curseur — rien n'est perdu, tout est repris plus tard.
  const ensured = await ensureLeadTopic(leadId);
  if (ensured.deferred) {
    console.warn(`[TAKEOVER] relais différé pour lead ${leadId} — ${pending.length} message(s) en attente`);
    return { posted: 0, deferred: true };
  }
  // En mode plat, chaque post doit reporter l'en-tête du lead ; dans un sujet, la
  // carte épinglée le fait déjà une fois pour toutes.
  const inTopic = !ensured.flat;
  const chat = adminChatId();

  const anchor = db.prepare(
    `SELECT admin_message_id, from_msg_id FROM relay_map
     WHERE admin_chat_id = ? AND lead_id = ? AND from_msg_id IS NOT NULL
       AND created_at > datetime('now', ?)
     ORDER BY created_at DESC, admin_message_id DESC LIMIT 1`
  ).get(chat, leadId, `-${RELAY_SALVE_SECONDS} seconds`) as
    { admin_message_id: number; from_msg_id: number } | undefined;

  let ok = false;
  if (anchor) {
    // Salve en cours : on reconstruit le post avec tous les entrants depuis l'ancre.
    const salve = db.prepare(
      `SELECT text FROM bot_messages
       WHERE lead_id = ? AND direction = 'in' AND id >= ?
       ORDER BY id`
    ).all(leadId, anchor.from_msg_id) as { text: string | null }[];
    const texts = salve.map(r => r.text ?? "").filter(Boolean);
    const edited = await sendInTopic(leadId, "editMessageText", {
      message_id: anchor.admin_message_id,
      text: relayBody(lead, texts, !inTopic),
      parse_mode: "HTML",
    });
    ok = edited.ok;
    if (edited.deferred) return { posted: 0, deferred: true };
    // Édition impossible (post supprimé, contenu identique…) → on crée un post neuf.
  }

  if (!ok) {
    const texts = pending.map(p => p.text ?? "").filter(Boolean);
    // Mention des opérateurs sur le PREMIER post d'une salve seulement — jamais sur
    // les éditions qui la complètent. C'est ce qui fait sonner le téléphone dans un
    // groupe en mode Sujets, où un nouveau sujet ne notifie personne ; la coller sur
    // chaque message transformerait le sujet en machine à notifications.
    const mention = await mentionPrefix();
    const posted = await sendInTopic(leadId, "sendMessage", {
      text: mention + relayBody(lead, texts.length ? texts : ["[message vide]"], !inTopic),
      parse_mode: "HTML",
      disable_notification: false,
    });
    if (posted.deferred) return { posted: 0, deferred: true };
    if (!posted.ok) {
      console.error(`[TAKEOVER] post admin impossible (lead=${leadId}) : ${posted.description}`);
      return { posted: 0, deferred: true };
    }
    if (posted.result?.message_id) {
      mapAdminMessage(chat, posted.result.message_id, leadId, pending[0].id);
    }
  }

  // Les médias ne s'éditent pas dans un post texte : chacun est copié à part, et
  // reçoit sa propre ligne relay_map pour rester répondable en mode plat.
  for (const p of pending) {
    if (p.kind === "text" || !p.telegram_message_id) continue;
    const copied = await sendInTopic(leadId, "copyMessage", {
      from_chat_id: lead.tg_user_id, message_id: p.telegram_message_id,
    });
    if (copied.ok && copied.result?.message_id) {
      mapAdminMessage(chat, copied.result.message_id, leadId, p.id);
    } else if (!copied.deferred) {
      // Le texte/libellé du média est déjà dans le post : on n'immobilise pas le
      // curseur pour une copie ratée, sinon un média expiré bloquerait tout le lead.
      console.error(`[TAKEOVER] copie média échouée (lead=${leadId}, msg=${p.id}) : ${copied.description}`);
    }
  }

  const maxId = pending[pending.length - 1].id;
  db.prepare(`UPDATE nexa_leads SET last_relayed_msg_id = ? WHERE id = ? AND last_relayed_msg_id < ?`)
    .run(maxId, leadId, maxId);
  return { posted: pending.length, deferred: false };
}

/**
 * Reprise des relais restés en attente (rate limit, topic indisponible, panne).
 * Appelé par le cron : c'est le filet qui rend la promesse « aucun message perdu »
 * vraie même quand Telegram refuse de coopérer pendant un moment.
 */
export async function drainPendingRelays(): Promise<{ leads: number; posted: number; deferred: number }> {
  const rows = getDb().prepare(`
    SELECT l.id
    FROM nexa_leads l
    JOIN (SELECT lead_id, MAX(id) AS mx FROM bot_messages WHERE direction = 'in' GROUP BY lead_id) m
      ON m.lead_id = l.id
    WHERE m.mx > l.last_relayed_msg_id
    ORDER BY l.id
    LIMIT ?
  `).all(DRAIN_BATCH) as Array<{ id: number }>;

  let posted = 0, deferred = 0;
  for (const r of rows) {
    try {
      const out = await relayPendingForLead(r.id);
      posted += out.posted;
      if (out.deferred) deferred++;
    } catch (e: any) {
      console.error(`[TAKEOVER] drain lead ${r.id} :`, e?.message ?? e);
      deferred++;
    }
    await new Promise(res => setTimeout(res, 120));
  }
  return { leads: rows.length, posted, deferred };
}

export function mapAdminMessage(chatId: string, messageId: number, leadId: number, fromMsgId?: number) {
  getDb().prepare(
    `INSERT OR REPLACE INTO relay_map (admin_chat_id, admin_message_id, lead_id, from_msg_id)
     VALUES (?, ?, ?, ?)`
  ).run(chatId, messageId, leadId, fromMsgId ?? null);
}

export function resolveLeadFromAdminMessage(chatId: string | number, messageId: number): LeadLite | undefined {
  const row = getDb().prepare(
    `SELECT lead_id FROM relay_map WHERE admin_chat_id = ? AND admin_message_id = ?`
  ).get(String(chatId), messageId) as { lead_id: number } | undefined;
  return row ? getLeadById(row.lead_id) : undefined;
}

// ── Notifications ─────────────────────────────────────────

/**
 * Alerte SYSTÈME — postée dans « General », jamais dans un topic de lead (§3 du
 * brief). C'est le seul contenu qui a le droit d'y aller : erreurs d'envoi,
 * configuration manquante, incidents.
 */
export async function postSystemAlert(text: string): Promise<void> {
  await tg("sendMessage", {
    chat_id: adminChatId(), text, parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

/** Message posté dans le topic du lead (ou à plat si les Sujets sont désactivés). */
async function postForLead(leadId: number, text: string, replyTo?: number, notify = false) {
  return sendInTopic(leadId, "sendMessage", {
    text, parse_mode: "HTML",
    // Explicite : dans un sujet, un post sans mention ET sans son passe totalement
    // inaperçu. `false` est le défaut de l'API, on l'écrit quand même là où la
    // notification EST l'objectif.
    ...(notify ? { disable_notification: false } : {}),
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  });
}

/**
 * Signal qui n'est pas un message entrant (clic « J'ai une question »…), posté dans
 * le topic du lead. L'opérateur peut répondre directement dans le topic — et, pour
 * les leads restés en mode plat, la ligne relay_map garde le « Répondre » utilisable.
 * `body` est du HTML Telegram déjà sûr — à l'appelant de l'échapper.
 */
export async function postAnchoredNotice(
  leadId: number, body: string, withCta = false, withMention = false,
): Promise<void> {
  const lead = getLeadById(leadId);
  if (!lead) return;
  const inTopic = lead.admin_thread_id !== null;
  // L'invite dépend du mode : dans un sujet on écrit simplement dedans, à plat il
  // faut passer par « Répondre ». Une invite fausse coûte un aller-retour à chaque
  // fois qu'on la lit.
  const cta = !withCta ? "" : inTopic
    ? `\n<i>Écris ici → le lead reçoit ta réponse du bot.</i>`
    : `\n<i>Réponds à ce message → le lead reçoit ta réponse du bot.</i>`;
  const head = inTopic ? "" : `${relayHeader(lead)}\n———\n`;
  const mention = withMention ? await mentionPrefix() : "";
  const res = await postForLead(leadId, `${mention}${head}${body}${cta}`, undefined, withMention);
  if (res.ok && res.result?.message_id) {
    mapAdminMessage(adminChatId(), res.result.message_id, leadId);
  }
}

/**
 * Ligne discrète quand le lead clique un bouton alors que le bot est muselé
 * (takeover en cours OU attente d'un humain) : le scénario lui répond quand même
 * — un lead qui pilote lui-même ne doit pas rester sans réponse (choix Hugo) —
 * donc l'opérateur doit voir ce qui vient de partir sans avoir à le deviner.
 *
 * Seuls les CLICS passent ; le texte libre, lui, est silencieux (cf. isLeadMuted).
 */
export async function notifyAutoReplyWhileMuted(leadId: number, buttonLabel: string) {
  const lead = getLeadById(leadId);
  if (!lead || !isLeadMuted(lead)) return;
  const who = lead.admin_thread_id ? "Le lead" : `<b>${esc(leadLabel(lead))}</b>`;
  await postForLead(leadId, `→ ${who} a cliqué « ${esc(buttonLabel)} » · le bot a répondu automatiquement`)
    .catch(() => {});
}

// ── Commandes du chat admin ───────────────────────────────

/** /bot — rend la main au scénario immédiatement. */
export function handoverToBot(leadId: number, operator: string): { ok: boolean; error?: string } {
  const lead = getLeadById(leadId);
  if (!lead) return { ok: false, error: "Lead introuvable" };
  getDb().prepare(
    `UPDATE nexa_leads SET takeover_until = NULL, awaiting_human_since = NULL,
       updated_at = datetime('now') WHERE id = ?`
  ).run(leadId);
  logEvent(leadId, `takeover rendu au bot par ${operator}`);
  return { ok: true };
}

/** /stop — plus AUCUNE relance sur ce lead, définitivement. */
export function stopRelances(leadId: number, operator: string): { ok: boolean; error?: string } {
  const lead = getLeadById(leadId);
  if (!lead) return { ok: false, error: "Lead introuvable" };
  getDb().prepare(
    `UPDATE nexa_leads SET relances_off = 1, updated_at = datetime('now') WHERE id = ?`
  ).run(leadId);
  logEvent(leadId, `relances désactivées définitivement par ${operator}`);
  return { ok: true };
}

/** /note <texte> — append dans les notes internes, horodaté. Rien n'est écrasé. */
export function appendNote(leadId: number, note: string, operator: string): { ok: boolean; error?: string } {
  const lead = getLeadById(leadId);
  if (!lead) return { ok: false, error: "Lead introuvable" };
  const clean = note.trim();
  if (!clean) return { ok: false, error: "Note vide" };
  const stamp = nowSql().slice(0, 16);
  const line = `[${stamp} · ${operator}] ${clean}`;
  const merged = lead.notes ? `${lead.notes}\n${line}` : line;
  getDb().prepare(`UPDATE nexa_leads SET notes = ?, updated_at = datetime('now') WHERE id = ?`).run(merged, leadId);
  logEvent(leadId, `note : ${clean.slice(0, 120)}`);
  return { ok: true };
}

/** Nom lisible de l'opérateur, pour `sender` et pour les notes. */
export function operatorName(from: any): string {
  return from?.username ? `@${from.username}`
    : [from?.first_name, from?.last_name].filter(Boolean).join(" ") || `tg:${from?.id ?? "?"}`;
}

/**
 * Résolution du lead visé par un message du chat admin.
 *
 * 1. Le TOPIC. C'est le chemin principal : écrire dans le sujet d'un lead suffit,
 *    plus besoin de « Répondre ».
 * 2. relay_map, en repli — leads créés avant la bascule Sujets, médias copiés, et
 *    messages du topic General répondus à l'ancienne.
 *
 * Retourne `null` si le message ne concerne aucun lead : le chat admin reste
 * utilisable pour autre chose, et General n'est jamais confondu avec un lead.
 */
function resolveAdminTarget(msg: any): LeadLite | undefined {
  const chatId = msg?.chat?.id;
  // `is_topic_message` distingue un vrai sujet de forum d'un simple fil de réponses
  // (les groupes de discussion liés à un canal exposent aussi message_thread_id).
  if (msg?.is_topic_message === true && typeof msg?.message_thread_id === "number") {
    const leadId = resolveLeadIdFromThread(chatId, msg.message_thread_id);
    if (leadId) return getLeadById(leadId);
  }
  const replyTo = msg?.reply_to_message?.message_id;
  if (replyTo) return resolveLeadFromAdminMessage(chatId, replyTo);
  return undefined;
}

/**
 * Point d'entrée du chat admin. Retourne true si le message a été consommé.
 *
 * Dans un topic de lead, TOUT message d'opérateur part vers le lead : c'est le
 * cœur de la bascule Sujets. Hors topic (General) et hors relay_map, rien n'est
 * consommé — le chat reste utilisable normalement.
 */
export async function handleAdminChatMessage(msg: any): Promise<boolean> {
  const chatId = msg?.chat?.id;
  if (String(chatId) !== adminChatId()) return false;
  if (msg?.from?.is_bot) return false;
  // Créations de topic, épinglages… : du bruit de service, jamais du contenu.
  if (isServiceMessage(msg)) return false;

  const lead = resolveAdminTarget(msg);
  if (!lead) return false;

  const operator = operatorName(msg.from);
  const raw: string = (msg.text ?? msg.caption ?? "").trim();
  const cmd = raw.split(/\s+/)[0]?.toLowerCase() ?? "";
  const replyTo = msg.message_id;

  touchTopic(lead.id);

  // ── Commandes ──
  if (cmd === "/bot") {
    const r = handoverToBot(lead.id, operator);
    await postForLead(lead.id, r.ok
      ? `🤖 <b>${esc(leadLabel(lead))}</b> — la main est rendue au scénario automatique.`
      : `❌ ${esc(r.error ?? "Erreur")}`, replyTo);
    return true;
  }
  if (cmd === "/stop") {
    const r = stopRelances(lead.id, operator);
    await postForLead(lead.id, r.ok
      ? `🔕 <b>${esc(leadLabel(lead))}</b> — relances désactivées définitivement.`
      : `❌ ${esc(r.error ?? "Erreur")}`, replyTo);
    return true;
  }
  if (cmd === "/note") {
    const r = appendNote(lead.id, raw.slice(cmd.length), operator);
    await postForLead(lead.id, r.ok
      ? `📝 Note ajoutée sur <b>${esc(leadLabel(lead))}</b>.`
      : `❌ ${esc(r.error ?? "Erreur")}`, replyTo);
    return true;
  }
  // Une commande inconnue n'est pas relayée au lead : mieux vaut un message
  // d'erreur qu'un « /truc » envoyé tel quel à un prospect.
  if (cmd.startsWith("/")) {
    await postForLead(lead.id,
      `❓ Commande inconnue <code>${esc(cmd)}</code> — dispo : /bot · /stop · /note &lt;texte&gt;`, replyTo);
    return true;
  }

  // ── Réponse au lead ──
  const { kind } = describeIncoming(msg);
  const res = kind === "text"
    ? await replyToLead({ leadId: lead.id, operator, text: raw })
    : await replyToLead({
        leadId: lead.id, operator,
        copyFrom: { chatId, messageId: msg.message_id, kind, caption: msg.caption ?? null },
      });

  if (res.ok) {
    await reactOk(adminChatId(), msg.message_id);
  } else {
    // Les échecs d'envoi sont des alertes système : elles vont dans General (§3),
    // avec un lien vers le topic concerné pour ne pas perdre le contexte.
    const link = topicLink(lead);
    await postSystemAlert(
      `❌ Envoi impossible à <b>${esc(leadLabel(lead))}</b> — ${esc(res.error ?? "erreur inconnue")}` +
      (link ? `\n→ <a href="${link}">ouvrir le sujet</a>` : "")
    );
  }
  return true;
}

// ── Entretien ─────────────────────────────────────────────

// ── Rappels opérateur ─────────────────────────────────────

export type PendingQuestion = {
  id: number;
  question_open_since: string;
  question_nudge_level: number;
  waited_min: number;
  label: string;
};

/** Leads dont la question est ouverte, avec leur temps d'attente en minutes. */
export function listOpenQuestions(): PendingQuestion[] {
  const rows = getDb().prepare(`
    SELECT id, question_open_since, question_nudge_level,
           CAST((julianday('now') - julianday(question_open_since)) * 1440 AS INTEGER) AS waited_min,
           tg_username, first_name, tg_user_id
    FROM nexa_leads
    WHERE question_open_since IS NOT NULL AND blocked = 0
    ORDER BY question_open_since
  `).all() as Array<PendingQuestion & { tg_username: string | null; first_name: string | null; tg_user_id: number }>;
  return rows.map(r => ({ ...r, label: leadLabel(r) }));
}

function setNudgeLevel(leadId: number, level: number) {
  getDb().prepare(
    `UPDATE nexa_leads SET question_nudge_level = ?, updated_at = datetime('now')
     WHERE id = ? AND question_nudge_level < ?`
  ).run(level, leadId, level);
}

/**
 * Rappelle à l'opérateur les questions restées sans réponse.
 *
 * Un rappel par PALIER (15 min puis 60 min), jamais un toutes les N minutes : le
 * niveau franchi est mémorisé, donc une passe qui repasse sur le même lead ne
 * reposte rien. La reprise du bot à 90 min ne ferme pas le rappel — le critère est
 * `question_open_since`, qui n'expire pas : le scénario a beau avoir redémarré,
 * personne n'a répondu au lead.
 */
export async function runQuestionNudges(): Promise<{ nudged: number; waiting: number }> {
  const open = listOpenQuestions();
  if (open.length === 0) return { nudged: 0, waiting: 0 };

  let nudged = 0;
  for (const q of open) {
    // Palier atteint = le plus haut seuil franchi ; on ne notifie que s'il dépasse
    // ce qui a déjà été envoyé.
    let level = 0;
    for (let i = 0; i < QUESTION_NUDGE_MINUTES.length; i++) {
      if (q.waited_min >= QUESTION_NUDGE_MINUTES[i]) level = i + 1;
    }
    if (level <= q.question_nudge_level) continue;

    setNudgeLevel(q.id, level);
    await postAnchoredNotice(q.id,
      `⏳ <b>sans réponse depuis ${q.waited_min} min</b>\n` +
      `<i>Réponds ici, ou /bot pour rendre la main au scénario.</i>`,
      false, true,
    ).catch(() => {});
    nudged++;
    await new Promise(r => setTimeout(r, 150));
  }

  // Récapitulatif dans General — uniquement quand un palier vient d'être franchi.
  // Le poster à chaque passe produirait un message toutes les 5 min tant qu'une file
  // existe ; ici il ne sort que lorsqu'il s'est réellement passé quelque chose.
  if (nudged > 0 && open.length > QUESTION_RECAP_THRESHOLD) {
    const lines = open
      .slice(0, 10)
      .map(q => `• <b>${esc(q.label)}</b> — ${q.waited_min} min`)
      .join("\n");
    const extra = open.length > 10 ? `\n<i>…et ${open.length - 10} autre(s).</i>` : "";
    await postSystemAlert(
      `⏳ <b>${open.length} leads attendent une réponse</b>\n${lines}${extra}`
    ).catch(() => {});
  }

  return { nudged, waiting: open.length };
}

/** Compteur « À répondre » du back-office — non lus OU questions ouvertes. */
export function countNeedsReply(): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n
    FROM nexa_leads l
    LEFT JOIN (SELECT lead_id, MAX(CASE WHEN direction = 'in' THEN id END) AS last_in_id
               FROM bot_messages GROUP BY lead_id) m ON m.lead_id = l.id
    WHERE COALESCE(m.last_in_id, 0) > l.last_read_msg_id
       OR l.question_open_since IS NOT NULL
  `).get() as { n: number };
  return row.n;
}

// ── Entretien ─────────────────────────────────────────────

/** Purge des entrées relay_map de plus de 30 jours (cron quotidien). */
export function purgeRelayMap(): { deleted: number } {
  const info = getDb().prepare(
    `DELETE FROM relay_map WHERE created_at < datetime('now', ?)`
  ).run(`-${RELAY_MAP_RETENTION_DAYS} days`);
  return { deleted: info.changes };
}
