import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { upsertPlayerGameDeal, insertWalletTransaction } from "@/lib/queries";
import { isMention, runChat } from "@/lib/agent-chat";

const AGENT_CHAT_ID = process.env.AGENT_TELEGRAM_CHAT_ID ?? "-4846690641";

const OWNER_IDS = new Set<number>(
  (process.env.TELEGRAM_OWNER_IDS ?? "1298290355")
    .split(",").map(id => parseInt(id.trim(), 10)).filter(n => !isNaN(n))
);
const GAME_NAMES = ["tele", "wepoker", "xpoker", "clubgg"];
const TRC20_RE = /^T[a-zA-Z0-9]{33}$/;

// ── Telegram API ──────────────────────────────────────────
async function sendMsg(chatId: number | string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  if (!res.ok) console.error("[TG sendMsg]", chatId, res.status, await res.text());
}

const WALLET_GAME_PHOTO_URL = "https://lecerclepoker-production.up.railway.app/tele-wallet-guide.jpg";

async function askWalletGame(chatId: number | string, mention: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const caption =
    `📲 <b>Étape 2/3</b> — ${mention}, envoie ton <b>WALLET GAME</b>\n` +
    `<i>C'est la "Deposit Address" TRON dans l'app TELE (voir capture ci-dessus)</i>`;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo: WALLET_GAME_PHOTO_URL, caption, parse_mode: "HTML" }),
  });

  // Fallback to text if photo fails
  if (!res.ok) {
    await sendMsg(chatId, caption);
  }
}

// ── Session helpers ───────────────────────────────────────
type Step = "waiting_action_pct" | "waiting_wallet_game" | "waiting_wallet_cashout" | "waiting_game" | "waiting_player";

