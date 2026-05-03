import { getDb } from "@/lib/db";
import { sendMsg, AGENT_CHAT_ID } from "./helpers";
import { isUserbotConfigured, createPlayerGroup } from "@/lib/telegram-userbot";

/**
 * Direct onboarding: /start → create group immediately → send presentation in group.
 */
export async function handleOnboardingDirect(
  chatId: number,
  from: { id: number; first_name?: string; last_name?: string; username?: string }
) {
  const db = getDb();
  const firstName = from.first_name ?? "Joueur";
  const lastName = from.last_name ?? "";
  const username: string | null = from.username ?? null;
  const fullName = [firstName, lastName].filter(Boolean).join(" ");

  // Upsert lead
  db.prepare(`
    INSERT INTO onboarding_leads (telegram_id, telegram_username, first_name, stage)
    VALUES (?, ?, ?, 'joined')
    ON CONFLICT(telegram_id) DO UPDATE SET
      telegram_username = excluded.telegram_username,
      first_name = excluded.first_name,
      stage = 'joined',
      last_seen = datetime('now')
  `).run(from.id, username, firstName);

  // Already has a group? Don't create another
  const existingPlayer = db.prepare(`SELECT id FROM players WHERE telegram_id = ?`).get(from.id);
  if (existingPlayer) {
    await sendMsg(chatId, `✅ Tu es déjà inscrit ! Ton groupe est prêt.\n\nQuestions ? → @baki77777`);
    return;
  }

  await sendMsg(chatId,
    `🃏 <b>Bienvenue sur Le Cercle !</b>\n\n` +
    `On crée ton groupe privé avec ton support dédié — ` +
    `tu y retrouveras tout pour jouer sur nos tables.\n\n` +
    `⏳ Ça arrive...`
  );

  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  let groupCreated = false;

  if (isUserbotConfigured() && botToken) {
    try {
      const result = await createPlayerGroup(from.id, fullName, botToken, username ?? undefined);
      if (result) {
        groupCreated = true;

        await sendMsg(result.chatId,
          `🎰 <b>TELE AK POKER — ${fullName}</b>\n\n` +
          `Bienvenue dans ton espace privé !\n\n` +
          `💬 <b>General</b> — discussion avec ton support\n` +
          `🏛 <b>Accounting</b> — suivi de tes transactions\n` +
          `📋 <b>Deals</b> — tes deals et conditions\n` +
          `🗂 <b>Clubs</b> — infos des clubs\n\n` +
          `Ton support dédié va te guider pour la suite. 🃏`
        );

        // Confirm in private chat
        await sendMsg(chatId,
          `🎉 <b>C'est parti !</b>\n\n` +
          `Ton groupe privé a été créé. Retrouve-le dans tes conversations !\n\n` +
          `Bienvenue dans Le Cercle 🃏`
        );

        // Notify admins
        await sendMsg(AGENT_CHAT_ID,
          `🆕 <b>Nouveau joueur onboardé !</b>\n\n` +
          `👤 ${fullName}\n` +
          (username ? `📱 @${username}\n` : "") +
          `🆔 <code>${from.id}</code>\n` +
          `✅ Groupe créé automatiquement`
        );
      }
    } catch (e) {
      console.error("[ONBOARDING] auto-group failed:", e);
    }
  }

  // Fallback: notify admins to create group manually
  if (!groupCreated) {
    await sendMsg(chatId,
      `✅ <b>Tu es inscrit !</b>\n\n` +
      `On prépare ton groupe privé. Tu recevras une invitation très bientôt.\n\n` +
      `En attendant → @baki77777`
    );

    await sendMsg(AGENT_CHAT_ID,
      `🆕 <b>Nouveau joueur prêt à joindre !</b>\n\n` +
      `👤 ${fullName}\n` +
      (username ? `📱 @${username}\n` : "") +
      `🆔 <code>${from.id}</code>\n\n` +
      `⚡ Crée un groupe avec ce joueur + @hugoroine et ajoute le bot.`
    );
  }
}
