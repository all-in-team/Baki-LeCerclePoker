import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "./db";
import { todayCost, usageBetween } from "./agent-cost";

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

export function executeTool(name: string, input: any): string {
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
      const params: any[] = [start, end];
      let sql = `
        SELECT p.name AS player, g.name AS game, pgd.action_pct,
          COALESCE(SUM(CASE WHEN wt.type='deposit' THEN wt.amount ELSE 0 END), 0) AS deposited,
          COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE 0 END), 0) AS withdrawn,
          COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) AS net,
          COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) * pgd.action_pct / 100.0 AS my_pnl
        FROM players p
        JOIN player_game_deals pgd ON pgd.player_id = p.id
        JOIN games g ON g.id = pgd.game_id
        LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id
          AND date(wt.created_at) BETWEEN ? AND ?
      `;
      if (playerId) { sql += ` WHERE p.id = ?`; params.push(playerId); }
      sql += ` GROUP BY p.id, pgd.game_id HAVING (deposited > 0 OR withdrawn > 0) ORDER BY my_pnl DESC`;
      const rows = db.prepare(sql).all(...params) as any[];

      if (rows.length === 0) return `P&L (${label}): aucune transaction sur cette période${playerId ? ` pour ${playerFilter![0].name}` : ""}.`;

      const total = rows.reduce((acc, r) => acc + r.my_pnl, 0);
      const lines = rows.map(r =>
        `${r.player}/${r.game} [${r.action_pct}%] — déposé:${r.deposited.toFixed(0)} retiré:${r.withdrawn.toFixed(0)} net:${fmtAmount(r.net)} mon P&L:${fmtAmount(r.my_pnl)} USDT`
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

      const balances = db.prepare(
        `SELECT g.name AS game,
                COALESCE(SUM(CASE WHEN wt.type='deposit' THEN wt.amount ELSE -wt.amount END), 0) AS net
         FROM wallet_transactions wt JOIN games g ON g.id = wt.game_id
         WHERE wt.player_id = ?
         GROUP BY g.id`
      ).all(pid) as any[];

      const recentTx = db.prepare(
        `SELECT g.name AS game, wt.type, wt.amount, wt.created_at
         FROM wallet_transactions wt LEFT JOIN games g ON g.id = wt.game_id
         WHERE wt.player_id = ? ORDER BY wt.created_at DESC LIMIT 10`
      ).all(pid) as any[];

      const out = [
        `👤 ${player.name} ${player.telegram_handle ? `@${player.telegram_handle}` : ""} — tier ${player.tier ?? "?"}, status ${player.status}`,
        player.tron_address ? `Wallet TELE: ${player.tron_address}` : "Wallet TELE: non configuré",
        deals.length ? `\nDeals:\n${deals.map(d => `  ${d.game}: ${d.action_pct}% action, ${d.rakeback_pct}% RB${d.insurance_pct ? `, ${d.insurance_pct}% ins` : ""}`).join("\n")}` : "\nAucun deal configuré",
        balances.length ? `\nSoldes nets (joueur me doit si négatif):\n${balances.map(b => `  ${b.game}: ${fmtAmount(b.net)} USDT`).join("\n")}` : "",
        recentTx.length ? `\n10 dernières tx:\n${recentTx.map(t => `  ${t.created_at.slice(0, 10)} ${t.game ?? "?"} ${t.type} ${t.amount.toFixed(0)}`).join("\n")}` : "",
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

    if (name === "list_players") {
      const params: any[] = [];
      let where = "1=1";
      if (input?.status) { where += ` AND p.status = ?`; params.push(input.status); }
      const rows = db.prepare(
        `SELECT p.id, p.name, p.tier, p.status, p.telegram_handle,
                COALESCE(SUM(CASE WHEN wt.type='deposit' THEN wt.amount ELSE -wt.amount END), 0) AS net_balance
         FROM players p LEFT JOIN wallet_transactions wt ON wt.player_id = p.id
         WHERE ${where}
         GROUP BY p.id ORDER BY p.tier, p.name`
      ).all(...params) as any[];
      if (rows.length === 0) return "Aucun joueur.";
      return rows.map(r =>
        `${r.tier ?? "?"} · ${r.name}${r.telegram_handle ? ` @${r.telegram_handle}` : ""} · ${r.status} · solde net: ${fmtAmount(r.net_balance)} USDT`
      ).join("\n");
    }

    return `Tool inconnu: ${name}`;
  } catch (e: any) {
    return `Erreur exécution ${name}: ${e?.message ?? String(e)}`;
  }
}