function getSession(chatId: string | number): { step: Step; player_id: number; expected_tg_id: number | null; pending_cmd: string | null } | null {
  return getDb().prepare(
    `SELECT step, player_id, expected_tg_id, pending_cmd FROM telegram_sessions WHERE chat_id = ? AND created_at > datetime('now', '-24 hours')`
  ).get(String(chatId)) as any ?? null;
}
function setSession(chatId: string | number, step: Step, player_id: number | null, expected_tg_id?: number | null, pending_cmd?: string | null) {
  getDb().prepare(
    `INSERT OR REPLACE INTO telegram_sessions (chat_id, step, player_id, expected_tg_id, pending_cmd, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(String(chatId), step, player_id ?? null, expected_tg_id ?? null, pending_cmd ?? null);
}

function mentionOf(player: { name: string; telegram_handle?: string | null; telegram_id?: number | null }) {
  if (player.telegram_id) return `<a href="tg://user?id=${player.telegram_id}">${player.name}</a>`;
  if (player.telegram_handle) return `@${player.telegram_handle}`;
  return `<b>${player.name}</b>`;
}
function clearSession(chatId: string | number) {
  getDb().prepare(`DELETE FROM telegram_sessions WHERE chat_id = ?`).run(String(chatId));
}
async function promptGame(chatId: number, cmd: string, args: string) {
  setSession(chatId, "waiting_game", null, null, `${cmd}:${args}`);
  await sendMsg(chatId, `🎮 Quelle game ?\n\n<b>TELE · Wepoker · Xpoker · ClubGG</b>`);
}
async function promptPlayer(chatId: number, cmd: string, args: string) {
  setSession(chatId, "waiting_player", null, null, `${cmd}:${args}`);
  await sendMsg(chatId, `👤 Pour quel joueur ? (envoie le nom ou @tag)`);
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

  // Extract @mention → use as player query directly
  const mentionMatch = text.match(/@(\w+)/);
  if (mentionMatch) {
    // Remove the @mention from the text, parse the rest normally
    text = text.replace(/@\w+/, "").replace(/\s+/g, " ").trim();
    const rest = parseArgs(text); // parse remaining (game, amount, pct)
    return { ...rest, playerQuery: `@${mentionMatch[1]}` };
  }

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
    const kMatch = tok.match(/^(\d+(?:\.\d+)?)[kK]$/);
    if (kMatch && amount === null) { amount = parseFloat(kMatch[1]) * 1000; }
    else {
      const n = parseFloat(tok);
      if (!isNaN(n) && amount === null && tok.match(/^\d/)) { amount = n; }
      else { playerParts.push(tok); }
    }
  }

  return { playerQuery: playerParts.join(" ").trim(), gameName, amount, action_pct, rakeback_pct };
}

// ── DB helpers ────────────────────────────────────────────
function findPlayer(query: string) {
  const db = getDb();
  if (query.startsWith("@")) {
    const handle = query.slice(1).toLowerCase();
    // 1. Exact telegram_handle match
    const byHandle = db.prepare(
      `SELECT id, name, telegram_handle FROM players WHERE LOWER(telegram_handle) = ? LIMIT 1`
    ).get(handle) as { id: number; name: string; telegram_handle: string | null } | undefined;
    if (byHandle) return [byHandle];
    // 2. Fallback: name search with the text after @
    return db.prepare(
      `SELECT id, name, telegram_handle FROM players WHERE LOWER(name) LIKE LOWER(?) ORDER BY name LIMIT 5`
    ).all(`%${handle}%`) as { id: number; name: string; telegram_handle: string | null }[];
  }
  return db.prepare(
    `SELECT id, name, telegram_handle FROM players WHERE LOWER(name) LIKE LOWER(?) ORDER BY name LIMIT 5`
  ).all(`%${query}%`) as { id: number; name: string; telegram_handle: string | null }[];
}
function findGame(name: string) {
  return getDb().prepare(
    `SELECT id, name FROM games WHERE LOWER(name) = LOWER(?)`
  ).get(name) as { id: number; name: string } | undefined;
}
function getPlayerFull(playerId: number) {
  return getDb().prepare(`SELECT id, name, telegram_handle, telegram_id, tron_address, tele_wallet_cashout FROM players WHERE id = ?`).get(playerId) as
    { id: number; name: string; telegram_handle: string | null; telegram_id: number | null; tron_address: string | null; tele_wallet_cashout: string | null } | undefined;
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

// ── Guided flow: handle raw messages ─────────────────────
async function handleRawMessage(text: string, chatId: number) {
  const session = getSession(chatId);
  if (!session) return;

  // ── waiting_game: owner chose a game after missing it in a command ──
  if (session.step === "waiting_game") {
    const canonical: Record<string, string> = { tele: "TELE", wepoker: "Wepoker", xpoker: "Xpoker", clubgg: "ClubGG" };
    const gameName = canonical[text.trim().toLowerCase()] ?? null;
    if (!gameName) {
      await sendMsg(chatId, `❌ Game inconnue. Réponds avec : <b>TELE</b>, <b>Wepoker</b>, <b>Xpoker</b> ou <b>ClubGG</b>`);
      return;
    }
    clearSession(chatId);
    const pending = session.pending_cmd ?? "";
    const colon = pending.indexOf(":");
    const cmdType = colon === -1 ? pending : pending.slice(0, colon);
    const originalArgs = colon === -1 ? "" : pending.slice(colon + 1);
    const fullArgs = originalArgs ? `${originalArgs} ${gameName}` : gameName;
    if (cmdType === "deal")    { await handleDeal(fullArgs, chatId); return; }
    if (cmdType === "depot")   { await handleTx("deposit", fullArgs, chatId); return; }
    if (cmdType === "retrait") { await handleTx("withdrawal", fullArgs, chatId); return; }
    if (cmdType === "reset")   { await handleReset(fullArgs, chatId); return; }
    return;
  }

  // ── waiting_player: owner named a player after missing it in a command ──
  if (session.step === "waiting_player") {
    const query = text.trim();
    const players = findPlayer(query);
    if (players.length === 0) {
      await sendMsg(chatId, `❌ Joueur "${query}" introuvable — essaie un autre nom ou @tag`);
      return;
    }
    if (players.length > 1) {
      const lines = players.map(p => `• <b>${p.name}</b>${p.telegram_handle ? ` (@${p.telegram_handle})` : ""}`).join("\n");
      await sendMsg(chatId, `❌ Plusieurs joueurs trouvés :\n${lines}\n\nSois plus précis.`);
      return;
    }
    // Exactly one match — confirm and re-dispatch with player name prepended
    clearSession(chatId);
    const pending = session.pending_cmd ?? "";
    const colon = pending.indexOf(":");
    const cmdType = colon === -1 ? pending : pending.slice(0, colon);
    const originalArgs = colon === -1 ? "" : pending.slice(colon + 1);
    const fullArgs = `${players[0].name} ${originalArgs}`.trim();
    if (cmdType === "deal")    { await handleDeal(fullArgs, chatId); return; }
    if (cmdType === "depot")   { await handleTx("deposit", fullArgs, chatId); return; }
    if (cmdType === "retrait") { await handleTx("withdrawal", fullArgs, chatId); return; }
    if (cmdType === "reset")   { await handleReset(fullArgs, chatId); return; }
    return;
  }

  if (!session.player_id) { clearSession(chatId); return; }
  const player = getPlayerFull(session.player_id);
  if (!player) { clearSession(chatId); return; }

  const db = getDb();
  const teleGame = findGame("TELE");

  if (session.step === "waiting_action_pct") {
    // Accept "40", "40%", "40% action", "40 rb 5", etc.
    const pctMatch = text.match(/(\d+(?:\.\d+)?)/);
    if (!pctMatch) {
      await sendMsg(chatId, `❌ Envoie juste le pourcentage, ex : <b>40</b>`);
      return;
    }
    const action_pct = parseFloat(pctMatch[1]);
    // Check for RB too (optional): "40 5" or "40% 5%"
    const nums = [...text.matchAll(/(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]));
    const rakeback_pct = nums.length >= 2 ? nums[1] : 0;

    if (!teleGame) { await sendMsg(chatId, `❌ Game TELE introuvable`); return; }
    upsertPlayerGameDeal({ player_id: player.id, game_id: teleGame.id, action_pct, rakeback_pct });

    const fullForDeal = getPlayerFull(player.id)!;
    setSession(chatId, "waiting_wallet_game", player.id, fullForDeal.telegram_id);
    await sendMsg(chatId,
      `✅ <b>Deal enregistré</b> — <b>${player.name}</b> sur TELE\n` +
      `Action : <b>${action_pct}%</b>` + (rakeback_pct > 0 ? ` · RB : <b>${rakeback_pct}%</b>` : "")
    );
    await askWalletGame(chatId, mentionOf(fullForDeal));

  } else if (session.step === "waiting_wallet_game") {
    if (!TRC20_RE.test(text)) {
      await sendMsg(chatId, `❌ Adresse invalide — doit commencer par <b>T</b> et faire 34 caractères\nEnvoie le WALLET GAME de ${player.name}`);
      return;
    }
    db.prepare(`UPDATE players SET tron_address = ? WHERE id = ?`).run(text, player.id);
    const fullForGame = getPlayerFull(player.id)!;
    setSession(chatId, "waiting_wallet_cashout", player.id, fullForGame.telegram_id);
    await sendMsg(chatId,
      `✅ <b>WALLET GAME enregistré</b> pour <b>${player.name}</b>\n<code>${text}</code>\n\n` +
      `💸 <b>Étape 3/3</b> — ${mentionOf(fullForGame)}, envoie ton <b>WALLET CASHOUT</b>\n` +
      `<i>(ton adresse Binance TRC20 pour recevoir les cashouts)</i>`
    );

  } else if (session.step === "waiting_wallet_cashout") {
    if (!TRC20_RE.test(text)) {
      await sendMsg(chatId, `❌ Adresse invalide — doit commencer par <b>T</b> et faire 34 caractères\nEnvoie le WALLET CASHOUT de ${player.name}`);
      return;
    }
    db.prepare(`UPDATE players SET tele_wallet_cashout = ? WHERE id = ?`).run(text, player.id);
    clearSession(chatId);
    const deal = getTeleDeal(player.id);
    await sendMsg(chatId,
      `✅ <b>WALLET CASHOUT enregistré</b> pour <b>${player.name}</b>\n<code>${text}</code>\n\n` +
      `🟢 <b>${player.name} est 100% configuré !</b>\n` +
      `Deal : <b>${deal?.action_pct ?? "?"}% action</b>` + (deal?.rakeback_pct ? ` · RB : <b>${deal.rakeback_pct}%</b>` : "") + `\n` +
      `WALLET GAME ✅ · WALLET CASHOUT ✅`
    );
    // Auto-advance to next incomplete TELE player if any
    const hasNext = await startNextWalletFlow(chatId, player.id);
    if (!hasNext) {
      await sendMsg(chatId, `🎉 <b>Tous les joueurs TELE sont configurés !</b> Lance un <b>Sync TELE</b> sur le dashboard.`);
    }
  }
}

// ── Command: /transfer ───────────────────────────────────
function parseTransferArgs(rawText: string): { playerQuery: string; amount: number | null; fromGame: string | null; toGame: string | null } {
  let text = rawText.replace(/\$|€/g, "").replace(/,\s*(?=\d)/g, " ").replace(/\s+/g, " ").trim();

  let playerQuery = "";
  const mentionMatch = text.match(/@(\w+)/);
  if (mentionMatch) {
    playerQuery = `@${mentionMatch[1]}`;
    text = text.replace(/@\w+/, "").trim();
  }

  const canonical: Record<string, string> = { tele: "TELE", wepoker: "Wepoker", xpoker: "Xpoker", clubgg: "ClubGG" };
  const tokens = text.split(/\s+/);
  const games: string[] = [];
  let amount: number | null = null;
  const playerParts: string[] = [];

  for (const tok of tokens) {
    const gameMatch = GAME_NAMES.find(g => g === tok.toLowerCase());
    if (gameMatch && games.length < 2) { games.push(canonical[gameMatch]); continue; }
    const kMatch = tok.match(/^(\d+(?:\.\d+)?)[kK]$/);
    if (kMatch && amount === null) { amount = parseFloat(kMatch[1]) * 1000; continue; }
    const n = parseFloat(tok);
    if (!isNaN(n) && amount === null && tok.match(/^\d/)) { amount = n; continue; }
    if (!mentionMatch) playerParts.push(tok);
  }

  if (!mentionMatch) playerQuery = playerParts.join(" ").trim();
  return { playerQuery, amount, fromGame: games[0] ?? null, toGame: games[1] ?? null };
}

async function handleTransfer(rawText: string, chatId: number) {
  const p = parseTransferArgs(rawText);

  if (!p.playerQuery) {
    await sendMsg(chatId, `❌ Usage : <code>/transfer hugo 1k tele wepoker</code>`);
    return;
  }
  if (!p.fromGame || !p.toGame) {
    await sendMsg(chatId, `❌ Spécifie les deux games : <code>/transfer hugo 1k tele wepoker</code>`);
    return;
  }
  if (!p.amount || p.amount <= 0) {
    await sendMsg(chatId, `❌ Montant invalide`);
    return;
  }

  const players = findPlayer(p.playerQuery);
  if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${p.playerQuery}" introuvable`); return; }
  if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }

  const fromGame = findGame(p.fromGame);
  if (!fromGame) { await sendMsg(chatId, `❌ Game "${p.fromGame}" inconnue`); return; }
  const toGame = findGame(p.toGame);
  if (!toGame) { await sendMsg(chatId, `❌ Game "${p.toGame}" inconnue`); return; }

  const today = new Date().toISOString().slice(0, 10);
  insertWalletTransaction({ player_id: players[0].id, game_id: fromGame.id, type: "withdrawal", amount: p.amount, currency: "USDT", tx_date: today });
  insertWalletTransaction({ player_id: players[0].id, game_id: toGame.id, type: "deposit", amount: p.amount, currency: "USDT", tx_date: today });

  await sendMsg(chatId,
    `🔄 <b>Transfer enregistré</b>\n<b>${players[0].name}</b>\n<b>${p.amount.toFixed(2)} USDT</b> : ${fromGame.name} → ${toGame.name} · ${today}`
  );
}

