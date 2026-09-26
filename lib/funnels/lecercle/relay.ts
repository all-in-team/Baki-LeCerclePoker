// Relais des réponses aux diffusions vers le groupe Support (live takeover hors Nexa).
//
// ┌─ CE QUE FAIT CE MODULE ────────────────────────────────────────────────────┐
// │ Un compte HORS nexa_leads qui écrit au bot en privé dans la fenêtre d'une  │
// │ diffusion (72 h après le plus tardif de : réception de la diffusion,       │
// │ dernière réponse de l'opérateur) :                                         │
// │   • son message est stocké, puis recopié dans SON sujet du groupe Support  │
// │     (créé au premier message, carte contexte épinglée) ;                   │
// │   • le webhook s'arrête là : ni scénario de funnel ni « Envoie /start ».   │
// │ Un message posté par l'opérateur dans ce sujet lui est envoyé (texte       │
// │ simple, ou média recopié). /bot clôt le relais, /note annote.              │
// │                                                                            │
// │ Un lead Nexa qui répond à une diffusion : son silence est armé             │
// │ (setAwaitingHuman) et mémorisé dans lecercle_nexa_holds — le relais Nexa   │
// │ existant fait le reste, et ce silence n'expire pas au bout de 90 min.      │
// │                                                                            │
// │ Exception : un lead dont le parcours (QQPK étape 2, Nexa étape de l'ID)    │
// │ attend son ID joueur, et qui l'envoie : ce message-là va au parcours, ni   │
// │ relayé ni mis en silence. Tout autre message suit la règle générale.       │
// │ Hors périmètre : les commandes (/start…) s'exécutent normalement, jamais   │
// │ relayées ; les clics de boutons ne sont pas des messages.                  │
// └────────────────────────────────────────────────────────────────────────────┘

import { randomBytes } from "crypto";
import { getDb } from "@/lib/db";
import { adminChatId as defaultAdminChatId, esc, isServiceMessage } from "@/lib/funnels/telegram-api";
import { tgRetrying, type TgResult } from "./tg";
// Mêmes règles que les parcours eux-mêmes, importées plutôt que recopiées.
import { NEXA_STAGE_ORDER } from "@/lib/funnels/nexa/config";
import { QQPK_MEMBER_ID_RE } from "@/lib/qqpk-funnel";
import type { DbLike } from "./audience";
import { REPLY_WINDOW_HOURS } from "./tracking";

// ── Dépendances injectables ───────────────────────────────

export interface RelayDeps {
  db?: DbLike;
  tg?: (method: string, body: Record<string, any>) => Promise<TgResult<any>>;
  adminChat?: string;
  /** Le chat admin est-il un forum ? `null` = inconnu → on diffère. */
  isForum?: (chat: string) => Promise<boolean | null>;
  /** Lead Nexa pour ce telegram_id (le relais Nexa s'en occupe alors). */
  nexaLeadId?: (telegramId: number) => number | null;
  /** Arme le silence Nexa (setAwaitingHuman). */
  armNexa?: (leadId: number) => void;
}

interface Resolved {
  db: DbLike;
  tg: (method: string, body: Record<string, any>) => Promise<TgResult<any>>;
  adminChat: string;
  isForum: (chat: string) => Promise<boolean | null>;
  nexaLeadId: (telegramId: number) => number | null;
  armNexa: (leadId: number) => void;
}

async function resolve(d: RelayDeps = {}): Promise<Resolved> {
  const db = d.db ?? getDb();
  return {
    db,
    tg: d.tg ?? tgRetrying,
    adminChat: d.adminChat ?? defaultAdminChatId(),
    isForum: d.isForum ?? (async (chat) => (await import("@/lib/funnels/live-takeover-topics")).adminChatIsForum(chat)),
    nexaLeadId: d.nexaLeadId ?? ((tg) => {
      const r = db.prepare(`SELECT id FROM nexa_leads WHERE tg_user_id = ?`).get(tg) as { id: number } | undefined;
      return r?.id ?? null;
    }),
    armNexa: d.armNexa ?? (await import("@/lib/funnels/live-takeover")).setAwaitingHuman,
  };
}

// ── Fenêtre ───────────────────────────────────────────────

function sqlTime(unixSeconds: unknown): string {
  const n = typeof unixSeconds === "number" && Number.isFinite(unixSeconds) ? unixSeconds * 1000 : Date.now();
  return new Date(n).toISOString().slice(0, 19).replace("T", " ");
}

/** Coupe à `n` points de code : jamais un emoji coupé en deux (Telegram refuse un demi-surrogate). */
export function cut(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length <= n ? s : cps.slice(0, n).join("");
}

export interface RelayWindow {
  open: boolean;
  /** Dernière diffusion reçue avant `at` (peut être hors fenêtre). */
  broadcastId: number | null;
  receivedAt: string | null;
}

