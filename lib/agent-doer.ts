import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "./db";

// ────────────────────────────────────────────────────────────
// Settings helpers
// ────────────────────────────────────────────────────────────
export function getSetting(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value);
}

// ────────────────────────────────────────────────────────────
// Budget cap check
// ────────────────────────────────────────────────────────────
export function getDoerBudgetCap(): number {
  const v = getSetting("agent_doer_budget_cap_usd_daily");
  const n = v ? parseFloat(v) : 10;
  return isNaN(n) ? 10 : n;
}

export function getTodayDoerSpend(): number {
  const today = new Date().toISOString().slice(0, 10);
  const row = getDb().prepare(
    `SELECT COALESCE(SUM(cost_usd_estimate), 0) AS spend
     FROM agent_doer_sessions WHERE date(created_at) = ?`
  ).get(today) as { spend: number };
  return row.spend;
}

export function isWithinBudget(): { ok: boolean; spent: number; cap: number; remaining: number } {
  const cap = getDoerBudgetCap();
  const spent = getTodayDoerSpend();
  return { ok: spent < cap, spent, cap, remaining: Math.max(0, cap - spent) };
}

// ────────────────────────────────────────────────────────────
// Session record helpers
// ────────────────────────────────────────────────────────────
export interface DoerSessionRow {
  id: number;
  session_id: string;
  chat_id: string;
  description: string;
  money_ok: number;
  status: string;
  pr_url: string | null;
  branch_name: string | null;
  cost_usd_estimate: number;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export function recordSessionStart(args: {
  session_id: string;
  chat_id: string;
  description: string;
  money_ok: boolean;
}) {
  getDb().prepare(
    `INSERT INTO agent_doer_sessions (session_id, chat_id, description, money_ok, status)
     VALUES (?, ?, ?, ?, 'starting')`
  ).run(args.session_id, args.chat_id, args.description, args.money_ok ? 1 : 0);
}

export function updateSessionStatus(session_id: string, status: string, extras?: { pr_url?: string; branch_name?: string; cost_usd_estimate?: number; error_message?: string }) {
  const completed = ["completed", "failed", "cancelled"].includes(status);
  const sets: string[] = ["status = ?"];
  const params: any[] = [status];
  if (extras?.pr_url !== undefined) { sets.push("pr_url = ?"); params.push(extras.pr_url); }
  if (extras?.branch_name !== undefined) { sets.push("branch_name = ?"); params.push(extras.branch_name); }
  if (extras?.cost_usd_estimate !== undefined) { sets.push("cost_usd_estimate = ?"); params.push(extras.cost_usd_estimate); }
  if (extras?.error_message !== undefined) { sets.push("error_message = ?"); params.push(extras.error_message); }
  if (completed) { sets.push("completed_at = datetime('now')"); }
  params.push(session_id);
  getDb().prepare(`UPDATE agent_doer_sessions SET ${sets.join(", ")} WHERE session_id = ?`).run(...params);
}

export function recentDoerSessions(limit = 10): DoerSessionRow[] {
  return getDb().prepare(
    `SELECT * FROM agent_doer_sessions ORDER BY created_at DESC LIMIT ?`
  ).all(limit) as DoerSessionRow[];
}

// ────────────────────────────────────────────────────────────
// Money-flow path detection (defense in depth — agent prompt also forbids it,
// but we double-check in code so a misbehaving agent never silently bypasses)
// ────────────────────────────────────────────────────────────
export const MONEY_FLOW_KEYWORDS = [
  "deal", "depot", "dépôt", "retrait", "retraits", "withdrawal", "deposit",
  "transfer", "wallet", "wallets", "tron", "blockchain", "p&l", "pnl",
  "rakeback", "insurance", "winnings", "transaction", "ledger", "balance",
];

export function looksMoneyFlow(description: string): boolean {
  const d = description.toLowerCase();
  return MONEY_FLOW_KEYWORDS.some(k => d.includes(k));
}

// ────────────────────────────────────────────────────────────
// Dispatch a fix request to Anthropic Managed Agents
// ────────────────────────────────────────────────────────────
export interface DispatchResult {
  ok: boolean;
  session_id?: string;
  reason?: string;
}

export async function dispatchFix(args: {
  chatId: string;
  description: string;
  money_ok?: boolean;
}): Promise<DispatchResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, reason: "ANTHROPIC_API_KEY non configuré" };

  const pat = process.env.GITHUB_FIX_PAT;
  if (!pat) return { ok: false, reason: "GITHUB_FIX_PAT non configuré (token GitHub manquant côté Railway)" };

  // Prefer env vars (set in Railway) → fall back to local settings table
  const envId = process.env.AGENT_DOER_ENV_ID || getSetting("agent_doer_env_id");
  const agentId = process.env.AGENT_DOER_AGENT_ID || getSetting("agent_doer_agent_id");
  if (!envId || !agentId) {
    return { ok: false, reason: "Doer agent pas encore enregistré chez Anthropic. Lance le setup script (scripts/setup-doer-agent.ts) puis set AGENT_DOER_ENV_ID + AGENT_DOER_AGENT_ID dans Railway." };
  }

  // Budget cap check
  const budget = isWithinBudget();
  if (!budget.ok) {
    return {
      ok: false,
      reason: `Budget doer journalier dépassé : $${budget.spent.toFixed(2)} / $${budget.cap.toFixed(2)}. Réessaie demain ou augmente le cap via la table settings.`,
    };
  }

  // Money-flow safety check
  const moneyFlow = looksMoneyFlow(args.description);
  if (moneyFlow && !args.money_ok) {
    return {
      ok: false,
      reason: `La requête semble toucher à du code financier (deal/depot/retrait/wallet/PnL/rakeback). Pour autoriser, ajoute "money:ok" dans ta demande. Sinon je préfère que tu fasses ce changement à la main pour éviter une régression silencieuse.`,
    };
  }

  const client = new Anthropic({ apiKey });
  const branchName = `fix/agent-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;

  const kickoffPrompt = `${args.description}

