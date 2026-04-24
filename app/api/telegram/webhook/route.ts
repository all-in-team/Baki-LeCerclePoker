import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { upsertPlayerGameDeal, insertWalletTransaction } from "@/lib/queries";

const OWNER_IDS = new Set([1298290355]);
const GAME_NAMES = ["tele", "wepoker", "xpoker", "clubgg"];

// ── Telegram API ──────────────────────────────────────────
async function sendMsg(chatId: number | string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

// ── Flexible parser ───────────────────────────────────────
// Handles: "hugo 2000$ wepoker 55% action, 5% RB"
//      or: "hugo wepoker 2000 50 0"
//      or: "hugo 2000 wepoker"
interface Parsed {
  playerQuery: string;
  gameName: string | null;
  amount: number | null;
  action_pct: number | null;
  rakeback_pct: number | null;
}

function parseArgs(rawText: string): Parsed {
  // Strip $, commas between digits, normalize spaces
  let text = rawText
    .replace(/\$|€/g, "")
    .replace(/,\s*(?=\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Extract action%: "55% action" or "action 55%" or "action: 55"
  let action_pct: number | null = null;
  text = text.replace(/(\d+(?:\.\d+)?)\s*%\s*action\b/gi, (_, n) => { action_pct = parseFloat(n); return ""; });
  text = text.replace(/\baction\s*:?\s*(\d+(?:\.\d+)?)\s*%?/gi, (_, n) => { action_pct ??= parseFloat(n); return ""; });

  // Extract RB%: "5% RB" or "RB 5%" or "rakeback 5"
  let rakeback_pct: number | null = null;
  text = text.replace(/(\d+(?:\.\d+)?)\s*%?\s*(?:rb|rakeback)\b/gi, (_, n) => { rakeback_pct = parseFloat(n); return ""; });
  text = text.replace(/\b(?:rb|rakeback)\s*:?\s*(\d+(?:\.\d+)?)\s*%?/gi, (_, n) => { rakeback_pct ??= parseFloat(n); return ""; });

  // Remove stray % signs and keywords
  text = text.replace(/\b(action|rb|rakeback)\b/gi, "").replace(/%/g, "").replace(/\s+/g, " ").trim();

  // Find game name
  let gameName: string | null = null;
  const tokens = text.split(/\s+/);
  const nonGameTokens: string[] = [];
  for (const tok of tokens) {
    const match = GAME_NAMES.find(g => g === tok.toLowerCase());
    if (match && !gameName) {
      // Capitalize correctly
      const canonical: Record<string, string> = { tele: "TELE", wepoker: "Wepoker", xpoker: "Xpoker", clubgg: "ClubGG" };
      gameName = canonical[match];
    } else {
      nonGameTokens.push(tok);
    }
  }

  // From remaining tokens: extract amount (first number), rest is player name
  let amount: number | null = null;
  const playerParts: string[] = [];
  for (const tok of nonGameTokens) {
    const n = parseFloat(tok);
    if (!isNaN(n) && amount === null && tok.match(/^\d/)) {
      amount = n;
    } else {
      playerParts.push(tok);
    }
  }

  return {
    playerQuery: playerParts.join(" ").trim(),
    gameName,
    amount,
    action_pct,
    rakeback_pct,
  };
}

// ── DB helpers ────────────────────────────────────────────
function findPlayer(query: string) {
  return getDb().prepare(
    `SELECT id, name FROM players WHERE LOWER(name) LIKE LOWER(?) ORDER BY name LIMIT 5`
  ).all(`%${query}%`) as { id: number; name: string }[];
}

function findGame(name: string) {
  return getDb().prepare(
    `SELECT id, name FROM games WHERE LOWER(name) = LOWER(?)`
  ).get(name) as { id: number; name: string } | undefined;
}

function getPlayerPnl(playerId?: number) {
  const base = `
    SELECT p.name AS player_name, g.name AS game_name, pgd.action_pct,
      COALESCE(SUM(CASE WHEN wt.type='deposit' THEN wt.amount ELSE 0 END), 0) AS deposited,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE 0 END), 0) AS withdrawn,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) AS net,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE -wt.amount END), 0) * pgd.action_pct / 100 AS my_pnl
    FROM players p
    JOIN player_game_deals pgd ON pgd.player_id = p.id
    JOIN games g ON g.id = pgd.game_id
    LEFT JOIN wallet_transactions wt ON wt.player_id = p.id AND wt.game_id = pgd.game_id
  `;
  if (playerId !== undefined)
    return getDb().prepare(base + ` WHERE p.id = ? GROUP BY p.id, pgd.game_id`).all(playerId) as any[];
  return getDb().prepare(base + ` GROUP BY p.id, pgd.game_id ORDER BY my_pnl DESC`).all() as any[];
}

function s(n: number) {
  return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(2);
}

// ── Command: /deal ────────────────────────────────────────
async function handleDeal(rawText: string, chatId: number) {
  const p = parseArgs(rawText);

  if (!p.playerQuery) {
    await sendMsg(chatId, "❌ Usage : <code>/deal hugo wepoker 55% action 5% RB</code>");
    return;
  }
  if (!p.gameName) {
    await sendMsg(chatId, "❌ Game manquante. Games : TELE · Wepoker · Xpoker · ClubGG");
    return;
  }
  if (p.action_pct === null) {
    // Fallback: first number in original text is action_pct
    if (p.amount !== null) { p.action_pct = p.amount; p.amount = null; }
    else {
      await sendMsg(chatId, "❌ Action % manquant.\nEx : <code>/deal hugo wepoker 55% action 5% RB</code>");
      return;
    }
  }

  const players = findPlayer(p.playerQuery);
  if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${p.playerQuery}" introuvable`); return; }
  if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }

  const game = findGame(p.gameName);
  if (!game) { await sendMsg(chatId, `❌ Game "${p.gameName}" inconnue`); return; }

  const rb = p.rakeback_pct ?? 0;
  upsertPlayerGameDeal({ player_id: players[0].id, game_id: game.id, action_pct: p.action_pct, rakeback_pct: rb });

  await sendMsg(chatId,
    `✅ <b>Deal enregistré</b>\n<b>${players[0].name}</b> sur <b>${game.name}</b>\nAction : <b>${p.action_pct}%</b> · RB : <b>${rb}%</b>`
  );
}

// ── Command: /depot & /retrait ────────────────────────────
async function handleTx(type: "deposit" | "withdrawal", rawText: string, chatId: number) {
  const p = parseArgs(rawText);
  const cmd = type === "deposit" ? "depot" : "retrait";

  if (!p.playerQuery) {
    await sendMsg(chatId, `❌ Usage : <code>/${cmd} hugo 2000$ wepoker 55% action 5% RB</code>`);
    return;
  }
  if (!p.gameName) {
    await sendMsg(chatId, "❌ Game manquante. Games : TELE · Wepoker · Xpoker · ClubGG");
    return;
  }
  if (!p.amount || p.amount <= 0) {
    await sendMsg(chatId, "❌ Montant invalide");
    return;
  }

  const players = findPlayer(p.playerQuery);
  if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${p.playerQuery}" introuvable`); return; }
  if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }

  const game = findGame(p.gameName);
  if (!game) { await sendMsg(chatId, `❌ Game "${p.gameName}" inconnue`); return; }

  // Si deal fourni → upsert deal en même temps
  let dealMsg = "";
  if (p.action_pct !== null) {
    const rb = p.rakeback_pct ?? 0;
    upsertPlayerGameDeal({ player_id: players[0].id, game_id: game.id, action_pct: p.action_pct, rakeback_pct: rb });
    dealMsg = `\nDeal : <b>${p.action_pct}% action</b> · <b>${rb}% RB</b>`;
  }

  const today = new Date().toISOString().slice(0, 10);
  insertWalletTransaction({ player_id: players[0].id, game_id: game.id, type, amount: p.amount, currency: "USDT", tx_date: today });

  const emoji = type === "deposit" ? "📥" : "📤";
  const label = type === "deposit" ? "Dépôt" : "Retrait";
  await sendMsg(chatId,
    `${emoji} <b>${label} enregistré</b>\n<b>${players[0].name}</b> · ${game.name}\n<b>${p.amount.toFixed(2)} USDT</b> · ${today}${dealMsg}`
  );
}

// ── Command: /pnl ─────────────────────────────────────────
async function handlePnl(rawText: string, chatId: number) {
  const query = rawText.trim();
  if (query) {
    const players = findPlayer(query);
    if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${query}" introuvable`); return; }
    if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }
    const rows = getPlayerPnl(players[0].id);
    if (rows.length === 0) { await sendMsg(chatId, `ℹ️ ${players[0].name} — aucun deal configuré`); return; }
    const lines = rows.map((r: any) =>
      `<b>${r.game_name}</b> [${r.action_pct}%]\n  Déposé: ${r.deposited.toFixed(2)} | Retiré: ${r.withdrawn.toFixed(2)}\n  Net joueur: ${s(r.net)} | <b>Mon P&L: ${s(r.my_pnl)}</b>`
    );
    await sendMsg(chatId, `📊 <b>${players[0].name}</b>\n\n${lines.join("\n\n")}`);
  } else {
    const rows = getPlayerPnl();
    if (rows.length === 0) { await sendMsg(chatId, "ℹ️ Aucune donnée"); return; }
    let total = 0;
    const lines = rows.map((r: any) => {
      total += r.my_pnl;
      return `${r.my_pnl > 0 ? "🟢" : r.my_pnl < 0 ? "🔴" : "⚪"} <b>${r.player_name}</b> / ${r.game_name} — ${s(r.my_pnl)} USDT`;
    });
    await sendMsg(chatId, `📊 <b>P&L Global</b>\n\n${lines.join("\n")}\n\n<b>Total : ${s(total)} USDT</b>`);
  }
}

