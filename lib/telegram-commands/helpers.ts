import { getDb } from "@/lib/db";

// ── Constants ────────────────────────────────────────────
export const OWNER_IDS = new Set<number>(
  (process.env.TELEGRAM_OWNER_IDS ?? "1298290355")
    .split(",").map(id => parseInt(id.trim(), 10)).filter(n => !isNaN(n))
);
export const GAME_NAMES = ["tele", "wepoker", "xpoker", "clubgg"];
export const TRC20_RE = /^T[a-zA-Z0-9]{33}$/;
export const AGENT_CHAT_ID = process.env.AGENT_TELEGRAM_CHAT_ID ?? "-4846690641";
export const WALLET_GAME_PHOTO_URL = "https://lecerclepoker-production.up.railway.app/tele-wallet-guide.jpg";

// ── Telegram API ──────────────────────────────────────────
export async function sendMsg(chatId: number | string, text: string, messageThreadId?: number) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const body: Record<string, any> = { chat_id: chatId, text, parse_mode: "HTML" };
  if (messageThreadId) body.message_thread_id = messageThreadId;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error("[TG sendMsg]", chatId, res.status, await res.text());
}

export async function askWalletGame(chatId: number | string, mention: string) {
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
export type Step = "waiting_action_pct" | "waiting_wallet_game" | "waiting_wallet_cashout" | "waiting_game" | "waiting_player";

export function getSession(chatId: string | number): { step: Step; player_id: number; expected_tg_id: number | null; pending_cmd: string | null } | null {
  return getDb().prepare(
    `SELECT step, player_id, expected_tg_id, pending_cmd FROM telegram_sessions WHERE chat_id = ? AND created_at > datetime('now', '-24 hours')`
  ).get(String(chatId)) as any ?? null;
}
export function setSession(chatId: string | number, step: Step, player_id: number | null, expected_tg_id?: number | null, pending_cmd?: string | null) {
  getDb().prepare(
    `INSERT OR REPLACE INTO telegram_sessions (chat_id, step, player_id, expected_tg_id, pending_cmd, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(String(chatId), step, player_id ?? null, expected_tg_id ?? null, pending_cmd ?? null);
}

export function clearSession(chatId: string | number) {
  getDb().prepare(`DELETE FROM telegram_sessions WHERE chat_id = ?`).run(String(chatId));
}

export async function promptGame(chatId: number, cmd: string, args: string) {
  setSession(chatId, "waiting_game", null, null, `${cmd}:${args}`);
  await sendMsg(chatId, `🎮 Quelle game ?\n\n<b>TELE · Wepoker · Xpoker · ClubGG</b>`);
}
export async function promptPlayer(chatId: number, cmd: string, args: string) {
  setSession(chatId, "waiting_player", null, null, `${cmd}:${args}`);
  await sendMsg(chatId, `👤 Pour quel joueur ? (envoie le nom ou @tag)`);
}

export function mentionOf(player: { name: string; telegram_handle?: string | null; telegram_id?: number | null }) {
  if (player.telegram_id) return `<a href="tg://user?id=${player.telegram_id}">${player.name}</a>`;
  if (player.telegram_handle) return `@${player.telegram_handle}`;
  return `<b>${player.name}</b>`;
}

// ── Flexible parser ───────────────────────────────────────
export interface Parsed {
  playerQuery: string;
  gameName: string | null;
  amount: number | null;
  action_pct: number | null;
  rakeback_pct: number | null;
}

export function parseArgs(rawText: string): Parsed {
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
export function findPlayer(query: string) {
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
export function findGame(name: string) {
  return getDb().prepare(
    `SELECT id, name FROM games WHERE LOWER(name) = LOWER(?)`
  ).get(name) as { id: number; name: string } | undefined;
}
export function getPlayerFull(playerId: number) {
  return getDb().prepare(`SELECT id, name, telegram_handle, telegram_id, tron_address, tele_wallet_cashout FROM players WHERE id = ?`).get(playerId) as
    { id: number; name: string; telegram_handle: string | null; telegram_id: number | null; tron_address: string | null; tele_wallet_cashout: string | null } | undefined;
}
export function getTeleDeal(playerId: number) {
  return getDb().prepare(`
    SELECT pgd.action_pct, pgd.rakeback_pct FROM player_game_deals pgd
    JOIN games g ON g.id = pgd.game_id WHERE pgd.player_id = ? AND LOWER(g.name) = 'tele'
  `).get(playerId) as { action_pct: number; rakeback_pct: number } | undefined;
}
export function getPlayerPnl(playerId?: number) {
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
export function s(n: number) {
  return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(2);
}

// ── Onboarding status summary ─────────────────────────────
export function onboardingStatus(player: { id: number; name: string; tron_address: string | null; tele_wallet_cashout: string | null }) {
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

// ── Transfer parser ───────────────────────────────────────
export function parseTransferArgs(rawText: string): { playerQuery: string; amount: number | null; fromGame: string | null; toGame: string | null } {
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

// ── Kickstart helpers ─────────────────────────────────────
export function getIncompleteTelePlayers() {
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

export async function startNextWalletFlow(chatId: number, skipPlayerId?: number) {
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

// ── Guided flow: handle raw messages ─────────────────────
// Forward declarations needed for circular dependency with command handlers.
// We use a late-binding registry so command handlers can register themselves.
type CommandHandler = (rawArgs: string, chatId: number) => Promise<void>;
type TxHandler = (type: "deposit" | "withdrawal", rawArgs: string, chatId: number) => Promise<void>;

const commandRegistry: {
  handleDeal?: CommandHandler;
  handleTx?: TxHandler;
  handleReset?: CommandHandler;
} = {};

export function registerCommandHandlers(handlers: {
  handleDeal: CommandHandler;
  handleTx: TxHandler;
  handleReset: CommandHandler;
}) {
  commandRegistry.handleDeal = handlers.handleDeal;
  commandRegistry.handleTx = handlers.handleTx;
  commandRegistry.handleReset = handlers.handleReset;
}

export async function handleRawMessage(text: string, chatId: number) {
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
    if (cmdType === "deal")    { await commandRegistry.handleDeal?.(fullArgs, chatId); return; }
    if (cmdType === "depot")   { await commandRegistry.handleTx?.("deposit", fullArgs, chatId); return; }
    if (cmdType === "retrait") { await commandRegistry.handleTx?.("withdrawal", fullArgs, chatId); return; }
    if (cmdType === "reset")   { await commandRegistry.handleReset?.(fullArgs, chatId); return; }
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
    if (cmdType === "deal")    { await commandRegistry.handleDeal?.(fullArgs, chatId); return; }
    if (cmdType === "depot")   { await commandRegistry.handleTx?.("deposit", fullArgs, chatId); return; }
    if (cmdType === "retrait") { await commandRegistry.handleTx?.("withdrawal", fullArgs, chatId); return; }
    if (cmdType === "reset")   { await commandRegistry.handleReset?.(fullArgs, chatId); return; }
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
    const { upsertPlayerGameDeal } = await import("@/lib/queries");
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
