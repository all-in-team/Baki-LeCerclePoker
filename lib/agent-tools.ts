import Anthropic from "@anthropic-ai/sdk";
import { getDb, getReadonlyDb } from "./db";
import { todayCost, usageBetween } from "./agent-cost";
import { dispatchFix, isWithinBudget, recentDoerSessions, looksMoneyFlow } from "./agent-doer";
import { getCurrentWeekStart } from "./telegram-commands/cashout-reminder";
import { getWeekBounds, toUTCISO, toParisDate } from "./date-utils";
import { getLockAwareSummaryByPlayer, getLockAwareKPIs, getWalletSummaryByPlayer, getAkpokerPnL, getKkpokerPnL, getA5pokerPnL, getAksPnL, getNutspkPnL, getWepokerPnL, getAgencyTotalPnL, getTopContributors, getActivePlayersCount, getPlayerPnLAllGames, type Period } from "./queries";
import { checkUserbotHealth, listGroups } from "./telegram-userbot";
import { isActionTool, createPendingAction } from "./agent-actions";

// ────────────────────────────────────────────────────────────
// Period parsing — accepts: today | yesterday | week | month |
// ytd | YYYY-MM-DD | YYYY-MM-DD..YYYY-MM-DD
// Returns { start, end } as ISO date strings (YYYY-MM-DD).
// ────────────────────────────────────────────────────────────
function parsePeriod(period: string): { start: string; end: string; label: string } {
  const today = new Date().toISOString().slice(0, 10);
  const p = period.trim().toLowerCase();
  if (p === "today" || p === "aujourd'hui") return { start: today, end: today, label: "aujourd'hui" };
  if (p === "yesterday" || p === "hier") {
    const d = new Date(); d.setDate(d.getDate() - 1);
    const yest = d.toISOString().slice(0, 10);
    return { start: yest, end: yest, label: "hier" };
  }
  if (p === "week" || p === "semaine") {
    const d = new Date(); d.setDate(d.getDate() - 7);
    return { start: d.toISOString().slice(0, 10), end: today, label: "7 derniers jours" };
  }
  if (p === "month" || p === "mois") {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return { start: d.toISOString().slice(0, 10), end: today, label: "30 derniers jours" };
  }
  if (p === "ytd") {
    const yr = new Date().getFullYear();
    return { start: `${yr}-01-01`, end: today, label: `année ${yr}` };
  }
  // Custom range: YYYY-MM-DD..YYYY-MM-DD
  const range = p.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (range) return { start: range[1], end: range[2], label: `${range[1]} → ${range[2]}` };
  // Single date
  const single = p.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (single) return { start: single[1], end: single[1], label: single[1] };
  // Default: today
  return { start: today, end: today, label: "aujourd'hui (défaut)" };
}