// ── Command: /deal ────────────────────────────────────────
async function handleDeal(rawText: string, chatId: number) {
  const p = parseArgs(rawText);

  if (!p.playerQuery) {
    await promptPlayer(chatId, "deal", rawText);
    return;
  }
  if (!p.gameName) {
    await promptGame(chatId, "deal", rawText);
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

  // If TELE → continue guided flow from where we are
  if (game.name === "TELE") {
    const player = getPlayerFull(players[0].id)!;
    const hasGame = !!(player.tron_address && TRC20_RE.test(player.tron_address));
    const hasCashout = !!(player.tele_wallet_cashout && TRC20_RE.test(player.tele_wallet_cashout));
    if (!hasGame) {
      setSession(chatId, "waiting_wallet_game", player.id, player.telegram_id);
      await askWalletGame(chatId, mentionOf(player));
    } else if (!hasCashout) {
      setSession(chatId, "waiting_wallet_cashout", player.id);
      await sendMsg(chatId,
        `💸 <b>Étape 3/3</b> — Envoie le <b>WALLET CASHOUT</b> de ${player.name}\n` +
        `<i>(son adresse Binance TRC20 pour recevoir les cashouts)</i>`
      );
    } else {
      clearSession(chatId);
      await sendMsg(chatId, `🟢 <b>${player.name} est déjà 100% configuré</b> — rien à faire.`);
    }
  }
}

// ── Command: /depot & /retrait ────────────────────────────
async function handleTx(type: "deposit" | "withdrawal", rawText: string, chatId: number) {
  const p = parseArgs(rawText);
  const cmd = type === "deposit" ? "depot" : "retrait";

  if (!p.playerQuery) {
    await promptPlayer(chatId, cmd, rawText);
    return;
  }
  if (!p.gameName) {
    await promptGame(chatId, cmd, rawText);
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

// ── Command: /reset ───────────────────────────────────────
// /reset hugo tele              → reset complet TELE (deal + wallets)
// /reset hugo tele game         → efface wallet game, relance flow
// /reset hugo tele cashout      → efface wallet cashout, relance flow
// /reset hugo tele deal         → efface deal TELE seulement
// /reset hugo wepoker           → efface deal Wepoker
async function handleReset(rawText: string, chatId: number) {
  const parts = rawText.trim().split(/\s+/).filter(Boolean);

  // Position-independent parse: scan all tokens for game / sub-type / player name
  const canonical: Record<string, string> = { tele: "TELE", wepoker: "Wepoker", xpoker: "Xpoker", clubgg: "ClubGG" };
  const subTypes = ["game", "cashout", "deal"] as const;
  type SubType = typeof subTypes[number];
  let gameName: string | null = null;
  let subType: SubType | null = null;
  const playerParts: string[] = [];
  for (const tok of parts) {
    const lower = tok.toLowerCase();
    if (!gameName && GAME_NAMES.includes(lower)) { gameName = canonical[lower]; }
    else if (!subType && (subTypes as readonly string[]).includes(lower)) { subType = lower as SubType; }
    else { playerParts.push(tok); }
  }
  const playerQuery = playerParts.join(" ").trim();

  if (!playerQuery) {
    await promptPlayer(chatId, "reset", rawText.trim());
    return;
  }
  if (!gameName) {
    await promptGame(chatId, "reset", rawText.trim());
    return;
  }

  const players = findPlayer(playerQuery);
  if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${playerQuery}" introuvable`); return; }
  if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }

  const db = getDb();
  const player = players[0];
  const full = getPlayerFull(player.id)!;
  const game = findGame(gameName);
  if (!game) { await sendMsg(chatId, `❌ Game "${gameName}" inconnue`); return; }
  clearSession(chatId);
  const firstName = player.name.split(" ")[0].toLowerCase();

  if (gameName === "TELE") {
    if (subType === "game") {
      db.prepare(`UPDATE players SET tron_address = NULL WHERE id = ?`).run(player.id);
      setSession(chatId, "waiting_wallet_game", player.id, full.telegram_id);
      await sendMsg(chatId, `🔄 WALLET GAME réinitialisé pour <b>${player.name}</b>`);
      await askWalletGame(chatId, mentionOf(full));
    } else if (subType === "cashout") {
      db.prepare(`UPDATE players SET tele_wallet_cashout = NULL WHERE id = ?`).run(player.id);
      setSession(chatId, "waiting_wallet_cashout", player.id, full.telegram_id);
      await sendMsg(chatId,
        `🔄 WALLET CASHOUT réinitialisé pour <b>${player.name}</b>\n\n` +
        `💸 ${mentionOf(full)}, envoie ton <b>WALLET CASHOUT</b>\n<i>(adresse Binance TRC20)</i>`
      );
    } else if (subType === "deal") {
      db.prepare(`DELETE FROM player_game_deals WHERE player_id = ? AND game_id = ?`).run(player.id, game.id);
      await sendMsg(chatId,
        `🔄 Deal TELE supprimé pour <b>${player.name}</b>\n` +
        `<code>/deal ${firstName} tele 40% action</code> pour reconfigurer.`
      );
    } else {
      // Full TELE reset
      db.prepare(`UPDATE players SET tron_address = NULL, tele_wallet_cashout = NULL WHERE id = ?`).run(player.id);
      db.prepare(`DELETE FROM player_game_deals WHERE player_id = ? AND game_id = ?`).run(player.id, game.id);
      setSession(chatId, "waiting_action_pct", player.id);
      await sendMsg(chatId,
        `🔄 <b>${player.name}</b> réinitialisé sur TELE (deal + wallets).\n\n` +
        `📋 <b>Étape 1/3</b> — Quel est son % action sur TELE ?`
      );
    }
  } else {
    // Other games: deal reset only
    db.prepare(`DELETE FROM player_game_deals WHERE player_id = ? AND game_id = ?`).run(player.id, game.id);
    await sendMsg(chatId,
      `🔄 Deal <b>${gameName}</b> supprimé pour <b>${player.name}</b>\n` +
      `<code>/deal ${firstName} ${gameName.toLowerCase()} 55% action</code> pour reconfigurer.`
    );
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

<b>— Override / correction —</b>
<code>/wallet hugo game TXxxx…</code>
<code>/wallet hugo cashout TXxxx…</code>
<code>/reset hugo tele</code> — reset complet TELE (deal + wallets)
<code>/reset hugo tele game</code> — wallet game seulement
<code>/reset hugo tele cashout</code> — wallet cashout seulement
<code>/reset hugo tele deal</code> — deal TELE seulement
<code>/reset hugo wepoker</code> — deal Wepoker · idem pour xpoker, clubgg

<b>— Vérifier un joueur —</b>
<code>/check hugo</code>

<b>— Transactions manuelles —</b>
<code>/depot hugo 2000$ wepoker</code>
<code>/depot hugo 2k wepoker</code>
<code>/retrait hugo 500$ wepoker</code>
<code>/transfer hugo 1k tele wepoker</code>

<b>— Deal seul —</b>
<code>/deal hugo wepoker 55% action 5% RB</code>

<b>— P&L & Solde —</b>
<code>/pnl</code> — tous · <code>/pnl hugo</code> — un joueur
<code>/solde hugo</code> — solde net par game
<code>/solde hugo wepoker</code> — solde sur une game

<b>— Historique —</b>
<code>/historique hugo</code> — 5 dernières transactions
<code>/historique hugo wepoker 10</code> — 10 dernières sur une game

<b>— Onboarding en attente —</b>
<code>/todo</code> — liste les joueurs incomplets
<code>/kickstart</code> — collecte les wallets TELE manquants (joueur par joueur)

Games : <b>TELE · Wepoker · Xpoker · ClubGG</b>`);
}

// ── Command: /solde ───────────────────────────────────────
async function handleSolde(rawText: string, chatId: number) {
  const p = parseArgs(rawText);
  if (!p.playerQuery) {
    await sendMsg(chatId, `❌ Usage : <code>/solde hugo</code> ou <code>/solde hugo wepoker</code>`);
    return;
  }
  const players = findPlayer(p.playerQuery);
  if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${p.playerQuery}" introuvable`); return; }
  if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }

  const db = getDb();
  const baseQuery = `
    SELECT g.name AS game_name,
      COALESCE(SUM(CASE WHEN wt.type='deposit' THEN wt.amount ELSE 0 END), 0) AS deposited,
      COALESCE(SUM(CASE WHEN wt.type='withdrawal' THEN wt.amount ELSE 0 END), 0) AS withdrawn,
      COALESCE(SUM(CASE WHEN wt.type='deposit' THEN wt.amount ELSE -wt.amount END), 0) AS balance
    FROM wallet_transactions wt
    JOIN games g ON g.id = wt.game_id
    WHERE wt.player_id = ?`;

  let rows: any[];
  if (p.gameName) {
    const game = findGame(p.gameName);
    if (!game) { await sendMsg(chatId, `❌ Game "${p.gameName}" inconnue`); return; }
    rows = db.prepare(baseQuery + ` AND g.id = ? GROUP BY wt.game_id`).all(players[0].id, game.id) as any[];
  } else {
    rows = db.prepare(baseQuery + ` GROUP BY wt.game_id ORDER BY g.name`).all(players[0].id) as any[];
  }

  if (rows.length === 0) {
    await sendMsg(chatId, `ℹ️ ${players[0].name} — aucune transaction enregistrée`);
    return;
  }

  let total = 0;
  const lines = rows.map((r: any) => {
    total += r.balance;
    const emoji = r.balance > 0 ? "🟢" : r.balance < 0 ? "🔴" : "⚪";
    return `${emoji} <b>${r.game_name}</b> : <b>${s(r.balance)} USDT</b>  (📥 ${r.deposited.toFixed(2)} / 📤 ${r.withdrawn.toFixed(2)})`;
  });
  const totalLine = rows.length > 1 ? `\n\n<b>Total : ${s(total)} USDT</b>` : "";
  await sendMsg(chatId, `💰 <b>Solde — ${players[0].name}</b>\n\n${lines.join("\n")}${totalLine}`);
}

