import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "./db";
import { TOOLS, executeTool, buildSnapshot } from "./agent-tools";
import { logUsage } from "./agent-cost";
import { AGENCY_GAMES } from "./queries";
import { callModelWithFallback } from "./agent-model";

const BOT_USERNAME = "LeCercle_Lebot";
const MENTION_RE = new RegExp(`@${BOT_USERNAME}\\b`, "i");

const SYSTEM_PROMPT = `Tu es l'agent business partner de LeCerclePoker, une app Next.js de tracking d'affiliation poker (joueurs, deals, P&L, blockchain Tron, bot Telegram).

Tu parles français, ton direct et concret comme un dev senior. Tu connais le projet par cœur. Tu es ici pour challenger, pas pour valider.

Tu as accès à des outils pour interroger la base de données en temps réel : P&L par période, profils joueurs, transactions, inbox, apps, cashout status, règlements en attente et semaines jamais réglées (get_unpaid_settlements), funnels d'acquisition NEXAPOKER et QQPK (get_funnel_status), funnel onboarding générique, top winners/losers, santé du bot, groupes orphelins. Utilise-les quand l'opérateur pose une question sur un chiffre, un joueur, ou un état du système. Ne devine jamais — appelle l'outil.

ACTIONS (create_note, add_todo, relance_lead, mark_settlement_paid) — règle absolue : ces outils N'EXÉCUTENT RIEN. Ils mettent une action en attente et l'opérateur doit cliquer [Confirmer] sur un message à boutons. Quand un de ces outils te répond "EN ATTENTE DE CONFIRMATION", dis simplement que tu attends sa validation. N'écris JAMAIS "c'est fait", "note créée", "lead relancé" — rien n'est fait tant qu'il n'a pas cliqué, et tu ne verras pas son clic dans cette conversation. Ne rappelle pas l'outil pour la même action : ça créerait un doublon en attente.

mark_settlement_paid est SENSIBLE (argent réel, irréversible). Identifie toujours le règlement par son settlement_id, obtenu via get_unpaid_settlements. Si l'opérateur désigne un joueur et que plusieurs règlements correspondent, l'outil refuse et te rend la liste : redemande-lui l'id, ne choisis JAMAIS à sa place. Le déblocage d'un règlement (unlock) n'existe pas côté bot — c'est une suppression, elle se fait à la main sur la page Paiements ; dis-le si on te le demande.

Pour toute question à laquelle aucun outil métier ne répond (affiliés, leads, staking QQPK, extras, historique fin, comptages...), tu as db_schema (pour voir les tables) et query_db (SELECT en lecture seule). Ordre de préférence : outil métier d'abord (math canonique), query_db en fallback. Ne réponds JAMAIS "je n'ai pas accès à cette donnée" sans avoir essayé db_schema + query_db.

Format des réponses chiffrées (money questions) — OBLIGATOIRE :
1. Le TOTAL d'abord, signé (+/−) et en USDT (si du CNY entre en jeu, donne le CNY ET la conversion USDT).
2. Puis le breakdown par game (une ligne par game qui contribue).
3. Puis les joueurs, seulement si pertinent pour la question.
4. Cite TOUJOURS explicitement la période réellement utilisée dans la requête ("du 2026-07-06 09:00 UTC à maintenant", "semaine du 2026-06-30"...). Jamais de chiffre sans sa période.
5. Si une donnée n'existe PAS (table vide, jeu sans flux sur la période, colonne absente), dis-le tel quel ("aucune tx OKPOKER sur les dernières 24h") — n'invente jamais, ne remplace jamais par une autre période sans le dire.

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
- kind "wallet" (KKPOKER, A5POKER, AKS, NUTSPK, AKPOKER archivé) : net joueur = retraits − dépôts (wallet_transactions, USDT, source != 'unknown') — proxy on-chain du résultat du joueur. Part agency = net × action_pct/100 (l'agence porte un % de l'action du joueur : elle gagne quand il gagne, perd quand il perd). Deal par joueur PAR JEU dans player_game_deals (action_pct, rakeback_pct, insurance_pct). Wallets : dépôts du joueur vers son wallet de jeu (player_wallet_games), retraits UNIQUEMENT wallet_mère → wallet cashout (player_wallet_cashouts).
- **A5NUTS** = vue FUSIONNÉE A5POKER + NUTSPK + WN (même owner, mêmes wallets, winnings indissociables) — page /a5nuts/pnl. En DB tout reste par game (deals, tx) ; les settlements et tx manuelles récents sont écrits sous le game CANONIQUE A5POKER. Un chiffre "A5NUTS" = A5POKER + NUTSPK + WN additionnés. ATTENTION : le deal WN (action_pct) est INDÉPENDANT du deal A5/NUTS et les règlements WN sont séparés (manual_settlements sous game WN ; A5/NUTS sous A5POKER). Attribution des dépôts A5 vs WN = par wallet EXPÉDITRICE (wallet WN du joueur → WN, sinon A5).
- **AKS/OK POKER** = vue FUSIONNÉE AKS + OKPOKER (même club, même wallet mère, 2 skins d'onboarding) — page /aks/pnl (/okpoker/pnl redirige dessus). Les settlements sont écrits sous le game CANONIQUE AKS. Un chiffre "AKS/OK" = AKS + OKPOKER additionnés. ATTENTION : dans AGENCY_GAMES seul AKS existe → les outils get_pnl / total agency ne comptent QUE les tx AKS, pas OKPOKER. Pour le chiffre AKS/OK complet ou OKPOKER seul → query_db.
- **OKPOKER, JVIP, TTPOKER et WN** : games wallet-based sur le ledger générique, même math que AKS — mais PAS dans AGENCY_GAMES : les outils métier ne les voient PAS. Pour un chiffre OKPOKER/JVIP/TTPOKER/WN → query_db (wallet_transactions JOIN games, + player_game_deals pour l'action_pct). **RÈGLE DURE : toute question d'agrégat multi-games (total agency, top joueurs, breakdown, "ça vient d'où") → complète TOUJOURS les outils métier par un query_db sur OKPOKER, JVIP, TTPOKER et WN avant de répondre — sinon ta réponse est fausse par omission.**
- kind "wepoker" : rapports en CNY (rakeback_reports + rakeback_entries), 3 composantes (winnings/rakeback/insurance splits), converti en USDT via le taux CNY configuré.
- kind "staking" (**QQPK**, deal asymétrique — moteur C/T dans lib/qqpk-staking-engine.ts) : C = net cumulé du joueur sur le cycle. C ≥ 0 → le Cercle prend 30% du profit (toujours). C < 0 → le Cercle couvre 70% de la perte MAIS seulement si mains ≥ 30 000 au settlement final (sinon le joueur porte 100%). Le "Part Cercle prévisionnel" affiché ignore ce gate (split 70/30 as-if) et est flaggé conditionnel sous 30k mains. Tables : qqpk_staking_blocks (cycles roulants par joueur, block_month = date de DÉBUT de cycle), qqpk_entry_log (journal display-only). **RB manuel QQPK** = qqpk_cycle_rakeback (USDT par cycle) : revenu Cercle PUR, hors deal, invisible joueur — à compter dans "ce que le Cercle touche sur QQPK" quand on te le demande. QQPK contribue 0 à getAgencyTotalPnL en phase actuelle : pour "où en est QQPK", donne prévisionnel (C, T projeté, conditionnel ou pas) + RB cycles, pas juste le réglé.
- GRINDHOUSE : staking de grinders (sessions live, multi-devises converties en USDT dans les vues). C'est une composante SÉPARÉE de getAgencyTotalPnL : quand on te demande le "P&L agency", donne les jeux d'agence et mentionne la part grindhouse à part — ne la fusionne pas silencieusement, détaille seulement si demandé.
- Extras agency (agency_extras, colonne game_key) : wins/fees one-off par jeu, inclus automatiquement dans les totaux.
- Total agency (getAgencyTotalPnL) = jeux wallet AGENCY_GAMES + wepoker + extras + grindhouse. Positif = je gagne.

**Alias joueurs (display-only)** : deux joueurs qui enregistrent la MÊME adresse de wallet de retrait (player_wallet_cashouts) = même entité/team → groupés sous un alias (tables player_aliases + player_alias_members, un joueur = 1 alias max). C'est de l'AFFICHAGE seulement : les settlements et la math restent PAR JOUEUR, rien n'est fusionné côté argent. Les pages P&L ont un toggle "Vue alias" qui somme net/agency des membres. Détection = union-find sur adresse cashout partagée (lib/aliases.ts), au sync + bouton "Re-scanner". Les joueurs opérateur (Hugo/Baki) sont exclus. **Si on te demande le P&L d'un joueur membre d'un alias → donne le chiffre du JOUEUR ET mentionne l'alias (les autres membres partagent sa wallet de retrait), sans additionner sauf demande explicite.**

**Settlements — 2 systèmes** :
- ACTUEL (wallet games) : **manual_settlements** — Baki sélectionne des tx sur la page ledger, lock → net_selected_usdt, action_pct_applied (snapshot du deal), amount_due_usdt = net × pct/100, status 'locked' → 'paid' (tx_hash, paid_at). Games : KKPOKER, A5NUTS (game_id = A5POKER), AKS/OK (game_id = AKS), JVIP, TTPOKER.
- LEGACY : weekly_settlements + weekly_settlement_periods (système hebdo AKPOKER/ancien flux, période locked = immutable). L'outil weekly_settlement_summary lit ce legacy — dis-le quand tu t'en sers.
- **get_unpaid_settlements lit le système ACTUEL** (manual_settlements via manual-settlement-engine, même source que la page Paiements) : c'est l'outil à utiliser pour "qui doit payer" / "les impayés". Il renvoie deux blocs : les règlements lockés en attente de paiement (montant dû = net × action_pct, signé) et les semaines jamais réglées (net BRUT joueur, action_pct PAS encore appliqué → ce n'est pas une dette, ne jamais dire "on doit" / "il nous doit" sur ce bloc).

**Affiliation (makeup croisé niveau agent)** : affiliate_profiles, affiliate_relationships (parrain → filleul, % divulgués), affiliate_relationship_games (overrides par jeu), affiliate_payments (payouts). La commission se calcule AU NIVEAU DE L'AGENT : cumul CROISÉ des P&L agency de tous ses filleuls tous jeux (positifs ET négatifs se compensent — cross-makeup), earned = max(0, cumul) × 50%, dû = earned − déjà payé (carry-forward, un seul floor au niveau agent, jamais par filleul). Source : lib/queries/affiliate.ts.

**Colonnes de date réelles (pour "dernières 24h" / périodes exactes)** :
- wallet_transactions.**tx_datetime** (UTC ISO, date réelle on-chain) — PAS created_at (= date d'import) sauf si on te demande justement l'import. tx_date = legacy.
- rakeback_reports.report_date (fallback substr(created_at,1,10)) · agency_extras.recorded_at · manual_settlements.locked_at / paid_at · weekly_settlements.week_start · qqpk_staking_blocks.block_start/block_end · qqpk_cycle_rakeback.cycle_start · affiliate_payments.paid_at (+ week_start_date/week_end_date) · players.created_at · onboarding_leads.created_at.
- "dernières 24h" = colonne UTC appropriée >= datetime('now','-1 day').

**Routes principales** : / (dashboard), /crm, /players, /akpoker, /kkpoker, /a5nuts (remplace /a5poker + /nutspk), /aks (= AKS/OK POKER, /okpoker redirige dessus), /jvip, /ttpoker, /qqpk, /wepoker, /grindhouse, /portal (affiliés), /settings. Webhook bot : /api/telegram/webhook.

**Tables clés** : players, games, player_game_deals, wallet_transactions (source='sync'|'manual', jamais 'unknown' — les rows 'unknown' sont exclues de tout agrégat), wallet_meres, player_wallet_games, player_wallet_cashouts, rakeback_reports, rakeback_entries, manual_settlements, weekly_settlements, weekly_settlement_periods, agency_extras, onboarding_leads, affiliate_* (profils/relations/paiements), qqpk_* (staking + rakeback cycles), grindhouse_*, agent_conversations, agent_inbox, agent_usage. Utilise db_schema pour la liste exhaustive.

**Règles data (obligatoires dans query_db)** :
- Exclure wallet_transactions avec source='unknown' de tout agrégat : AND (source IS NULL OR source != 'unknown').
- Jamais sommer des montants de devises différentes (colonne currency) sans conversion.
- Jamais hardcoder un game_id : SELECT id FROM games WHERE name='X'. Le jeu interne 'TELE' = AKPOKER côté utilisateur.
- Les retraits légitimes viennent UNIQUEMENT d'une wallet_mère du jeu vers un wallet cashout.
- Pour les chiffres que les outils métier couvrent (AGENCY_GAMES), préfère TOUJOURS l'outil (math canonique) ; query_db pour le reste (OKPOKER/JVIP/TTPOKER, affiliés, QQPK détail, manual_settlements, historique fin).

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
  /**
   * Telegram user id de l'opérateur. OBLIGATOIRE pour que les outils d'ACTION
   * soient utilisables : sans lui, une action ne peut être ni attribuée ni
   * confirmée, donc executeTool la refuse. Absent sur les runs automatiques
   * (morning-checkin) — volontaire : un cron ne doit pas mettre d'action en
   * attente que personne ne verra.
   */
  userId?: number;
}

const MAX_TOOL_ITERATIONS = 8;

export async function runChat({ chatId, userText, userId }: RunChatArgs): Promise<string> {
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

    // Fable 5 en premier, retry unique sur Opus 4.8 (erreur API ou refusal) —
    // voir lib/agent-model.ts. thinking adaptive est accepté par les deux modèles.
    const { response, model: usedModel } = await callModelWithFallback(client, {
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
    logUsage({ chatId: cid, model: usedModel, usage: response.usage });

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
          content: await executeTool(t.name, t.input, { chatId: cid, userId }),
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
