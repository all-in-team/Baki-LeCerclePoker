import { getDb } from "@/lib/db";

// ── Constants ────────────────────────────────────────────
export const OWNER_IDS = new Set<number>(
  (process.env.TELEGRAM_OWNER_IDS ?? "1298290355,1486389037")
    .split(",").map(id => parseInt(id.trim(), 10)).filter(n => !isNaN(n))
);
export const GAME_NAMES = ["tele", "wepoker", "xpoker", "clubgg"];
export const TRC20_RE = /^T[a-zA-Z0-9]{33}$/;
export const AGENT_CHAT_ID = process.env.AGENT_TELEGRAM_CHAT_ID ?? "-4846690641";
export const WALLET_GAME_PHOTO_URL = "https://lecerclepoker-production.up.railway.app/tele-wallet-guide.jpg";
const BASE_URL = "https://lecerclepoker-production.up.railway.app";

// ── Telegram API ──────────────────────────────────────────
//
// Les trois helpers d'envoi retournent `{ ok, messageId }` depuis l'ajout du live
// takeover : `bot_messages.telegram_message_id` a besoin de l'id rendu par Telegram.
// Rétro-compatible — les dizaines d'appels existants ignorent simplement la valeur.
export type SendResult = { ok: boolean; messageId?: number };

async function postSend(label: string, chatId: number | string, body: Record<string, any>): Promise<SendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`[TG ${label}]`, chatId, res.status, await res.text());
    return { ok: false };
  }
  try {
    const json = await res.json();
    return { ok: true, messageId: json?.result?.message_id };
  } catch {
    return { ok: true };
  }
}

export async function sendMsg(chatId: number | string, text: string, messageThreadId?: number): Promise<SendResult> {
  const body: Record<string, any> = { chat_id: chatId, text, parse_mode: "HTML" };
  if (messageThreadId) body.message_thread_id = messageThreadId;
  return postSend("sendMsg", chatId, body);
}

export async function sendMsgKeyboard(chatId: number | string, text: string, keyboard: any[][], messageThreadId?: number): Promise<SendResult> {
  const body: Record<string, any> = {
    chat_id: chatId, text, parse_mode: "HTML",
    reply_markup: JSON.stringify({ inline_keyboard: keyboard }),
  };
  if (messageThreadId) body.message_thread_id = messageThreadId;
  return postSend("sendMsgKeyboard", chatId, body);
}

// ForceReply : ouvre directement le champ de réponse du user (clavier + focus).
// `selective` cible le user visé dans un groupe ; en DM c'est sans effet.
export async function sendForceReply(chatId: number | string, text: string, messageThreadId?: number): Promise<SendResult> {
  const body: Record<string, any> = {
    chat_id: chatId, text, parse_mode: "HTML",
    reply_markup: JSON.stringify({ force_reply: true, selective: true }),
  };
  if (messageThreadId) body.message_thread_id = messageThreadId;
  return postSend("sendForceReply", chatId, body);
}

export async function sendPhoto(chatId: number | string, photoPath: string, caption: string, messageThreadId?: number) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const photoUrl = `${BASE_URL}/onboarding/${photoPath}`;
  const body: Record<string, any> = { chat_id: chatId, photo: photoUrl, caption, parse_mode: "HTML" };
  if (messageThreadId) body.message_thread_id = messageThreadId;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("[TG sendPhoto]", chatId, res.status, await res.text());
    await sendMsg(chatId, caption, messageThreadId);
  }
}

export async function answerCbQuery(id: string, text?: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, ...(text ? { text } : {}) }),
  });
}

export async function editMessageReplyMarkup(chatId: number | string, messageId: number) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: JSON.stringify({ inline_keyboard: [] }) }),
  });
}

export function chatLink(chatId: number | string): string {
  const s = String(chatId);
  if (s.startsWith("-100")) return `https://t.me/c/${s.slice(4)}/1`;
  return `(chat ${s})`;
}

export async function askWalletGame(chatId: number | string, mention: string, messageThreadId?: number) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const caption =
    `📲 <b>Étape 2/3</b> — ${mention}, envoie ton <b>WALLET GAME</b>\n` +
    `<i>C'est la "Deposit Address" TRON dans l'app TELE (voir capture ci-dessus)</i>`;

  const body: Record<string, any> = { chat_id: chatId, photo: WALLET_GAME_PHOTO_URL, caption, parse_mode: "HTML" };
  if (messageThreadId) body.message_thread_id = messageThreadId;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    await sendMsg(chatId, caption, messageThreadId);
  }
}