// ── Command: /todo ────────────────────────────────────────
async function handleTodo(chatId: number) {
  const players = getDb().prepare(`
    SELECT p.id, p.name, p.tron_address, p.tele_wallet_cashout,
      (SELECT COUNT(*) FROM player_game_deals pgd
       JOIN games g ON g.id = pgd.game_id
       WHERE pgd.player_id = p.id AND LOWER(g.name) = 'tele') AS has_deal
    FROM players p WHERE p.status = 'active' ORDER BY p.name
  `).all() as any[];

  const incomplete = players.filter(p => {
    const hasGame = !!(p.tron_address && TRC20_RE.test(p.tron_address));
    const hasCashout = !!(p.tele_wallet_cashout && TRC20_RE.test(p.tele_wallet_cashout));
    return !p.has_deal || !hasGame || !hasCashout;
  });

  if (incomplete.length === 0) {
    await sendMsg(chatId, `✅ <b>Tous les joueurs actifs sont configurés !</b>`);
    return;
  }

  const lines = incomplete.map(p => {
    const hasGame = !!(p.tron_address && TRC20_RE.test(p.tron_address));
    const hasCashout = !!(p.tele_wallet_cashout && TRC20_RE.test(p.tele_wallet_cashout));
    const step = !p.has_deal ? "1/3 deal" : !hasGame ? "2/3 wallet game" : "3/3 wallet cashout";
    return `• <b>${p.name}</b> — étape ${step}`;
  });
  await sendMsg(chatId,
    `📋 <b>${incomplete.length} joueur(s) à compléter</b>\n\n${lines.join("\n")}\n\n<i>Utilise <code>/check nom</code> pour le détail.</i>`
  );
}

