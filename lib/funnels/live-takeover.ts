// Reprise en main humaine du bot funnel — « live takeover ».
//
// Le bot Nexa est scripté : hors scénario, il répondait une phrase générique et
// la question du lead disparaissait. Ce module ajoute la couche manquante :
//
//   lead ──DM──> bot ──relais──> chat admin ──« Répondre »──> bot ──DM──> lead
//
// Côté lead c'est TOUJOURS le bot qui parle : jamais de forward, jamais de nom
// d'opérateur, jamais de mention du back-office. C'est la contrainte structurante
// de tout ce fichier — voir sendToLead().
//
// Trois tables (migration add_live_takeover_v1) :
//   • bot_messages  — l'historique complet, entrant ET sortant, takeover ou pas.
//   • relay_map     — admin_message_id -> lead_id, ce qui rend « Répondre » résolvable.
//   • telegram_updates — dédoublonnage des updates rejoués par Telegram.
//
// Ce module ne dépend PAS de lib/nexa-funnel.ts (qui, lui, l'importe) : il lit
// `nexa_leads` en direct. Sans ça, cycle d'import à la compilation.
import { getDb } from "@/lib/db";
import { AGENT_CHAT_ID } from "@/lib/telegram-commands/helpers";

// ── Paramètres ────────────────────────────────────────────

/** Toute réponse d'opérateur pousse le takeover à now + 6 h. */
export const TAKEOVER_HOURS = 6;
/** Salve : plusieurs messages du même lead dans cette fenêtre = UN seul post admin. */
export const RELAY_SALVE_SECONDS = 60;
/** Au-delà, plus personne ne répond à un vieux post : la ligne relay_map est purgée. */
export const RELAY_MAP_RETENTION_DAYS = 30;
/** Un update rejoué l'est dans la minute ; 24 h de mémoire est déjà très large. */
const UPDATE_DEDUP_RETENTION_HOURS = 24;

/**
 * Chat Telegram où atterrissent les messages des leads.
 *
 * Repli sur AGENT_CHAT_ID plutôt que sur rien : une variable oubliée doit dégrader
 * (relais au mauvais endroit, visible immédiatement) et non faire disparaître les
 * questions en silence — c'est exactement le bug que cette feature corrige.
 */
export function adminChatId(): string {
  const id = process.env.ADMIN_CHAT_ID?.trim();
  if (id) return id;
  console.warn("[TAKEOVER] ADMIN_CHAT_ID non défini — repli sur AGENT_TELEGRAM_CHAT_ID. Voir docs/LIVE_TAKEOVER.md");
  return AGENT_CHAT_ID;
}

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
  blocked, notes, takeover_until, takeover_by, relances_off`;

// ── Utilitaires ───────────────────────────────────────────

/** UTC au format SQLite — même référentiel que datetime('now'). */
function nowSql(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function leadLabel(lead: Pick<LeadLite, "tg_username" | "first_name" | "tg_user_id">): string {
  const handle = lead.tg_username ? `@${lead.tg_username}` : null;
  if (lead.first_name && handle) return `${lead.first_name} / ${handle}`;
  return handle ?? lead.first_name ?? `tg:${lead.tg_user_id}`;
}

// ── Accès DB ──────────────────────────────────────────────

export function getLeadById(leadId: number): LeadLite | undefined {
  return getDb().prepare(`SELECT ${LEAD_COLS} FROM nexa_leads WHERE id = ?`).get(leadId) as LeadLite | undefined;
}

export function getLeadByTgId(tgId: number): LeadLite | undefined {
  return getDb().prepare(`SELECT ${LEAD_COLS} FROM nexa_leads WHERE tg_user_id = ?`).get(tgId) as LeadLite | undefined;
}

/** Takeover actif = un humain a la main sur ce lead, là, maintenant. */
export function isTakeoverActive(lead: Pick<LeadLite, "takeover_until"> | undefined | null): boolean {
  if (!lead?.takeover_until) return false;
  return lead.takeover_until > nowSql();
}

export function isTakeoverActiveFor(leadId: number): boolean {
  const row = getDb().prepare(`SELECT takeover_until FROM nexa_leads WHERE id = ?`).get(leadId) as
    { takeover_until: string | null } | undefined;
  return isTakeoverActive(row);
}

/** Idem à partir du telegram_id — utilisé par les boucles de relance. */
export function isTakeoverActiveForTgId(tgId: number): boolean {
  const row = getDb().prepare(`SELECT takeover_until FROM nexa_leads WHERE tg_user_id = ?`).get(tgId) as
    { takeover_until: string | null } | undefined;
  return isTakeoverActive(row);
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

// ── API Telegram ──────────────────────────────────────────

type TgResult<T = any> = { ok: boolean; result?: T; error_code?: number; description?: string };

async function tg<T = any>(method: string, body: Record<string, any>): Promise<TgResult<T>> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, description: "TELEGRAM_BOT_TOKEN absent" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as TgResult<T>;
    if (!json.ok) console.error(`[TAKEOVER tg:${method}]`, json.error_code, json.description);
    return json;
  } catch (e: any) {
    console.error(`[TAKEOVER tg:${method}] fetch failed:`, e?.message ?? e);
    return { ok: false, description: e?.message ?? String(e) };
  }
}

/**
 * ✅ n'appartient pas au jeu de réactions gratuites de Telegram sur tous les chats ;
 * 👍 en fait toujours partie. On tente le pouce vert demandé, on retombe sur le
 * pouce plutôt que de laisser l'opérateur sans accusé de réception.
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
  return { ok: true, messageId };
}

/** Toute réponse d'opérateur repousse la main humaine à now + 6 h. */
export function bumpTakeover(leadId: number, operator: string) {
  getDb().prepare(
    `UPDATE nexa_leads
     SET takeover_until = datetime('now', ?), takeover_by = ?, updated_at = datetime('now')
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

