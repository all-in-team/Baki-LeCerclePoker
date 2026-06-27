import { getDb } from "@/lib/db";
import {
  sendMsg, sendMsgKeyboard, answerCbQuery, editMessageReplyMarkup, getSession, setSession, OWNER_IDS, AGENT_CHAT_ID,
  type Step,
} from "@/lib/telegram-commands/helpers";
import { recordDealAcceptance } from "@/lib/queries";
import { AAPKMY_GAME_NAME, AAPKMY_DOWNLOAD_LINK, AAPKMY_CLUB_ID } from "./config";

// Fallback only — the action % is now chosen by the owner at onboarding (free text)
// and stored in player_game_deals. NOTE: AAPK is identity-only (not in AGENCY_GAMES),
// so its % is cosmetic until AAPK is wired into agency P&L.
const AAPKMY_DEFAULT_ACTION_PCT = 20;

function getAapkmyGameId(): number | null {
  const row = getDb().prepare(`SELECT id FROM games WHERE name = ?`).get(AAPKMY_GAME_NAME) as { id: number } | undefined;
  return row?.id ?? null;
}

function getAapkmyDeal(playerId: number): { action_pct: number } | null {
  const gameId = getAapkmyGameId();
  if (!gameId) return null;
  return getDb().prepare(
    `SELECT action_pct FROM player_game_deals WHERE player_id = ? AND game_id = ?`
  ).get(playerId, gameId) as { action_pct: number } | undefined ?? null;
}

// AAPK pitch — action % chosen by the owner via the shared free-text prompt (askActionPct)
// and passed in here. Deal upserted + pitch copy built from the chosen %.
export async function sendAapkmyPitch(
  chatId: number,
  playerId: number,
  player: { name: string; telegram_id: number | null },
  actionPct: number,
  tid?: number,
) {
  const db = getDb();
  const gameId = getAapkmyGameId();
  if (gameId) {
    db.prepare(
      `INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct) VALUES (?, ?, ?, 0)
       ON CONFLICT(player_id, game_id) DO UPDATE SET action_pct = excluded.action_pct`
    ).run(playerId, gameId, actionPct);
  }

  setSession(chatId, "aapkmy_pitch_sent" as Step, playerId, player.telegram_id);

  // Anti-bypass: download link + club ID are NOT shown here. They are revealed only
  // after the player clicks "J'accepte" (handleAapkmyCallback → aapk_accept).
  await sendMsgKeyboard(chatId,
    `🎰 <b>Welcome AAPK</b>\n\n` +
    `💼 Deal: ${actionPct}% action pour LeCercle\n` +
    `💱 Taux: 1$ = 6.6 chips\n\n` +
    `Tu valides le deal ?`,
    [
      [{ text: "✅ J'accepte le deal", callback_data: "aapk_accept" }],
      [{ text: "❓ J'ai une question", callback_data: "aapk_question" }],
    ],
    tid
  );
}

// ── Callback handler for AAPKMY onboarding buttons ──
export async function handleAapkmyCallback(
  callbackQueryId: string,
  data: string,
  chatId: number,
  messageThreadId?: number,
  from?: any,
  messageId?: number,
) {
  await answerCbQuery(callbackQueryId);

  const session = getSession(chatId);
  if (!session) {
    await sendMsg(chatId, "🔧 Petit souci technique, je te reviens dans un instant.");
    return;
  }

  const db = getDb();
  const player = session.player_id
    ? db.prepare(`SELECT id, name FROM players WHERE id = ?`).get(session.player_id) as { id: number; name: string } | undefined
    : null;
  const playerName = player?.name ?? from?.first_name ?? "Joueur";
  const tid = messageThreadId;

  // ── Question ──
  if (data === "aapk_question") {
    if (session.step === ("awaiting_human_response" as Step)) {
      await sendMsg(chatId, "Ta question est en cours de traitement, on te répond bientôt 👍", tid);
      return;
    }
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});
    setSession(chatId, "awaiting_human_response" as Step, session.player_id, session.expected_tg_id, "question_pending");
    await sendMsg(chatId, `Pas de souci, pose ta question ici. Baki vient voir 👇`, tid);
    await sendMsg(AGENT_CHAT_ID,
      `💬 <b>Question AAPK onboarding — ${playerName}</b>\n` +
      `@baki77777 — réponds dans le chat <code>${chatId}</code>`
    );
    return;
  }

  // ── J'accepte → record acceptance, THEN reveal download + club ID ──
  if (data === "aapk_accept") {
    if (session.step !== ("aapkmy_pitch_sent" as Step)) return;
    if (messageId) await editMessageReplyMarkup(chatId, messageId).catch(() => {});

    const gameId = getAapkmyGameId();
    if (session.player_id && gameId) {
      const deal = getAapkmyDeal(session.player_id);
      recordDealAcceptance(session.player_id, gameId, deal?.action_pct ?? AAPKMY_DEFAULT_ACTION_PCT);
      db.prepare(`UPDATE players SET status = 'active' WHERE id = ?`).run(session.player_id);
    }

    setSession(chatId, "aapkmy_waiting_id" as Step, session.player_id, session.expected_tg_id);

    // Download link + club ID revealed ONLY now — after explicit acceptance.
    await sendMsg(chatId,
      `✅ <b>Deal accepté !</b>\n\n` +
      `📥 Download: ${AAPKMY_DOWNLOAD_LINK}\n` +
      `🏠 Club ID: <code>${AAPKMY_CLUB_ID}</code>\n\n` +
      `Une fois installé et le club rejoint, envoie-moi ton ID AAPK ici.`,
      tid
    );

    await sendMsg(AGENT_CHAT_ID,
      `🎉 <b>Deal accepté AAPK — ${playerName}</b>\n` +
      `<i>En attente de l'ID AAPK...</i>`
    );
    return;
  }
}