// ────────────────────────────────────────────────────────────
// Snapshot — used for the always-injected "état du jour"
// ────────────────────────────────────────────────────────────
export function buildSnapshot(): string {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const txToday = db.prepare(
    `SELECT type, COALESCE(SUM(amount), 0) AS amt, COUNT(*) AS n
     FROM wallet_transactions
     WHERE date(created_at) = ? AND (source IS NULL OR source != 'unknown')
     GROUP BY type`
  ).all(today) as Array<{ type: string; amt: number; n: number }>;

  const dep = txToday.find(t => t.type === "deposit");
  const wd = txToday.find(t => t.type === "withdrawal");

  const playersActive = (db.prepare(
    `SELECT COUNT(*) AS n FROM players WHERE status = 'active'`
  ).get() as { n: number }).n;

  const playersTotal = (db.prepare(`SELECT COUNT(*) AS n FROM players`).get() as { n: number }).n;

  const inboxN = (db.prepare(
    `SELECT COUNT(*) AS n FROM agent_inbox WHERE processed_at IS NULL`
  ).get() as { n: number }).n;

  const lastSync = db.prepare(
    `SELECT MAX(created_at) AS ts FROM wallet_transactions WHERE tron_tx_hash IS NOT NULL`
  ).get() as { ts: string | null };

  // Cumulative agency P&L (all-time) — canonical math from lib/queries.ts
  // (all games + extras + grindhouse), not a local SQL approximation.
  let myPnl = 0;
  try { myPnl = getAgencyTotalPnL().total_usdt; } catch { /* fresh DB */ }

  const cost = todayCost();

  const lines = [
    `📅 ${today}`,
    `💸 Aujourd'hui — dépôts: ${dep ? dep.amt.toFixed(0) : 0} USDT (${dep ? dep.n : 0} tx) · retraits: ${wd ? wd.amt.toFixed(0) : 0} USDT (${wd ? wd.n : 0} tx)`,
    `👥 Joueurs: ${playersActive}/${playersTotal} actifs`,
    `📊 Mon P&L cumulé (all-time): ${myPnl >= 0 ? "+" : ""}${myPnl.toFixed(0)} USDT`,
    `📥 Inbox agent: ${inboxN} message${inboxN !== 1 ? "s" : ""} en attente`,
    `🔄 Dernière sync wallet: ${lastSync.ts ? lastSync.ts.replace("T", " ").slice(0, 16) : "jamais"}`,
    `🤖 Crédit Claude aujourd'hui: $${cost.cost_usd.toFixed(3)} (${cost.calls} appel${cost.calls !== 1 ? "s" : ""})`,
  ];
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────
// Tool definitions (sorted alphabetically for cache stability)
// ────────────────────────────────────────────────────────────
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "bot_health",
    description: "Santé du système : session userbot Telegram, nombre de groupes, dernière sync wallet, erreurs récentes.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "cashout_status_this_week",
    description: "État des cashouts de la semaine : combien confirmé, pas joué, en attente de réponse, pas encore relancé.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "db_schema",
    description: "Schéma de la base SQLite : liste compacte des tables avec leurs colonnes. Optionnel : passer un nom de table pour voir son CREATE TABLE complet. À appeler avant query_db pour savoir ce qui existe.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Optionnel : nom exact d'une table pour le détail complet" },
      },
      required: [],
    },
  },
  {
    name: "query_db",
    description: "Exécute une requête SQL SELECT en LECTURE SEULE sur la base de production. À utiliser en fallback quand aucun outil métier ne répond à la question (affiliés, leads, staking QQPK, extras, historique fin...). Pour les chiffres P&L/settlement, préfère TOUJOURS les outils métier (get_pnl, weekly_settlement_summary...) — ce sont eux qui portent la math canonique. Règles : une seule requête SELECT/WITH, max 200 lignes retournées. Rappels invariants : exclure wallet_transactions avec source='unknown' des agrégats ; ne jamais sommer des devises différentes ; le jeu 'TELE' = AKPOKER.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "Requête SQL SELECT (ou WITH ... SELECT). Une seule instruction, pas d'écriture." },
      },
      required: ["sql"],
    },
  },
  {
    name: "find_orphan_groups",
    description: "Trouve les groupes Telegram 'x LeCercle' visibles au userbot qui ne sont associés à aucun joueur en base.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_apps_overview",
    description: "Liste tous les poker apps configurés (TELE, Wepoker, Xpoker, ClubGG, et tout club ajouté) avec le nombre de joueurs actifs sur chacun.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_claude_usage",
    description: "Coût Claude API consommé sur une période. Renvoie total $, nombre d'appels, breakdown tokens. Période = 'today', 'yesterday', 'week', 'month', 'ytd', YYYY-MM-DD, ou plage YYYY-MM-DD..YYYY-MM-DD.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", description: "today, yesterday, week, month, ytd, YYYY-MM-DD, ou YYYY-MM-DD..YYYY-MM-DD" },
      },
      required: ["period"],
    },
  },
  {
    name: "get_inbox_messages",
    description: "Récupère les messages dans l'inbox de l'agent — les choses que l'opérateur a évoquées dans le chat et qui attendent traitement par un agent planifié. Renvoie les 20 derniers non-traités par défaut.",
    input_schema: {
      type: "object",
      properties: {
        include_processed: { type: "boolean", description: "Si true, inclut aussi les messages déjà traités" },
        limit: { type: "integer", description: "Nombre max à retourner (défaut 20)" },
      },
      required: [],
    },
  },
  {
    name: "get_pnl",
    description: "Calcule le P&L (mon profit selon les % deal action) sur une période donnée. Période = 'today', 'yesterday', 'week', 'month', 'ytd', ou date 'YYYY-MM-DD', ou plage 'YYYY-MM-DD..YYYY-MM-DD'. Optionnel: filtrer par joueur (nom ou handle).",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", description: "today, yesterday, week, month, ytd, YYYY-MM-DD, ou YYYY-MM-DD..YYYY-MM-DD" },
        player: { type: "string", description: "Optionnel: nom ou @handle du joueur" },
      },
      required: ["period"],
    },
  },
  {
    name: "get_recent_agency_extras",
    description: "Liste les extras agency récents (wins et fees one-off non liés à un joueur, inclus automatiquement dans tous les P&L). Optionnel: filtrer par game (akpoker/wepoker).",
    input_schema: {
      type: "object",
      properties: {
        game_key: { type: "string", enum: ["akpoker", "wepoker"], description: "Filtre par game" },
        limit: { type: "integer", description: "Nombre max (défaut 10)" },
      },
      required: [],
    },
  },
  {
    name: "get_player_detail",
    description: "Profil complet d'un joueur : tier, status, deals par game, balance par game, 10 dernières transactions, wallets Tron. Recherche par nom ou @handle (matching partiel).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Nom ou @handle (partiel ok, ex: 'baki' trouve 'Baki')" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_recent_transactions",
    description: "Les N dernières transactions wallet (dépôts/retraits) tous joueurs confondus. Optionnel: filtrer par type ou joueur.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Nombre de transactions (défaut 20, max 100)" },
        type: { type: "string", enum: ["deposit", "withdrawal"], description: "Filtre par type" },
        player: { type: "string", description: "Filtre par nom de joueur" },
      },
      required: [],
    },
  },
  {
    name: "list_players",
    description: "Liste tous les joueurs avec leur tier, status, et solde net cumulé. Optionnel: filtrer par status.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "inactive", "churned"], description: "Filtre par status" },
      },
      required: [],
    },
  },
  {
    name: "get_unpaid_settlements",
    description: "Qui doit payer / qui attend d'être payé. Deux blocs, lus sur le système ACTUEL (manual_settlements via manual-settlement-engine, la même source que la page Paiements) : (1) règlements lockés en attente de paiement, avec le montant dû signé et l'ancienneté depuis le lock ; (2) semaines jamais réglées (anti-oubli), avec le net brut joueur. ATTENTION : le net brut du bloc 2 n'est PAS un montant dû (l'action_pct n'a pas encore été appliqué) — ne jamais le présenter avec « on doit » / « il nous doit ».",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "onboarding_funnel",
    description: "Comptage du funnel GÉNÉRIQUE : leads par stage (welcome/discovered/joined) dans onboarding_leads + joueurs par status (active/inactive/churned). Ne couvre PAS les funnels d'acquisition NEXAPOKER et QQPK — pour ceux-là, utiliser get_funnel_status.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_note",
    description: "ACTION — Crée une note CRM sur un joueur. N'exécute RIEN immédiatement : met l'action en attente et l'opérateur doit cliquer [Confirmer]. Ne prétends jamais que la note est créée avant d'avoir vu une confirmation.",
    input_schema: {
      type: "object",
      properties: {
        player: { type: "string", description: "Nom exact ou id du joueur." },
        content: { type: "string", description: "Contenu de la note." },
        type: { type: "string", enum: ["note", "call", "payment", "alert", "message"], description: "Type de note. Défaut: note." },
      },
      required: ["player", "content"],
    },
  },
  {
    name: "add_todo",
    description: "ACTION — Ajoute une entrée à l'inbox de l'agent (todo repris par le run planifié du lendemain). N'exécute RIEN immédiatement : met l'action en attente, l'opérateur doit cliquer [Confirmer].",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Le todo à retenir." },
      },
      required: ["message"],
    },
  },
  {
    name: "relance_lead",
    description: "ACTION — Envoie une relance manuelle à un lead NEXAPOKER (seul funnel avec relance par lead ; QQPK n'a qu'une relance de masse planifiée). N'exécute RIEN immédiatement : met l'action en attente, l'opérateur doit cliquer [Confirmer].",
    input_schema: {
      type: "object",
      properties: {
        lead: { type: "string", description: "id, member_id, @username ou tg_user_id du lead." },
        funnel: { type: "string", enum: ["nexa"], description: "Funnel. Seul 'nexa' est supporté." },
      },
      required: ["lead"],
    },
  },
  {
    name: "mark_settlement_paid",
    description: "ACTION SENSIBLE (argent réel) — Marque un règlement comme payé, via la même fonction que le bouton « Marquer payé » de la page Paiements. N'exécute RIEN immédiatement : met l'action en attente avec un récap complet, l'opérateur doit cliquer [Confirmer]. IRRÉVERSIBLE une fois confirmé : il n'existe pas de « démarquer payé ». Identifie le règlement par son settlement_id (tu l'obtiens avec get_unpaid_settlements) ; si tu ne donnes que le joueur et que plusieurs règlements correspondent, l'action est refusée avec la liste des candidats — redemande alors l'id exact à l'opérateur, ne choisis jamais à sa place. Le déblocage d'un règlement (unlock) n'est PAS disponible via le bot : c'est une suppression, elle se fait à la main sur la page Paiements.",
    input_schema: {
      type: "object",
      properties: {
        settlement_id: { type: "integer", description: "Id du règlement (voie recommandée)." },
        player: { type: "string", description: "Nom du joueur, si l'id n'est pas connu. Refusé si ambigu." },
        room: { type: "string", description: "Room, pour lever une ambiguïté (ex. KKPOKER)." },
        tx_hash: { type: "string", description: "Hash de la transaction de paiement, si fourni par l'opérateur." },
        paid_date: { type: "string", description: "Jour réel du paiement, YYYY-MM-DD. Omettre si c'est aujourd'hui." },
      },
      required: [],
    },
  },
  {
    name: "get_funnel_status",
    description: "État des funnels d'acquisition NEXAPOKER (table nexa_leads) et QQPK (table qqpk_funnel_leads) : nombre de leads par étape, plus les compteurs de relances, de leads froids et de doublons côté Nexa. C'est l'outil à appeler pour toute question sur « le funnel Nexa » ou « le funnel QQPK ».",
    input_schema: {
      type: "object",
      properties: {
        funnel: { type: "string", enum: ["nexa", "qqpk", "all"], description: "Quel funnel. Défaut: all." },
      },
      required: [],
    },
  },
  {
    name: "pending_cashouts_now",
    description: "Liste les joueurs en attente de cashout cette semaine : nom, nombre de relances, temps écoulé depuis le dernier message.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_doer_sessions",
    description: "Liste les dernières sessions du doer agent (PRs en cours, terminées, échouées) — utile quand l'opérateur demande 'où en est le fix de tout à l'heure ?'.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Nombre max (défaut 5)" },
      },
      required: [],
    },
  },
  {
    name: "revenue_breakdown",
    description: "Décomposition du revenu opérateur par joueur : dépôts, retraits, net joueur, mon P&L (action %) en USDT. Optionnel: période.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", description: "today, yesterday, week, month, ytd, YYYY-MM-DD, ou YYYY-MM-DD..YYYY-MM-DD. Défaut: week." },
      },
      required: [],
    },
  },
  {
    name: "request_code_fix",
    description: "Demande au doer agent (Anthropic Managed Agents en cloud) d'attaquer un fix ou une feature. Le doer va cloner le repo, faire le changement, ouvrir une PR, puis poster un récap dans le groupe. Use quand l'opérateur dit clairement 'fix X', 'ajoute Y', 'change Z', 'corrige W'. Pour des questions ou réflexions, n'utilise PAS ce tool — réponds directement. Si la requête touche au code financier (deal/depot/retrait/wallet/PnL/rakeback), demande money_ok=true seulement si l'opérateur l'a explicitement autorisé via 'money:ok' dans son message.",
    input_schema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Description claire du fix/feature pour le doer (en français). Inclus le contexte (quel fichier, quelle page, quel comportement attendu). Le doer va lire ça et agir en autonomie.",
        },
        money_ok: {
          type: "boolean",
          description: "true SEULEMENT si l'opérateur a explicitement écrit 'money:ok' dans son message — sinon laisse à false.",
        },
      },
      required: ["description"],
    },
  },
  {
    name: "top_players_this_week",
    description: "Top N gagnants ou perdants de la semaine (P&L joueur). Défaut: top 5 winners.",
    input_schema: {
      type: "object",
      properties: {
        side: { type: "string", enum: ["winners", "losers"], description: "winners (défaut) ou losers" },
        limit: { type: "integer", description: "Nombre (défaut 5)" },
      },
      required: [],
    },
  },
  {
    name: "weekly_settlement_summary",
    description: "Résumé du settlement hebdo : dépôts totaux, retraits totaux, net, mon P&L, par joueur. Optionnel : week_offset (0=cette semaine, -1=dernière, etc.).",
    input_schema: {
      type: "object",
      properties: {
        week_offset: { type: "integer", description: "0 = semaine en cours, -1 = semaine dernière. Défaut 0." },
      },
      required: [],
    },
  },
];

