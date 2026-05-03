import { getDb } from "@/lib/db";
import { sendMsg, AGENT_CHAT_ID } from "./helpers";
import { isUserbotConfigured, createPlayerGroup } from "@/lib/telegram-userbot";

const TOPIC_MESSAGES: Record<string, string> = {
  accounting:
    `📊 <b>Accounting</b>\n\n` +
    `Ce canal sert au suivi de ta bankroll.\n\n` +
    `Tu y trouveras :\n` +
    `• Updates de ton solde\n` +
    `• Résultats hebdo\n` +
    `• Ajustements\n\n` +
    `👉 Transparence totale.\n` +
    `👉 Mise à jour régulière.\n\n` +
    `Voici les commandes pour le suivi de ton solde :\n` +
    `<code>/solde</code> — ton solde actuel\n` +
    `<code>/historique</code> — tes transactions`,

  deals:
    `📋 <b>Deals</b>\n\n` +
    `Ici tu trouveras tous les deals actifs :\n\n` +
    `• % d'action\n` +
    `• Stacking\n` +
    `• Conditions spécifiques\n\n` +
    `👉 Chaque game = règles différentes\n` +
    `👉 Toujours vérifier avant de jouer`,

  clubs:
    `🏠 <b>Clubs</b>\n\n` +
    `Tous les clubs disponibles sont listés ici.\n\n` +
    `Tu y trouveras :\n` +
    `• Les apps\n` +
    `• Les ID clubs\n` +
    `• Les formats (NLH, PLO, Short Deck…)`,

  depot:
    `💳 <b>Dépôt</b>\n\n` +
    `⚠️ Toujours demander confirmation AVANT d'envoyer\n\n` +
    `⸻\n\n` +
    `🏦 <b>Dépôt bancaire</b>\n\n` +
    `Frais :\n` +
    `• -1000€ → 5%\n` +
    `• +1000€ → 2%\n\n` +
    `Nom :\n<code>Baki Consulting LLP</code>\n` +
    `IBAN :\n<code>BE07905412731266</code>\n` +
    `Swift :\n<code>TRWIBEB1XXX</code>\n` +
    `Adresse :\nWise, Rue du Trône 100, 3rd floor, Brussels, 1050, Belgium\n\n` +
    `⸻\n\n` +
    `💰 <b>Dépôt crypto</b>\n\n` +
    `BTC\n<code>bc1qjpglfnn8xfsqvjk36tz4vcks2qaga06cwes239</code>\n\n` +
    `USDT (TRC20)\n<code>TTavAAgmeaBFWo8bX8zGwGQzcfLGSPfUqc</code>\n\n` +
    `USDT (ERC20)\n<code>0xb79AF3958e1e870DD08D63A5774abA40732045C2</code>\n\n` +
    `USDC (TRC20)\n<code>TTavAAgmeaBFWo8bX8zGwGQzcfLGSPfUqc</code>\n\n` +
    `USDC (ERC20)\n<code>0xb79AF3958e1e870DD08D63A5774abA40732045C2</code>\n\n` +
    `⸻\n\n` +
    `👉 Envoie le TX + montant après dépôt`,
};

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

        // Welcome in General topic
        await sendMsg(result.chatId,
          `🃏 <b>Bienvenue ${firstName} !</b>\n\n` +
          `C'est ici que tu peux discuter avec ton support dédié.\n` +
          `Toutes les infos importantes sont dans les topics ci-dessous.\n\n` +
          `👉 Questions ? → envoie un message ici.`
        );

        // Send messages in each topic
        for (const [key, msg] of Object.entries(TOPIC_MESSAGES)) {
          const topicId = result.topicIds[key];
          if (topicId) {
            await sendMsg(result.chatId, msg, topicId);
          }
        }

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