export async function handleAapkmyRawMessage(
  text: string,
  chatId: number,
  session: { step: Step; player_id: number; expected_tg_id: number | null },
  messageThreadId?: number,
): Promise<boolean> {
  const reply = (msg: string) => sendMsg(chatId, msg, messageThreadId);

  if (session.step === ("aapkmy_waiting_id" as Step)) {
    const aapkId = text.trim();
    if (!/^\d{3,30}$/.test(aapkId)) {
      await reply("❌ ID AAPK doit être uniquement numérique (ex: 11116820). Réessaie.");
      return true;
    }

    const gameId = getAapkmyGameId();
    if (!gameId) {
      await reply("❌ Erreur interne (game AAPKMY introuvable). Contacte @baki77777");
      return true;
    }

    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO player_game_ids (player_id, game_id, external_id) VALUES (?, ?, ?)`
    ).run(session.player_id, gameId, aapkId);

    setSession(chatId, "aapkmy_waiting_proof" as Step, session.player_id, session.expected_tg_id, aapkId);

    await reply(
      `✅ ID AAPK enregistré : <code>${aapkId}</code>\n\n` +
      `💰 <b>Pour déposer :</b>\n` +
      `→ Va dans le topic <b>Dépôt</b> de ton group LeCercle\n` +
      `→ Choisis le moyen qui te convient (USDT, Wechat, etc.)\n` +
      `→ Envoie-moi le screenshot de la proof ici\n\n` +
      `On ajoute les chips dès réception.`
    );

    await sendMsg(AGENT_CHAT_ID,
      `🆔 <b>AAPK ID enregistré</b>\n` +
      `Player ID: ${session.player_id}\n` +
      `AAPK ID: <code>${aapkId}</code>`
    );

    return true;
  }

  return false;
}

export async function handleAapkmyPhoto(
  chatId: number,
  session: { step: Step; player_id: number; expected_tg_id: number | null; pending_cmd: string | null },
  msg: any,
  messageThreadId?: number,
): Promise<boolean> {
  if (session.step !== ("aapkmy_waiting_proof" as Step)) return false;

  const db = getDb();
  const player = db.prepare(`SELECT name, telegram_handle FROM players WHERE id = ?`).get(session.player_id) as { name: string; telegram_handle: string | null } | undefined;
  const playerName = player?.name ?? "Joueur";
  const handle = player?.telegram_handle ? `@${player.telegram_handle}` : "";
  const aapkId = session.pending_cmd ?? "???";

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return true;

  const caption =
    `🔔 <b>Dépôt AAPK</b>\n` +
    `Player: <b>${playerName}</b> ${handle}\n` +
    `ID AAPK: <code>${aapkId}</code>\n\n` +
    `→ Forward à l'agent AAPK pour processing`;

  for (const ownerId of OWNER_IDS) {
    await fetch(`https://api.telegram.org/bot${token}/copyMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ownerId,
        from_chat_id: chatId,
        message_id: msg.message_id,
      }),
    });

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ownerId,
        text: caption,
        parse_mode: "HTML",
      }),
    });
  }

  await sendMsg(chatId,
    `✅ Proof reçue et envoyée à l'équipe ! On ajoute tes chips dès que c'est traité. 🎰`,
    messageThreadId
  );

  return true;
}
