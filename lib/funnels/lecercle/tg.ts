// Couche d'appel Telegram des diffusions @LeCercle_Lebot.
//
// Copie de lib/funnels/dzpk/tg.ts, pour la même raison que celle-ci : ne pas
// modifier `lib/funnels/telegram-api.ts` ni `lib/telegram-commands/helpers.ts`,
// qui portent le relais NEXA et tout le bot en production. Seul le token change
// (TELEGRAM_BOT_TOKEN, celui du bot principal) et la lecture des 403.

export type TgResult<T = any> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
  /**
   * Posé quand la requête n'est JAMAIS partie (token absent) : on SAIT que rien
   * n'a été livré. À distinguer d'un échec réseau, dont l'issue est inconnue.
   */
  notSent?: true;
};

/** Au-delà, la requête est abandonnée : un drain ne reste pas suspendu 5 minutes. */
export const FETCH_TIMEOUT_MS = 15_000;

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function tg<T = any>(method: string, body: Record<string, any>): Promise<TgResult<T>> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, notSent: true, description: "TELEGRAM_BOT_TOKEN absent" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const json = (await res.json()) as TgResult<T>;
    if (!json.ok) console.error(`[LECERCLE BROADCAST:${method}]`, json.error_code, json.description);
    return json;
  } catch (e: any) {
    // Réseau, timeout ou réponse illisible : Telegram a PU livrer. Pas d'error_code,
    // exprès — le moteur lit « pas de code » comme « issue inconnue ».
    console.error(`[LECERCLE BROADCAST:${method}] fetch failed:`, e?.message ?? e);
    return { ok: false, description: e?.message ?? String(e) };
  }
}

/** Appel qui honore `retry_after` sur 429, dans un budget d'attente borné. */
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
    if (waited + waitMs > maxWaitMs) return res;
    waited += waitMs;
    await sleep(waitMs);
  }
}

/**
 * 403 DÉFINITIF côté destinataire : il a bloqué le bot, ou son compte est supprimé.
 * Le compte est marqué bloqué et sort des diffusions suivantes.
 *
 * Volontairement ÉTROIT. « bot can't initiate conversation with a user » est
 * aussi un 403, mais il dit « n'a jamais démarré le bot » — le cas attendu des
 * joueurs sans preuve de /start. Le marquer bloqué fausserait le compteur.
 */
export function isBlockedError(res: TgResult): boolean {
  if (res.error_code !== 403) return false;
  const d = (res.description ?? "").toLowerCase();
  return d.includes("blocked by the user") || d.includes("user is deactivated");
}

/**
 * Échec qui ne changera pas en réessayant : on le classe tout de suite en
 * 'failed' au lieu de consommer trois tentatives.
 */
export function isPermanentRecipientError(res: TgResult): boolean {
  const d = (res.description ?? "").toLowerCase();
  if (res.error_code === 403) return true;
  return res.error_code === 400 && (d.includes("chat not found") || d.includes("user not found"));
}