/**
 * La fenêtre de relais d'un compte à l'instant `at` (UTC, format SQLite).
 *
 * Ancre = le plus tardif de : dernière diffusion reçue, datée à sa RÉSERVATION
 * (claimed_at, juste avant l'envoi — sent_at n'est écrit qu'après la réponse de
 * Telegram, et une réponse très rapide du destinataire serait sinon datée AVANT
 * lui) ; et dernière réponse de l'opérateur
 * dans le sujet. Ouverte si l'ancre a moins de 72 h, et si le fil n'a pas été
 * clos (/bot) APRÈS l'ancre.
 *
 * `withOperator = false` pour les leads Nexa : leurs réponses d'opérateur vivent
 * dans le relais Nexa, seule la réception d'une diffusion compte.
 */
export function relayWindow(telegramId: number, at: string, dbOverride?: DbLike, withOperator = true): RelayWindow {
  const db = dbOverride ?? getDb();
  const bc = db.prepare(
    `SELECT broadcast_id, COALESCE(claimed_at, sent_at) AS ts
       FROM lecercle_broadcast_targets
      WHERE telegram_id = ? AND status IN ('sent','unknown')
        AND COALESCE(claimed_at, sent_at) IS NOT NULL AND COALESCE(claimed_at, sent_at) <= ?
      ORDER BY ts DESC, id DESC LIMIT 1`
  ).get(telegramId, at) as { broadcast_id: number; ts: string } | undefined;

  const th = db.prepare(
    `SELECT last_operator_reply_at, closed_at FROM lecercle_dm_threads WHERE telegram_id = ?`
  ).get(telegramId) as { last_operator_reply_at: string | null; closed_at: string | null } | undefined;

  const candidates = [bc?.ts ?? null, withOperator ? th?.last_operator_reply_at ?? null : null]
    .filter((x): x is string => !!x && x <= at);
  if (!candidates.length) return { open: false, broadcastId: bc?.broadcast_id ?? null, receivedAt: bc?.ts ?? null };
  const anchor = candidates.sort().at(-1)!;

  const floor = (db.prepare(`SELECT datetime(?, ?) AS f`).get(at, `-${REPLY_WINDOW_HOURS} hours`) as { f: string }).f;
  const closedAfter = withOperator && th?.closed_at && th.closed_at >= anchor;
  return {
    open: anchor >= floor && !closedAfter,
    broadcastId: bc?.broadcast_id ?? null,
    receivedAt: bc?.ts ?? null,
  };
}

// ── Exceptions : un ID joueur attendu par un parcours ─────

/**
 * Un lead dont le parcours ATTEND son ID joueur, et qui l'envoie, doit tomber sur
 * le parcours : lui seul sait l'enregistrer. Pour ce message-là (et lui seul) :
 * ni relais ni silence. Tout autre message — « je trouve pas mon ID » compris —
 * suit la règle générale, donc arrive dans le sujet de l'opérateur.
 * (Décisions Hugo 2026-09-26 : A, puis 1 et 2 de la contre-expertise.)
 */
function textOf(msg: any): string | null {
  return typeof msg?.text === "string" ? msg.text.trim() : null;
}

/** QQPK étape 2, et le texte a la forme d'un ID QQPK (même règle que le parcours). */
function isQqpkIdAttempt(telegramId: number, msg: any, db: DbLike): boolean {
  const text = textOf(msg);
  if (text === null || !QQPK_MEMBER_ID_RE.test(text)) return false;
  try {
    return !!db.prepare(`SELECT 1 FROM qqpk_funnel_leads WHERE telegram_id = ? AND stage = 2`).get(telegramId);
  } catch {
    return false; // table absente : aucun lead QQPK
  }
}

/**
 * Lead Nexa à l'étape de l'ID (pas encore d'ID, étape ≥ app_installed) qui envoie
 * des chiffres : même test que le parcours Nexa (atIdStage && looksLikeIdAttempt).
 */
function isNexaIdAttempt(leadId: number, msg: any, db: DbLike): boolean {
  const text = textOf(msg);
  if (text === null || !/^\d+$/.test(text)) return false;
  try {
    const lead = db.prepare(`SELECT stage, member_id FROM nexa_leads WHERE id = ?`).get(leadId) as
      { stage: string; member_id: string | null } | undefined;
    if (!lead || lead.member_id) return false;
    const order = NEXA_STAGE_ORDER as Record<string, number>;
    return (order[lead.stage] ?? -1) >= order.app_installed;
  } catch {
    return false;
  }
}

// ── Nexa : armer le silence ───────────────────────────────

/**
 * Lead Nexa qui répond à une diffusion dans les 72 h : le bot automatique se tait
 * jusqu'à la réponse de l'opérateur ou /bot. Appelé AVANT la capture Nexa du
 * webhook, qui voit alors le lead « muselé » et coupe le scénario.
 *
 * Retourne true si le silence a été armé.
 */