// ── Command: /historique ──────────────────────────────────
async function handleHistorique(rawText: string, chatId: number) {
  const p = parseArgs(rawText);
  const limit = p.amount !== null ? Math.min(Math.max(1, Math.round(p.amount)), 20) : 5;

  if (!p.playerQuery) {
    await sendMsg(chatId, `❌ Usage : <code>/historique hugo</code> ou <code>/historique hugo wepoker 10</code>`);
    return;
  }
  const players = findPlayer(p.playerQuery);
  if (players.length === 0) { await sendMsg(chatId, `❌ Joueur "${p.playerQuery}" introuvable`); return; }
  if (players.length > 1) { await sendMsg(chatId, `❌ Plusieurs joueurs :\n${players.map(x => `• ${x.name}`).join("\n")}`); return; }

  const db = getDb();
  let rows: any[];
  if (p.gameName) {
    const game = findGame(p.gameName);
    if (!game) { await sendMsg(chatId, `❌ Game "${p.gameName}" inconnue`); return; }
    rows = db.prepare(`
      SELECT wt.type, wt.amount, g.name AS game_name, wt.tx_date
      FROM wallet_transactions wt JOIN games g ON g.id = wt.game_id
      WHERE wt.player_id = ? AND wt.game_id = ?
      ORDER BY wt.tx_date DESC, wt.id DESC LIMIT ?
    `).all(players[0].id, game.id, limit) as any[];
  } else {
    rows = db.prepare(`
      SELECT wt.type, wt.amount, g.name AS game_name, wt.tx_date
      FROM wallet_transactions wt JOIN games g ON g.id = wt.game_id
      WHERE wt.player_id = ?
      ORDER BY wt.tx_date DESC, wt.id DESC LIMIT ?
    `).all(players[0].id, limit) as any[];
  }

  if (rows.length === 0) {
    await sendMsg(chatId, `ℹ️ ${players[0].name} — aucune transaction enregistrée`);
    return;
  }

  const lines = rows.map((r: any) => {
    const emoji = r.type === "deposit" ? "📥" : "📤";
    const sign = r.type === "deposit" ? "+" : "−";
    return `${emoji} ${r.tx_date} · <b>${sign}${r.amount.toFixed(2)} USDT</b> · ${r.game_name}`;
  });
  const gameLabel = p.gameName ? ` / ${p.gameName}` : "";
  await sendMsg(chatId, `📜 <b>${players[0].name}${gameLabel}</b> — ${rows.length} transaction(s)\n\n${lines.join("\n")}`);
}