// ────────────────────────────────────────────────────────────
// Tool execution
// ────────────────────────────────────────────────────────────
function findPlayerLoose(query: string): Array<{ id: number; name: string }> {
  const q = `%${query.replace(/^@/, "").toLowerCase()}%`;
  return getDb().prepare(
    `SELECT id, name FROM players
     WHERE LOWER(name) LIKE ? OR LOWER(COALESCE(telegram_handle, '')) LIKE ?
     LIMIT 5`
  ).all(q, q) as Array<{ id: number; name: string }>;
}

function fmtAmount(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

// One line per contributor, only the games where they actually have P&L.
function fmtContributorParts(c: any): string {
  const parts: string[] = [];
  if (c.akpoker_usdt) parts.push(`AK: ${fmtAmount(c.akpoker_usdt)}`);
  if (c.kkpoker_usdt) parts.push(`KK: ${fmtAmount(c.kkpoker_usdt)}`);
  if (c.a5poker_usdt) parts.push(`A5: ${fmtAmount(c.a5poker_usdt)}`);
  if (c.aks_usdt) parts.push(`AKS: ${fmtAmount(c.aks_usdt)}`);
  if (c.nutspk_usdt) parts.push(`NUTSPK: ${fmtAmount(c.nutspk_usdt)}`);
  if (c.wepoker_usdt) parts.push(`WP: ${fmtAmount(c.wepoker_usdt)}`);
  if (c.grindhouse_usdt) parts.push(`GH: ${fmtAmount(c.grindhouse_usdt)}`);
  return parts.length ? parts.join(" · ") : "—";
}

const SQL_FORBIDDEN = /\b(attach|pragma|vacuum|reindex|insert|update|delete|drop|alter|create|replace|begin|commit|rollback|recursive)\b/i;
// telegram_sessions holds GramJS credentials (full Telegram account access) —
// never readable nor listable through the agent's SQL surface.
const SQL_DENYLIST_TABLES = /\btelegram_sessions\b/i;

function runReadonlyQuery(rawSql: string): string {
  const sql = String(rawSql ?? "").trim().replace(/;\s*$/, "");
  if (!sql) return "❌ Requête vide.";
  if (!/^(select|with)\b/i.test(sql)) return "❌ Refusé : seules les requêtes SELECT (ou WITH ... SELECT) sont autorisées.";
  if (sql.includes(";")) return "❌ Refusé : une seule instruction SQL à la fois.";
  if (SQL_FORBIDDEN.test(sql)) return "❌ Refusé : mot-clé d'écriture ou d'administration détecté. Lecture seule.";
  if (SQL_DENYLIST_TABLES.test(sql)) return "❌ Refusé : table sensible (credentials) inaccessible via cet outil.";

  const stmt = getReadonlyDb().prepare(sql);
  if (!stmt.reader) return "❌ Refusé : cette requête ne retourne pas de lignes (lecture seule).";

  const MAX_ROWS = 200;
  const MAX_CHARS = 8000;
  const rows: any[] = [];
  let truncatedRows = false;
  for (const row of stmt.iterate()) {
    if (rows.length >= MAX_ROWS) { truncatedRows = true; break; }
    rows.push(row);
  }
  if (rows.length === 0) return "(0 ligne)";

  const cols = Object.keys(rows[0]);
  const lines = [
    cols.join(" | "),
    ...rows.map(r => cols.map(c => {
      const v = (r as any)[c];
      if (v === null || v === undefined) return "NULL";
      if (typeof v === "number" && !Number.isInteger(v)) return v.toFixed(2);
      return String(v);
    }).join(" | ")),
  ];
  let out = lines.join("\n");
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS) + "\n… (sortie tronquée à 8 Ko)";
  if (truncatedRows) out += `\n… (résultat tronqué à ${MAX_ROWS} lignes — affine ta requête)`;
  out += `\n(${rows.length}${truncatedRows ? "+" : ""} ligne${rows.length > 1 ? "s" : ""})`;
  return out;
}