export async function armNexaHoldIfBroadcastReply(msg: any, deps: RelayDeps = {}): Promise<boolean> {
  if (!isPrivateInbound(msg)) return false;
  const d = await resolve(deps);
  const leadId = d.nexaLeadId(msg.from.id);
  if (!leadId) return false;
  // Seule l'exception Nexa vaut ici. Pour un lead à la fois Nexa et QQPK, la capture
  // Nexa du webhook remet son last_interaction_at à maintenant AVANT le répartiteur
  // des funnels : c'est toujours Nexa qui reçoit le message, jamais QQPK. Épargner
  // le silence ne ferait qu'obtenir une réponse scriptée Nexa et un ID perdu ;
  // silencé, le message arrive dans son sujet Nexa, sous les yeux de l'opérateur.
  if (isNexaIdAttempt(leadId, msg, d.db)) return false;
  const w = relayWindow(msg.from.id, sqlTime(msg.date), d.db, false);
  if (!w.open) return false;

  // UNE fois par diffusion. Sans ça, après /bot ou une réponse de l'opérateur, le
  // message suivant du lead ré-armerait le silence : /bot ne rendrait jamais la main
  // au scénario pendant 72 h (audit, finding 1). Une NOUVELLE diffusion ré-arme.
  const prev = d.db.prepare(`SELECT broadcast_id FROM lecercle_nexa_holds WHERE lead_id = ?`).get(leadId) as
    { broadcast_id: number | null } | undefined;
  if (prev && prev.broadcast_id === w.broadcastId) return false;

  d.armNexa(leadId);
  d.db.prepare(
    `INSERT INTO lecercle_nexa_holds (lead_id, armed_at, broadcast_id) VALUES (?, datetime('now'), ?)
     ON CONFLICT(lead_id) DO UPDATE SET armed_at = excluded.armed_at, broadcast_id = excluded.broadcast_id`
  ).run(leadId, w.broadcastId);
  return true;
}

// ── Entrant hors Nexa ─────────────────────────────────────

/** Message privé d'un humain, qui n'est pas une commande. */
function isPrivateInbound(msg: any): boolean {
  return msg?.chat?.type === "private" && msg?.from && !msg.from.is_bot && typeof msg.from.id === "number"
    && !isServiceMessage(msg)
    && !(typeof msg.text === "string" && msg.text.trimStart().startsWith("/"));
}

export type MsgKind = "text" | "photo" | "voice" | "video" | "audio" | "sticker" | "document" | "other";

export function describe(msg: any): { kind: MsgKind; text: string } {
  if (typeof msg?.text === "string") return { kind: "text", text: msg.text };
  const caption: string = msg?.caption ?? "";
  if (msg?.photo) return { kind: "photo", text: caption || "[photo]" };
  if (msg?.voice) return { kind: "voice", text: caption || "[message vocal]" };
  if (msg?.video || msg?.video_note) return { kind: "video", text: caption || "[vidéo]" };
  if (msg?.audio) return { kind: "audio", text: caption || "[audio]" };
  if (msg?.sticker) return { kind: "sticker", text: msg.sticker.emoji ? `[sticker ${msg.sticker.emoji}]` : "[sticker]" };
  if (msg?.document) return { kind: "document", text: caption || `[document ${msg.document.file_name ?? ""}]`.replace(" ]", "]") };
  return { kind: "other", text: caption || "[message non textuel]" };
}

/**
 * Capture d'un message privé hors Nexa. Retourne true si le message a été PRIS
 * EN CHARGE (stocké, relayé ou en attente de relais) : le webhook doit alors
 * s'arrêter — pas de scénario, pas de « Envoie /start ».
 *
 * false = hors périmètre (Nexa, commande, hors fenêtre) : le webhook continue
 * comme avant. Une erreur de stockage remonte à l'appelant, qui la logge et
 * continue lui aussi : dans le doute, l'ancien comportement.
 */
export async function captureBroadcastReply(msg: any, deps: RelayDeps = {}): Promise<boolean> {
  if (!isPrivateInbound(msg)) return false;
  const d = await resolve(deps);
  const tgId: number = msg.from.id;
  if (d.nexaLeadId(tgId)) return false;
  if (isQqpkIdAttempt(tgId, msg, d.db)) return false;

  const at = sqlTime(msg.date);
  const w = relayWindow(tgId, at, d.db, true);
  if (!w.open) return false;

  // Groupe Support pas en mode Sujets : on ne saurait où relayer. Plutôt que
  // d'avaler le message, on rend la main au webhook (ancien comportement).
  // Statut inconnu (null) : on stocke, le cron relaiera quand il saura.
  if (await d.isForum(d.adminChat) === false) {
    console.error("[LECERCLE RELAY] groupe Support pas en mode Sujets — message rendu au bot, non relayé");
    return false;
  }

  const { kind, text } = describe(msg);
  d.db.transaction(() => {
    d.db.prepare(
      `INSERT INTO lecercle_dm_threads (telegram_id, broadcast_id) VALUES (?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET broadcast_id = COALESCE(excluded.broadcast_id, lecercle_dm_threads.broadcast_id)`
    ).run(tgId, w.broadcastId);
    d.db.prepare(
      `INSERT OR IGNORE INTO lecercle_dm_messages (telegram_id, direction, sender, kind, text, telegram_message_id, broadcast_id)
       VALUES (?, 'in', 'user', ?, ?, ?, ?)`
    ).run(tgId, kind, cut(text, 4000), msg.message_id ?? null, w.broadcastId);
  })();

  // Relais immédiat ; un échec laisse le message en attente pour le cron.
  await relayPending(tgId, deps).catch(e =>
    console.error(`[LECERCLE RELAY] relais différé (tg=${tgId}):`, e?.message ?? e));
  return true;
}

