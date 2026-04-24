import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { upsertPlayerGameDeal, insertWalletTransaction } from "@/lib/queries";

const OWNER_IDS = new Set([1298290355]);
const GAME_NAMES = ["tele", "wepoker", "xpoker", "clubgg"];
const TRC20_RE = /^T[a-zA-Z0-9]{33}$/;

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

// ── Session helpers ───────────────────────────────────────
type Step = "waiting_wallet_game" | "waiting_wallet_cashout";

function getSession(chatId: string | number): { step: Step; player_id: number } | null {
  return getDb().prepare(
    `SELECT step, player_id FROM telegram_sessions WHERE chat_id = ?`
  ).get(String(chatId)) as any ?? null;
}
function setSession(chatId: string | number, step: Step, player_id: number) {
  getDb().prepare(
    `INSERT OR REPLACE INTO telegram_sessions (chat_id, step, player_id, created_at) VALUES (?, ?, ?, datetime('now'))`
  ).run(String(chatId), step, player_id);
}
function clearSession(chatId: string | number) {
  getDb().prepare(`DELETE FROM telegram_sessions WHERE chat_id = ?`).run(String(chatId));
}

// ── Flexible parser ───────────────────────────────────────
interface Parsed {
  playerQuery: string;
  gameName: string | null;
  amount: number | null;
  action_pct: number | null;
  rakeback_pct: number | null;
}