/** Contexte de la conversation, requis pour toute ACTION (jamais pour la lecture). */
export interface ToolContext {
  chatId: string;
  /** Telegram user id de l'opérateur. Absent sur un run automatique (cron). */
  userId?: number;
}

export async function executeTool(name: string, input: any, ctx?: ToolContext): Promise<string> {
  const db = getDb();

  try {
    // ── ACTIONS ─────────────────────────────────────────
    // Rien n'est exécuté ici. On enregistre une intention et on rend la main.
    // L'exécution part uniquement du clic [Confirmer] (cf. lib/agent-actions.ts).
    if (isActionTool(name)) {
      if (!ctx?.userId) {
        return `❌ Action impossible : pas de contexte utilisateur (run automatique). Les actions ne peuvent être déclenchées que depuis une conversation avec un opérateur.`;
      }
      const r = await createPendingAction({ chatId: ctx.chatId, userId: ctx.userId, tool: name, params: input });
      if (!r.ok) return `❌ Action non mise en attente : ${r.error}`;
      return [
        `⏸ Action #${r.id} EN ATTENTE DE CONFIRMATION — rien n'a été exécuté.`,
        r.preview.replace(/<[^>]+>/g, ""),
        `L'opérateur doit cliquer [Confirmer] ou [Annuler] sous le message qui va suivre.`,
        `Annonce-lui simplement que tu attends sa confirmation. N'affirme JAMAIS que l'action est faite, et ne rappelle pas cet outil pour la même action.`,
      ].join("\n");
    }

    if (name === "db_schema") {
      const ro = getReadonlyDb();
      const table = input?.table ? String(input.table).trim() : null;
      if (table) {
        if (SQL_DENYLIST_TABLES.test(table)) return `❌ Table sensible (credentials) inaccessible via cet outil.`;
        const row = ro.prepare(`SELECT sql FROM sqlite_master WHERE type IN ('table','view') AND name = ?`).get(table) as { sql: string } | undefined;
        if (!row?.sql) return `Table "${table}" introuvable.`;
        return row.sql;
      }
      const tables = (ro.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[])
        .filter(t => !SQL_DENYLIST_TABLES.test(t.name));
      const lines = tables.map(t => {
        const cols = ro.pragma(`table_info("${t.name.replace(/"/g, '""')}")`) as Array<{ name: string }>;
        return `${t.name}(${cols.map(c => c.name).join(", ")})`;
      });
      return lines.join("\n");
    }

    if (name === "query_db") {
      return runReadonlyQuery(input?.sql);
    }

    if (name === "get_apps_overview") {
      const apps = db.prepare(
        `SELECT a.id, a.name, a.deal_type, a.deal_value, a.currency, a.club_name,
                (SELECT COUNT(*) FROM player_app_assignments paa WHERE paa.app_id = a.id AND paa.status = 'active') AS active_players
         FROM poker_apps a ORDER BY a.name, a.club_name`
      ).all() as any[];
      if (apps.length === 0) return "Aucun poker app configuré.";
      return apps.map(a =>
        `${a.name}${a.club_name ? ` (${a.club_name})` : ""} — ${a.deal_type} ${a.deal_value}${a.currency || ""} — ${a.active_players} joueur(s) actif(s)`
      ).join("\n");
    }

    if (name === "get_claude_usage") {
      const { start, end, label } = parsePeriod(input?.period ?? "today");
      const u = usageBetween(start, end);
      if (u.calls === 0) return `Aucun appel Claude sur ${label}.`;
      const lines = [
        `Coût Claude (${label}): $${u.cost_usd.toFixed(3)} sur ${u.calls} appel(s)`,
        `Tokens: ${u.input_tokens} input, ${u.output_tokens} output, ${u.cache_read_tokens} cache-read, ${u.cache_creation_tokens} cache-write`,
      ];
      if (u.by_day.length > 1) {
        lines.push("Par jour :");
        u.by_day.forEach(d => lines.push(`  ${d.day}: $${d.cost_usd.toFixed(3)} (${d.calls} appels)`));
      }
      return lines.join("\n");
    }

    if (name === "get_inbox_messages") {
      const limit = Math.min(input?.limit ?? 20, 100);
      const includeProcessed = input?.include_processed === true;
      const where = includeProcessed ? "" : "WHERE processed_at IS NULL";
      const rows = db.prepare(
        `SELECT id, message, created_at, processed_at FROM agent_inbox ${where} ORDER BY created_at DESC LIMIT ?`
      ).all(limit) as any[];
      if (rows.length === 0) return "Inbox vide.";
      return rows.map(r =>
        `[${r.created_at.slice(0, 16).replace("T", " ")}${r.processed_at ? " ✓" : ""}] ${r.message}`
      ).join("\n");
    }

    if (name === "get_pnl") {
      const { start, end, label } = parsePeriod(input?.period ?? "today");
      const playerFilter = input?.player ? findPlayerLoose(input.player) : null;
      if (input?.player && (!playerFilter || playerFilter.length === 0)) {
        return `Aucun joueur trouvé pour "${input.player}".`;
      }
      if (playerFilter && playerFilter.length > 1) {
        return `Plusieurs joueurs correspondent à "${input.player}":\n${playerFilter.map(p => `- ${p.name}`).join("\n")}\nPrécise.`;
      }

      const playerId = playerFilter?.[0]?.id ?? undefined;
      const period: Period = { from: start, to: end };
      const total = getAgencyTotalPnL(period);
      const walletGames: Array<{ label: string; rows: ReturnType<typeof getAkpokerPnL> }> = [
        { label: "AKPOKER", rows: getAkpokerPnL(playerId, period) },
        { label: "KKPOKER", rows: getKkpokerPnL(playerId, period) },
        { label: "A5POKER", rows: getA5pokerPnL(playerId, period) },
        { label: "AKS", rows: getAksPnL(playerId, period) },
        { label: "NUTSPK", rows: getNutspkPnL(playerId, period) },
      ];
      const wp = getWepokerPnL(playerId, period);

      const lines: string[] = [`P&L (${label}):`];
      let anyData = wp.length > 0;
      for (const g of walletGames) {
        if (!g.rows.length) continue;
        anyData = true;
        lines.push(`\n${g.label}:`);
        g.rows.forEach(r => lines.push(`  ${r.player_name} [${r.action_pct}%] — dép:${r.deposited.toFixed(0)} ret:${r.withdrawn.toFixed(0)} net:${fmtAmount(r.net_usdt)} agency:${fmtAmount(r.agency_cut_usdt)} USDT`));
      }
      if (wp.length) {
        lines.push(`\nWEPOKER:`);
        wp.forEach(r => lines.push(`  ${r.player_name} [${r.action_pct}%] — agency: winnings ${fmtAmount(r.agency_winnings_split_cny)} + RB ${fmtAmount(r.agency_rakeback_split_cny)} + ins ${fmtAmount(r.agency_insurance_split_cny)} = ${fmtAmount(r.total_agency_cny)} CNY (${fmtAmount(r.total_agency_usdt)} USDT)`));
      }
      if (!playerId) {
        lines.push(`\nTotal agency: ${fmtAmount(total.total_usdt)} USDT`);
        lines.push(`  AK: ${fmtAmount(total.akpoker_usdt)} · KK: ${fmtAmount(total.kkpoker_usdt)} · A5: ${fmtAmount(total.a5poker_usdt)} · AKS: ${fmtAmount(total.aks_usdt)} · NUTSPK: ${fmtAmount(total.nutspk_usdt)} · WP: ${fmtAmount(total.wepoker_usdt)} · GH: ${fmtAmount(total.grindhouse_usdt)}`);
        if (total.extras_usdt) lines.push(`  dont extras (tous jeux): ${fmtAmount(total.extras_usdt)} USDT`);
      }
      if (!anyData) return `P&L (${label}): aucune donnée${playerId ? ` pour ${playerFilter![0].name}` : ""}.`;
      return lines.join("\n");
    }

    if (name === "get_recent_agency_extras") {
      const gk = input?.game_key;
      const lim = Math.min(input?.limit ?? 10, 50);
      const games = gk ? [gk] : ["akpoker", "kkpoker", "wepoker"];
      const lines: string[] = ["📒 Extras agency récents:"];
      for (const g of games) {
        const rows = db.prepare(
          `SELECT * FROM agency_extras WHERE game_key = ? AND deleted_at IS NULL ORDER BY recorded_at DESC LIMIT ?`
        ).all(g, lim) as any[];
        if (rows.length === 0) { lines.push(`\n${g.toUpperCase()}: aucun`); continue; }
        const cur = g === "wepoker" ? "CNY" : "USDT";
        lines.push(`\n${g.toUpperCase()} (${cur}):`);
        for (const r of rows) {
          const sign = r.type === "win" ? "+" : "-";
          lines.push(`  ${r.recorded_at.slice(0, 10)} ${sign}${r.amount} ${cur} — ${r.description ?? "(sans description)"}`);
        }
        const net = rows.reduce((s: number, r: any) => s + (r.type === "win" ? r.amount : -r.amount), 0);
        lines.push(`  Net: ${net >= 0 ? "+" : ""}${net.toFixed(2)} ${cur}`);
      }
      return lines.join("\n");
    }

    if (name === "get_player_detail") {
      const matches = findPlayerLoose(input?.query ?? "");
      if (matches.length === 0) return `Aucun joueur trouvé pour "${input?.query}".`;
      if (matches.length > 1) return `Plusieurs joueurs:\n${matches.map(p => `- ${p.name}`).join("\n")}\nPrécise.`;
      const pid = matches[0].id;

      const player = db.prepare(
        `SELECT id, name, telegram_handle, telegram_phone, status, tier, notes, created_at
         FROM players WHERE id = ?`
      ).get(pid) as any;

      const deals = db.prepare(
        `SELECT g.name AS game, pgd.action_pct, pgd.rakeback_pct, pgd.insurance_pct, pgd.start_date
         FROM player_game_deals pgd JOIN games g ON g.id = pgd.game_id
         WHERE pgd.player_id = ?`
      ).all(pid) as any[];

      const allGames = getPlayerPnLAllGames(pid);

      const recentTx = db.prepare(
        `SELECT g.name AS game, wt.type, wt.amount, wt.tx_datetime
         FROM wallet_transactions wt LEFT JOIN games g ON g.id = wt.game_id
         WHERE wt.player_id = ? AND (wt.source IS NULL OR wt.source != 'unknown')
         ORDER BY wt.tx_datetime DESC LIMIT 10`
      ).all(pid) as any[];

      const out: string[] = [
        `👤 ${player.name} ${player.telegram_handle ? `@${player.telegram_handle}` : ""} — tier ${player.tier ?? "?"}, status ${player.status}`,
      ];

      if (deals.length) {
        out.push(`\nDeals:`);
        deals.forEach(d => out.push(`  ${d.game}: ${d.action_pct}% action${d.rakeback_pct ? `, ${d.rakeback_pct}% RB` : ""}${d.insurance_pct ? `, ${d.insurance_pct}% ins` : ""}${d.start_date ? ` · depuis ${d.start_date}` : ""}`));
      }

      for (const g of allGames.games) {
        if (g.kind === "wepoker" && g.wp) {
          out.push(`\n${g.label}${g.archived ? " (archivé)" : ""}:`);
          out.push(`  Player P&L: ${fmtAmount(g.player_pnl_all)} CNY`);
          out.push(`  Agency: winnings ${fmtAmount(g.wp.agency_winnings_cny)} · RB ${fmtAmount(g.wp.agency_rakeback_cny)} · ins ${fmtAmount(g.wp.agency_insurance_cny)} CNY`);
          out.push(`  Total agency: ${fmtAmount(g.wp.agency_cut_cny)} CNY = ${fmtAmount(g.wp.agency_cut_usdt)} USDT`);
        } else if (g.kind === "staking") {
          out.push(`\n${g.label} (staking):`);
          out.push(`  Net joueur: ${fmtAmount(g.player_pnl_all)} ${g.currency} (part cercle via cycles staking, hors deal action)`);
        } else {
          out.push(`\n${g.label}${g.archived ? " (archivé)" : ""}:`);
          out.push(`  dép ${g.deposited.toFixed(0)} · ret ${g.withdrawn.toFixed(0)} · net ${fmtAmount(g.player_pnl_all)} · agency ${fmtAmount(g.agency_cut_usdt_all)} USDT`);
        }
      }

      if (allGames.grindhouse_usdt_all) {
        out.push(`\nGRINDHOUSE: part agency ${fmtAmount(allGames.grindhouse_usdt_all)} USDT`);
      }

      if (allGames.games.length || allGames.grindhouse_usdt_all) {
        out.push(`\nTotal agency (tous jeux): ${fmtAmount(allGames.total_agency_usdt_all)} USDT (30j: ${fmtAmount(allGames.total_agency_usdt_30d)}, 7j: ${fmtAmount(allGames.total_agency_usdt_7d)})`);
      }

      if (recentTx.length) {
        out.push(`\n10 dernières tx:`);
        recentTx.forEach(t => out.push(`  ${(t.tx_datetime ?? "?").slice(0, 10)} ${t.game ?? "?"} ${t.type} ${t.amount.toFixed(0)}`));
      }

      if (player.notes) out.push(`\nNotes: ${player.notes}`);

      return out.join("\n");
    }

    if (name === "get_recent_transactions") {
      const limit = Math.min(input?.limit ?? 20, 100);
      const params: any[] = [];
      let where = "1=1";
      if (input?.type) { where += ` AND wt.type = ?`; params.push(input.type); }
      if (input?.player) {
        const matches = findPlayerLoose(input.player);
        if (matches.length === 0) return `Aucun joueur "${input.player}".`;
        if (matches.length > 1) return `Plusieurs joueurs pour "${input.player}":\n${matches.map(p => `- ${p.name}`).join("\n")}`;
        where += ` AND wt.player_id = ?`; params.push(matches[0].id);
      }
      params.push(limit);
      const rows = db.prepare(
        `SELECT p.name AS player, g.name AS game, wt.type, wt.amount, wt.created_at, wt.tron_tx_hash
         FROM wallet_transactions wt JOIN players p ON p.id = wt.player_id LEFT JOIN games g ON g.id = wt.game_id
         WHERE ${where}
         ORDER BY wt.created_at DESC LIMIT ?`
      ).all(...params) as any[];
      if (rows.length === 0) return "Aucune transaction.";
      return rows.map(r =>
        `${r.created_at.slice(0, 16).replace("T", " ")} · ${r.player} · ${r.game ?? "?"} · ${r.type} ${r.amount.toFixed(0)} USDT${r.tron_tx_hash ? " (auto-sync)" : ""}`
      ).join("\n");
    }

    if (name === "list_doer_sessions") {
      const limit = Math.min(input?.limit ?? 5, 50);
      const rows = recentDoerSessions(limit);
      if (rows.length === 0) return "Aucune session doer pour l'instant.";
      const budget = isWithinBudget();
      const lines = [`Budget doer aujourd'hui: $${budget.spent.toFixed(2)} / $${budget.cap.toFixed(2)} (reste $${budget.remaining.toFixed(2)})`, ""];
      rows.forEach(r => {
        const status = r.status === "completed" ? "✅" : r.status === "failed" ? "❌" : r.status === "running" ? "🔄" : "⏳";
        lines.push(`${status} [${r.created_at.slice(0, 16).replace("T", " ")}] ${r.description.slice(0, 60)}`);
        if (r.pr_url) lines.push(`  → PR: ${r.pr_url}`);
        if (r.error_message) lines.push(`  ⚠️ ${r.error_message.slice(0, 100)}`);
        lines.push(`  coût: $${r.cost_usd_estimate.toFixed(3)}`);
      });
      return lines.join("\n");
    }

    if (name === "request_code_fix") {
      const description = String(input?.description ?? "").trim();
      const moneyOk = input?.money_ok === true;
      if (!description) return "description requise pour request_code_fix.";

      // Defense in depth — even if Claude calls this with money_ok=false on a money-flow
      // request, dispatchFix() will refuse cleanly.
      if (!moneyOk && looksMoneyFlow(description)) {
        return `⚠️ Cette requête semble toucher au code financier (deal/depot/retrait/wallet/PnL/rakeback). Je refuse de la dispatcher sans autorisation explicite. Si l'opérateur veut vraiment, qu'il rajoute "money:ok" dans son message — je rappellerai alors avec money_ok=true.`;
      }

      // We need the chat_id for dispatch — pull from a known context. Since
      // tools don't natively get chat context, we use the agent group default.
      const chatId = process.env.AGENT_TELEGRAM_CHAT_ID ?? "-4846690641";
      const result = await dispatchFix({ chatId, description, money_ok: moneyOk });
      if (!result.ok) {
        return `❌ Dispatch refusé: ${result.reason}`;
      }
      return `✅ Doer agent démarré (session ${result.session_id?.slice(0, 16)}…). Il va cloner le repo, faire le changement, ouvrir une PR, et poster un récap dans le groupe quand c'est terminé. Délai typique: 2-15 min selon la complexité.`;
    }

    if (name === "list_players") {
      const statusFilter = input?.status ?? null;
      const allPlayers = db.prepare(
        `SELECT id, name, tier, status, telegram_handle FROM players${statusFilter ? ` WHERE status = ?` : ""} ORDER BY tier, name`
      ).all(...(statusFilter ? [statusFilter] : [])) as any[];
      if (allPlayers.length === 0) return "Aucun joueur.";

      const contributors = getTopContributors({}, 100);
      const agencyByPlayer = new Map<number, number>();
      for (const c of contributors) agencyByPlayer.set(c.player_id, c.agency_usdt);

      const games = db.prepare(`SELECT player_id, GROUP_CONCAT(g.name, ', ') AS game_names FROM player_game_deals pgd JOIN games g ON g.id = pgd.game_id GROUP BY player_id`).all() as any[];
      const gamesByPlayer = new Map<number, string>();
      for (const g of games) gamesByPlayer.set(g.player_id, g.game_names);

      return allPlayers.map((p: any) =>
        `${p.tier ?? "?"} · ${p.name}${p.telegram_handle ? ` @${p.telegram_handle}` : ""} · ${p.status} · games: ${gamesByPlayer.get(p.id) ?? "aucun"} · agency P&L: ${fmtAmount(agencyByPlayer.get(p.id) ?? 0)} USDT`
      ).join("\n");
    }

    if (name === "bot_health") {
      const health = await checkUserbotHealth();
      const lastSync = db.prepare(
        `SELECT MAX(created_at) AS ts FROM wallet_transactions WHERE tron_tx_hash IS NOT NULL`
      ).get() as { ts: string | null };
      const groupCount = health.connected ? (await listGroups()).groups.length : null;
      const lines = [
        `Userbot: ${health.connected ? "✅ connecté" : "❌ déconnecté"}${health.username ? ` (@${health.username})` : ""}`,
        health.error ? `Erreur: ${health.error}` : null,
        `Groupes visibles: ${groupCount ?? "N/A"}`,
        `Dernière sync wallet: ${lastSync.ts ? lastSync.ts.replace("T", " ").slice(0, 16) : "jamais"}`,
      ].filter(Boolean);
      return lines.join("\n");
    }

    if (name === "cashout_status_this_week") {
      const weekStart = getCurrentWeekStart();
      const stats = db.prepare(`
        SELECT
          COALESCE(SUM(cashout_confirmed = 1), 0) AS confirmed,
          COALESCE(SUM(not_played = 1), 0) AS not_played,
          COALESCE(SUM(cashout_confirmed = 0 AND not_played = 0), 0) AS pending
        FROM weekly_cashout_state WHERE week_start = ?
      `).get(weekStart) as { confirmed: number; not_played: number; pending: number };
      const totalEligible = (db.prepare(`
        SELECT COUNT(*) AS n FROM players
        WHERE status IN ('active', 'signed') AND telegram_group_id IS NOT NULL AND accounting_topic_id IS NOT NULL
      `).get() as { n: number }).n;
      const notReminded = totalEligible - stats.confirmed - stats.not_played - stats.pending;
      return `Cashout semaine du ${weekStart}:\n✅ Confirmé: ${stats.confirmed}\n⏸️ Pas joué: ${stats.not_played}\n⏳ En attente: ${stats.pending}\n🔇 Pas encore relancé: ${notReminded < 0 ? 0 : notReminded}\nTotal éligibles: ${totalEligible}`;
    }

    if (name === "find_orphan_groups") {
      const groupList = await listGroups();
      if (!groupList.ok) return `Erreur listGroups: ${groupList.error}`;
      const linkedIds = new Set(
        (db.prepare(`SELECT telegram_group_id FROM players WHERE telegram_group_id IS NOT NULL`).all() as { telegram_group_id: string }[])
          .map(r => r.telegram_group_id)
      );
      const orphans = groupList.groups.filter(g =>
        g.title.toLowerCase().includes("x lecercle") && !linkedIds.has(g.chat_id)
      );
      if (orphans.length === 0) return "Aucun groupe orphelin trouvé.";
      return `Groupes orphelins (${orphans.length}):\n${orphans.map(g => `• ${g.title} (${g.chat_id}, ${g.member_count} membres)`).join("\n")}`;
    }

    // Lit le système ACTUEL (manual_settlements) via le moteur, pas le legacy
    // weekly_settlements : c'est la même source que la page Paiements, donc une
    // seule vérité. Aucun calcul ici — le moteur porte la math (Baki 2026-07-27).
    if (name === "get_unpaid_settlements") {
      const { getPendingSettlements, getOverdueBuckets, settlementDetail } = await import("./manual-settlement-engine");
      const pending = getPendingSettlements();
      const overdue = getOverdueBuckets();

      const out: string[] = [];

      if (pending.length === 0) {
        out.push("Règlements lockés en attente de paiement : aucun.");
      } else {
        const totalDue = pending.reduce((s, p) => s + p.amount_due_usdt, 0);
        out.push(`Règlements lockés en attente de paiement (${pending.length}) — le plus ancien d'abord :`);
        out.push(...pending.map(p =>
          `• #${p.id} · ${p.player_name} · ${p.room_label} · ${fmtAmount(p.amount_due_usdt)} USDT ` +
          `${settlementDetail(p, fmtAmount)} · ` +
          `locké depuis ${p.age_days}j · ${p.week_label ?? "semaine ?"} · ${p.tx_count} tx`
        ));
        out.push(`Net des montants dus : ${fmtAmount(totalDue)} USDT (positif = ça rentre, le joueur doit au Cercle ; négatif = ça sort, le Cercle doit au joueur).`);
        out.push(`Le « #N » en tête de ligne est le settlement_id — c'est lui qu'attend mark_settlement_paid.`);
      }

      out.push("");

      if (overdue.length === 0) {
        out.push("Semaines jamais réglées : aucune.");
      } else {
        out.push(`Semaines jamais réglées (${overdue.length}) — anti-oubli, tx qui ne sont entrées dans AUCUN règlement :`);
        out.push(...overdue.map(b =>
          `• ${b.player_name} · ${b.room_label} · ${b.week_label} (${b.week_monday}) · ` +
          `net brut ${fmtAmount(b.net_usdt)} USDT · ${b.tx_count} tx · ${b.weeks_late} sem. de retard` +
          `${b.severity === "critical" ? " · CRITIQUE" : ""}${b.never_settled ? " · jamais réglé dans cette room" : ""}` +
          `${b.unconvertible > 0 ? ` · ⚠️ ${b.unconvertible} tx sans taux de change, exclues du net` : ""}`
        ));
        out.push("⚠️ Le « net brut » ci-dessus est le net JOUEUR (retraits − dépôts). Ce n'est PAS un montant dû : l'action_pct n'a pas encore été appliqué car aucun règlement n'existe. Ne jamais le présenter avec « on doit » ou « il nous doit ».");
      }

      return out.join("\n");
    }

    if (name === "onboarding_funnel") {
      const leads = db.prepare(`SELECT stage, COUNT(*) AS n FROM onboarding_leads GROUP BY stage`).all() as { stage: string; n: number }[];
      const players = db.prepare(`SELECT status, COUNT(*) AS n FROM players GROUP BY status`).all() as { status: string; n: number }[];
      const leadMap = Object.fromEntries(leads.map(l => [l.stage, l.n]));
      const playerMap = Object.fromEntries(players.map(p => [p.status, p.n]));
      return [
        `Funnel leads:`,
        `  welcome: ${leadMap.welcome ?? 0}`,
        `  discovered: ${leadMap.discovered ?? 0}`,
        `  joined: ${leadMap.joined ?? 0}`,
        `Joueurs:`,
        `  active: ${playerMap.active ?? 0}`,
        `  inactive: ${playerMap.inactive ?? 0}`,
        `  churned: ${playerMap.churned ?? 0}`,
      ].join("\n");
    }

    // Funnels d'acquisition NEXAPOKER et QQPK — tables dédiées, invisibles pour
    // onboarding_funnel qui ne lit que onboarding_leads (Baki 2026-07-27).
    // Les libellés d'étapes viennent des configs de funnel : une seule source.
    if (name === "get_funnel_status") {
      const which = String(input?.funnel ?? "all");
      const out: string[] = [];

      if (which === "nexa" || which === "all") {
        const { NEXA_STAGES } = await import("./funnels/nexa/config");
        const rows = db.prepare(`SELECT stage, COUNT(*) AS n FROM nexa_leads GROUP BY stage`).all() as { stage: string; n: number }[];
        const byStage = new Map(rows.map(r => [r.stage, r.n]));
        const total = rows.reduce((s, r) => s + r.n, 0);
        const extra = db.prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN cold = 1 THEN 1 ELSE 0 END) AS cold,
                  SUM(CASE WHEN duplicate_id = 1 THEN 1 ELSE 0 END) AS dupes,
                  SUM(relances_count) AS relances
           FROM nexa_leads`
        ).get() as { total: number; cold: number | null; dupes: number | null; relances: number | null };
        out.push(`NEXAPOKER — ${total} lead(s) :`);
        out.push(...NEXA_STAGES.map(s => `  ${s.label} : ${byStage.get(s.key) ?? 0}`));
        out.push(`  froids : ${extra.cold ?? 0} · doublons d'ID : ${extra.dupes ?? 0} · relances envoyées : ${extra.relances ?? 0}`);
      }

      if (which === "all") out.push("");

      if (which === "qqpk" || which === "all") {
        const { QQPK_STAGES } = await import("./funnels/qqpk/config");
        const rows = db.prepare(`SELECT stage, COUNT(*) AS n FROM qqpk_funnel_leads GROUP BY stage`).all() as { stage: number; n: number }[];
        const byStage = new Map(rows.map(r => [r.stage, r.n]));
        const total = rows.reduce((s, r) => s + r.n, 0);
        const extra = db.prepare(
          `SELECT SUM(CASE WHEN blocked = 1 THEN 1 ELSE 0 END) AS blocked,
                  SUM(reminders_sent) AS relances
           FROM qqpk_funnel_leads`
        ).get() as { blocked: number | null; relances: number | null };
        out.push(`QQPK — ${total} lead(s) :`);
        out.push(...QQPK_STAGES.map(s => `  ${s.label} : ${byStage.get(s.key) ?? 0}`));
        out.push(`  bloqués : ${extra.blocked ?? 0} · relances envoyées : ${extra.relances ?? 0}`);
      }

      return out.join("\n");
    }

    if (name === "pending_cashouts_now") {
      const weekStart = getCurrentWeekStart();
      const rows = db.prepare(`
        SELECT p.name, p.telegram_handle, wcs.escalation_count, wcs.last_message_at
        FROM weekly_cashout_state wcs
        JOIN players p ON p.id = wcs.player_id
        WHERE wcs.week_start = ? AND wcs.cashout_confirmed = 0 AND wcs.not_played = 0
        ORDER BY wcs.last_message_at ASC
      `).all(weekStart) as { name: string; telegram_handle: string | null; escalation_count: number; last_message_at: string | null }[];
      if (rows.length === 0) return "Aucun joueur en attente de cashout.";
      const lines = rows.map(r => {
        const minAgo = r.last_message_at ? Math.round((Date.now() - new Date(r.last_message_at + "Z").getTime()) / 60_000) : null;
        const timeStr = minAgo !== null ? (minAgo >= 60 ? `${Math.floor(minAgo / 60)}h${minAgo % 60}min` : `${minAgo}min`) : "jamais";
        return `• ${r.name}${r.telegram_handle ? ` @${r.telegram_handle}` : ""} — ${r.escalation_count} relances, dernier msg il y a ${timeStr}`;
      });
      return `En attente (${rows.length}):\n${lines.join("\n")}`;
    }

    if (name === "revenue_breakdown") {
      const { start, end, label } = parsePeriod(input?.period ?? "week");
      const period: Period = { from: start, to: end };
      const total = getAgencyTotalPnL(period);
      const contributors = getTopContributors(period, 20);
      if (contributors.length === 0) return `Aucun revenu sur ${label}.`;
      const lines = contributors.map(c => `${c.player_name} — ${fmtContributorParts(c)} · total: ${fmtAmount(c.agency_usdt)} USDT`);
      return `Revenu (${label}):\n${lines.join("\n")}\nTotal: ${fmtAmount(total.total_usdt)} USDT (AK: ${fmtAmount(total.akpoker_usdt)}, KK: ${fmtAmount(total.kkpoker_usdt)}, A5: ${fmtAmount(total.a5poker_usdt)}, AKS: ${fmtAmount(total.aks_usdt)}, NUTSPK: ${fmtAmount(total.nutspk_usdt)}, WP: ${total.wepoker_cny.toFixed(0)} CNY = ${fmtAmount(total.wepoker_usdt)}, GH: ${fmtAmount(total.grindhouse_usdt)})`;
    }

    if (name === "top_players_this_week") {
      const { start, end } = getWeekBounds(0);
      const period: Period = { from: toParisDate(toUTCISO(start)), to: toParisDate(toUTCISO(end)) };
      const side = input?.side ?? "winners";
      const limit = Math.min(input?.limit ?? 5, 20);
      const contributors = getTopContributors(period, 100);
      const filtered = side === "winners"
        ? contributors.filter(c => c.agency_usdt > 0)
        : contributors.filter(c => c.agency_usdt < 0).reverse();
      const top = filtered.slice(0, limit);
      if (top.length === 0) return `Aucun ${side === "winners" ? "gagnant" : "perdant"} cette semaine.`;
      return `Top ${top.length} ${side === "winners" ? "gagnants" : "perdants"} (semaine, agency cut):\n${top.map((c, i) => `${i + 1}. ${c.player_name} — ${fmtAmount(c.agency_usdt)} USDT (${fmtContributorParts(c)})`).join("\n")}`;
    }

    if (name === "weekly_settlement_summary") {
      const offset = input?.week_offset ?? 0;
      const { start, end } = getWeekBounds(offset);
      const since = toUTCISO(start);
      const until = toUTCISO(end);
      const kpis = getLockAwareKPIs({ since_date: since, end_date: until }) as any;
      const rows = getLockAwareSummaryByPlayer({ since_date: since, end_date: until }) as any[];
      const weekLabel = `${toParisDate(since)} → ${toParisDate(until)}`;
      if (rows.length === 0) return `Aucune donnée settlement pour ${weekLabel}.`;
      const playerLines = rows
        .filter((r: any) => (r.deposited ?? 0) > 0 || (r.withdrawn ?? 0) > 0)
        .map((r: any) => `  ${r.player_name ?? r.name ?? "?"}: dép ${(r.deposited ?? 0).toFixed(0)} · ret ${(r.withdrawn ?? 0).toFixed(0)} · net ${fmtAmount(r.net ?? 0)} · mon P&L ${fmtAmount(r.my_pnl ?? 0)}`);
      return [
        `Settlement ${weekLabel}:`,
        `Totaux: dépôts ${(kpis.total_deposited ?? 0).toFixed(0)} · retraits ${(kpis.total_withdrawn ?? 0).toFixed(0)} · net ${fmtAmount(kpis.total_net ?? 0)} · mon P&L ${fmtAmount(kpis.total_my_pnl ?? kpis.my_total_pnl ?? 0)} USDT`,
        `\nPar joueur:`,
        ...playerLines,
      ].join("\n");
    }

    return `Tool inconnu: ${name}`;
  } catch (e: any) {
    return `Erreur exécution ${name}: ${e?.message ?? String(e)}`;
  }
}
