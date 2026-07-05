import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "./db";
import { TOOLS, executeTool, buildSnapshot } from "./agent-tools";
import { logUsage } from "./agent-cost";
import { AGENCY_GAMES } from "./queries";

const MODEL = "claude-opus-4-8";

const BOT_USERNAME = "LeCercle_Lebot";
const MENTION_RE = new RegExp(`@${BOT_USERNAME}\\b`, "i");

const SYSTEM_PROMPT = `Tu es l'agent business partner de LeCerclePoker, une app Next.js de tracking d'affiliation poker (joueurs, deals, P&L, blockchain Tron, bot Telegram).

Tu parles français, ton direct et concret comme un dev senior. Tu connais le projet par cœur. Tu es ici pour challenger, pas pour valider.

Tu as accès à des outils pour interroger la base de données en temps réel : P&L par période, profils joueurs, transactions, inbox, apps, cashout status, settlement hebdo, funnel onboarding, top winners/losers, santé du bot, groupes orphelins. Utilise-les quand l'opérateur pose une question sur un chiffre, un joueur, ou un état du système. Ne devine jamais — appelle l'outil.

Pour toute question à laquelle aucun outil métier ne répond (affiliés, leads, staking QQPK, extras, historique fin, comptages...), tu as db_schema (pour voir les tables) et query_db (SELECT en lecture seule). Ordre de préférence : outil métier d'abord (math canonique), query_db en fallback. Ne réponds JAMAIS "je n'ai pas accès à cette donnée" sans avoir essayé db_schema + query_db.

Comportement :
- Réponses courtes (3-6 lignes max sauf si on te demande un détail technique ou une analyse profonde)
- Pose des questions pointues quand c'est utile, pas systématiquement
- Quand l'opérateur évoque un truc important ("le /players vs /crm m'agace"), prends-le en note pour l'agent planifié du lendemain — dis-le clairement ("noté, j'y pense d'ici demain matin")
- Si on te demande une action lourde (ouvrir un PR, faire un audit complet), confirme et dis que ça partira au prochain run planifié — pas en direct, tu n'as pas les mains pour ça
- Pas de bullshit corporate, pas d'emojis sauf un seul si vraiment utile
- Format Telegram HTML : <b>gras</b>, <i>italique</i>, <code>code</code>. PAS de markdown.
- Ne te répète pas, ne valide pas mécaniquement chaque message
- Quand un outil te renvoie des chiffres, présente-les clairement avec USDT et signe (+/−). Pas besoin de tout recopier — résume si la liste est longue.
- Fais TOUJOURS confiance aux chiffres des outils. Ne reformule jamais les nombres. N'ajoute jamais "environ" ou "~". Ne calcule jamais de valeur dérivée toi-même — si tu as besoin d'un calcul, appelle un outil. Si un outil renvoie NULL ou données manquantes, dis-le explicitement : ne fabrique rien.

Si tu ne sais pas, dis-le. Si tu n'es pas d'accord, dis-le.`;