function relayBody(lead: LeadLite, texts: string[]): string {
  return `${relayHeader(lead)}\n———\n${texts.map(t => esc(t)).join("\n")}`;
}

/**
 * Capture d'un message entrant : persistance + relais vers le chat admin.
 *
 * Retourne `takeoverActive` pour que l'appelant sache s'il doit couper le scénario
 * (le bot se tait pendant qu'un humain a la main) et `duplicate` si Telegram a
 * rejoué l'update — auquel cas rien n'est reposté.
 */
export async function captureLeadInbound(msg: any): Promise<
  { lead: LeadLite; takeoverActive: boolean; duplicate: boolean } | null
> {
  const fromId: number | undefined = msg?.from?.id;
  if (!fromId || msg?.from?.is_bot) return null;
  const lead = getLeadByTgId(fromId);
  if (!lead) return null;

  const takeoverActive = isTakeoverActive(lead);
  const { kind, text } = describeIncoming(msg);

  const inserted = logBotMessage({
    leadId: lead.id, direction: "in", sender: "lead", kind, text,
    telegramMessageId: msg?.message_id ?? null,
  });
  if (inserted === null) return { lead, takeoverActive, duplicate: true };

  getDb().prepare(
    `UPDATE nexa_leads
     SET last_lead_msg_at = strftime('%Y-%m-%d %H:%M:%f','now'),
         last_interaction_at = datetime('now'), blocked = 0, updated_at = datetime('now')
     WHERE id = ?`
  ).run(lead.id);

  await relayToAdmin(lead, msg, kind, text).catch(e =>
    console.error(`[TAKEOVER] relais admin échoué (lead=${lead.id}):`, e?.message ?? e));

  return { lead, takeoverActive, duplicate: false };
}

/**
 * Poste (ou complète) le message du chat admin.
 *
 * Regroupement par salve : si un post existe pour ce lead depuis moins de 60 s, on
 * l'ÉDITE avec l'ensemble des messages de la salve au lieu d'en créer un second —
 * trois messages d'affilée ne doivent pas produire trois notifications. Le post
 * édité reste l'ancre relay_map : « le dernier relay_map fait foi ».
 *
 * Un média ne s'édite pas dans un post texte : il est copié en plus, et sa propre
 * ligne relay_map permet de répondre directement dessus.
 */