// ── Command: /aide ────────────────────────────────────────
async function handleAide(chatId: number) {
  await sendMsg(chatId, `🃏 <b>Le Cercle Bot</b>

<b>Dépôt avec deal en une ligne :</b>
<code>/depot hugo 2000$ wepoker 55% action, 5% RB</code>

<b>Retrait :</b>
<code>/retrait hugo 500$ wepoker</code>

<b>Deal seul (sans transaction) :</b>
<code>/deal hugo wepoker 55% action, 5% RB</code>

<b>P&L :</b>
<code>/pnl</code> — tous les joueurs
<code>/pnl hugo</code> — un joueur

Games : <b>TELE · Wepoker · Xpoker · ClubGG</b>
Le $ et % sont optionnels.`);
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
    if (existing) { playerId = existing.id; isNew = false; }
    else {
      const r = db.prepare(`INSERT INTO players (name, telegram_handle, telegram_id, status, tier) VALUES (@name, @handle, @telegram_id, 'active', 'B')`)
        .run({ name, handle: member.username ?? null, telegram_id: member.id });
      playerId = Number(r.lastInsertRowid);
      isNew = true;
    }
    db.prepare(`INSERT INTO crm_notes (player_id, content, type) VALUES (?, ?, 'note')`)
      .run(playerId, `${isNew ? "Créé automatiquement — a" : "A"} rejoint "${chatTitle}"`);
  }
}

