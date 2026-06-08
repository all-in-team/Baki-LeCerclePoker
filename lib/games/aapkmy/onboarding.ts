import { getDb } from "@/lib/db";
import {
  sendMsg, setSession, OWNER_IDS, AGENT_CHAT_ID,
  type Step,
} from "@/lib/telegram-commands/helpers";
import { AAPKMY_GAME_NAME, AAPKMY_DOWNLOAD_LINK, AAPKMY_CLUB_ID } from "./config";

function getAapkmyGameId(): number | null {
  const row = getDb().prepare(`SELECT id FROM games WHERE name = ?`).get(AAPKMY_GAME_NAME) as { id: number } | undefined;
  return row?.id ?? null;
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
