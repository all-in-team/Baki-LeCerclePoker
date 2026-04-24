import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { upsertPlayerGameDeal, insertWalletTransaction } from "@/lib/queries";

// Only Baki can send commands
const OWNER_IDS = new Set([1298290355]);

// ── Telegram API helpers ──────────────────────────────────
async function sendMsg(chatId: number | string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

// ── DB helpers ────────────────────────────────────────────
function findPlayer(query: string) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, name FROM players WHERE LOWER(name) LIKE LOWER(?) ORDER BY name LIMIT 5`
  ).all(`%${query}%`) as { id: number; name: string }[];
  return rows;
}

function findGame(query: string) {
  const db = getDb();
  return db.prepare(
    `SELECT id, name FROM games WHERE LOWER(name) = LOWER(?)`
  ).get(query) as { id: number; name: string } | undefined;
}

function getPlayerPnl(playerId?: number) {
  const db = getDb();
  if (playerId) {
    return db.prepare(`
      SELECT
        p.name AS player_name,
        g.name AS game_name,
        pgd.action_pct,
        COALESCE(SUM(CASE WHEN wt.type='deposit' THEN wt.amount ELSE 0 END), 0) AS deposited,
        COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE 0 END), 0) AS withdrawn,
        COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) AS net,
        COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) * pgd.action_pct / 100 AS my_pnl
      FROM players p
      JOIN player_game_deals pgd ON pgd.player_id = p.id
      JOIN games g ON g.id = pgd.game_id
      LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id
      WHERE p.id = ?
      GROUP BY p.id, pgd.game_id
    `).all(playerId) as any[];
  }
  return db.prepare(`
    SELECT
      p.name AS player_name,
      g.name AS game_name,
      pgd.action_pct,
      COALESCE(SUM(CASE WHEN wt.type='deposit' THEN wt.amount ELSE 0 END), 0) AS deposited,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE 0 END), 0) AS withdrawn,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) AS net,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) * pgd.action_pct / 100 AS my_pnl
    FROM players p
    JOIN player_game_deals pgd ON pgd.player_id = p.id
    JOIN games g ON g.id = pgd.game_id
    LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id
    GROUP BY p.id, pgd.game_id
    ORDER BY my_pnl DESC
  `).all() as any[];
}

function pnlSign(n: number) {
  if (n > 0) return `+${n.toFixed(2)}`;
  if (n < 0) return `−${Math.abs(n).toFixed(2)}`;
  return "0.00";
}

// ── Command handlers ──────────────────────────────────────

// /deal [joueur] [game] [action%] [rb%=0]
async function handleDeal(args: string[], chatId: number) {
  if (args.length < 3) {
    await sendMsg(chatId, "❌ Usage : <code>/deal [joueur] [game] [action%] [rb%]</code>\nEx : <code>/deal Hugo Wepoker 50 0</code>");
    return;
  }
  const [playerQuery, gameQuery, actionStr, rbStr] = args;
  const action_pct = parseFloat(actionStr);
  const rakeback_pct = parseFloat(rbStr ?? "0");

  if (isNaN(action_pct) || action_pct < 0 || action_pct > 100) {
    await sendMsg(chatId, "❌ Action % invalide (0–100)");
    return;
  }

  const players = findPlayer(playerQuery);
  if (players.length === 0) {
    await sendMsg(chatId, `❌ Joueur "${playerQuery}" introuvable`);
    return;
  }
  if (players.length > 1) {
    await sendMsg(chatId, `❌ Plusieurs joueurs trouvés :\n${players.map(p => `• ${p.name}`).join("\n")}\nSois plus précis.`);
    return;
  }

  const game = findGame(gameQuery);
  if (!game) {
    await sendMsg(chatId, `❌ Game "${gameQuery}" inconnue. Games : TELE, Wepoker, Xpoker, ClubGG`);
    return;
  }

  upsertPlayerGameDeal({ player_id: players[0].id, game_id: game.id, action_pct, rakeback_pct });

  await sendMsg(chatId,
    `✅ Deal enregistré\n<b>${players[0].name}</b> sur <b>${game.name}</b>\nAction : <b>${action_pct}%</b> · RB : <b>${rakeback_pct}%</b>`
  );
}

// /depot [joueur] [montant] [game]
async function handleDeposit(args: string[], chatId: number) {
  await handleTx("deposit", args, chatId);
}

// /retrait [joueur] [montant] [game]
async function handleWithdrawal(args: string[], chatId: number) {
  await handleTx("withdrawal", args, chatId);
}

async function handleTx(type: "deposit" | "withdrawal", args: string[], chatId: number) {
  if (args.length < 3) {
    const cmd = type === "deposit" ? "depot" : "retrait";
    await sendMsg(chatId, `❌ Usage : <code>/${cmd} [joueur] [montant] [game]</code>\nEx : <code>/${cmd} Hugo 2000 Wepoker</code>`);
    return;
  }
  const [playerQuery, amountStr, gameQuery] = args;
  const amount = parseFloat(amountStr.replace(",", "."));

  if (isNaN(amount) || amount <= 0) {
    await sendMsg(chatId, "❌ Montant invalide");
    return;
  }

  const players = findPlayer(playerQuery);
  if (players.length === 0) {
    await sendMsg(chatId, `❌ Joueur "${playerQuery}" introuvable`);
    return;
  }
  if (players.length > 1) {
    await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(p => `• ${p.name}`).join("\n")}`);
    return;
  }

  const game = findGame(gameQuery);
  if (!game) {
    await sendMsg(chatId, `❌ Game "${gameQuery}" inconnue. Games : TELE, Wepoker, Xpoker, ClubGG`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  insertWalletTransaction({ player_id: players[0].id, game_id: game.id, type, amount, currency: "USDT", tx_date: today });

  const emoji = type === "deposit" ? "📥" : "📤";
  const label = type === "deposit" ? "Dépôt" : "Retrait";
  await sendMsg(chatId,
    `${emoji} <b>${label} enregistré</b>\n<b>${players[0].name}</b> · ${game.name}\n<b>${amount.toFixed(2)} USDT</b> · ${today}`
  );
}

// /pnl [joueur?]
async function handlePnl(args: string[], chatId: number) {
  if (args.length > 0) {
    const players = findPlayer(args[0]);
    if (players.length === 0) {
      await sendMsg(chatId, `❌ Joueur "${args[0]}" introuvable`);
      return;
    }
    if (players.length > 1) {
      await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(p => `• ${p.name}`).join("\n")}`);
      return;
    }
    const rows = getPlayerPnl(players[0].id);
    if (rows.length === 0) {
      await sendMsg(chatId, `ℹ️ ${players[0].name} — aucun deal configuré`);
      return;
    }
    const lines = rows.map((r: any) =>
      `<b>${r.game_name}</b> [${r.action_pct}%]\n  Déposé: ${r.deposited.toFixed(2)} | Retiré: ${r.withdrawn.toFixed(2)}\n  Net joueur: ${pnlSign(r.net)} | <b>Mon P&L: ${pnlSign(r.my_pnl)}</b>`
    );
    await sendMsg(chatId, `📊 <b>${players[0].name}</b>\n\n${lines.join("\n\n")}`);
  } else {
    const rows = getPlayerPnl();
    if (rows.length === 0) {
      await sendMsg(chatId, "ℹ️ Aucune donnée — configure des deals d'abord");
      return;
    }
    let totalMyPnl = 0;
    const lines = rows.map((r: any) => {
      totalMyPnl += r.my_pnl;
      const sign = r.my_pnl > 0 ? "🟢" : r.my_pnl < 0 ? "🔴" : "⚪";
      return `${sign} <b>${r.player_name}</b> / ${r.game_name} — ${pnlSign(r.my_pnl)} USDT`;
    });
    await sendMsg(chatId, `📊 <b>P&L Global</b>\n\n${lines.join("\n")}\n\n<b>Total mon P&L : ${pnlSign(totalMyPnl)} USDT</b>`);
  }
}

// /aide
async function handleAide(chatId: number) {
  await sendMsg(chatId, `🃏 <b>Le Cercle Bot — Commandes</b>

<code>/deal [joueur] [game] [action%] [rb%]</code>
Ex: <code>/deal Hugo Wepoker 50 0</code>
→ Crée ou met à jour le deal du joueur

<code>/depot [joueur] [montant] [game]</code>
Ex: <code>/depot Hugo 2000 Wepoker</code>
→ Enregistre un dépôt (aujourd'hui, USDT)

<code>/retrait [joueur] [montant] [game]</code>
Ex: <code>/retrait Hugo 500 Wepoker</code>
→ Enregistre un retrait

<code>/pnl</code> ou <code>/pnl [joueur]</code>
→ Affiche le P&L

Games disponibles : TELE · Wepoker · Xpoker · ClubGG`);
}

// ── Member join handler ───────────────────────────────────
async function handleNewMembers(members: any[], chatTitle: string) {
  const db = getDb();
  for (const member of members) {
    if (member.is_bot) continue;
    const name = [member.first_name, member.last_name].filter(Boolean).join(" ") || `TG#${member.id}`;
    const existing = db.prepare(`SELECT id FROM players WHERE telegram_id = ?`).get(member.id) as { id: number } | undefined;
    let playerId: number;
    let isNew: boolean;
    if (existing) {
      playerId = existing.id;
      isNew = false;
    } else {
      const r = db.prepare(
        `INSERT INTO players (name, telegram_handle, telegram_id, status, tier) VALUES (@name, @handle, @telegram_id, 'active', 'B')`
      ).run({ name, handle: member.username ?? null, telegram_id: member.id });
      playerId = Number(r.lastInsertRowid);
      isNew = true;
    }
    db.prepare(`INSERT INTO crm_notes (player_id, content, type) VALUES (?, ?, 'note')`)
      .run(playerId, `${isNew ? "Créé automatiquement — a" : "A"} rejoint "${chatTitle}"`);
  }
}

// ── Main handler ──────────────────────────────────────────
export async function POST(req: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const incoming = req.headers.get("x-telegram-bot-api-secret-token");
    if (incoming !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const update = await req.json();

  // Commands from authorized user
  const msg = update.message;
  if (msg?.text?.startsWith("/") && OWNER_IDS.has(msg.from?.id)) {
    const [rawCmd, ...args] = msg.text.trim().split(/\s+/);
    const cmd = rawCmd.split("@")[0].toLowerCase(); // handle /cmd@botname format
    const chatId = msg.chat.id;

    try {
      if (cmd === "/deal")    await handleDeal(args, chatId);
      else if (cmd === "/depot")   await handleDeposit(args, chatId);
      else if (cmd === "/retrait") await handleWithdrawal(args, chatId);
      else if (cmd === "/pnl")     await handlePnl(args, chatId);
      else if (cmd === "/aide" || cmd === "/help") await handleAide(chatId);
    } catch (e: any) {
      console.error("[TG CMD]", e);
      await sendMsg(chatId, `❌ Erreur : ${e.message}`);
    }
    return NextResponse.json({ ok: true });
  }

  // New members joining a group
  if (msg?.new_chat_members) {
    await handleNewMembers(msg.new_chat_members, msg.chat?.title ?? "");
    return NextResponse.json({ ok: true });
  }

  const cm = update.chat_member;
  if (cm?.new_chat_member?.status === "member" && !cm.new_chat_member.user?.is_bot) {
    await handleNewMembers([cm.new_chat_member.user], cm.chat?.title ?? "");
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