async function relayToAdmin(lead: LeadLite, msg: any, kind: MsgKind, text: string) {
  const db = getDb();
  const chat = adminChatId();

  const anchor = db.prepare(
    `SELECT admin_message_id, created_at FROM relay_map
     WHERE admin_chat_id = ? AND lead_id = ? AND created_at > datetime('now', ?)
     ORDER BY created_at DESC LIMIT 1`
  ).get(chat, lead.id, `-${RELAY_SALVE_SECONDS} seconds`) as
    { admin_message_id: number; created_at: string } | undefined;

  if (anchor) {
    // Salve en cours : on reconstruit le post avec tous les entrants depuis l'ancre.
    const salve = db.prepare(
      `SELECT text FROM bot_messages
       WHERE lead_id = ? AND direction = 'in' AND created_at >= ?
       ORDER BY created_at, id`
    ).all(lead.id, anchor.created_at) as { text: string | null }[];
    const texts = salve.map(r => r.text ?? "").filter(Boolean);
    const edited = await tg("editMessageText", {
      chat_id: chat, message_id: anchor.admin_message_id,
      text: relayBody(lead, texts.length ? texts : [text]), parse_mode: "HTML",
    });
    if (edited.ok) {
      // `created_at` n'est PAS rafraîchi : c'est l'horodatage du DÉBUT de la salve.
      // Le rafraîchir ferait glisser la fenêtre à chaque message, et la requête
      // ci-dessus ne ramènerait plus que le dernier — le post perdrait les
      // précédents à chaque édition. La salve dure donc 60 s à partir du premier
      // message, ce qui est exactement la règle du brief.
      if (kind !== "text") await copyMediaToAdmin(lead, msg, chat);
      return;
    }
    // Édition impossible (post supprimé, message identique…) → nouveau post.
  }

  const posted = await tg<{ message_id: number }>("sendMessage", {
    chat_id: chat, text: relayBody(lead, [text]), parse_mode: "HTML",
  });
  if (posted.ok && posted.result?.message_id) {
    mapAdminMessage(chat, posted.result.message_id, lead.id);
  }
  if (kind !== "text") await copyMediaToAdmin(lead, msg, chat);
}

/** Le média du lead lui-même, copié dans le chat admin (et répondable). */
async function copyMediaToAdmin(lead: LeadLite, msg: any, chat: string) {
  if (!msg?.message_id || !msg?.chat?.id) return;
  const copied = await tg<{ message_id: number }>("copyMessage", {
    chat_id: chat, from_chat_id: msg.chat.id, message_id: msg.message_id,
  });
  if (copied.ok && copied.result?.message_id) {
    mapAdminMessage(chat, copied.result.message_id, lead.id);
  }
}

export function mapAdminMessage(chatId: string, messageId: number, leadId: number) {
  getDb().prepare(
    `INSERT OR REPLACE INTO relay_map (admin_chat_id, admin_message_id, lead_id) VALUES (?, ?, ?)`
  ).run(chatId, messageId, leadId);
}

export function resolveLeadFromAdminMessage(chatId: string | number, messageId: number): LeadLite | undefined {
  const row = getDb().prepare(
    `SELECT lead_id FROM relay_map WHERE admin_chat_id = ? AND admin_message_id = ?`
  ).get(String(chatId), messageId) as { lead_id: number } | undefined;
  return row ? getLeadById(row.lead_id) : undefined;
}

// ── Notifications d'appoint ───────────────────────────────

async function postToAdmin(text: string, replyTo?: number) {
  return tg<{ message_id: number }>("sendMessage", {
    chat_id: adminChatId(), text, parse_mode: "HTML",
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  });
}

/**
 * Post admin ANCRÉ sur un lead pour un signal qui n'est pas un message entrant
 * (clic « J'ai une question »…). Même en-tête, même relay_map : l'opérateur peut
 * répondre dessus immédiatement et le lead reçoit la réponse via le bot.
 * `body` est du HTML Telegram déjà sûr — à l'appelant de l'échapper.
 */
export async function postAnchoredNotice(leadId: number, body: string): Promise<void> {
  const lead = getLeadById(leadId);
  if (!lead) return;
  const chat = adminChatId();
  const res = await tg<{ message_id: number }>("sendMessage", {
    chat_id: chat, text: `${relayHeader(lead)}\n———\n${body}`, parse_mode: "HTML",
  });
  if (res.ok && res.result?.message_id) mapAdminMessage(chat, res.result.message_id, leadId);
}