// ── Session helpers ───────────────────────────────────────
export type Step = "pitch_sent" | "solo_declined" | "contract_shown" | "signed_active" | "contract_questions" | "awaiting_wallet_address" | "onboarding_complete" | "awaiting_deposit_wallet" | "awaiting_cashout_wallet" | "wallets_complete" | "waiting_action_pct" | "waiting_game_action_pct" | "waiting_wallet_game" | "waiting_wallet_cashout" | "waiting_game" | "waiting_player" | "awaiting_human_response" | "kkpoker_pitch_sent" | "kkpoker_contract_shown" | "awaiting_kkpoker_cashout_wallet" | "awaiting_kkpoker_game_wallet" | "a5poker_pitch_sent" | "a5poker_contract_shown" | "a5poker_wallet_check" | "awaiting_a5poker_cashout_wallet" | "awaiting_a5poker_game_wallet" | "aks_awaiting_pct" | "waiting_aks_pct" | "aks_pitch_sent" | "aks_contract_shown" | "aks_wallet_check" | "awaiting_aks_cashout_wallet" | "awaiting_aks_game_wallet" | "nutspk_pitch_sent" | "nutspk_wallet_check" | "awaiting_nutspk_cashout_wallet" | "awaiting_nutspk_game_wallet" | "qqpk_pitch_sent" | "qqpk_wallet_check" | "awaiting_qqpk_cashout_wallet" | "awaiting_qqpk_game_wallet" | "affiliation_awaiting_handle" | "aapkmy_pitch_sent" | "aapkmy_waiting_id" | "aapkmy_waiting_proof" | "okpoker_pitch_sent" | "okpoker_wallet_check" | "awaiting_okpoker_cashout_wallet" | "awaiting_okpoker_game_wallet" | "jvip_pitch_sent" | "jvip_wallet_check" | "awaiting_jvip_cashout_wallet" | "awaiting_jvip_game_wallet";

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

const TRACKABLE_STEPS = new Set(["pitch_sent", "contract_shown", "awaiting_deposit_wallet", "awaiting_cashout_wallet", "awaiting_human_response", "onboarding_complete"]);

