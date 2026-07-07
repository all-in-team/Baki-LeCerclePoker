import Anthropic from "@anthropic-ai/sdk";

// Choix de modèle centralisé pour tout ce qui passe par l'agent ops
// (Q&A Telegram via runChat + morning-checkin qui réutilise runChat).
// Le daily-summary (lib/daily-summary.ts) est du SQL pur, sans LLM.
export const PRIMARY_MODEL = "claude-fable-5";
export const FALLBACK_MODEL = "claude-opus-4-8";

type CreateParams = Omit<Anthropic.MessageCreateParamsNonStreaming, "model">;

export interface ModelCallResult {
  response: Anthropic.Message;
  model: string;
  fellBack: boolean;
}

// Fable 5 d'abord ; retry UNE fois sur Opus 4.8 quand :
//   - erreur API (overload 529, 5xx, 429, réseau, 4xx type mauvais modèle) —
//     APIConnectionError est une sous-classe d'APIError dans le SDK TS, donc
//     un seul instanceof couvre tout le transport ;
//   - stop_reason "refusal" (classifieurs Fable 5) — on rejoue la même requête
//     sur Opus, qui ignore silencieusement les thinking blocks Fable de l'historique.
// Les erreurs non-API (bugs de code) remontent telles quelles, sans retry.
export async function callModelWithFallback(
  client: Anthropic,
  params: CreateParams
): Promise<ModelCallResult> {
  try {
    const response = await client.messages.create({ model: PRIMARY_MODEL, ...params });
    if (response.stop_reason === "refusal") {
      console.warn(`[agent-model] ${PRIMARY_MODEL} refusal (${response.stop_details?.category ?? "?"}) — retry ${FALLBACK_MODEL}`);
      const retry = await client.messages.create({ model: FALLBACK_MODEL, ...params });
      return { response: retry, model: FALLBACK_MODEL, fellBack: true };
    }
    return { response, model: PRIMARY_MODEL, fellBack: false };
  } catch (e) {
    if (!(e instanceof Anthropic.APIError)) throw e;
    console.warn(`[agent-model] ${PRIMARY_MODEL} error ${(e as { status?: number }).status ?? "network"} — retry ${FALLBACK_MODEL}`);
    const retry = await client.messages.create({ model: FALLBACK_MODEL, ...params });
    return { response: retry, model: FALLBACK_MODEL, fellBack: true };
  }
}