// ── Kickstart helpers ─────────────────────────────────────
function getIncompleteTelePlayers() {
  const rows = getDb().prepare(`
    SELECT p.id, p.name, p.telegram_id, p.telegram_handle, p.tron_address, p.tele_wallet_cashout
    FROM players p
    JOIN player_game_deals pgd ON pgd.player_id = p.id
    JOIN games g ON g.id = pgd.game_id
    WHERE p.status = 'active' AND LOWER(g.name) = 'tele'
    ORDER BY p.name
  `).all() as { id: number; name: string; telegram_id: number | null; telegram_handle: string | null; tron_address: string | null; tele_wallet_cashout: string | null }[];

  return rows.filter(p => {
    const hasGame = !!(p.tron_address && TRC20_RE.test(p.tron_address));
    const hasCashout = !!(p.tele_wallet_cashout && TRC20_RE.test(p.tele_wallet_cashout));
    return !hasGame || !hasCashout;
  });
}

async function startNextWalletFlow(chatId: number, skipPlayerId?: number) {
  const incomplete = getIncompleteTelePlayers().filter(p => p.id !== skipPlayerId);
  if (incomplete.length === 0) return false;
  const next = incomplete[0];
  const hasGame = !!(next.tron_address && TRC20_RE.test(next.tron_address));
  if (!hasGame) {
    setSession(chatId, "waiting_wallet_game", next.id, next.telegram_id);
    await askWalletGame(chatId, mentionOf(next));
  } else {
    setSession(chatId, "waiting_wallet_cashout", next.id, next.telegram_id);
    await sendMsg(chatId,
      `💸 <b>Étape 3/3</b> — ${mentionOf(next)}, envoie ton <b>WALLET CASHOUT</b>\n<i>(adresse Binance TRC20 pour recevoir les cashouts)</i>`
    );
  }
  return true;
}