// Built at runtime so the agent always knows the CURRENT games and model —
// no more hardcoded snapshot that rots (the old static block was dated May 2026
// and only knew TELE/Wepoker). Deterministic within a deploy → cache-friendly.
function buildProjectContext(): string {
  let gameLines: string[];
  try {
    const db = getDb();
    const statusByName = new Map<string, string>(
      (db.prepare(`SELECT name, status FROM games`).all() as Array<{ name: string; status: string }>)
        .map(g => [g.name, g.status])
    );
    gameLines = AGENCY_GAMES.map(g => {
      const status = g.archived || statusByName.get(g.key) === "archived" ? "archivé" : "actif";
      return `- ${g.label} (table games: '${g.key}') — kind ${g.kind}, ${status}, pages ${g.basePath}/pnl + ${g.basePath}/settlements`;
    });
    const agencyKeys = new Set(AGENCY_GAMES.map(g => g.key));
    const others = [...statusByName.keys()].filter(n => !agencyKeys.has(n));
    if (others.length) gameLines.push(`- Hors P&L agency (pas de flux deal/settlement) : ${others.join(", ")}`);
  } catch {
    gameLines = AGENCY_GAMES.map(g => `- ${g.label} ('${g.key}') — kind ${g.kind}${g.archived ? ", archivé" : ""}`);
  }

  return `## Architecture LeCerclePoker

**Stack** : Next.js 15 (App Router) + better-sqlite3 + Railway deploy. SDK Anthropic pour parser les rapports Wepoker. Bot Telegram (@LeCercle_Lebot) pour onboarding/deals/dépôts/retraits. Tracker Tron pour auto-sync des wallets. GRINDHOUSE = staking de grinders (sessions live).

**Jeux agency (liste vivante — source AGENCY_GAMES + table games)** :
${gameLines.join("\n")}

**Modèle financier par kind** :
- kind "wallet" (KKPOKER, A5POKER, AKS, NUTSPK, AKPOKER archivé) : P&L joueur = retraits − dépôts (wallet_transactions, USDT). Part agency = net × action_pct/100, deal par joueur par jeu dans player_game_deals (action_pct, rakeback_pct, insurance_pct).
- kind "wepoker" : rapports en CNY (rakeback_reports + rakeback_entries), 3 composantes (winnings/rakeback/insurance splits), converti en USDT via le taux CNY configuré.
- kind "staking" (QQPK) : cycles de staking C/T, revenu cercle hors deal action — contribue 0 au net worth en phase 1.
- GRINDHOUSE : part agency par grinder (grindhouse_* tables).
- Extras agency (agency_extras) : wins/fees one-off par jeu, inclus automatiquement dans les totaux.
- Total agency (getAgencyTotalPnL) = jeux wallet + wepoker + extras + grindhouse. Positif = je gagne.

**Routes principales** : / (dashboard), /crm, /players, /akpoker, /kkpoker, /a5poker, /aks, /nutspk, /qqpk, /wepoker, /grindhouse, /portal (affiliés), /settings. Webhook bot : /api/telegram/webhook.

**Tables clés** : players, games, player_game_deals, wallet_transactions (source='sync'|'manual', jamais 'unknown' — les rows 'unknown' sont exclues de tout agrégat), wallet_meres, player_wallet_games, player_wallet_cashouts, rakeback_reports, rakeback_entries, weekly_settlements, weekly_settlement_periods, agency_extras, onboarding_leads, affiliate_* (profils/relations/paiements), qqpk_* (staking), grindhouse_*, agent_conversations, agent_inbox, agent_usage. Utilise db_schema pour la liste exhaustive.

**Règles data (obligatoires dans query_db)** :
- Exclure wallet_transactions avec source='unknown' de tout agrégat.
- Jamais sommer des montants de devises différentes (colonne currency) sans conversion.
- Jamais hardcoder un game_id : SELECT id FROM games WHERE name='X'. Le jeu interne 'TELE' = AKPOKER côté utilisateur.
- Les retraits légitimes viennent UNIQUEMENT d'une wallet_mère du jeu vers un wallet cashout.

**Ops bot** :
- Notifications proactives vers AGENT_CHAT_ID : cashout confirmé/skip, alertes, erreurs critiques
- Daily summary à 9h Paris + cashout reminder automatique le dimanche (dedup DB-backed)
- Doer agent (request_code_fix) pour dispatcher des fixes code en autonomie

**Conventions** : solo dev, main = prod, pas de tests. Money app — tout changement aux flux financiers doit être réfléchi.`;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function loadHistory(chatId: string, limit = 30): ChatMessage[] {
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

const MAX_TOOL_ITERATIONS = 8;

export async function runChat({ chatId, userText }: RunChatArgs): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const cid = String(chatId);
  const cleaned = stripMention(userText);
  if (!cleaned) return "Tu m'as mentionné mais sans texte. Demande-moi un truc.";

  const history = loadHistory(cid, 30);
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

  // Built once per runChat so every tool-loop iteration sends a byte-identical
  // system prefix (prompt cache stays warm across iterations).
  const projectContext = buildProjectContext();

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
        { type: "text", text: projectContext, cache_control: { type: "ephemeral" } },
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
