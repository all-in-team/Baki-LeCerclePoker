// Fil de conversation lead ↔ opérateur, côté dzpk.
//
// ┌─ CE QUI EST DÉLIBÉRÉMENT ABSENT, PAR RAPPORT À NEXA ───────────────────────┐
// │ `lib/funnels/live-takeover.ts` fait 1000 lignes. Celui-ci en fait un       │
// │ cinquième, et l'écart n'est pas une dette : c'est l'absence de la chose    │
// │ que le takeover NEXA sert à gérer.                                          │
// │                                                                            │
// │ Chez NEXA, un scénario automatique parle au lead. Tout l'appareillage —    │
// │ `takeover_until`, `awaiting_human_since`, l'expiration à 90 min, les       │
// │ relances coupées — existe pour EMPÊCHER le bot de parler par-dessus un     │
// │ humain. (Incident du 2026-08-04 : le bot renvoyait l'accueil au milieu     │
// │ d'une conversation d'Hugo.)                                                 │
// │                                                                            │
// │ Le bot dzpk n'a pas de scénario. Il envoie un accueil au /start, puis se   │
// │ tait. Il n'y a donc rien à museler, et une horloge de takeover ici ne      │
// │ protègerait de rien tout en devant être comprise et maintenue.             │
// │                                                                            │
// │ À rouvrir le jour où la relance J+1 de la phase 4 existera : ce sera le    │
// │ premier envoi automatique capable de tomber au mauvais moment.             │
// └────────────────────────────────────────────────────────────────────────────┘

import { getDb } from "@/lib/db";
import { tg } from "./tg";
import { dzpkAdminChatId } from "./config";
import type { DbLike } from "./leads";

export type DzpkMsgKind =
  | "text" | "photo" | "document" | "voice" | "video" | "audio" | "sticker" | "other";

export interface DzpkBotMessage {
  id: number;
  lead_id: number;
  direction: "in" | "out";
  sender: string;
  kind: string;
  text: string | null;
  telegram_message_id: number | null;
  created_at: string;
}

// ── Écriture ──────────────────────────────────────────────

/**
 * Persiste un message du fil.
 *
 * Retourne `null` quand rien n'a été inséré — c'est-à-dire quand l'index UNIQUE
 * partiel a reconnu un entrant déjà connu. L'appelant s'en sert pour distinguer
 * « nouveau message » de « rejeu », sans avoir à interroger la base lui-même.
 *
 * Ne lève jamais : une conversation non journalisée est ennuyeuse, un webhook qui
 * répond 500 fait rejouer l'update par Telegram en boucle.
 */
