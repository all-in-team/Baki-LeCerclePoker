// Reprise des appels vision sur saturation de l'API — logique PARTAGEABLE.
//
// Extraite telle quelle de app/api/nexa/affiliate/extract/route.ts, où elle est
// née et où elle reste en place : cette route-là a son propre harnais
// (scripts/nexa-extract-retry.test.ts) qui charge le fichier de route et simule
// le SDK. La migrer vers ce module est un pas séparé et testable, pas un effet
// de bord d'un autre chantier. Ici, c'est la version utilisée par les NOUVELLES
// routes d'extraction.
//
// DEUX CAS DE REPRISE, ET DEUX SEULEMENT, parce qu'ils sont PASSAGERS :
//   • 529 overloaded_error — l'API est saturée ;
//   • 429 rate_limit_error — quota momentanément dépassé.
// Un 400 (image invalide) ou un 401 (clé fausse) ne deviendront jamais bons en
// réessayant : les retenter brûle du temps et de l'argent pour la même erreur.
//
// Le SDK retente déjà les 5xx, mais avec un backoff de quelques centaines de ms
// taillé pour un hoquet, pas pour une saturation qui dure. Les appelants doivent
// donc le construire avec `new Anthropic({ maxRetries: 0 })` et laisser ce
// module piloter — sinon 3 reprises SDK × 3 boucles = 9 appels vision facturés.
import Anthropic from "@anthropic-ai/sdk";

export const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
/** Le 429 est plus court : au-delà, c'est un vrai quota, pas un pic. */
export const RATE_LIMIT_MAX_RETRIES = 2;
/** Plafond de l'attente suggérée par l'API — au-delà, autant rendre la main. */
export const MAX_RETRY_AFTER_MS = 60_000;

export const OVERLOADED_MESSAGE =
  "API saturée, réessaie dans une minute. Rien n'a été perdu : ta photo n'est pas encore enregistrée, "
  + "il suffit de la redéposer. (Le serveur a déjà réessayé plusieurs fois de son côté.)";

export const RATE_LIMIT_MESSAGE =
  "Quota API atteint, réessaie dans une minute. Rien n'a été perdu : ta photo n'est pas encore "
  + "enregistrée, il suffit de la redéposer. (Le serveur a déjà réessayé de son côté — si ça persiste, "
  + "c'est le quota du jour qui est épuisé.)";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** `status` et `type` vivent sur les sous-classes APIStatusError ; on les lit sans
 *  caster la classe elle-même (elle est exportée comme valeur, pas comme type). */
function apiErrorFields(e: unknown): { status?: number; type?: string } {
  return e as unknown as { status?: number; type?: string };
}

export function isOverloaded(e: unknown): boolean {
  if (!(e instanceof Anthropic.APIError)) return false;
  const { status, type } = apiErrorFields(e);
  return status === 529 || type === "overloaded_error";
}

export function isRateLimited(e: unknown): boolean {
  if (!(e instanceof Anthropic.APIError)) return false;
  if (e instanceof Anthropic.RateLimitError) return true;
  const { status, type } = apiErrorFields(e);
  return status === 429 || type === "rate_limit_error";
}

/**
 * Attente demandée par l'API sur un 429, en ms — elle sait mieux que nous quand
 * sa fenêtre se rouvre. `null` si elle ne dit rien d'exploitable.
 *
 * `retry-after` peut aussi être une DATE HTTP ; Number() donne alors NaN et on
 * retombe proprement sur l'échelle plutôt que d'attendre une valeur absurde.
 */
export function retryAfterMs(e: unknown): number | null {
  const headers = (e as { headers?: unknown }).headers;
  if (!headers) return null;
  const get = (k: string): string | null => {
    const h = headers as Headers;
    if (typeof h?.get === "function") return h.get(k);
    const rec = headers as Record<string, string>;
    return rec[k] ?? rec[k.toLowerCase()] ?? null;
  };
  const ms = Number(get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, MAX_RETRY_AFTER_MS);
  const secs = Number(get("retry-after"));
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  return null;
}

export type VisionOutcome =
  | { ok: true; message: Anthropic.Message }
  | { ok: false; status: 503 | 429; error: string };

/**
 * Appelle `call` en reprenant sur 529 et 429, et rend un refus lisible sinon.
 *
 * Deux budgets de reprise SÉPARÉS : une saturation et un pic de quota sont deux
 * problèmes distincts, et un compteur commun laisserait l'un consommer les
 * reprises de l'autre. Tout ce qui n'est ni l'un ni l'autre est relancé à
 * l'appelant : ce n'est pas passager.
 */
export async function callVisionWithRetry(
  call: () => Promise<Anthropic.Message>, tag: string,
): Promise<VisionOutcome> {
  let overloadRetries = 0;
  let rateLimitRetries = 0;
  for (;;) {
    try {
      return { ok: true, message: await call() };
    } catch (e) {
      if (isOverloaded(e)) {
        if (overloadRetries >= RETRY_DELAYS_MS.length) {
          console.error(`[${tag}] 529 overloaded après ${overloadRetries + 1} tentative(s) — abandon.`);
          return { ok: false, status: 503, error: OVERLOADED_MESSAGE };
        }
        const wait = RETRY_DELAYS_MS[overloadRetries++];
        console.warn(`[${tag}] 529 overloaded — reprise ${overloadRetries}/${RETRY_DELAYS_MS.length} dans ${wait} ms`);
        await sleep(wait);
        continue;
      }
      if (isRateLimited(e)) {
        if (rateLimitRetries >= RATE_LIMIT_MAX_RETRIES) {
          console.error(`[${tag}] 429 rate limit après ${rateLimitRetries + 1} tentative(s) — abandon.`);
          return { ok: false, status: 429, error: RATE_LIMIT_MESSAGE };
        }
        const hinted = retryAfterMs(e);
        const wait = hinted ?? RETRY_DELAYS_MS[rateLimitRetries];
        rateLimitRetries++;
        console.warn(`[${tag}] 429 rate limit — reprise ${rateLimitRetries}/${RATE_LIMIT_MAX_RETRIES} dans ${wait} ms`
                   + `${hinted !== null ? " (retry-after de l'API)" : ""}`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
}
