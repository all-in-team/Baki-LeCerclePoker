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
  branch_name: string;
}) {
  getDb().prepare(
    `INSERT INTO agent_doer_sessions (session_id, chat_id, description, money_ok, branch_name, status)
     VALUES (?, ?, ?, ?, ?, 'starting')`
  ).run(args.session_id, args.chat_id, args.description, args.money_ok ? 1 : 0, args.branch_name);
}

export function getSessionRow(session_id: string): DoerSessionRow | null {
  return (getDb().prepare(`SELECT * FROM agent_doer_sessions WHERE session_id = ?`).get(session_id) as DoerSessionRow | undefined) ?? null;
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

TON JOB (et seulement ça)
========================
1. cd /workspace/Baki-LeCerclePoker
2. git checkout -b ${branchName}
3. Lis les fichiers pertinents avant de modifier
4. Fais le changement minimal
5. npx tsc --noEmit  → DOIT passer
6. npm run build     → DOIT passer
7. git add <fichiers PRÉCIS modifiés>  (jamais git add . ni -A)
8. git commit -m "<message clair en français>"
9. git push origin ${branchName}

Quand tu as poussé la branche avec succès, c'est terminé pour toi.
La PR sera ouverte automatiquement et un récap sera posté sur Telegram
côté infrastructure — tu n'as PAS à le faire toi-même.

Si tu rencontres un problème ou tu décides de ne PAS toucher au code
(ex: money:ok manquant alors que la requête l'exige), termine ton dernier
message en commençant par "ABORT:" suivi de la raison. Ce signal sera
détecté côté infra qui notifiera l'opérateur.

Sois efficace, lis les fichiers UNE FOIS, fais le changement, push.`;

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
      branch_name: branchName,
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
// Background streaming — track session events, accumulate cost,
// then open PR + post recap to Telegram once session ends.
// ────────────────────────────────────────────────────────────
async function streamAndPostBackground(session_id: string, chat_id: string): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const client = new Anthropic({ apiKey });
  let totalCost = 0;
  let lastAgentText = "";
  let aborted = false;
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
      } else if (event.type === "agent.message") {
        // Capture latest agent text — may contain ABORT: signal
        const text = (event.content ?? [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
        if (text) lastAgentText = text;
        if (text.includes("ABORT:")) aborted = true;
      } else if (event.type === "session.status_terminated") {
        break;
      } else if (event.type === "session.status_idle") {
        const stop = event.stop_reason?.type;
        if (stop === "requires_action") continue;
        if (stop === "end_turn" || stop === "retries_exhausted") break;
      } else if (event.type === "session.error") {
        updateSessionStatus(session_id, "failed", {
          cost_usd_estimate: totalCost,
          error_message: event.error?.message ?? "session error",
        });
        await postFinalToTelegram(chat_id, "Doer agent — erreur", `❌ Erreur session: ${event.error?.message ?? "session error"}\nCoût: $${totalCost.toFixed(3)}`);
        return;
      }
    }
  } catch (e: any) {
    updateSessionStatus(session_id, "failed", {
      cost_usd_estimate: totalCost,
      error_message: `stream error: ${e?.message ?? String(e)}`,
    });
    return;
  }

  // Session ended — finalize: open PR if branch exists, post recap to Telegram
  await finalizeSession(session_id, chat_id, totalCost, lastAgentText, aborted);
}

async function postFinalToTelegram(chat_id: string, title: string, summary: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const text = `<b>🤖 ${escapeHtml(title)}</b>\n\n${escapeHtml(summary)}`;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text, parse_mode: "HTML", disable_web_page_preview: false }),
    });
  } catch (e) {
    console.error("[doer postFinal]", e);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function finalizeSession(session_id: string, chat_id: string, totalCost: number, lastAgentText: string, aborted: boolean): Promise<void> {
  const session = getSessionRow(session_id);
  if (!session) return;

  // Aborted by agent (ABORT: signal in last message)
  if (aborted) {
    updateSessionStatus(session_id, "cancelled", {
      cost_usd_estimate: totalCost,
      error_message: lastAgentText.slice(0, 1000),
    });
    const reason = (lastAgentText.match(/ABORT:\s*(.+?)(?:\n|$)/)?.[1] ?? lastAgentText.slice(0, 300));
    await postFinalToTelegram(chat_id, "Doer — annulé",
      `L'agent a annulé la tâche.\n\nRaison: ${reason}\n\nCoût: $${totalCost.toFixed(3)}`);
    return;
  }

  const pat = process.env.GITHUB_FIX_PAT;
  const repoOwner = "all-in-team";
  const repoName = "Baki-LeCerclePoker";
  const branch = session.branch_name;

  if (!pat || !branch) {
    updateSessionStatus(session_id, "failed", {
      cost_usd_estimate: totalCost,
      error_message: "Missing GITHUB_FIX_PAT or branch_name in finalize",
    });
    await postFinalToTelegram(chat_id, "Doer — échec finalisation",
      `Session terminée mais finalisation impossible (PAT ou branch manquant).\nCoût: $${totalCost.toFixed(3)}`);
    return;
  }

  // Check if the branch was actually pushed
  let branchExists = false;
  let lastSha: string | null = null;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/branches/${encodeURIComponent(branch)}`,
      { headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json" } }
    );
    if (r.ok) {
      branchExists = true;
      const data = await r.json();
      lastSha = data?.commit?.sha?.slice(0, 8) ?? null;
    }
  } catch {}

  if (!branchExists) {
    updateSessionStatus(session_id, "failed", {
      cost_usd_estimate: totalCost,
      error_message: "Agent did not push a branch",
    });
    await postFinalToTelegram(chat_id, "Doer — pas de branche",
      `Session terminée mais aucune branche poussée. L'agent n'a probablement rien fait ou a buggé.\n\nDernier message agent:\n${lastAgentText.slice(0, 800)}\n\nCoût: $${totalCost.toFixed(3)}`);
    return;
  }

  // Open the PR
  const prTitle = `Doer: ${session.description.slice(0, 60)}`;
  const prBody = `Auto-généré par le doer agent depuis Telegram.\n\n**Demande originale:**\n${session.description}\n\n**Session:** ${session_id}\n**Coût Claude:** $${totalCost.toFixed(3)}\n**Money flag:** ${session.money_ok ? "✅ ok" : "❌ not granted (no money-flow code touched)"}\n\n**Dernier message agent:**\n${lastAgentText.slice(0, 1500)}\n\n---\n⚠️ Review attentivement avant merge. NE PAS auto-merger.`;

  let prUrl: string | null = null;
  let prError: string | null = null;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/pulls`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: prTitle, body: prBody, head: branch, base: "main" }),
      }
    );
    const data = await r.json();
    if (r.ok && data?.html_url) {
      prUrl = data.html_url;
    } else {
      prError = data?.message ?? `HTTP ${r.status}`;
    }
  } catch (e: any) {
    prError = e?.message ?? String(e);
  }

  if (prUrl) {
    updateSessionStatus(session_id, "completed", {
      cost_usd_estimate: totalCost,
      pr_url: prUrl,
    });
    await postFinalToTelegram(chat_id, "Doer terminé ✅",
      `<b>${escapeHtml(prTitle)}</b>\n\nPR ouverte: ${prUrl}\nBranche: <code>${branch}</code> (${lastSha ?? "?"})\nCoût: $${totalCost.toFixed(3)}\n\nReview et merge quand tu veux. Railway redéploiera tout seul.`);
  } else {
    updateSessionStatus(session_id, "failed", {
      cost_usd_estimate: totalCost,
      error_message: `PR creation failed: ${prError}`,
    });
    await postFinalToTelegram(chat_id, "Doer — branche poussée mais PR foirée",
      `Branche <code>${branch}</code> poussée (${lastSha ?? "?"}).\nÉchec création PR: ${prError}\n\nTu peux ouvrir la PR à la main: https://github.com/${repoOwner}/${repoName}/compare/main...${branch}\n\nCoût: $${totalCost.toFixed(3)}`);
  }
}