CONTEXTE TECHNIQUE
==================
- Repo monté dans /workspace/Baki-LeCerclePoker
- Branch à créer : ${branchName}
- money:ok ${args.money_ok ? "OUI — tu as l'autorisation explicite de toucher au code financier" : "NON — refuse si la requête touche à ce code"}
- Token Telegram d'agent-report dans la variable d'env: AGENT_REPORT_SECRET (déjà disponible — utilise $AGENT_REPORT_SECRET en bash)

QUAND TU AURAS FINI (succès ou échec) :
Poste dans le groupe Telegram via curl :
  curl -X POST "https://lecerclepoker-production.up.railway.app/api/agent-report" \\
    -H "Content-Type: application/json" \\
    -H "x-agent-report-secret: $AGENT_REPORT_SECRET" \\
    -d '{"title":"Doer terminé","summary":"<RECAP>"}'

Le RECAP doit contenir :
- Ce que tu as compris de la requête
- Les fichiers modifiés (chemins exacts)
- Le lien de la PR si succès, sinon la raison de l'échec
- Si tu as eu besoin de skipper quelque chose (ex: money:ok manquant), dis-le clairement.

Allons-y. Lis d'abord les fichiers pertinents AVANT de modifier quoi que ce soit.`;

  try {
    const session = await (client as any).beta.sessions.create({
      agent: { type: "agent", id: agentId },
      environment_id: envId,
      title: args.description.slice(0, 80),
      resources: [
        {
          type: "github_repository",
          url: "https://github.com/all-in-team/Baki-LeCerclePoker",
          authorization_token: pat,
          mount_path: "/workspace/Baki-LeCerclePoker",
          checkout: { type: "branch", name: "main" },
        },
      ],
      metadata: {
        chat_id: args.chatId,
        money_ok: args.money_ok ? "true" : "false",
      },
    });

    recordSessionStart({
      session_id: session.id,
      chat_id: args.chatId,
      description: args.description,
      money_ok: !!args.money_ok,
    });

    // Send kickoff message
    await (client as any).beta.sessions.events.send(session.id, {
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text: kickoffPrompt }],
        },
      ],
    });

    updateSessionStatus(session.id, "running");

    // Fire-and-forget background streaming — track progress + cost, post final to Telegram
    streamAndPostBackground(session.id, args.chatId).catch(e => {
      console.error("[doer stream]", session.id, e);
      updateSessionStatus(session.id, "failed", { error_message: String(e?.message ?? e) });
    });

    return { ok: true, session_id: session.id };
  } catch (e: any) {
    return { ok: false, reason: `Erreur création session: ${e?.message ?? String(e)}` };
  }
}

// ────────────────────────────────────────────────────────────
// Background streaming — track session events, accumulate cost
// ────────────────────────────────────────────────────────────
async function streamAndPostBackground(session_id: string, chat_id: string): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const client = new Anthropic({ apiKey });
  let totalCost = 0;
  // Per-million-token pricing for Opus 4.7
  const RATE_INPUT = 5.0 / 1e6;
  const RATE_OUTPUT = 25.0 / 1e6;
  const RATE_CACHE_READ = 0.5 / 1e6;
  const RATE_CACHE_WRITE = 6.25 / 1e6;

  try {
    const stream = await (client as any).beta.sessions.events.stream(session_id);
    for await (const event of stream) {
      if (event.type === "span.model_request_end") {
        const u = event.model_usage || {};
        totalCost +=
          (u.input_tokens || 0) * RATE_INPUT +
          (u.output_tokens || 0) * RATE_OUTPUT +
          (u.cache_read_input_tokens || 0) * RATE_CACHE_READ +
          (u.cache_creation_input_tokens || 0) * RATE_CACHE_WRITE;
        updateSessionStatus(session_id, "running", { cost_usd_estimate: totalCost });
      } else if (event.type === "session.status_terminated") {
        updateSessionStatus(session_id, "completed", { cost_usd_estimate: totalCost });
        break;
      } else if (event.type === "session.status_idle") {
        const stop = event.stop_reason?.type;
        if (stop === "requires_action") continue; // waiting on tool confirmation
        if (stop === "end_turn" || stop === "retries_exhausted") {
          updateSessionStatus(session_id, "completed", { cost_usd_estimate: totalCost });
          break;
        }
      } else if (event.type === "session.error") {
        updateSessionStatus(session_id, "failed", {
          cost_usd_estimate: totalCost,
          error_message: event.error?.message ?? "session error",
        });
        break;
      }
    }
  } catch (e: any) {
    updateSessionStatus(session_id, "failed", {
      cost_usd_estimate: totalCost,
      error_message: `stream error: ${e?.message ?? String(e)}`,
    });
  }
}