export function logMessage(m: {
  leadId: number;
  direction: "in" | "out";
  sender: string;
  text: string | null;
  kind?: DzpkMsgKind;
  telegramMessageId?: number | null;
}, dbOverride?: DbLike): number | null {
  const db = dbOverride ?? getDb();
  try {
    const info = db.prepare(
      `INSERT OR IGNORE INTO dzpk_bot_messages
         (lead_id, direction, sender, kind, text, telegram_message_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(m.leadId, m.direction, m.sender, m.kind ?? "text", m.text, m.telegramMessageId ?? null);
    return info.changes > 0 ? Number(info.lastInsertRowid) : null;
  } catch (e: any) {
    console.error(`[DZPK TAKEOVER] logMessage échoué (lead=${m.leadId}):`, e?.message ?? e);
    return null;
  }
}

/**
 * Nature d'un message entrant + le texte à afficher.
 *
 * Un média sans légende produit un libellé entre crochets plutôt qu'une ligne
 * vide : dans le fil, « [photo] » se lit, une bulle vide ressemble à un bug.
 */
export function describeIncoming(msg: any): { kind: DzpkMsgKind; text: string } {
  if (typeof msg?.text === "string") return { kind: "text", text: msg.text };
  const caption: string = msg?.caption ?? "";
  if (msg?.photo) return { kind: "photo", text: caption || "[photo]" };
  if (msg?.voice) return { kind: "voice", text: caption || "[message vocal]" };
  if (msg?.video || msg?.video_note) return { kind: "video", text: caption || "[vidéo]" };
  if (msg?.audio) return { kind: "audio", text: caption || "[audio]" };
  if (msg?.sticker) {
    return { kind: "sticker", text: msg.sticker.emoji ? `[sticker ${msg.sticker.emoji}]` : "[sticker]" };
  }
  if (msg?.document) {
    const nom = msg.document.file_name ? ` ${msg.document.file_name}` : "";
    return { kind: "document", text: caption || `[document${nom}]` };
  }
  return { kind: "other", text: caption || "[message non textuel]" };
}

/**
 * Capture d'un message entrant dans le fil.
 *
 * Appelé APRÈS `recordLeadMessage`, qui reste seul responsable du journal
 * d'événements et de l'historique d'identité dont dépend l'appariement. Les deux
 * écritures sont volontairement distinctes : elles ne servent pas le même usage
 * et n'ont pas la même durée de vie.
 *
 * `duplicate: true` ⇒ ce message était déjà dans le fil, l'appelant ne doit rien
 * en déduire de neuf (et, le jour venu, ne rien relayer).
 */
export function captureInbound(
  msg: any,
  leadId: number,
  dbOverride?: DbLike,
): { messageId: number | null; duplicate: boolean; kind: DzpkMsgKind } {
  const db = dbOverride ?? getDb();
  const { kind, text } = describeIncoming(msg);

  const inserted = logMessage({
    leadId, direction: "in", sender: "lead", kind, text,
    telegramMessageId: msg?.message_id ?? null,
  }, dbOverride);

  if (inserted === null) return { messageId: null, duplicate: true, kind };

  // Un lead qui écrit n'a évidemment pas bloqué le bot. Le drapeau a pu être posé
  // par un 403 lors d'une diffusion, puis le lead a débloqué : le laisser à 1
  // l'exclurait de tous les envois suivants alors qu'il vient de parler.
  db.prepare(`UPDATE dzpk_leads SET blocked = 0 WHERE id = ? AND blocked = 1`).run(leadId);

  // Curseur de relais : tant qu'aucun chat admin n'est configuré, il suit le
  // dernier message capté. Le jour où DZPK_ADMIN_CHAT_ID sera posée, il pointera
  // donc sur « maintenant » — le relais démarrera sur les messages SUIVANTS, sans
  // déverser l'historique et sans migration de rattrapage. Cf. schema.ts.
  if (!dzpkAdminChatId()) {
    db.prepare(`UPDATE dzpk_leads SET last_relayed_msg_id = ? WHERE id = ?`).run(inserted, leadId);
  }

  return { messageId: inserted, duplicate: false, kind };
}

// ── Lecture ───────────────────────────────────────────────

/**
 * Le fil, du plus ancien au plus récent.
 *
 * Trié DESC puis inversé : la limite doit garder les messages les plus RÉCENTS.
 * Un `ORDER BY created_at ASC LIMIT 300` rendrait les 300 plus vieux, c'est-à-dire
 * exactement ceux dont personne n'a besoin.
 */
export function getConversation(leadId: number, limit = 300, dbOverride?: DbLike): DzpkBotMessage[] {
  const db = dbOverride ?? getDb();
  const rows = db.prepare(
    `SELECT * FROM dzpk_bot_messages WHERE lead_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
  ).all(leadId, limit) as DzpkBotMessage[];
  return rows.reverse();
}

/**
 * Éteint la pastille « non lu ».
 *
 * Le curseur se pose sur le dernier entrant EXISTANT au moment de la lecture, pas
 * sur l'horloge : un message qui arrive pendant que le panneau s'ouvre porte un id
 * supérieur, il reste donc non lu au lieu d'être avalé.
 */
export function markConversationRead(leadId: number, dbOverride?: DbLike): void {
  const db = dbOverride ?? getDb();
  db.prepare(
    `UPDATE dzpk_leads
        SET last_read_msg_id = (SELECT COALESCE(MAX(id), 0) FROM dzpk_bot_messages
                                 WHERE lead_id = ? AND direction = 'in')
      WHERE id = ?`
  ).run(leadId, leadId);
}

/**
 * Leads dont le DERNIER message du fil vient du lead. « À répondre ».
 *
 * Distinct du non-lu, et c'est tout l'intérêt : le non-lu s'éteint quand on OUVRE
 * le panneau. Ouvrir sans répondre — le cas le plus banal quand on est occupé —
 * effacerait donc le seul signal qu'une question attend. Celui-ci ne s'éteint
 * qu'au moment où le message part.
 *
 * Un lead qui n'a jamais écrit n'y figure pas : il n'attend rien.
 */
export function getAwaitingReply(dbOverride?: DbLike): Set<number> {
  const db = dbOverride ?? getDb();
  const rows = db.prepare(
    `SELECT m.lead_id AS lead_id
       FROM dzpk_bot_messages m
      WHERE m.id = (SELECT MAX(x.id) FROM dzpk_bot_messages x WHERE x.lead_id = m.lead_id)
        AND m.direction = 'in'`
  ).all() as Array<{ lead_id: number }>;
  return new Set(rows.map(r => r.lead_id));
}

/** Entrants postérieurs au curseur de lecture, par lead. Alimente la pastille du tableau. */
export function getUnreadCounts(dbOverride?: DbLike): Map<number, number> {
  const db = dbOverride ?? getDb();
  const rows = db.prepare(
    `SELECT m.lead_id AS lead_id, COUNT(*) AS n
       FROM dzpk_bot_messages m
       JOIN dzpk_leads l ON l.id = m.lead_id
      WHERE m.direction = 'in' AND m.id > l.last_read_msg_id
      GROUP BY m.lead_id`
  ).all() as Array<{ lead_id: number; n: number }>;
  return new Map(rows.map(r => [r.lead_id, r.n]));
}

// ── Envoi ─────────────────────────────────────────────────

export type ReplyResult = { ok: boolean; error?: string; messageId?: number };

/**
 * Envoie la réponse de l'opérateur au lead, sous l'identité du bot.
 *
 * ⚠️ Envoyé SANS `parse_mode`, contrairement à NEXA et contrairement à la
 * diffusion. Ce n'est pas un oubli : un opérateur qui tape « moins de 5 < 10 » ou
 * une balise mal fermée verrait son message refusé par Telegram avec un « can't
 * parse entities », et le lead ne recevrait rien. Une réponse de chat se tape
 * vite ; un message de diffusion se compose. On échange la mise en forme contre
 * la garantie que ce qui est tapé part tel quel.
 */
export async function replyToLead(opts: {
  leadId: number;
  operator: string;
  text: string;
}, dbOverride?: DbLike): Promise<ReplyResult> {
  const db = dbOverride ?? getDb();
  const lead = db.prepare(
    `SELECT id, telegram_id FROM dzpk_leads WHERE id = ?`
  ).get(opts.leadId) as { id: number; telegram_id: number } | undefined;
  if (!lead) return { ok: false, error: "Lead introuvable" };

  const text = (opts.text ?? "").trim();
  if (!text) return { ok: false, error: "Message vide" };
  if ([...text].length > 4096) {
    return { ok: false, error: `Message trop long : ${[...text].length} caractères, maximum 4096` };
  }

  const res = await tg<{ message_id: number }>("sendMessage", {
    chat_id: lead.telegram_id,
    text,
    disable_web_page_preview: true,
  });

  if (!res.ok) {
    // 403 : le lead a bloqué le bot. Seul cas où l'opérateur doit changer de
    // canal — il mérite donc une phrase, pas un code d'erreur.
    if (res.error_code === 403) {
      db.prepare(`UPDATE dzpk_leads SET blocked = 1, updated_at = datetime('now') WHERE id = ?`).run(lead.id);
      return { ok: false, error: "Le lead a bloqué le bot — impossible de lui écrire. Il est marqué 🚫 dans le tableau." };
    }
    if (res.error_code === 400 && /chat not found/i.test(res.description ?? "")) {
      return { ok: false, error: "Chat introuvable — ce compte n'a jamais ouvert de conversation avec le bot." };
    }
    return { ok: false, error: `Telegram : ${res.description ?? "erreur inconnue"}` };
  }

  const messageId = res.result?.message_id;
  logMessage({
    leadId: lead.id, direction: "out", sender: `operator:${opts.operator}`,
    kind: "text", text, telegramMessageId: messageId ?? null,
  }, dbOverride);

  return { ok: true, messageId };
}

/** Fiche minimale affichée en tête du panneau. */
export interface DzpkConversationHead {
  id: number;
  label: string;
  source: string;
  blocked: number;
  started_at: string;
}

export function getConversationHead(leadId: number, dbOverride?: DbLike): DzpkConversationHead | undefined {
  const db = dbOverride ?? getDb();
  const l = db.prepare(
    `SELECT id, telegram_id, username, display_name, source, blocked, started_at
       FROM dzpk_leads WHERE id = ?`
  ).get(leadId) as any;
  if (!l) return undefined;
  return {
    id: l.id,
    label: l.username ? `@${l.username}` : (l.display_name || `tg:${l.telegram_id}`),
    source: l.source,
    blocked: l.blocked,
    started_at: l.started_at,
  };
}