/**
 * Ligne discrète quand le lead clique un bouton PENDANT un takeover : le scénario
 * lui répond quand même (choix Hugo — un lead qui pilote ne doit pas rester sans
 * réponse), donc l'opérateur doit voir ce qui vient de partir sans avoir à deviner.
 */
export async function notifyAutoReplyDuringTakeover(leadId: number, buttonLabel: string) {
  const lead = getLeadById(leadId);
  if (!lead || !isTakeoverActive(lead)) return;
  await postToAdmin(
    `→ <b>${esc(leadLabel(lead))}</b> a cliqué « ${esc(buttonLabel)} » · le bot a répondu automatiquement`
  ).catch(() => {});
}

// ── Commandes du chat admin ───────────────────────────────

/** /bot — rend la main au scénario immédiatement. */
export function handoverToBot(leadId: number, operator: string): { ok: boolean; error?: string } {
  const lead = getLeadById(leadId);
  if (!lead) return { ok: false, error: "Lead introuvable" };
  getDb().prepare(
    `UPDATE nexa_leads SET takeover_until = NULL, updated_at = datetime('now') WHERE id = ?`
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
 * Point d'entrée du chat admin. Retourne true si le message a été consommé.
 *
 * Ne réagit QU'aux messages en réponse à un post relayé : le reste du chat admin
 * (discussion libre, autres bots, agent Claude) est laissé intact.
 */
export async function handleAdminChatMessage(msg: any): Promise<boolean> {
  const chatId = msg?.chat?.id;
  if (String(chatId) !== adminChatId()) return false;
  const replyTo = msg?.reply_to_message?.message_id;
  if (!replyTo) return false;

  const lead = resolveLeadFromAdminMessage(chatId, replyTo);
  if (!lead) return false;

  const operator = operatorName(msg.from);
  const raw: string = (msg.text ?? msg.caption ?? "").trim();
  const cmd = raw.split(/\s+/)[0]?.toLowerCase() ?? "";

  // ── Commandes ──
  if (cmd === "/bot") {
    const r = handoverToBot(lead.id, operator);
    await postToAdmin(r.ok
      ? `🤖 <b>${esc(leadLabel(lead))}</b> — la main est rendue au scénario automatique.`
      : `❌ ${esc(r.error ?? "Erreur")}`, replyTo);
    return true;
  }
  if (cmd === "/stop") {
    const r = stopRelances(lead.id, operator);
    await postToAdmin(r.ok
      ? `🔕 <b>${esc(leadLabel(lead))}</b> — relances désactivées définitivement.`
      : `❌ ${esc(r.error ?? "Erreur")}`, replyTo);
    return true;
  }
  if (cmd === "/note") {
    const r = appendNote(lead.id, raw.slice(cmd.length), operator);
    await postToAdmin(r.ok
      ? `📝 Note ajoutée sur <b>${esc(leadLabel(lead))}</b>.`
      : `❌ ${esc(r.error ?? "Erreur")}`, replyTo);
    return true;
  }
  // Une commande inconnue n'est pas relayée au lead : mieux vaut un message
  // d'erreur qu'un « /truc » envoyé tel quel à un prospect.
  if (cmd.startsWith("/")) {
    await postToAdmin(`❓ Commande inconnue <code>${esc(cmd)}</code> — dispo : /bot · /stop · /note &lt;texte&gt;`, replyTo);
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

  if (res.ok) await reactOk(adminChatId(), msg.message_id);
  else await postToAdmin(`❌ Envoi impossible à <b>${esc(leadLabel(lead))}</b> — ${esc(res.error ?? "erreur inconnue")}`, replyTo);
  return true;
}

// ── Entretien ─────────────────────────────────────────────

/** Purge des entrées relay_map de plus de 30 jours (cron quotidien). */
export function purgeRelayMap(): { deleted: number } {
  const info = getDb().prepare(
    `DELETE FROM relay_map WHERE created_at < datetime('now', ?)`
  ).run(`-${RELAY_MAP_RETENTION_DAYS} days`);
  return { deleted: info.changes };
}
