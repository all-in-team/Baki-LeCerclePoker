import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "./db";
import { todayCost, usageBetween } from "./agent-cost";
import { dispatchFix, isWithinBudget, recentDoerSessions, looksMoneyFlow } from "./agent-doer";
import { getCurrentWeekStart } from "./telegram-commands/cashout-reminder";
import { getWeekBounds, toUTCISO, toParisDate } from "./date-utils";
import { getLockAwareSummaryByPlayer, getLockAwareKPIs, getWalletSummaryByPlayer } from "./queries";
import { checkUserbotHealth, listGroups } from "./telegram-userbot";

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
     WHERE date(created_at) = ?
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

  // Cumulative P&L (all-time, my share) — sum of (withdrawn - deposited) * action_pct/100
  const myPnl = db.prepare(
    `SELECT COALESCE(SUM(
       CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END
     ) * pgd.action_pct / 100.0, 0) AS my_pnl
     FROM wallet_transactions wt
     JOIN player_game_deals pgd ON pgd.player_id = wt.player_id AND pgd.game_id = wt.game_id`
  ).get() as { my_pnl: number };

  const cost = todayCost();

  const lines = [
    `📅 ${today}`,
    `💸 Aujourd'hui — dépôts: ${dep ? dep.amt.toFixed(0) : 0} USDT (${dep ? dep.n : 0} tx) · retraits: ${wd ? wd.amt.toFixed(0) : 0} USDT (${wd ? wd.n : 0} tx)`,
    `👥 Joueurs: ${playersActive}/${playersTotal} actifs`,
    `📊 Mon P&L cumulé (all-time): ${myPnl.my_pnl >= 0 ? "+" : ""}${myPnl.my_pnl.toFixed(0)} USDT`,
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
    name: "onboarding_funnel",
    description: "Comptage du funnel : leads par stage (welcome/discovered/joined) + joueurs par status (active/inactive/churned).",
    input_schema: { type: "object", properties: {}, required: [] },
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

export async function executeTool(name: string, input: any): Promise<string> {
  const db = getDb();

  try {
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

      const playerId = playerFilter?.[0]?.id ?? null;
      let rows = getLockAwareSummaryByPlayer({
        since_date: start + "T00:00:00Z",
        end_date: end + "T23:59:59Z",
      }) as any[];
      if (playerId) rows = rows.filter((r: any) => r.player_id === playerId);
      rows = rows.filter((r: any) => (r.total_deposited ?? 0) > 0 || (r.total_withdrawn ?? 0) > 0);

      if (rows.length === 0) return `P&L (${label}): aucune transaction sur cette période${playerId ? ` pour ${playerFilter![0].name}` : ""}.`;

      const total = rows.reduce((acc: number, r: any) => acc + (r.my_pnl ?? 0), 0);
      const lines = rows.map((r: any) =>
        `${r.player_name}/${r.game_name} [${r.action_pct}%] — déposé:${(r.total_deposited ?? 0).toFixed(0)} retiré:${(r.total_withdrawn ?? 0).toFixed(0)} net:${fmtAmount(r.net ?? 0)} mon P&L:${fmtAmount(r.my_pnl ?? 0)} USDT`
      );
      return `P&L (${label}):\n${lines.join("\n")}\nTotal mon P&L: ${fmtAmount(total)} USDT`;
    }

    if (name === "get_player_detail") {
      const matches = findPlayerLoose(input?.query ?? "");
      if (matches.length === 0) return `Aucun joueur trouvé pour "${input?.query}".`;
      if (matches.length > 1) return `Plusieurs joueurs:\n${matches.map(p => `- ${p.name}`).join("\n")}\nPrécise.`;
      const pid = matches[0].id;

      const player = db.prepare(
        `SELECT id, name, telegram_handle, telegram_phone, status, tier, notes, tron_address, tele_wallet_cashout, created_at
         FROM players WHERE id = ?`
      ).get(pid) as any;

      const deals = db.prepare(
        `SELECT g.name AS game, pgd.action_pct, pgd.rakeback_pct, pgd.insurance_pct
         FROM player_game_deals pgd JOIN games g ON g.id = pgd.game_id
         WHERE pgd.player_id = ?`
      ).all(pid) as any[];

      const balances = (getWalletSummaryByPlayer() as any[]).filter((r: any) => r.player_id === pid);

      const recentTx = db.prepare(
        `SELECT g.name AS game, wt.type, wt.amount, wt.tx_datetime
         FROM wallet_transactions wt LEFT JOIN games g ON g.id = wt.game_id
         WHERE wt.player_id = ? AND (wt.source IS NULL OR wt.source != 'unknown')
         ORDER BY wt.tx_datetime DESC LIMIT 10`
      ).all(pid) as any[];

      const totalNet = balances.reduce((s: number, b: any) => s + (b.net ?? 0), 0);
      const totalMyPnl = balances.reduce((s: number, b: any) => s + (b.my_pnl ?? 0), 0);

      const out = [
        `👤 ${player.name} ${player.telegram_handle ? `@${player.telegram_handle}` : ""} — tier ${player.tier ?? "?"}, status ${player.status}`,
        player.tron_address ? `Wallet TELE: ${player.tron_address}` : "Wallet TELE: non configuré",
        deals.length ? `\nDeals:\n${deals.map(d => `  ${d.game}: ${d.action_pct}% action, ${d.rakeback_pct}% RB${d.insurance_pct ? `, ${d.insurance_pct}% ins` : ""}`).join("\n")}` : "\nAucun deal configuré",
        balances.length ? `\nSoldes par game:\n${balances.map((b: any) => `  ${b.game_name}: dép ${(b.total_deposited ?? 0).toFixed(0)} · ret ${(b.total_withdrawn ?? 0).toFixed(0)} · net ${fmtAmount(b.net ?? 0)} · mon P&L ${fmtAmount(b.my_pnl ?? 0)} USDT`).join("\n")}` : "",
        balances.length ? `\nTotal: net ${fmtAmount(totalNet)} USDT · mon P&L ${fmtAmount(totalMyPnl)} USDT` : "",
        recentTx.length ? `\n10 dernières tx:\n${recentTx.map(t => `  ${(t.tx_datetime ?? "?").slice(0, 10)} ${t.game ?? "?"} ${t.type} ${t.amount.toFixed(0)}`).join("\n")}` : "",
        player.notes ? `\nNotes: ${player.notes}` : "",
      ].filter(Boolean).join("\n");
      return out;
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

      const balanceRows = getWalletSummaryByPlayer() as any[];
      const netByPlayer = new Map<number, number>();
      for (const r of balanceRows) netByPlayer.set(r.player_id, (netByPlayer.get(r.player_id) ?? 0) + (r.net ?? 0));

      return allPlayers.map((p: any) =>
        `${p.tier ?? "?"} · ${p.name}${p.telegram_handle ? ` @${p.telegram_handle}` : ""} · ${p.status} · solde net: ${fmtAmount(netByPlayer.get(p.id) ?? 0)} USDT`
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
      let rows = getLockAwareSummaryByPlayer({
        since_date: start + "T00:00:00Z",
        end_date: end + "T23:59:59Z",
      }) as any[];
      rows = rows.filter((r: any) => (r.total_deposited ?? 0) > 0 || (r.total_withdrawn ?? 0) > 0);
      if (rows.length === 0) return `Aucun revenu sur ${label}.`;
      const total = rows.reduce((s: number, r: any) => s + (r.my_pnl ?? 0), 0);
      const lines = rows.map((r: any) => `${r.player_name} [${r.action_pct}%] — dép:${(r.total_deposited ?? 0).toFixed(0)} ret:${(r.total_withdrawn ?? 0).toFixed(0)} net:${fmtAmount(r.net ?? 0)} mon P&L:${fmtAmount(r.my_pnl ?? 0)}`);
      return `Revenu (${label}):\n${lines.join("\n")}\nTotal mon P&L: ${fmtAmount(total)} USDT`;
    }

    if (name === "top_players_this_week") {
      const { start, end } = getWeekBounds(0);
      const rows = getLockAwareSummaryByPlayer({ since_date: toUTCISO(start), end_date: toUTCISO(end) }) as any[];
      const side = input?.side ?? "winners";
      const limit = Math.min(input?.limit ?? 5, 20);
      const sorted = rows
        .filter((r: any) => side === "winners" ? r.net > 0 : r.net < 0)
        .sort((a: any, b: any) => side === "winners" ? b.net - a.net : a.net - b.net)
        .slice(0, limit);
      if (sorted.length === 0) return `Aucun ${side === "winners" ? "gagnant" : "perdant"} cette semaine.`;
      return `Top ${sorted.length} ${side === "winners" ? "gagnants" : "perdants"} (semaine):\n${sorted.map((r: any, i: number) => `${i + 1}. ${r.player_name ?? r.name ?? "?"} — net: ${fmtAmount(r.net)} USDT`).join("\n")}`;
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