// ── Relais vers le sujet ──────────────────────────────────

const LOCK_SECONDS = 120;
const CLOSED_RE = /topic_closed|topic is closed/i;
const GONE_RE = /thread not found|topic_deleted|message thread not found|TOPIC_ID_INVALID/i;
/** Tours de relecture sous le même verrou : borne un fil qui ne se vide jamais. */
const MAX_ROUNDS = 5;

export interface RelayOutcome { posted: number; deferred: boolean }

/** Verrou du fil tenu par CE relais : renouvelé avant chaque appel Telegram. */
interface Lock { owner: string; renew: () => boolean }
const LOCK_LOST: TgResult<any> = { ok: false, description: "verrou du fil perdu" };

/**
 * Relaie tout ce qui n'a pas été posté pour ce fil, dans l'ordre.
 *
 * Verrou en base par fil, avec PROPRIÉTAIRE : le webhook et le cron (bundles
 * distincts) ne relaient jamais le même fil en même temps ; le verrou est
 * renouvelé avant chaque appel Telegram et n'est libéré que par son détenteur.
 * Le curseur n'avance qu'après un post réussi (ou un repli définitif, cf.
 * postToTopic). Avant de rendre le verrou, on relit : un message arrivé pendant
 * le relais part dans la foulée au lieu d'attendre le cron.
 */
export async function relayPending(telegramId: number, deps: RelayDeps = {}): Promise<RelayOutcome> {
  const d = await resolve(deps);
  const owner = randomBytes(8).toString("hex");
  const got = d.db.prepare(
    `UPDATE lecercle_dm_threads SET relay_lock_until = datetime('now', ?), relay_lock_owner = ?
      WHERE telegram_id = ? AND (relay_lock_until IS NULL OR relay_lock_until < datetime('now'))`
  ).run(`+${LOCK_SECONDS} seconds`, owner, telegramId);
  if (got.changes === 0) return { posted: 0, deferred: true };

  const renew = () => d.db.prepare(
    `UPDATE lecercle_dm_threads SET relay_lock_until = datetime('now', ?)
      WHERE telegram_id = ? AND relay_lock_owner = ? AND relay_lock_until >= datetime('now')`
  ).run(`+${LOCK_SECONDS} seconds`, telegramId, owner).changes === 1;
  const lock: Lock = { owner, renew };

  let posted = 0;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const pending = d.db.prepare(
        `SELECT m.id, m.kind, m.text, m.telegram_message_id
           FROM lecercle_dm_messages m JOIN lecercle_dm_threads t ON t.telegram_id = m.telegram_id
          WHERE m.telegram_id = ? AND m.direction = 'in' AND m.id > t.last_relayed_msg_id
          ORDER BY m.id`
      ).all(telegramId) as Array<{ id: number; kind: MsgKind; text: string | null; telegram_message_id: number | null }>;
      if (!pending.length) return { posted, deferred: false };

      if (!renew()) return { posted, deferred: true };
      let threadId = await ensureTopic(telegramId, d, lock);
      if (threadId === null) return { posted, deferred: true };
      let recreated = false;

      for (const p of pending) {
        // Verrou perdu (appel Telegram trop long) : on s'arrête AVANT de poster,
        // pour ne pas doubler ce qu'un autre relais est peut-être en train d'envoyer.
        if (!renew()) return { posted, deferred: true };
        let res = await postToTopic(telegramId, threadId, p, d, lock);
        // Sujet supprimé côté Telegram (postToTopic l'a oublié) : recréé tout de
        // suite, une fois par passe, plutôt que d'attendre le cron.
        if (!res.ok && GONE_RE.test(res.description ?? "") && !recreated && renew()) {
          recreated = true;
          const again = await ensureTopic(telegramId, d, lock);
          if (again === null) return { posted, deferred: true };
          threadId = again;
          res = await postToTopic(telegramId, threadId, p, d, lock);
        }
        if (!res.ok) return { posted, deferred: true };
        d.db.prepare(`UPDATE lecercle_dm_threads SET last_relayed_msg_id = ? WHERE telegram_id = ? AND last_relayed_msg_id < ?`)
          .run(p.id, telegramId, p.id);
        posted++;
      }
    }
    return { posted, deferred: true };
  } finally {
    d.db.prepare(
      `UPDATE lecercle_dm_threads SET relay_lock_until = NULL, relay_lock_owner = NULL WHERE telegram_id = ? AND relay_lock_owner = ?`
    ).run(telegramId, owner);
  }
}

