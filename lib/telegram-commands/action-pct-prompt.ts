import { getDb } from "@/lib/db";
import { sendMsg, setSession, type Step } from "./helpers";

// Shared free-text action-% entry for the action games. QQPK (staking 70/30 fixe)
// is deliberately NOT here. The owner types the exact % at onboarding; it is stored
// per-player+game in player_game_deals.action_pct and then drives the agency cut
// (my_pnl = net * action_pct/100) for the wallet games. AAPK is included for flow
// consistency even though it is identity-only (its % is cosmetic until AAPK joins
// AGENCY_GAMES).
const ACTION_GAMES: Record<string, { label: string }> = {
  A5POKER: { label: "A5POKER" },
  KKPOKER: { label: "KKPOKER" },
  AKS: { label: "AKS" },
  AAPKMY: { label: "AAPK" },
};

type StartPlayer = { name: string; telegram_id: number | null };

// Step 1 — prompt the owner for the action % (free text, NO preset buttons).
// gameKey is stashed in the session pending_cmd so the raw handler knows which game
// pitch to fire once a valid % is typed.
export async function askActionPct(
  chatId: number,
  playerId: number,
  player: StartPlayer,
  gameKey: string,
  tid?: number,
) {
  const cfg = ACTION_GAMES[gameKey];
  const label = cfg?.label ?? gameKey;
  const hintRow = getDb()
    .prepare(`SELECT default_action_pct FROM games WHERE name = ?`)
    .get(gameKey) as { default_action_pct: number | null } | undefined;
  const hint = hintRow?.default_action_pct ?? 30;

  setSession(chatId, "waiting_game_action_pct" as Step, playerId, player.telegram_id, gameKey);
  await sendMsg(chatId,
    `✏️ <b>${player.name}</b> — quel % d'action <b>${label}</b> pour ce joueur ?\n` +
    `Tape le nombre exact (0 à 100, décimales OK — ex : <b>${hint}</b>).`,
    tid
  );
}

// Step 2 — validate the typed % and dispatch to the game-specific pitch with that %.
// Money-critical: invalid input (letters, >100, negative, empty) is rejected and
// re-asked — NEVER stored, NEVER falls back to a silent 0.
export async function handleActionPctRawMessage(
  text: string,
  chatId: number,
  session: { step: Step; player_id: number; expected_tg_id: number | null; pending_cmd?: string | null },
  tid?: number,
): Promise<boolean> {
  if (session.step !== ("waiting_game_action_pct" as Step)) return false;

  // Strict full-match: accept "30", "27.5", "30%" — reject "-5", "abc", "27%5", "".
  const cleaned = text.trim().replace(/%$/, "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) {
    await sendMsg(chatId, `❌ Envoie un nombre entre 0 et 100 (décimales OK), ex : <b>30</b>`, tid);
    return true;
  }
  const pct = parseFloat(cleaned);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    await sendMsg(chatId, `❌ Le % doit être entre 0 et 100. Réessaie, ex : <b>30</b>`, tid);
    return true;
  }

  const gameKey = session.pending_cmd ?? "";
  const player = getDb()
    .prepare(`SELECT id, name, telegram_id, telegram_handle FROM players WHERE id = ?`)
    .get(session.player_id) as { id: number; name: string; telegram_id: number | null; telegram_handle: string | null } | undefined;
  if (!player) {
    await sendMsg(chatId, `❌ Joueur introuvable. Contacte @baki77777`, tid);
    return true;
  }

  switch (gameKey) {
    case "A5POKER": {
      const { sendA5pokerPitch } = await import("./new-members");
      await sendA5pokerPitch(chatId, player.id, player, pct, tid);
      return true;
    }
    case "KKPOKER": {
      const { sendKkpokerPitch } = await import("./new-members");
      await sendKkpokerPitch(chatId, player.id, player, pct, tid);
      return true;
    }
    case "AKS": {
      const { sendAksPitch } = await import("./new-members");
      await sendAksPitch(chatId, player.id, player, pct, tid);
      return true;
    }
    case "AAPKMY": {
      const { sendAapkmyPitch } = await import("@/lib/games/aapkmy/onboarding");
      await sendAapkmyPitch(chatId, player.id, player, pct, tid);
      return true;
    }
    default:
      await sendMsg(chatId, `❌ Game inconnue (<code>${gameKey}</code>). Contacte @baki77777`, tid);
      return true;
  }
}
