import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "./db";

const BOT_USERNAME = "LeCercle_Lebot";
const MENTION_RE = new RegExp(`@${BOT_USERNAME}\\b`, "i");

const SYSTEM_PROMPT = `Tu es l'agent business partner de LeCerclePoker, une app Next.js de tracking d'affiliation poker (joueurs, deals, P/L, blockchain Tron, bot Telegram).

Tu parles français, ton direct et concret comme un dev senior. Tu connais le projet par cœur. Tu es ici pour challenger, pas pour valider.

Comportement :
- Réponses courtes (3-6 lignes max sauf si on te demande un détail technique)
- Pose des questions pointues quand c'est utile, mais pas systématiquement
- Quand l'opérateur évoque un truc important ("le /players vs /crm m'agace"), prends-le en note pour l'agent planifié du lendemain — dis-le clairement ("noté, j'y pense d'ici demain matin")
- Si on te demande une action lourde (ouvrir un PR, faire un audit complet), confirme et dis que ça partira au prochain run planifié — pas en direct
- Pas de bullshit corporate, pas d'emojis sauf un seul si vraiment utile
- Format Telegram HTML : <b>gras</b>, <i>italique</i>, <code>code</code>. PAS de markdown.
- Tu ne te répètes pas, tu ne valides pas mécaniquement chaque message

Si tu ne sais pas, dis-le. Si tu n'es pas d'accord, dis-le.`;

const PROJECT_CONTEXT = `## Architecture LeCerclePoker

**Stack** : Next.js 15 (App Router) + better-sqlite3 + Railway deploy. SDK Anthropic pour parser screenshots Wepoker. Bot Telegram (@LeCercle_Lebot) pour deals/dépôts/retraits. Tracker Tron pour wallets TELE.

**Routes principales** :
- /finance, /crm, /players, /apps, /wallets, /reports, /ledger, /signals, /settings
- /api/telegram/webhook : reçoit les commandes /deal /depot /retrait /reset /check /pnl /solde /transfer /wallet /todo /historique /aide

**Tables clés** : players, poker_apps, player_app_assignments, player_game_deals, accounting_entries, telegram_transactions, wallet_transactions, rakeback_reports, rakeback_entries, telegram_sessions, agent_conversations, agent_inbox.

**Conventions** :
- Solo dev, commits sur main directement, pas de tests automatisés
- Ton mix FR/EN selon le contexte (UI souvent FR, code en EN)
- Money app — tout changement aux flux financiers doit être réfléchi
- Schema migrations via try/catch ALTER TABLE pattern dans lib/db.ts

**Connu / en cours** :
- Page /players nouvelle, doublonne /crm — décision produit à prendre
- 4 items QA différés du 2026-04-27 (sidebar nav, FR/EN copy, type drift, Btn type=submit)
- Tracking automatique sync TELE wallets via Tron
- Parser XLS Wepoker déterministe + fallback Vision Claude pour screenshots`;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function loadHistory(chatId: string, limit = 10): ChatMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT role, content FROM agent_conversations
       WHERE chat_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(chatId, limit) as ChatMessage[];
  return rows.reverse();
}

function saveTurn(chatId: string, role: "user" | "assistant", content: string) {
  getDb()
    .prepare(`INSERT INTO agent_conversations (chat_id, role, content) VALUES (?, ?, ?)`)
    .run(chatId, role, content);
}

function pushInbox(chatId: string, message: string) {
  getDb()
    .prepare(`INSERT INTO agent_inbox (chat_id, message) VALUES (?, ?)`)
    .run(chatId, message);
}

function recentGitContext(): string {
  // Recent commits surface naturally via the deployed app's git history.
  // For the chat handler we keep the dynamic context to a minimum so the
  // cache prefix stays stable across messages — heavy git/state queries
  // belong in the scheduled-agent path, not the live chat path.
  return `Date courante : ${new Date().toISOString().slice(0, 10)}`;
}

export function isMention(text: string | undefined | null): boolean {
  return !!text && MENTION_RE.test(text);
}

export function stripMention(text: string): string {
  return text.replace(MENTION_RE, "").trim();
}

interface RunChatArgs {
  chatId: number | string;
  userText: string;
  inboxHints?: string[]; // optional flags from caller (e.g. ["promise","action_request"])
}

export async function runChat({ chatId, userText, inboxHints = [] }: RunChatArgs): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const cid = String(chatId);
  const cleaned = stripMention(userText);
  if (!cleaned) return "Tu m'as mentionné mais sans texte. Demande-moi un truc.";

  const history = loadHistory(cid, 10);
  saveTurn(cid, "user", cleaned);

  const client = new Anthropic({ apiKey });

  const messages: Anthropic.MessageParam[] = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: cleaned },
  ];

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      { type: "text", text: PROJECT_CONTEXT, cache_control: { type: "ephemeral" } },
      { type: "text", text: recentGitContext() },
    ],
    messages,
  });

  // Extract the text response (skip thinking blocks)
  const textBlocks = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map(b => b.text)
    .join("\n")
    .trim();

  const reply = textBlocks || "(réponse vide)";
  saveTurn(cid, "assistant", reply);

  // If the user message looks like an actionable hint or a deferred-thought
  // signal, drop it in the inbox for the next scheduled agent.
  const lowerText = cleaned.toLowerCase();
  const hintPattern = /(faut|il faudrait|m'agace|plus tard|demain|un jour|plus tard|todo|à régler|à faire|gênant|chiant)/i;
  if (hintPattern.test(cleaned) || inboxHints.length > 0) {
    pushInbox(cid, cleaned);
  }

  return reply;
}