async function postToTopic(
  telegramId: number, threadId: number,
  p: { kind: MsgKind; text: string | null; telegram_message_id: number | null },
  d: Resolved,
  lock: Lock,
): Promise<TgResult<any>> {
  // Le premier appel est couvert par le renouvellement de l'appelant ; chaque
  // appel suivant (réouverture, second essai, avis de repli) renouvelle d'abord.
  // Verrou perdu → on n'envoie plus rien : un autre relais a peut-être la main.
  const send = () => (p.kind === "text" || !p.telegram_message_id)
    ? d.tg("sendMessage", {
        chat_id: d.adminChat, message_thread_id: threadId,
        text: esc(p.text ?? ""), parse_mode: "HTML", link_preview_options: { is_disabled: true },
      })
    : d.tg("copyMessage", {
        chat_id: d.adminChat, message_thread_id: threadId,
        from_chat_id: telegramId, message_id: p.telegram_message_id,
      });

  let res = await send();
  if (!res.ok && CLOSED_RE.test(res.description ?? "")) {
    if (!lock.renew()) return LOCK_LOST;
    await d.tg("reopenForumTopic", { chat_id: d.adminChat, message_thread_id: threadId });
    if (!lock.renew()) return LOCK_LOST;
    res = await send();
  }
  if (!res.ok && GONE_RE.test(res.description ?? "")) {
    // Sujet supprimé côté Telegram : on l'oublie, le prochain passage en recrée un.
    d.db.prepare(`UPDATE lecercle_dm_threads SET thread_id = NULL, card_message_id = NULL WHERE telegram_id = ?`).run(telegramId);
    return res;
  }
  // Refus DÉFINITIF de ce message-là (400 : média supprimé entre-temps, type non
  // recopiable, texte refusé). Le réessayer bloquerait pour toujours tout ce qui
  // suit (audit, finding 2) : on poste à la place un avis lisible dans le sujet,
  // et le curseur avance. 429, 5xx, réseau : pas définitifs → différé.
  if (!res.ok && res.error_code === 400) {
    const note = `⚠️ <i>${p.kind === "text" ? "Message" : "Média"} non recopiable (${esc(cut(res.description ?? "refus Telegram", 200))})</i>` +
      (p.text ? `\n${esc(cut(p.text, 3500))}` : "");
    if (!lock.renew()) return LOCK_LOST;
    const fallback = await d.tg("sendMessage", {
      chat_id: d.adminChat, message_thread_id: threadId, text: note, parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    if (fallback.ok) return fallback;
  }
  if (!res.ok) console.error(`[LECERCLE RELAY] post refusé (tg=${telegramId}):`, res.error_code, res.description);
  return res;
}

/**
 * Le sujet de ce compte, créé au besoin avec sa carte contexte épinglée.
 * `null` = différé (chat admin pas un forum, statut inconnu, création refusée,
 * verrou perdu) : on ne poste JAMAIS à plat — dans un forum, ça tomberait dans General.
 *
 * Le sujet créé n'est enregistré que si ce relais tient ENCORE le verrou : sinon
 * un autre relais a pu créer le sien entre-temps, et deux sujets pour une même
 * personne feraient perdre les réponses écrites dans le « mauvais ». Le sujet
 * orphelin est alors fermé.
 */
async function ensureTopic(telegramId: number, d: Resolved, lock: Lock): Promise<number | null> {
  const th = d.db.prepare(
    `SELECT admin_chat_id, thread_id FROM lecercle_dm_threads WHERE telegram_id = ?`
  ).get(telegramId) as { admin_chat_id: string | null; thread_id: number | null } | undefined;
  if (th?.thread_id && th.admin_chat_id === d.adminChat) return th.thread_id;

  const forum = await d.isForum(d.adminChat);
  if (forum !== true) {
    if (forum === false) {
      await alertOnce(telegramId, d, lock, `le groupe Support n'est pas en mode Sujets`);
    }
    return null;
  }

  const ctx = contextFor(telegramId, d.db);
  // Coupe au point de code (un emoji coupé en deux ferait refuser la création).
  const name = cut(`📣 ${ctx.name} · ${ctx.sourceShort}`, 120);
  if (!lock.renew()) return null;
  const res = await d.tg("createForumTopic", { chat_id: d.adminChat, name, icon_color: 0xFFD67E });
  const threadId: number | undefined = res.result?.message_thread_id;
  if (!res.ok || !threadId) {
    console.error(`[LECERCLE RELAY] création du sujet impossible (tg=${telegramId}):`, res.error_code, res.description);
    // 400/403 = refus durable (nom, droits du bot) : sans alerte, les messages
    // resteraient stockés sans jamais apparaître. 429, 5xx, réseau : on réessaiera.
    if (res.error_code === 400 || res.error_code === 403) {
      await alertOnce(telegramId, d, lock, `création du sujet refusée (${res.description ?? res.error_code})`);
    }
    return null;
  }

  const saved = d.db.prepare(
    `UPDATE lecercle_dm_threads
        SET admin_chat_id = ?, thread_id = ?, topic_name = ?, card_message_id = NULL, topic_alert_at = NULL
      WHERE telegram_id = ? AND relay_lock_owner = ? AND relay_lock_until >= datetime('now')`
  ).run(d.adminChat, threadId, name, telegramId, lock.owner).changes === 1;
  if (!saved) {
    await d.tg("closeForumTopic", { chat_id: d.adminChat, message_thread_id: threadId });
    return null;
  }

  if (!lock.renew()) return threadId;
  const card = await d.tg("sendMessage", {
    chat_id: d.adminChat, message_thread_id: threadId, text: ctx.card,
    parse_mode: "HTML", link_preview_options: { is_disabled: true },
  });
  if (card.ok && card.result?.message_id) {
    d.db.prepare(`UPDATE lecercle_dm_threads SET card_message_id = ? WHERE telegram_id = ?`).run(card.result.message_id, telegramId);
    // Sans le droit d'épingler, la carte reste le premier message du sujet.
    if (lock.renew()) {
      await d.tg("pinChatMessage", { chat_id: d.adminChat, message_id: card.result.message_id, disable_notification: true });
    }
  }
  return threadId;
}

/**
 * Alerte UNE fois par fil dans General quand des messages ne peuvent pas être
 * relayés durablement. Réarmée dès qu'un sujet est créé avec succès.
 */
async function alertOnce(telegramId: number, d: Resolved, lock: Lock, reason: string): Promise<void> {
  const first = d.db.prepare(
    `UPDATE lecercle_dm_threads SET topic_alert_at = datetime('now') WHERE telegram_id = ? AND topic_alert_at IS NULL`
  ).run(telegramId).changes === 1;
  if (!first || !lock.renew()) return;
  const pending = (d.db.prepare(
    `SELECT COUNT(*) AS n FROM lecercle_dm_messages m JOIN lecercle_dm_threads t USING (telegram_id)
      WHERE m.telegram_id = ? AND m.direction = 'in' AND m.id > t.last_relayed_msg_id`
  ).get(telegramId) as { n: number }).n;
  const ctx = contextFor(telegramId, d.db);
  await d.tg("sendMessage", {
    chat_id: d.adminChat, parse_mode: "HTML", link_preview_options: { is_disabled: true },
    text: `⚠️ <b>Relais des diffusions bloqué</b> pour ${esc(ctx.name)} (<code>${telegramId}</code>) : ${esc(cut(reason, 300))}.\n` +
      `${pending} message(s) en attente, réessayé toutes les 5 min.`,
  });
}

// ── Carte contexte ────────────────────────────────────────

function fmtUtc8(sql: string | null | undefined): string {
  if (!sql) return "—";
  const t = Date.parse(sql.replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return sql;
  const d = new Date(t + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC+8`;
}

/** Nom, source et diffusion reçue — en tête du sujet. */
export function contextFor(telegramId: number, db: DbLike): { name: string; sourceShort: string; card: string } {
  const one = (sql: string) => db.prepare(sql).get(telegramId) as any;
  const u = one(`SELECT username, first_name FROM lecercle_bot_users WHERE telegram_id = ?`);
  const t = one(`SELECT username, first_name FROM lecercle_broadcast_targets WHERE telegram_id = ? ORDER BY id DESC LIMIT 1`);
  const username = (u?.username ?? t?.username ?? "").replace(/^@/, "");
  const first = u?.first_name ?? t?.first_name ?? null;
  const name = username ? `@${username}` : (first || `tg:${telegramId}`);

  const sources: string[] = [];
  const onb = one(`SELECT stage FROM onboarding_leads WHERE telegram_id = ?`);
  if (onb) sources.push(`Onboarding (${onb.stage})`);
  const qq = one(`SELECT stage FROM qqpk_funnel_leads WHERE telegram_id = ?`);
  if (qq) sources.push(`QQPK (étape ${qq.stage})`);
  if (one(`SELECT 1 AS x FROM affiliate_leads WHERE referred_telegram_id = ? LIMIT 1`)) sources.push("Parrainage (ref_)");
  const pl = one(`SELECT id, name FROM players WHERE telegram_id = ? ORDER BY id LIMIT 1`);
  if (pl) sources.push(`Joueur « ${pl.name} » (#${pl.id})`);
  if (!sources.length) sources.push("Autre (vu par le webhook)");
  const sourceShort = sources[0].replace(/ \(.*$/, "").replace(/ «.*$/, "");

  const bc = one(
    `SELECT b.id, b.title, COALESCE(t.sent_at, t.claimed_at) AS at, t.first_click_at, t.status
       FROM lecercle_broadcast_targets t JOIN lecercle_broadcasts b ON b.id = t.broadcast_id
      WHERE t.telegram_id = ? AND t.status IN ('sent','unknown')
      ORDER BY COALESCE(t.sent_at, t.claimed_at) DESC, t.id DESC LIMIT 1`);

  const lines = [
    `📣 <b>Réponse à une diffusion</b>`,
    `<b>${esc(name)}</b>${first && username ? ` (${esc(first)})` : ""} · <code>${telegramId}</code>`,
    `Source : ${esc(sources.join(" · "))}`,
    bc
      ? `Diffusion reçue : #${bc.id} « ${esc(bc.title)} » · ${fmtUtc8(bc.at)}` +
        ` · ${bc.first_click_at ? "a cliqué ✅" : "n'a pas cliqué"}${bc.status === "unknown" ? " · issue d'envoi inconnue" : ""}`
      : `Diffusion reçue : —`,
    ``,
    `<i>Écris ici pour lui répondre (texte simple ou média). /bot = clore le relais · /note &lt;texte&gt;</i>`,
  ];
  return { name, sourceShort, card: lines.join("\n") };
}

// ── Messages de l'opérateur dans un sujet ─────────────────

/**
 * Message posté dans le groupe Support. Traité seulement s'il est dans un sujet
 * de CE module ; sinon false et le webhook continue (General, sujets Nexa…).
 * Appelé APRÈS handleAdminChatMessage (Nexa), qui a déjà écarté ses sujets.
 */
export async function handleBroadcastTopicMessage(msg: any, deps: RelayDeps = {}): Promise<boolean> {
  const d = await resolve(deps);
  if (String(msg?.chat?.id) !== String(d.adminChat)) return false;
  if (msg?.from?.is_bot || isServiceMessage(msg)) return false;
  if (msg?.is_topic_message !== true || typeof msg?.message_thread_id !== "number") return false;

  const th = d.db.prepare(
    `SELECT telegram_id FROM lecercle_dm_threads WHERE admin_chat_id = ? AND thread_id = ?`
  ).get(String(d.adminChat), msg.message_thread_id) as { telegram_id: number } | undefined;
  if (!th) {
    // Sujet « 📣 » qui n'est plus le sujet courant de personne (recréé, ou orphelin
    // fermé) : le dire, plutôt que d'ignorer en silence un message écrit pour un lead.
    // Reconnu au nom porté par le message de création du sujet, auquel Telegram
    // rattache chaque message d'un sujet.
    const topicName: string = msg.reply_to_message?.forum_topic_created?.name ?? "";
    if (topicName.startsWith("📣")) {
      await d.tg("sendMessage", {
        chat_id: d.adminChat, message_thread_id: msg.message_thread_id, parse_mode: "HTML",
        text: `⚠️ Sujet obsolète — rien n'a été envoyé. Cette personne a un sujet plus récent : écris-lui là-bas.`,
        reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      });
      return true;
    }
    return false;
  }
  const tgId = th.telegram_id;
  const operator = operatorLabel(msg.from);
  const raw: string = (msg.text ?? msg.caption ?? "").trim();
  // Commande = TEXTE commençant par « / ». Une légende de photo qui commence par
  // « / » reste un média à envoyer.
  const cmd = typeof msg.text === "string" && raw.startsWith("/") ? raw.split(/\s+/)[0].split("@")[0].toLowerCase() : "";
  const say = (text: string) => d.tg("sendMessage", {
    chat_id: d.adminChat, message_thread_id: msg.message_thread_id, text, parse_mode: "HTML",
    reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
  });

  if (cmd === "/bot") {
    d.db.prepare(`UPDATE lecercle_dm_threads SET closed_at = datetime('now'), closed_by = ? WHERE telegram_id = ?`).run(operator, tgId);
    await say(`🤖 Relais clos — ses prochains messages repartent vers le bot, jusqu'à une nouvelle diffusion ou ta prochaine réponse ici.`);
    return true;
  }
  if (cmd === "/note") {
    const note = raw.slice(cmd.length).trim();
    if (note) {
      d.db.prepare(
        `UPDATE lecercle_dm_threads SET notes = COALESCE(notes || char(10), '') || ? WHERE telegram_id = ?`
      ).run(`${new Date().toISOString().slice(0, 16)} ${operator} : ${note}`.slice(0, 1000), tgId);
    }
    await say(note ? `📝 Note ajoutée.` : `❓ /note &lt;texte&gt;`);
    return true;
  }
  if (cmd) {
    await say(`❓ Commande inconnue <code>${esc(cmd)}</code> — dispo : /bot · /note &lt;texte&gt;. Rien n'a été envoyé.`);
    return true;
  }

  // Devenu lead Nexa depuis : son fil vit désormais dans le relais Nexa (historique,
  // takeover, silence du scénario). Envoyer d'ici contournerait tout ça.
  const nexaId = d.nexaLeadId(tgId);
  if (nexaId) {
    let link: string | null = null;
    try {
      const r = d.db.prepare(`SELECT admin_topic_chat_id AS c, admin_thread_id AS t FROM nexa_leads WHERE id = ?`).get(nexaId) as
        { c: string | null; t: number | null } | undefined;
      if (r?.t && String(r.c ?? "").startsWith("-100")) link = `https://t.me/c/${String(r.c).slice(4)}/${r.t}`;
    } catch { /* pas de lien */ }
    await say(`↪️ Cette personne est désormais un lead Nexa : réponds-lui dans son sujet Nexa` +
      (link ? ` — <a href="${link}">ouvrir</a>` : "") + `. Rien n'a été envoyé d'ici.`);
    return true;
  }

  const { kind } = describe(msg);
  // Texte SIMPLE (sans parse_mode) : un « < » de l'opérateur ne doit pas faire échouer l'envoi.
  const res = kind === "text"
    ? await d.tg("sendMessage", { chat_id: tgId, text: raw })
    : await d.tg("copyMessage", { chat_id: tgId, from_chat_id: d.adminChat, message_id: msg.message_id });

  if (res.ok) {
    d.db.transaction(() => {
      d.db.prepare(
        `INSERT INTO lecercle_dm_messages (telegram_id, direction, sender, kind, text, telegram_message_id)
         VALUES (?, 'out', ?, ?, ?, ?)`
      ).run(tgId, `operator:${operator}`, kind, cut(kind === "text" ? raw : (msg.caption ?? `[${kind}]`), 4000),
            res.result?.message_id ?? null);
      // Réponse = la conversation continue : la fenêtre repart pour 72 h, le fil est rouvert.
      d.db.prepare(
        `UPDATE lecercle_dm_threads SET last_operator_reply_at = datetime('now'), closed_at = NULL, closed_by = NULL
          WHERE telegram_id = ?`
      ).run(tgId);
    })();
    await d.tg("setMessageReaction", {
      chat_id: d.adminChat, message_id: msg.message_id, reaction: [{ type: "emoji", emoji: "👍" }],
    });
  } else {
    const blocked = res.error_code === 403;
    if (blocked && /blocked by the user|user is deactivated/i.test(res.description ?? "")) {
      d.db.prepare(
        `INSERT INTO lecercle_bot_users (telegram_id, blocked_at, block_reason, origin) VALUES (?, datetime('now'), ?, 'send')
         ON CONFLICT(telegram_id) DO UPDATE SET blocked_at = COALESCE(lecercle_bot_users.blocked_at, excluded.blocked_at),
           block_reason = COALESCE(lecercle_bot_users.block_reason, excluded.block_reason)`
      ).run(tgId, (res.description ?? "403").slice(0, 200));
    }
    await say(`❌ Non envoyé — ${esc(res.description ?? "erreur Telegram")}` +
      (blocked ? `\n<i>Cette personne a bloqué le bot ou n'a pas de conversation ouverte avec lui.</i>` : ""));
  }
  return true;
}

function operatorLabel(from: any): string {
  if (from?.username) return `@${from.username}`;
  return String(from?.first_name ?? from?.id ?? "opérateur");
}

// ── Reprise (cron) ────────────────────────────────────────

/** Fils ayant des messages entrants pas encore relayés. Borné par passe. */
export async function drainPendingDmRelays(deps: RelayDeps = {}, limit = 30): Promise<{ threads: number; posted: number; deferred: number }> {
  const d = await resolve(deps);
  const rows = d.db.prepare(
    // Le message en attente le plus ANCIEN d'abord : un fil coincé ne bloque pas
    // les autres derrière lui, il passe simplement en premier à chaque tour.
    `SELECT t.telegram_id, MIN(m.id) AS oldest
       FROM lecercle_dm_threads t
       JOIN lecercle_dm_messages m
         ON m.telegram_id = t.telegram_id AND m.direction = 'in' AND m.id > t.last_relayed_msg_id
      GROUP BY t.telegram_id
      ORDER BY oldest LIMIT ?`
  ).all(limit) as Array<{ telegram_id: number }>;
  const out = { threads: rows.length, posted: 0, deferred: 0 };
  for (const r of rows) {
    const res = await relayPending(r.telegram_id, deps);
    out.posted += res.posted;
    if (res.deferred) out.deferred++;
  }
  return out;
}
