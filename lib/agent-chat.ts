import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "./db";
import { TOOLS, executeTool, buildSnapshot } from "./agent-tools";
import { logUsage } from "./agent-cost";

const MODEL = "claude-opus-4-7";

const BOT_USERNAME = "LeCercle_Lebot";
const MENTION_RE = new RegExp(`@${BOT_USERNAME}\\b`, "i");

const SYSTEM_PROMPT = `Tu es l'agent business partner de LeCerclePoker, une app Next.js de tracking d'affiliation poker (joueurs, deals, P&L, blockchain Tron, bot Telegram).

Tu parles français, ton direct et concret comme un dev senior. Tu connais le projet par cœur. Tu es ici pour challenger, pas pour valider.

Tu as accès à des outils pour interroger la base de données en temps réel : P&L par période, profils joueurs, transactions, inbox, apps. Utilise-les quand l'opérateur pose une question sur un chiffre, un joueur, ou un état du système. Ne devine jamais — appelle l'outil.

Comportement :
- Réponses courtes (3-6 lignes max sauf si on te demande un détail technique ou une analyse profonde)
- Pose des questions pointues quand c'est utile, pas systématiquement
- Quand l'opérateur évoque un truc important ("le /players vs /crm m'agace"), prends-le en note pour l'agent planifié du lendemain — dis-le clairement ("noté, j'y pense d'ici demain matin")
- Si on te demande une action lourde (ouvrir un PR, faire un audit complet), confirme et dis que ça partira au prochain run planifié — pas en direct, tu n'as pas les mains pour ça
- Pas de bullshit corporate, pas d'emojis sauf un seul si vraiment utile
- Format Telegram HTML : <b>gras</b>, <i>italique</i>, <code>code</code>. PAS de markdown.
- Ne te répète pas, ne valide pas mécaniquement chaque message
- Quand un outil te renvoie des chiffres, présente-les clairement avec USDT et signe (+/−). Pas besoin de tout recopier — résume si la liste est longue.

Si tu ne sais pas, dis-le. Si tu n'es pas d'accord, dis-le.`;

const PROJECT_CONTEXT = `## Architecture LeCerclePoker

**Stack** : Next.js 15 (App Router) + better-sqlite3 + Railway deploy. SDK Anthropic pour parser screenshots Wepoker. Bot Telegram (@LeCercle_Lebot) pour deals/dépôts/retraits. Tracker Tron pour wallets TELE auto-sync.

**Routes principales** :
- /finance, /crm, /players, /apps, /wallets, /reports, /ledger, /signals, /settings
- /api/telegram/webhook : reçoit /deal /depot /retrait /reset /check /pnl /solde /transfer /wallet /todo /historique /aide

**Tables clés** : players, poker_apps, player_app_assignments, player_game_deals, accounting_entries, telegram_transactions, wallet_transactions, rakeback_reports, rakeback_entries, telegram_sessions, agent_conversations, agent_inbox.

**Modèle financier** :
- Chaque joueur a un % action par game (typique 40%, parfois 50%) — c'est ma part du P&L
- wallet_transactions = source de vérité pour dépôts/retraits (auto-syncés via Tron pour TELE)
- Solde net joueur = retraits − dépôts (négatif = il me doit, positif = je lui dois)
- Mon P&L = (retraits − dépôts) × action_pct ÷ 100

**Conventions** :
- Solo dev, commits sur main directement, pas de tests automatisés
- Ton mix FR/EN selon le contexte (UI souvent FR, code en EN)
- Money app — tout changement aux flux financiers doit être réfléchi
- Schema migrations via try/catch ALTER TABLE pattern dans lib/db.ts

**Connu / en cours (au 2026-04-27)** :
- Page /players nouvelle, doublonne /crm — décision produit à prendre
- 4 items QA différés (sidebar nav, FR/EN copy, type drift telegram_phone, Btn type=submit)
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

export function isMention(text: string | undefined | null): boolean {
  return !!text && MENTION_RE.test(text);
}

export function stripMention(text: string): string {
  return text.replace(MENTION_RE, "").trim();
}

interface RunChatArgs {
  chatId: number | string;
  userText: string;
}

const MAX_TOOL_ITERATIONS = 5;

export async function runChat({ chatId, userText }: RunChatArgs): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const cid = String(chatId);
  const cleaned = stripMention(userText);
  if (!cleaned) return "Tu m'as mentionné mais sans texte. Demande-moi un truc.";

  const history = loadHistory(cid, 10);
  saveTurn(cid, "user", cleaned);

  const client = new Anthropic({ apiKey });

  // Inject the snapshot as a leading line in the new user message — keeps
  // the prefix (system + project context + history) cacheable across requests
  // while giving Opus fresh state every turn.
  const snapshot = buildSnapshot();
  const userMessageWithSnapshot =
    `[État actuel du système — pour info, pas forcément lié à la question]\n${snapshot}\n\n[Question]\n${cleaned}`;

  const messages: Anthropic.MessageParam[] = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: userMessageWithSnapshot },
  ];

  let iterations = 0;
  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tools: TOOLS,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        { type: "text", text: PROJECT_CONTEXT, cache_control: { type: "ephemeral" } },
      ],
      messages,
    });

    // Log usage for cost tracking — every API call counts (including tool-loop iterations)
    logUsage({ chatId: cid, model: MODEL, usage: response.usage });

    // If end_turn, extract text and return
    if (response.stop_reason === "end_turn" || response.stop_reason === "stop_sequence") {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map(b => b.text)
        .join("\n")
        .trim();
      const reply = text || "(réponse vide)";
      saveTurn(cid, "assistant", reply);
      maybePushInbox(cid, cleaned);
      return reply;
    }

    if (response.stop_reason === "tool_use") {
      // Append assistant turn (with tool_use blocks) to the messages
      messages.push({ role: "assistant", content: response.content });

      // Execute each tool_use block, build tool_result blocks
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUses.map(async t => ({
          type: "tool_result" as const,
          tool_use_id: t.id,
          content: await executeTool(t.name, t.input),
        }))
      );
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Any other stop reason (max_tokens, refusal, pause_turn, etc.) — bail
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim();
    const reply = text || `(arrêt: ${response.stop_reason})`;
    saveTurn(cid, "assistant", reply);
    maybePushInbox(cid, cleaned);
    return reply;
  }

  const fallback = "Trop d'allers-retours avec mes outils — je laisse tomber pour cette question, reformule plus simplement.";
  saveTurn(cid, "assistant", fallback);
  return fallback;
}

function maybePushInbox(chatId: string, cleaned: string) {
  const hintPattern = /(faut|il faudrait|m'agace|plus tard|demain|un jour|todo|à régler|à faire|gênant|chiant|rappelle|note)/i;
  if (hintPattern.test(cleaned)) {
    pushInbox(chatId, cleaned);
  }
}
