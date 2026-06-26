import { getDb } from "@/lib/db";
import { sendMsg, AGENT_CHAT_ID } from "./helpers";
import { isUserbotConfigured, createPlayerGroup } from "@/lib/telegram-userbot";

// Temporary map: telegram_id → group data, consumed by handleNewMembers when the player joins
const pendingGroupData = new Map<number, {
  groupId: number;
  alertesTopicId: number | null;
  liveplayTopicId: number | null;
  gameName?: string;
}>();

export function consumePendingGroupData(telegramId: number) {
  const data = pendingGroupData.get(telegramId);
  if (data) pendingGroupData.delete(telegramId);
  return data ?? null;
}

export const TOPIC_MESSAGES: Record<string, string> = {
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

  depot:
    `💳 <b>Dépôt</b>\n\n` +
    `⚠️ Toujours demander confirmation AVANT d'envoyer\n\n` +
    `⸻\n\n` +
    `🏦 <b>Dépôt bancaire</b>\n\n` +
    `Frais :\n` +
    `• -1000€ → 5%\n` +
    `• +1000€ → 2%\n\n` +
    `Nom :\n<blockquote>Baki Consulting LLP</blockquote>\n` +
    `IBAN :\n<blockquote>BE07905412731266</blockquote>\n` +
    `Swift :\n<blockquote>TRWIBEB1XXX</blockquote>\n` +
    `Adresse :\n<blockquote>Wise, Rue du Trône 100, 3rd floor, Brussels, 1050, Belgium</blockquote>\n\n` +
    `⸻\n\n` +
    `💰 <b>Dépôt crypto</b>\n\n` +
    `BTC\n<blockquote>bc1qjpglfnn8xfsqvjk36tz4vcks2qaga06cwes239</blockquote>\n` +
    `USDT (TRC20)\n<blockquote>TTavAAgmeaBFWo8bX8zGwGQzcfLGSPfUqc</blockquote>\n` +
    `USDT (ERC20)\n<blockquote>0xb79AF3958e1e870DD08D63A5774abA40732045C2</blockquote>\n` +
    `USDC (TRC20)\n<blockquote>TTavAAgmeaBFWo8bX8zGwGQzcfLGSPfUqc</blockquote>\n` +
    `USDC (ERC20)\n<blockquote>0xb79AF3958e1e870DD08D63A5774abA40732045C2</blockquote>\n\n` +
    `⸻\n\n` +
    `👉 Envoie le TX + montant après dépôt`,

  liveplay:
    `🔴 <b>Liveplay</b>\n\n` +
    `Ici seront postés les liveplay des différentes games.\n\n` +
    `👉 Reste connecté pour ne rien rater.`,

  onboarding:
    `🚀 <b>Onboarding</b>\n\n` +
    `Ce canal est dédié à ta mise en place.\n\n` +
    `Ton support va te guider étape par étape :\n` +
    `• Configuration de ton deal\n` +
    `• Wallet game (adresse de dépôt)\n` +
    `• Wallet cashout (adresse de retrait)\n\n` +
    `👉 Suis les instructions ici pour être 100% opérationnel.`,

  alertes:
    `📢 <b>Alertes</b>\n\n` +
    `Ce canal sert aux annonces importantes de Le Cercle.\n\n` +
    `Tu y recevras :\n` +
    `• Nouvelles tables\n` +
    `• Changements importants\n` +
    `• Annonces spéciales\n\n` +
    `👉 Active les notifications pour ne rien rater.`,
};

/**
 * Direct onboarding: /start → create group immediately → send presentation in group.
 * gameName: undefined = AKPOKER (default), "KKPOKER" = KKPOKER-specific flow
 */