export function trackOnboardingStep(telegramId: number, step: string) {
  if (!TRACKABLE_STEPS.has(step)) return;
  const db = getDb();
  if (step === "onboarding_complete") {
    db.prepare(`UPDATE onboarding_leads SET stage = 'joined', step_entered_at = datetime('now'), reminders_sent = 0, ops_alerted = 0 WHERE telegram_id = ?`).run(telegramId);
    return;
  }
  // `last_reminder_at` / `ops_alerted_at` ne sont PLUS remis à NULL (Hugo 2026-07-31) : ce sont
  // des horodatages de fait — « une relance est partie à telle date » reste vrai même après que le
  // joueur ait avancé. Les écraser détruisait la seule trace de l'envoi, précisément dans le cas
  // qui compte : un joueur actif relancé à tort, qui interagit ensuite. Les compteurs
  // `reminders_sent` / `ops_alerted`, eux, restent remis à zéro : ils pilotent le cycle de relance
  // du nouveau palier, ils ne documentent pas le passé. Le journal d'audit complet vit dans
  // `onboarding_reminder_log` (append-only).
  db.prepare(`UPDATE onboarding_leads SET step_entered_at = datetime('now'), reminders_sent = 0, ops_alerted = 0 WHERE telegram_id = ?`).run(telegramId);
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

export async function handleRawMessage(text: string, chatId: number, messageThreadId?: number) {
  const session = getSession(chatId);
  if (!session) return;
  const reply = (msg: string) => sendMsg(chatId, msg, messageThreadId);

  // ── waiting_game: owner chose a game after missing it in a command ──
  if (session.step === "waiting_game") {
    const canonical: Record<string, string> = { tele: "TELE", wepoker: "Wepoker", xpoker: "Xpoker", clubgg: "ClubGG" };
    const gameName = canonical[text.trim().toLowerCase()] ?? null;
    if (!gameName) {
      await reply(`❌ Game inconnue. Réponds avec : <b>TELE</b>, <b>Wepoker</b>, <b>Xpoker</b> ou <b>ClubGG</b>`);
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
      await reply(`❌ Joueur "${query}" introuvable — essaie un autre nom ou @tag`);
      return;
    }
    if (players.length > 1) {
      const lines = players.map(p => `• <b>${p.name}</b>${p.telegram_handle ? ` (@${p.telegram_handle})` : ""}`).join("\n");
      await reply(`❌ Plusieurs joueurs trouvés :\n${lines}\n\nSois plus précis.`);
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

  // KKPOKER wallet collection states — delegate to KKPOKER module
  if (session.step === "awaiting_kkpoker_cashout_wallet" || session.step === "awaiting_kkpoker_game_wallet") {
    const { handleKkpokerRawMessage } = await import("@/lib/games/kkpoker/onboarding");
    const handled = await handleKkpokerRawMessage(text, chatId, session, messageThreadId);
    if (handled) return;
  }

  // A5POKER wallet collection states — delegate to A5POKER module
  if (session.step === "awaiting_a5poker_cashout_wallet" || session.step === "awaiting_a5poker_game_wallet") {
    const { handleA5pokerRawMessage } = await import("@/lib/games/a5poker/onboarding");
    const handled = await handleA5pokerRawMessage(text, chatId, session, messageThreadId);
    if (handled) return;
  }

  // Shared free-text action % entry (A5 / KK / AKS / AAPK) — validates the typed %,
  // stores it in player_game_deals, then fires the game-specific pitch.
  if (session.step === "waiting_game_action_pct") {
    const { handleActionPctRawMessage } = await import("./action-pct-prompt");
    const handled = await handleActionPctRawMessage(text, chatId, session, messageThreadId);
    if (handled) return;
  }

  // AKS wallet collection states — delegate to AKS module
  if (session.step === "awaiting_aks_cashout_wallet" || session.step === "awaiting_aks_game_wallet") {
    const { handleAksRawMessage } = await import("@/lib/games/aks/onboarding");
    const handled = await handleAksRawMessage(text, chatId, session, messageThreadId);
    if (handled) return;
  }

  // NUTSPK wallet collection states — delegate to NUTSPK module
  if (session.step === "awaiting_nutspk_cashout_wallet" || session.step === "awaiting_nutspk_game_wallet") {
    const { handleNutspkRawMessage } = await import("@/lib/games/nutspk/onboarding");
    const handled = await handleNutspkRawMessage(text, chatId, session, messageThreadId);
    if (handled) return;
  }

  // OKPOKER wallet collection states — delegate to OKPOKER module
  if (session.step === ("awaiting_okpoker_cashout_wallet" as Step) || session.step === ("awaiting_okpoker_game_wallet" as Step)) {
    const { handleOkpokerRawMessage } = await import("@/lib/games/okpoker/onboarding");
    const handled = await handleOkpokerRawMessage(text, chatId, session, messageThreadId);
    if (handled) return;
  }

  // JVIP wallet collection states — delegate to JVIP module
  if (session.step === ("awaiting_jvip_cashout_wallet" as Step) || session.step === ("awaiting_jvip_game_wallet" as Step)) {
    const { handleJvipRawMessage } = await import("@/lib/games/jvip/onboarding");
    const handled = await handleJvipRawMessage(text, chatId, session, messageThreadId);
    if (handled) return;
  }

  // TTPOKER wallet collection states — delegate to TTPOKER module
  if (session.step === ("awaiting_wn_cashout_wallet" as Step) || session.step === ("awaiting_wn_game_wallet" as Step)) {
    const { handleWnRawMessage } = await import("@/lib/games/wn/onboarding");
    const handledWn = await handleWnRawMessage(text, chatId, session, messageThreadId);
    if (handledWn) return;
  }

  if (session.step === ("awaiting_ttpoker_cashout_wallet" as Step) || session.step === ("awaiting_ttpoker_game_wallet" as Step)) {
    const { handleTtpokerRawMessage } = await import("@/lib/games/ttpoker/onboarding");
    const handled = await handleTtpokerRawMessage(text, chatId, session, messageThreadId);
    if (handled) return;
  }

  // QQPK wallet collection states — delegate to QQPK module
  if (session.step === ("awaiting_qqpk_cashout_wallet" as Step) || session.step === ("awaiting_qqpk_game_wallet" as Step)) {
    const { handleQqpkRawMessage } = await import("@/lib/games/qqpk/onboarding");
    const handled = await handleQqpkRawMessage(text, chatId, session, messageThreadId);
    if (handled) return;
  }

  // AAPKMY onboarding — collect player ID
  if (session.step === ("aapkmy_waiting_id" as Step)) {
    const { handleAapkmyRawMessage } = await import("@/lib/games/aapkmy/onboarding");
    const handled = await handleAapkmyRawMessage(text, chatId, session, messageThreadId);
    if (handled) return;
  }

  // Affiliation flow — handle text input
  if (session.step === "affiliation_awaiting_handle") {
    const { handleAffiliationRawMessage } = await import("./affiliation");
    const handled = await handleAffiliationRawMessage(text, chatId, session, messageThreadId);
    if (handled) return;
  }

  const player = getPlayerFull(session.player_id);
  if (!player) { clearSession(chatId); return; }

  const db = getDb();
  const teleGame = findGame("TELE");

  // ── Question forwarding (first message only after "J'ai une question") ──
  if (session.step === "awaiting_human_response" && session.pending_cmd === "question_pending") {
    const username = db.prepare(`SELECT telegram_handle FROM players WHERE id = ?`).get(session.player_id) as { telegram_handle: string | null } | undefined;
    const handle = username?.telegram_handle ? `@${username.telegram_handle}` : "n/a";
    const groupLink = chatLink(chatId);
    setSession(chatId, "awaiting_human_response", session.player_id, session.expected_tg_id, "question_forwarded");
    await sendMsg(AGENT_CHAT_ID,
      `💬 <b>Question d'un nouveau joueur</b> (${player.name}, ${handle}) :\n` +
      `${text}\n\n` +
      `Réponds-lui dans son groupe → ${groupLink}`
    );
    return;
  }
  if (session.step === "awaiting_human_response") return;

  // ── Deposit wallet collection (pitch flow — step 1 of 2) ──
  if (session.step === "awaiting_deposit_wallet") {
    if (!TRC20_RE.test(text)) {
      await reply(`Cette adresse ne semble pas être au bon format. Une adresse TRON commence par <b>T</b> et fait 34 caractères. Réessaie.`);
      return;
    }
    db.prepare(`UPDATE players SET tron_address = ? WHERE id = ?`).run(text, player.id);
    setSession(chatId, "awaiting_cashout_wallet", player.id, session.expected_tg_id);
    if (session.expected_tg_id) trackOnboardingStep(session.expected_tg_id, "awaiting_cashout_wallet");
    await reply(`✅ Adresse de dépôt enregistrée.`);
    await new Promise(r => setTimeout(r, 1500));
    const cashoutPrompt =
      `Maintenant ton adresse de <b>CASHOUT</b> — c'est ta wallet perso (TronLink ou autre) où tu recevras tes gains.\n\n` +
      `Envoie-moi ton <b>adresse de CASHOUT</b> ici 👇\n` +
      `(format : commence par T, 34 caractères)\n\n` +
      `Si c'est la même adresse que ta wallet de dépôt, écris "<b>même</b>".`;
    try {
      await sendMsgKeyboard(chatId, cashoutPrompt, [[{ text: "❓ J'ai une question", callback_data: "onboard_choice_question" }]], messageThreadId);
    } catch { await reply(cashoutPrompt); }
    return;
  }

  // ── Cashout wallet collection (pitch flow — step 2 of 2) ──
  if (session.step === "awaiting_cashout_wallet") {
    const sameAliases = ["même", "meme", "same", "pareil", "idem"];
    let cashoutAddress: string;
    if (sameAliases.includes(text.toLowerCase())) {
      const freshPlayer = getPlayerFull(player.id);
      cashoutAddress = freshPlayer?.tron_address ?? "";
      if (!cashoutAddress) {
        await reply(`❌ Pas d'adresse de dépôt enregistrée. Envoie ton adresse TRON de cashout.`);
        return;
      }
    } else {
      if (!TRC20_RE.test(text)) {
        await reply(`Cette adresse ne semble pas être au bon format. Une adresse TRON commence par <b>T</b> et fait 34 caractères. Réessaie.\n\nOu écris "<b>même</b>" si c'est la même que ton adresse de dépôt.`);
        return;
      }
      cashoutAddress = text;
    }
    db.prepare(`UPDATE players SET tele_wallet_cashout = ? WHERE id = ?`).run(cashoutAddress, player.id);
    setSession(chatId, "onboarding_complete", player.id, session.expected_tg_id);
    if (session.expected_tg_id) trackOnboardingStep(session.expected_tg_id, "onboarding_complete");
    await reply(
      `✅ Tes 2 adresses sont enregistrées.\n\n` +
      `Tu es prêt à jouer 🎰\n` +
      `Ton support reste disponible ici 24/7 pour toute question.`
    );
    const freshPlayer = getPlayerFull(player.id);
    const depositAddr = freshPlayer?.tron_address ?? "(non définie)";
    await sendMsg(AGENT_CHAT_ID,
      `🎉 <b>Onboarding complet — ${player.name}</b>\n` +
      `Deal : 60/20/20\n` +
      `Wallet dépôt : <code>${depositAddr}</code>\n` +
      `Wallet cashout : <code>${cashoutAddress}</code>\n` +
      `Groupe : <code>${chatId}</code>`
    );
    return;
  }

  if (session.step === "waiting_action_pct") {
    // Accept "40", "40%", "40% action", "40 rb 5", etc.
    const pctMatch = text.match(/(\d+(?:\.\d+)?)/);
    if (!pctMatch) {
      await reply(`❌ Envoie juste le pourcentage, ex : <b>40</b>`);
      return;
    }
    const action_pct = parseFloat(pctMatch[1]);
    // Check for RB too (optional): "40 5" or "40% 5%"
    const nums = [...text.matchAll(/(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]));
    const rakeback_pct = nums.length >= 2 ? nums[1] : 0;

    if (!teleGame) { await reply(`❌ Game TELE introuvable`); return; }
    const { upsertPlayerGameDeal } = await import("@/lib/queries");
    upsertPlayerGameDeal({ player_id: player.id, game_id: teleGame.id, action_pct, rakeback_pct });

    const fullForDeal = getPlayerFull(player.id)!;
    setSession(chatId, "waiting_wallet_game", player.id, fullForDeal.telegram_id);
    await reply(
      `✅ <b>Deal enregistré</b> — <b>${player.name}</b> sur TELE\n` +
      `Action : <b>${action_pct}%</b>` + (rakeback_pct > 0 ? ` · RB : <b>${rakeback_pct}%</b>` : "")
    );
    await askWalletGame(chatId, mentionOf(fullForDeal), messageThreadId);

  } else if (session.step === "waiting_wallet_game") {
    if (!TRC20_RE.test(text)) {
      await reply(`❌ Adresse invalide — doit commencer par <b>T</b> et faire 34 caractères\nEnvoie le WALLET GAME de ${player.name}`);
      return;
    }
    db.prepare(`UPDATE players SET tron_address = ? WHERE id = ?`).run(text, player.id);
    const fullForGame = getPlayerFull(player.id)!;
    setSession(chatId, "waiting_wallet_cashout", player.id, fullForGame.telegram_id);
    await reply(
      `✅ <b>WALLET GAME enregistré</b> pour <b>${player.name}</b>\n<code>${text}</code>\n\n` +
      `💸 <b>Étape 3/3</b> — ${mentionOf(fullForGame)}, envoie ton <b>WALLET CASHOUT</b>\n` +
      `<i>(ton adresse Binance TRC20 pour recevoir les cashouts)</i>`
    );

  } else if (session.step === "waiting_wallet_cashout") {
    if (!TRC20_RE.test(text)) {
      await reply(`❌ Adresse invalide — doit commencer par <b>T</b> et faire 34 caractères\nEnvoie le WALLET CASHOUT de ${player.name}`);
      return;
    }
    db.prepare(`UPDATE players SET tele_wallet_cashout = ? WHERE id = ?`).run(text, player.id);
    clearSession(chatId);
    const deal = getTeleDeal(player.id);
    await reply(
      `✅ <b>WALLET CASHOUT enregistré</b> pour <b>${player.name}</b>\n<code>${text}</code>\n\n` +
      `🟢 <b>${player.name} est 100% configuré !</b>\n` +
      `Deal : <b>${deal?.action_pct ?? "?"}% action</b>` + (deal?.rakeback_pct ? ` · RB : <b>${deal.rakeback_pct}%</b>` : "") + `\n` +
      `WALLET GAME ✅ · WALLET CASHOUT ✅`
    );
    // Auto-advance to next incomplete TELE player if any
    const hasNext = await startNextWalletFlow(chatId, player.id);
    if (!hasNext) {
      await reply(`🎉 <b>Tous les joueurs TELE sont configurés !</b> Lance un <b>Sync TELE</b> sur le dashboard.`);
    }
  }
}
