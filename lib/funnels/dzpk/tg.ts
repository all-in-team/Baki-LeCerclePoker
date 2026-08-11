// Couche d'appel Telegram du bot dzpk.
//
// ┌─ POURQUOI CE FICHIER EST UNE COPIE ET NON UN IMPORT ───────────────────────┐
// │ `lib/funnels/telegram-api.ts` lit `process.env.TELEGRAM_BOT_TOKEN` en dur   │
// │ (ligne 73). Le rendre paramétrable imposerait de changer la signature de    │
// │ `tg()` dans le chemin d'exécution du bot NEXA — c'est-à-dire de toucher au  │
// │ relais des conversations lead en production, pour livrer une feature qui    │
// │ n'a rien à voir. Le prix d'une copie de 40 lignes est très inférieur à      │
// │ celui de ce risque, et l'étanchéité devient structurelle au lieu d'être     │
// │ une convention.                                                             │
// │                                                                             │
// │ Ce qui est copié est délibérément le strict minimum : appel, 429, file      │
// │ sérialisée. Rien de stateful, aucun accès base.                             │
// └─────────────────────────────────────────────────────────────────────────────┘

import { dzpkBotToken } from "./config";

export type TgResult<T = any> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  /** Rempli par Telegram sur 429 (`retry_after`, en secondes). */
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
};

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

let tokenWarned = false;

export async function tg<T = any>(method: string, body: Record<string, any>): Promise<TgResult<T>> {
  const token = dzpkBotToken();
  if (!token) {
    // Une seule fois : sans ça, chaque message de lead noierait les logs.
    if (!tokenWarned) {
      tokenWarned = true;
      console.error("[DZPK] DZPK_BOT_TOKEN absent — le bot dzpk est muet. Voir docs/DZPK_BOT.md");
    }
    return { ok: false, description: "DZPK_BOT_TOKEN absent" };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as TgResult<T>;
    if (!json.ok) console.error(`[DZPK:${method}]`, json.error_code, json.description);
    return json;
  } catch (e: any) {
    console.error(`[DZPK:${method}] fetch failed:`, e?.message ?? e);
    return { ok: false, description: e?.message ?? String(e) };
  }
}

/**
 * Appel avec respect du rate limit Telegram (429 + `retry_after`).
 *
 * `maxWaitMs` borne l'attente totale parce que cet appel se produit pendant le
 * traitement d'un webhook : au-delà, Telegram considère le webhook en échec et
 * rejoue l'update. On rend donc la main sans avoir envoyé plutôt que de tenir la
 * requête ouverte.
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

    const waitMs = Math.max(1, res.parameters?.retry_after ?? 1) * 1000 + 250;
    if (waited + waitMs > maxWaitMs) {
      console.warn(`[DZPK:${method}] 429 — attente ${waitMs}ms au-delà du budget ${maxWaitMs}ms, abandon`);
      return res;
    }
    waited += waitMs;
    await sleep(waitMs);
  }
}

/**
 * 403 = le lead a bloqué le bot (ou supprimé la conversation).
 *
 * Distingué des autres échecs parce que c'est le seul qui soit DÉFINITIF : il
 * ne se réessaie pas, il se marque sur le lead et l'exclut des envois futurs.
 */
export function isBlockedError(res: TgResult): boolean {
  if (res.error_code !== 403) return false;
  const d = (res.description ?? "").toLowerCase();
  return d.includes("blocked") || d.includes("deactivated") || d.includes("user is deactivated")
    || d.includes("chat not found") || d.includes("bot was kicked");
}

/** File d'exécution sérialisée — un seul appel à la fois pour un domaine donné. */
export function makeSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // `.then(fn, fn)` : un échec précédent ne doit pas bloquer la file.
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
}
