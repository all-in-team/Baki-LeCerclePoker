import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "./db";

// Per-million-token pricing (USD). Source: claude-api skill, current as of 2026-04.
const RATES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-4-7":   { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  "claude-opus-4-6":   { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  "claude-sonnet-4-6": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  "claude-haiku-4-5":  { input: 1.00, output:  5.00, cacheRead: 0.10, cacheWrite: 1.25 },
};

export function computeCost(model: string, usage: Anthropic.Usage | null | undefined): number {
  if (!usage) return 0;
  const r = RATES[model] ?? RATES["claude-opus-4-7"];
  return (
    (usage.input_tokens || 0) * r.input / 1e6 +
    (usage.output_tokens || 0) * r.output / 1e6 +
    (usage.cache_read_input_tokens || 0) * r.cacheRead / 1e6 +
    (usage.cache_creation_input_tokens || 0) * r.cacheWrite / 1e6
  );
}

export function logUsage(args: {
  chatId: string;
  model: string;
  usage: Anthropic.Usage | null | undefined;
}) {
  if (!args.usage) return;
  const cost = computeCost(args.model, args.usage);
  getDb().prepare(
    `INSERT INTO agent_usage (chat_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    args.chatId,
    args.model,
    args.usage.input_tokens || 0,
    args.usage.output_tokens || 0,
    args.usage.cache_creation_input_tokens || 0,
    args.usage.cache_read_input_tokens || 0,
    cost,
  );
}

export interface UsageSummary {
  cost_usd: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export function todayCost(): UsageSummary {
  const today = new Date().toISOString().slice(0, 10);
  const row = getDb().prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd,
            COUNT(*) AS calls,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens
     FROM agent_usage WHERE date(created_at) = ?`
  ).get(today) as UsageSummary;
  return row;
}

export function usageBetween(start: string, end: string): UsageSummary & { by_day: Array<{ day: string; cost_usd: number; calls: number }> } {
  const totals = getDb().prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd,
            COUNT(*) AS calls,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens
     FROM agent_usage WHERE date(created_at) BETWEEN ? AND ?`
  ).get(start, end) as UsageSummary;

  const byDay = getDb().prepare(
    `SELECT date(created_at) AS day, SUM(cost_usd) AS cost_usd, COUNT(*) AS calls
     FROM agent_usage WHERE date(created_at) BETWEEN ? AND ?
     GROUP BY date(created_at) ORDER BY day DESC`
  ).all(start, end) as Array<{ day: string; cost_usd: number; calls: number }>;

  return { ...totals, by_day: byDay };
}