// ── Main POST handler ─────────────────────────────────────
export async function POST(req: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const incoming = req.headers.get("x-telegram-bot-api-secret-token");
    if (incoming !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const update = await req.json();
  const msg = update.message;

  // Commands (owner only)
  if (msg?.text?.startsWith("/") && OWNER_IDS.has(msg.from?.id)) {
    const spaceIdx = msg.text.indexOf(" ");
    const rawCmd = spaceIdx === -1 ? msg.text : msg.text.slice(0, spaceIdx);
    const rawArgs = spaceIdx === -1 ? "" : msg.text.slice(spaceIdx + 1);
    const cmd = rawCmd.split("@")[0].toLowerCase();
    const chatId = msg.chat.id;
    try {
      if (cmd === "/deal")              await handleDeal(rawArgs, chatId);
      else if (cmd === "/depot")        await handleTx("deposit", rawArgs, chatId);
      else if (cmd === "/retrait")      await handleTx("withdrawal", rawArgs, chatId);
      else if (cmd === "/pnl")          await handlePnl(rawArgs, chatId);
      else if (cmd === "/aide" || cmd === "/help") await handleAide(chatId);
    } catch (e: any) {
      console.error("[TG CMD]", e);
      await sendMsg(chatId, `❌ Erreur : ${e.message}`);
    }
    return NextResponse.json({ ok: true });
  }

  // New members
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
