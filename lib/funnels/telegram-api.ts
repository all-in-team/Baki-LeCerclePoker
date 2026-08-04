// Couche d'appel Telegram partagée par le live takeover et les topics de forum.
//
// Elle existe pour une raison structurelle : `live-takeover.ts` et
// `live-takeover-topics.ts` ont tous deux besoin d'appeler l'API, et se les
// emprunter mutuellement créerait un cycle d'import. Tout ce qui est ici est
// sans état et sans accès DB.
//
// À ne pas confondre avec `lib/telegram-commands/helpers.ts` (sendMsg…), qui
// avale les erreurs et ne rend pas le corps de la réponse : ici on a besoin du
// `message_thread_id`, du `retry_after` et du code d'erreur exact.

import { AGENT_CHAT_ID } from "@/lib/telegram-commands/helpers";

/**
 * Chat Telegram où atterrissent les messages des leads.
 *
 * Vit ici plutôt que dans live-takeover.ts parce que le module des topics en a
 * besoin lui aussi, et que se l'emprunter créerait un cycle.
 *
 * Repli sur AGENT_CHAT_ID plutôt que sur rien : une variable oubliée doit dégrader
 * (relais au mauvais endroit, visible immédiatement) et non faire disparaître les
 * questions en silence — c'est exactement le bug que cette feature corrige.
 */
let adminChatWarned = false;

export function adminChatId(): string {
  const id = process.env.ADMIN_CHAT_ID?.trim();
  if (id) return id;
  // Une seule fois : cette fonction est appelée à chaque message du chat admin,
  // le warning noierait les logs au lieu de les alerter.
  if (!adminChatWarned) {
    adminChatWarned = true;
    console.warn("[TAKEOVER] ADMIN_CHAT_ID non défini — repli sur AGENT_TELEGRAM_CHAT_ID. Voir docs/LIVE_TAKEOVER.md");
  }
  return AGENT_CHAT_ID;
}

/**
 * Opérateurs à mentionner pour déclencher une notification Telegram.
 *
 * Dans un groupe en mode Sujets, les nouveaux sujets ne notifient personne : sans
 * mention explicite, un lead pouvait attendre des heures sans que le téléphone
 * sonne. Ces ids servent uniquement à ça.
 *
 * Liste vide = pas de mention (le relais fonctionne, il ne notifie simplement pas).
 */
export function operatorUserIds(): number[] {
  return (process.env.OPERATOR_USER_IDS ?? "")
    .split(",")
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n) && n > 0);
}

export type TgResult<T = any> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  /** Rempli par Telegram sur 429 (`retry_after`, en secondes) et sur migration de chat. */
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
};

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function tg<T = any>(method: string, body: Record<string, any>): Promise<TgResult<T>> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, description: "TELEGRAM_BOT_TOKEN absent" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as TgResult<T>;
    if (!json.ok) console.error(`[TG:${method}]`, json.error_code, json.description);
    return json;
  } catch (e: any) {
    console.error(`[TG:${method}] fetch failed:`, e?.message ?? e);
    return { ok: false, description: e?.message ?? String(e) };
  }
}

/**
 * Appel avec respect du rate limit Telegram (429 + `retry_after`).
 *
 * `maxWaitMs` borne le temps total d'attente, parce que cet appel se produit
 * pendant le traitement d'un webhook : au-delà, Telegram considère le webhook en
 * échec et rejoue l'update, que notre dédoublonnage écarterait. On rend donc la
 * main sans avoir envoyé — c'est le drain périodique (cf. relais en attente) qui
 * reprend le travail, jamais l'utilisateur.
 */
export async function tgRetrying<T = any>(
  method: string,
  body: Record<string, any>,
  opts: { attempts?: number; maxWaitMs?: number } = {},
): Promise<TgResult<T>> {
  const attempts = opts.attempts ?? 3;
  const maxWaitMs = opts.maxWaitMs ?? 15_000;
  let waited = 0;

  for (let i = 0; ; i++) {
    const res = await tg<T>(method, body);
    if (res.ok || res.error_code !== 429 || i >= attempts - 1) return res;

    // `retry_after` est en secondes ; +250 ms de marge, Telegram est strict sur la borne.
    const waitMs = Math.max(1, res.parameters?.retry_after ?? 1) * 1000 + 250;
    if (waited + waitMs > maxWaitMs) {
      console.warn(`[TG:${method}] 429 — attente ${waitMs}ms au-delà du budget ${maxWaitMs}ms, abandon (repris plus tard)`);
      return res;
    }
    waited += waitMs;
    console.warn(`[TG:${method}] 429 — nouvelle tentative dans ${waitMs}ms`);
    await sleep(waitMs);
  }
}

/**
 * File d'exécution sérialisée — un seul appel à la fois pour un domaine donné.
 *
 * `createForumTopic` est nettement plus limité que `sendMessage` côté Telegram :
 * dix leads qui écrivent en même temps déclencheraient dix créations parallèles,
 * donc une rafale de 429. En les sérialisant, la première attente absorbe le rate
 * limit pour toute la file au lieu de le multiplier.
 */
export function makeSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // `.then(fn, fn)` : un échec précédent ne doit pas bloquer la file.
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
}

/** Messages de service (création de topic, épinglage…) — jamais du contenu d'opérateur. */
export function isServiceMessage(msg: any): boolean {
  return Boolean(
    msg?.forum_topic_created || msg?.forum_topic_edited || msg?.forum_topic_closed ||
    msg?.forum_topic_reopened || msg?.general_forum_topic_hidden || msg?.general_forum_topic_unhidden ||
    msg?.pinned_message || msg?.new_chat_members || msg?.left_chat_member ||
    msg?.new_chat_title || msg?.new_chat_photo || msg?.delete_chat_photo ||
    msg?.message_auto_delete_timer_changed
  );
}