function parseArgs(rawText: string): Parsed {
  let text = rawText
    .replace(/\$|€/g, "")
    .replace(/,\s*(?=\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let action_pct: number | null = null;
  text = text.replace(/(\d+(?:\.\d+)?)\s*%\s*action\b/gi, (_, n) => { action_pct = parseFloat(n); return ""; });
  text = text.replace(/\baction\s*:?\s*(\d+(?:\.\d+)?)\s*%?/gi, (_, n) => { action_pct ??= parseFloat(n); return ""; });

  let rakeback_pct: number | null = null;
  text = text.replace(/(\d+(?:\.\d+)?)\s*%?\s*(?:rb|rakeback)\b/gi, (_, n) => { rakeback_pct = parseFloat(n); return ""; });
  text = text.replace(/\b(?:rb|rakeback)\s*:?\s*(\d+(?:\.\d+)?)\s*%?/gi, (_, n) => { rakeback_pct ??= parseFloat(n); return ""; });

  text = text.replace(/\b(action|rb|rakeback)\b/gi, "").replace(/%/g, "").replace(/\s+/g, " ").trim();

  let gameName: string | null = null;
  const canonical: Record<string, string> = { tele: "TELE", wepoker: "Wepoker", xpoker: "Xpoker", clubgg: "ClubGG" };
  const tokens = text.split(/\s+/);
  const nonGameTokens: string[] = [];
  for (const tok of tokens) {
    const match = GAME_NAMES.find(g => g === tok.toLowerCase());
    if (match && !gameName) { gameName = canonical[match]; }
    else { nonGameTokens.push(tok); }
  }

  let amount: number | null = null;
  const playerParts: string[] = [];
  for (const tok of nonGameTokens) {
    const n = parseFloat(tok);
    if (!isNaN(n) && amount === null && tok.match(/^\d/)) { amount = n; }
    else { playerParts.push(tok); }
  }

  return { playerQuery: playerParts.join(" ").trim(), gameName, amount, action_pct, rakeback_pct };
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
function getPlayerFull(playerId: number) {
  return getDb().prepare(`SELECT id, name, tron_address, tele_wallet_cashout FROM players WHERE id = ?`).get(playerId) as
    { id: number; name: string; tron_address: string | null; tele_wallet_cashout: string | null } | undefined;
}
function getTeleDeal(playerId: number) {
  return getDb().prepare(`
    SELECT pgd.action_pct, pgd.rakeback_pct FROM player_game_deals pgd
    JOIN games g ON g.id = pgd.game_id WHERE pgd.player_id = ? AND LOWER(g.name) = 'tele'
  `).get(playerId) as { action_pct: number; rakeback_pct: number } | undefined;
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

// ── Onboarding status summary ─────────────────────────────
function onboardingStatus(player: { id: number; name: string; tron_address: string | null; tele_wallet_cashout: string | null }) {
  const deal = getTeleDeal(player.id);
  const firstName = player.name.split(" ")[0].toLowerCase();
  const hasDeal = !!deal;
  const hasGame = !!(player.tron_address && TRC20_RE.test(player.tron_address));
  const hasCashout = !!(player.tele_wallet_cashout && TRC20_RE.test(player.tele_wallet_cashout));

  if (!hasDeal) return `📋 <b>Étape 1/3</b> — Configure le deal de <b>${player.name}</b> :\n<code>/deal ${firstName} tele 40% action</code>`;
  if (!hasGame) return `📲 <b>Étape 2/3</b> — WALLET GAME de <b>${player.name}</b> :\nEnvoie son adresse TRC20 (compte TELE) dans ce chat.`;
  if (!hasCashout) return `💸 <b>Étape 3/3</b> — WALLET CASHOUT de <b>${player.name}</b> :\nEnvoie son adresse Binance TRC20 (pour recevoir les cashouts) dans ce chat.`;
  return `🟢 <b>${player.name} est 100% configuré</b> — deal ${deal!.action_pct}% action · WALLET GAME ✅ · WALLET CASHOUT ✅\nLance un <b>Sync TELE</b> sur le dashboard pour capturer ses transactions.`;
}

// ── Guided flow: handle raw TRC20 address ─────────────────
async function handleRawAddress(address: string, chatId: number) {
  const session = getSession(chatId);
  if (!session) return; // no active session, ignore

  const player = getPlayerFull(session.player_id);
  if (!player) { clearSession(chatId); return; }

  const db = getDb();
  const firstName = player.name.split(" ")[0].toLowerCase();

  if (session.step === "waiting_wallet_game") {
    db.prepare(`UPDATE players SET tron_address = ? WHERE id = ?`).run(address, player.id);
    setSession(chatId, "waiting_wallet_cashout", player.id);
    await sendMsg(chatId,
      `✅ <b>WALLET GAME enregistré</b> pour <b>${player.name}</b>\n<code>${address}</code>\n\n` +
      `💸 <b>Étape 3/3</b> — Envoie maintenant le <b>WALLET CASHOUT</b> de ${player.name}\n` +
      `<i>(son adresse Binance TRC20 pour recevoir les cashouts)</i>`
    );
  } else if (session.step === "waiting_wallet_cashout") {
    db.prepare(`UPDATE players SET tele_wallet_cashout = ? WHERE id = ?`).run(address, player.id);
    clearSession(chatId);
    const deal = getTeleDeal(player.id);
    await sendMsg(chatId,
      `✅ <b>WALLET CASHOUT enregistré</b> pour <b>${player.name}</b>\n<code>${address}</code>\n\n` +
      `🟢 <b>${player.name} est 100% configuré !</b>\n` +
      `Deal : <b>${deal?.action_pct ?? "?"}% action</b> · RB : <b>${deal?.rakeback_pct ?? 0}%</b>\n` +
      `WALLET GAME ✅ · WALLET CASHOUT ✅\n\n` +
      `Lance un <b>Sync TELE</b> sur le dashboard pour capturer ses transactions automatiquement.`
    );
  }
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
    if (p.amount !== null) { p.action_pct = p.amount; p.amount = null; }
    else {
      await sendMsg(chatId, "❌ Action % manquant.\nEx : <code>/deal hugo tele 40% action</code>");
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

  // If TELE → start guided wallet flow
  if (game.name === "TELE") {
    const player = getPlayerFull(players[0].id)!;
    const hasGame = !!(player.tron_address && TRC20_RE.test(player.tron_address));
    const hasCashout = !!(player.tele_wallet_cashout && TRC20_RE.test(player.tele_wallet_cashout));

    if (!hasGame) {
      setSession(chatId, "waiting_wallet_game", player.id);
      await sendMsg(chatId,
        `📲 <b>Étape 2/3</b> — Envoie le <b>WALLET GAME</b> de ${player.name}\n` +
        `<i>(l'adresse TRC20 de son compte TELE — c'est là où on envoie les dépôts)</i>`
      );
    } else if (!hasCashout) {
      setSession(chatId, "waiting_wallet_cashout", player.id);
      await sendMsg(chatId,
        `💸 <b>Étape 3/3</b> — Envoie le <b>WALLET CASHOUT</b> de ${player.name}\n` +
        `<i>(son adresse Binance TRC20 pour recevoir les cashouts)</i>`
      );
    } else {
      await sendMsg(chatId, `🟢 <b>${player.name} est déjà 100% configuré</b> — rien à faire.`);
    }
  }
}

// ── Command: /depot & /retrait ────────────────────────────
async function handleTx(type: "deposit" | "withdrawal", rawText: string, chatId: number) {
  const p = parseArgs(rawText);
  const cmd = type === "deposit" ? "depot" : "retrait";

  if (!p.playerQuery) {
    await sendMsg(chatId, `❌ Usage : <code>/${cmd} hugo 2000$ wepoker</code>`);
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

// ── Command: /wallet (override manuel) ───────────────────
// /wallet hugo game TXxxx...   ou   /wallet hugo cashout TXxxx...
async function handleWallet(rawText: string, chatId: number) {
  const parts = rawText.trim().split(/\s+/);
  const address = parts[parts.length - 1];
  const typeToken = parts[parts.length - 2]?.toLowerCase();

  if (!["game", "cashout"].includes(typeToken)) {
    await sendMsg(chatId,
      `❌ Usage :\n<code>/wallet hugo game TXxxx…</code>\n<code>/wallet hugo cashout TXxxx…</code>`);
    return;
  }
  if (!TRC20_RE.test(address)) {
    await sendMsg(chatId, `❌ Adresse invalide — doit commencer par T et faire 34 caractères`);
    return;
  }

  const playerQuery = parts.slice(0, parts.length - 2).join(" ").trim();
  if (!playerQuery) { await sendMsg(chatId, `❌ Nom du joueur manquant`); return; }

  const players = findPlayer(playerQuery);
  if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${playerQuery}" introuvable`); return; }
  if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }

  const db = getDb();
  const player = players[0];

  if (typeToken === "game") {
    db.prepare(`UPDATE players SET tron_address = ? WHERE id = ?`).run(address, player.id);
    clearSession(chatId);
    const full = getPlayerFull(player.id)!;
    await sendMsg(chatId, `✅ <b>WALLET GAME enregistré</b> pour <b>${player.name}</b>\n<code>${address}</code>\n\n${onboardingStatus(full)}`);
  } else {
    db.prepare(`UPDATE players SET tele_wallet_cashout = ? WHERE id = ?`).run(address, player.id);
    clearSession(chatId);
    const full = getPlayerFull(player.id)!;
    await sendMsg(chatId, `✅ <b>WALLET CASHOUT enregistré</b> pour <b>${player.name}</b>\n<code>${address}</code>\n\n${onboardingStatus(full)}`);
  }
}

// ── Command: /check ───────────────────────────────────────
async function handleCheck(rawText: string, chatId: number) {
  const query = rawText.trim();
  if (!query) {
    await sendMsg(chatId, `❌ Usage : <code>/check hugo</code>`);
    return;
  }
  const players = findPlayer(query);
  if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${query}" introuvable`); return; }
  if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }

  const player = getPlayerFull(players[0].id)!;
  const deal = getTeleDeal(player.id);
  const hasGame = !!(player.tron_address && TRC20_RE.test(player.tron_address));
  const hasCashout = !!(player.tele_wallet_cashout && TRC20_RE.test(player.tele_wallet_cashout));

  const dealLine = deal ? `✅ Deal : <b>${deal.action_pct}% action · ${deal.rakeback_pct}% RB</b>` : `❌ Pas de deal TELE`;
  const gameLine = hasGame ? `✅ WALLET GAME : <code>${player.tron_address!.slice(0, 8)}…${player.tron_address!.slice(-6)}</code>` : `❌ WALLET GAME manquant`;
  const cashoutLine = hasCashout ? `✅ WALLET CASHOUT : <code>${player.tele_wallet_cashout!.slice(0, 8)}…${player.tele_wallet_cashout!.slice(-6)}</code>` : `❌ WALLET CASHOUT manquant`;

  await sendMsg(chatId, `🔎 <b>Statut de ${player.name}</b>\n\n${dealLine}\n${gameLine}\n${cashoutLine}`);
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

<b>— Onboarding joueur —</b>
Quand un joueur rejoint → auto-créé. Puis :
<code>/deal hugo tele 40% action</code>
→ le bot demande ensuite les wallets directement

<b>— Override wallets —</b>
<code>/wallet hugo game TXxxx…</code>
<code>/wallet hugo cashout TXxxx…</code>

<b>— Vérifier un joueur —</b>
<code>/check hugo</code>

<b>— Transactions manuelles —</b>
<code>/depot hugo 2000$ wepoker</code>
<code>/retrait hugo 500$ wepoker</code>

<b>— Deal seul —</b>
<code>/deal hugo wepoker 55% action 5% RB</code>

<b>— P&L —</b>
<code>/pnl</code> — tous · <code>/pnl hugo</code> — un joueur

Games : <b>TELE · Wepoker · Xpoker · ClubGG</b>`);
}

// ── Member join handler ───────────────────────────────────
async function handleNewMembers(members: any[], chatTitle: string, chatId: number) {
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

    const firstName = name.split(" ")[0].toLowerCase();
    if (isNew) {
      await sendMsg(chatId,
        `✅ <b>${name}</b> ajouté au CRM automatiquement.\n\n` +
        `📋 <b>Étape 1/3</b> — Configure son deal :\n<code>/deal ${firstName} tele 40% action</code>\n` +
        `<i>(ajuste le % selon ton deal avec lui)</i>`
      );
    }
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
  const chatId = msg?.chat?.id;

  // Commands (owner only)
  if (msg?.text?.startsWith("/") && OWNER_IDS.has(msg.from?.id)) {
    const spaceIdx = msg.text.indexOf(" ");
    const rawCmd = spaceIdx === -1 ? msg.text : msg.text.slice(0, spaceIdx);
    const rawArgs = spaceIdx === -1 ? "" : msg.text.slice(spaceIdx + 1);
    const cmd = rawCmd.split("@")[0].toLowerCase();
    try {
      if (cmd === "/deal")              await handleDeal(rawArgs, chatId);
      else if (cmd === "/depot")        await handleTx("deposit", rawArgs, chatId);
      else if (cmd === "/retrait")      await handleTx("withdrawal", rawArgs, chatId);
      else if (cmd === "/wallet")       await handleWallet(rawArgs, chatId);
      else if (cmd === "/check")        await handleCheck(rawArgs, chatId);
      else if (cmd === "/pnl")          await handlePnl(rawArgs, chatId);
      else if (cmd === "/aide" || cmd === "/help") await handleAide(chatId);
    } catch (e: any) {
      console.error("[TG CMD]", e);
      await sendMsg(chatId, `❌ Erreur : ${e.message}`);
    }
    return NextResponse.json({ ok: true });
  }

  // Raw TRC20 address → guided onboarding flow
  if (msg?.text && OWNER_IDS.has(msg.from?.id)) {
    const text = msg.text.trim();
    if (TRC20_RE.test(text)) {
      try { await handleRawAddress(text, chatId); } catch (e: any) {
        console.error("[TG ADDR]", e);
      }
      return NextResponse.json({ ok: true });
    }
  }

  // New members
  if (msg?.new_chat_members) {
    await handleNewMembers(msg.new_chat_members, msg.chat?.title ?? "", chatId);
    return NextResponse.json({ ok: true });
  }
  const cm = update.chat_member;
  if (cm?.new_chat_member?.status === "member" && !cm.new_chat_member.user?.is_bot) {
    await handleNewMembers([cm.new_chat_member.user], cm.chat?.title ?? "", cm.chat?.id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