// ── Command: /kickstart ───────────────────────────────────
async function handleKickstart(chatId: number) {
  const incomplete = getIncompleteTelePlayers();

  if (incomplete.length === 0) {
    await sendMsg(chatId, `✅ <b>Tous les joueurs TELE ont leurs wallets configurés !</b>`);
    return;
  }

  const lines = incomplete.map(p => {
    const hasGame = !!(p.tron_address && TRC20_RE.test(p.tron_address));
    const step = !hasGame ? "wallet game" : "wallet cashout";
    return `• ${mentionOf(p)} — manque ${step}`;
  });

  await sendMsg(chatId,
    `🚀 <b>Kickstart TELE — ${incomplete.length} joueur(s) à compléter</b>\n\n${lines.join("\n")}\n\n<i>Collecte démarrée joueur par joueur…</i>`
  );
  await startNextWalletFlow(chatId);
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

    if (isNew) {
      setSession(chatId, "waiting_action_pct", playerId);
      await sendMsg(chatId,
        `✅ <b>${name}</b> ajouté au CRM automatiquement.\n\n` +
        `📋 <b>Étape 1/3</b> — Quel est son <b>% action sur TELE</b> ?\n` +
        `<i>(envoie juste le chiffre, ex : <b>40</b> — ou <b>40 5</b> pour 40% action + 5% RB)</i>`
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

  // Debug log every incoming message sender (helps verify owner ID)
  if (msg?.from?.id) {
    console.log(`[TG] msg from user_id=${msg.from.id} username=@${msg.from.username ?? "none"} text="${msg.text?.slice(0, 30) ?? ""}"`);
  }

  // Agent chat: in the dedicated agent group, route mentions to Claude
  if (msg?.text && String(chatId) === AGENT_CHAT_ID && isMention(msg.text)) {
    try {
      const reply = await runChat({ chatId, userText: msg.text });
      await sendMsg(chatId, reply);
    } catch (e: any) {
      console.error("[TG AGENT CHAT]", e);
      await sendMsg(chatId, `❌ Erreur agent : ${e.message ?? String(e)}`);
    }
    return NextResponse.json({ ok: true });
  }

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
      else if (cmd === "/transfer")     await handleTransfer(rawArgs, chatId);
      else if (cmd === "/wallet")       await handleWallet(rawArgs, chatId);
      else if (cmd === "/reset")        await handleReset(rawArgs, chatId);
      else if (cmd === "/check")        await handleCheck(rawArgs, chatId);
      else if (cmd === "/pnl")          await handlePnl(rawArgs, chatId);
      else if (cmd === "/solde")        await handleSolde(rawArgs, chatId);
      else if (cmd === "/todo")         await handleTodo(chatId);
      else if (cmd === "/kickstart")    await handleKickstart(chatId);
      else if (cmd === "/historique")   await handleHistorique(rawArgs, chatId);
      else if (cmd === "/aide" || cmd === "/help") await handleAide(chatId);
    } catch (e: any) {
      console.error("[TG CMD]", e);
      await sendMsg(chatId, `❌ Erreur : ${e.message}`);
    }
    return NextResponse.json({ ok: true });
  }

  // Raw message → guided onboarding flow (action %, addresses)
  if (msg?.text && !msg.text.startsWith("/")) {
    const text = msg.text.trim();
    const senderId: number = msg.from?.id;
    const session = getSession(chatId);
    if (session) {
      // Accept if sender is owner OR sender is the expected player
      const isOwner = OWNER_IDS.has(senderId);
      const isExpectedPlayer = session.expected_tg_id != null && senderId === session.expected_tg_id;
      if (isOwner || isExpectedPlayer) {
        try { await handleRawMessage(text, chatId); } catch (e: any) {
          console.error("[TG FLOW]", e);
        }
        return NextResponse.json({ ok: true });
      }
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