export async function handleOnboardingDirect(
  chatId: number,
  from: { id: number; first_name?: string; last_name?: string; username?: string },
  gameName?: string,
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
  const existingPlayer = db.prepare(`SELECT id, name FROM players WHERE telegram_id = ?`).get(from.id) as { id: number; name: string } | undefined;

  if (existingPlayer && gameName === "KKPOKER") {
    const { getPlayerGameWallets, getPlayerCashouts } = await import("@/lib/queries");
    const kkGameId = (db.prepare(`SELECT id FROM games WHERE name = 'KKPOKER'`).get() as { id: number } | undefined)?.id;
    if (kkGameId) {
      const existingGameWallets = getPlayerGameWallets(existingPlayer.id, kkGameId);
      const existingCashouts = getPlayerCashouts(existingPlayer.id, kkGameId);
      if (existingGameWallets.length > 0 || existingCashouts.length > 0) {
        await sendMsg(chatId,
          `👋 <b>${existingPlayer.name}</b>, tu es déjà inscrit sur KKPOKER !\n\n` +
          `Si tu as besoin de modifier tes infos, contacte @baki77777`
        );
        await sendMsg(AGENT_CHAT_ID,
          `⚠️ <b>Re-onboarding KKPOKER bloqué</b>\n` +
          `Joueur : <b>${existingPlayer.name}</b> (ID ${existingPlayer.id})\n` +
          `🆔 TG: <code>${from.id}</code>\n` +
          `Wallets KKPOKER existants — intervention manuelle requise si le joueur veut changer.`
        );
        return;
      }
    }
  }

  if (existingPlayer && !gameName) {
    await sendMsg(chatId, `✅ Tu es déjà inscrit ! Ton groupe est prêt.\n\nQuestions ? → @baki77777`);
    return;
  }

  if (username) {
    const leadHandle = username.toLowerCase();
    const existingLead = db.prepare(
      `SELECT kickoff_invite_link, kickoff_group_id FROM affiliate_leads WHERE LOWER(referred_handle) = ? AND status IN ('pending', 'converted')`
    ).get(leadHandle) as { kickoff_invite_link: string | null; kickoff_group_id: string | null } | undefined;
    if (existingLead?.kickoff_invite_link) {
      console.log(`[ONBOARDING] User @${leadHandle} has affiliate lead with group, redirecting`);
      await sendMsg(chatId,
        `👉 Tu as déjà un groupe créé pour toi.\nClique ici pour rejoindre : ${existingLead.kickoff_invite_link}`
      );
      return;
    }
    // ref_ leads (no kickoff_group_id) continue to group creation below
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

        pendingGroupData.set(from.id, {
          groupId: result.chatId,
          alertesTopicId: result.topicIds.alertes ?? null,
          liveplayTopicId: result.topicIds.liveplay ?? null,
          gameName,
        });

        // Backfill kickoff_group_id on ref_ leads so handleNewMembers can match
        if (username) {
          db.prepare(
            `UPDATE affiliate_leads SET kickoff_group_id = ?, kickoff_invite_link = ? WHERE LOWER(referred_handle) = ? AND kickoff_group_id IS NULL AND status = 'pending'`
          ).run(String(result.chatId), result.inviteLink ?? null, username.toLowerCase());
        }

        // Send topic welcome messages into the group (bot is already in it)
        for (const [key, msg] of Object.entries(TOPIC_MESSAGES)) {
          const topicId = result.topicIds[key];
          if (topicId) {
            await sendMsg(result.chatId, msg, topicId);
          }
        }

        // Send invite link to the player's private DM
        if (result.inviteLink) {
          await sendMsg(chatId,
            `🎉 <b>C'est parti !</b>\n\n` +
            `Ton groupe privé est prêt.\n` +
            `👉 <b>Clique ici pour le rejoindre :</b>\n${result.inviteLink}\n\n` +
            `Bienvenue dans Le Cercle 🃏`
          );
        } else {
          await sendMsg(chatId,
            `🎉 <b>C'est parti !</b>\n\n` +
            `Ton groupe privé a été créé. Tu recevras une invitation très bientôt.\n\n` +
            `En attendant → @baki77777`
          );
        }

        const topicCount = Object.keys(result.topicIds).length;
        const botStatus = result.botPromoted ? "Bot admin ✅" : "⚠️ Bot NOT admin";
        if (result.status === "full_success") {
          await sendMsg(AGENT_CHAT_ID,
            `🆕 <b>Nouveau joueur onboardé !</b>\n\n` +
            `👤 ${fullName}\n` +
            (username ? `📱 @${username}\n` : "") +
            `🆔 <code>${from.id}</code>\n` +
            `📦 Chat ID: <code>${result.chatId}</code>\n` +
            `✅ Groupe créé — ${topicCount} topics — ${botStatus}`
          );
        } else {
          await sendMsg(AGENT_CHAT_ID,
            `⚠️ <b>Onboarding partiel — ${fullName}</b>\n\n` +
            `👤 ${fullName}\n` +
            (username ? `📱 @${username}\n` : "") +
            `🆔 <code>${from.id}</code>\n` +
            `📦 Chat ID: <code>${result.chatId}</code>\n\n` +
            `✅ Groupe créé — ${topicCount}/5 topics — ${botStatus}\n` +
            `❌ ${result.failedSteps.join(", ")}\n` +
            `💬 ${result.errors.join(" | ")}\n\n` +
            `<i>→ /api/admin/promote-bot + /api/admin/recreate-topics</i>`
          );
        }
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
